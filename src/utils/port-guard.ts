// src/utils/port-guard.ts
// 启动端口保卫：先甄别占用者身份，再决定「回收 / 复用 / 换端口 / 失败」。
//
// 背景（真实故障）：任务中断 + 锁屏后重启，配置端口 7766 被一个已退出的进程残留
// 监听（netstat 显示 PID 5244，tasklist 查无此进程）。旧实现直接 autoPort 漂移到 7767，
// 而 dev 前端仍代理 7766 → WebUI 全白。
//
// 本模块的判定顺序：
//   1. 端口空闲 → 直接用；
//   2. 占用者是当前进程/祖先 → 绝不 kill（防“自己杀自己”）；
//   3. 占用者是 MOSS（bun/node/moss 且命令行含 MOSS 入口）：
//      - 健康存活 → 不杀，抛错让上层退出（另一个实例正在服务）；
//      - 刚启动（<15s）→ 先等健康检查，避免把正在启动的实例当残留杀掉；
//      - 否则视为残留 → 精确 kill 进程树并等待端口释放；
//   4. 占用者不是 MOSS / 查不到 PID 的僵尸套接字：
//      - autoPort=true → 顺延找空闲端口，显式记录实际端口；
//      - autoPort=false → 抛错，绝不静默漂移。

import type { Logger } from '../core/types';
import { killProcess, type PidInfo } from './pid';

/** Windows 单进程信息（仅冲突时查询一次/进程） */
export interface ProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
  /** 进程启动时刻（ISO；CIM CreationDate） */
  createdAt?: string;
}

export interface StartupPortResult {
  /** 最终使用的端口 */
  port: number;
  /** 是否发生端口漂移（配置端口不可用） */
  switched: boolean;
  /** 被回收的残留 MOSS PID（未回收则 undefined） */
  reclaimedPid?: number;
}

export interface StartupPortOptions {
  configuredPort: number;
  host: string;
  autoPort: boolean;
  packageRoot: string;
  logger: Logger;
  isPortFree: (host: string, port: number) => Promise<boolean>;
}

/** 健康 MOSS 已在同一端口服务（上层必须退出，不得抢占） */
export class LiveMossPortError extends Error {
  readonly pid: number;
  readonly port: number;
  constructor(pid: number, port: number) {
    super(`另一个 MOSS 实例正在 http://127.0.0.1:${port} 运行（PID ${pid}）`);
    this.name = 'LiveMossPortError';
    this.pid = pid;
    this.port = port;
  }
}

/** 端口被非 MOSS 占用，且配置禁止 autoPort（上层必须失败并提示用户） */
export class PortOccupiedError extends Error {
  readonly port: number;
  readonly ownerPid: number | null;
  constructor(port: number, ownerPid: number | null, detail: string) {
    super(`端口 ${port} 被占用且无法回收${ownerPid ? `（PID ${ownerPid}）` : ''}：${detail}`);
    this.name = 'PortOccupiedError';
    this.port = port;
    this.ownerPid = ownerPid;
  }
}

/** 单进程查询的超时（PowerShell 冷启动可能 ~1s；仅冲突路径触发） */
const CIM_TIMEOUT_MS = 3000;
/** 刚启动进程的保护窗口：15s 内不判为残留，先等健康检查 */
const RECENT_START_MS = 15_000;
/** 等待端口释放的上限 */
const PORT_RELEASE_TIMEOUT_MS = 5_000;

/**
 * 解析 netstat 输出中的监听 PID。
 * 只接受 LISTENING 行；Windows 输出形如：
 *   `  TCP    127.0.0.1:7766    0.0.0.0:0    LISTENING    5244`
 */
export function parseNetstatListeningPid(output: string, port: number): number | null {
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    if (parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue;
    const local = parts[1];
    if (!local.endsWith(`:${port}`)) continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/** 解析 PowerShell ConvertTo-Json 的单进程信息（null/空返回 null） */
export function parseProcessInfoJson(raw: string): ProcessInfo | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as Record<string, unknown>;
    const pid = Number(p.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      parentPid: Number(p.ParentProcessId) || 0,
      name: typeof p.Name === 'string' ? p.Name : '',
      commandLine: typeof p.CommandLine === 'string' ? p.CommandLine : '',
      ...(typeof p.CreationDate === 'string' ? { createdAt: p.CreationDate } : {}),
    };
  } catch {
    return null;
  }
}

/** 查询单个 PID 的进程信息；Windows 专用，失败返回 null */
function queryProcessInfo(pid: number): ProcessInfo | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (Bun as any).spawnSync({
      cmd: [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){$p|Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate|ConvertTo-Json -Compress}`,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: CIM_TIMEOUT_MS,
    });
    const out = result.stdout?.toString() ?? '';
    return parseProcessInfoJson(out.trim());
  } catch {
    return null;
  }
}

/** 查询监听 PID（Windows netstat）；非 Windows/失败返回 null */
function findListeningPid(port: number): number | null {
  if (process.platform !== 'win32') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (Bun as any).spawnSync({
      cmd: ['netstat', '-ano', '-p', 'TCP'],
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: CIM_TIMEOUT_MS,
    });
    return parseNetstatListeningPid(result.stdout?.toString() ?? '', port);
  } catch {
    return null;
  }
}

/** 是否是当前进程或当前进程的祖先（祖先绝不能 kill） */
function isSelfOrAncestor(pid: number): boolean {
  if (pid === process.pid) return true;
  let current = pid;
  for (let depth = 0; depth < 16; depth++) {
    const info = queryProcessInfo(current);
    if (!info || info.parentPid <= 0) return false;
    if (info.parentPid === process.pid) return true;
    current = info.parentPid;
  }
  return false;
}

/** 映像名是否像 MOSS 运行时 */
function isRuntimeImage(name: string): boolean {
  return new Set(['bun.exe', 'node.exe', 'moss.exe', 'bun', 'node', 'moss']).has(
    name.toLowerCase(),
  );
}

/** 命令行是否包含 MOSS 入口特征（避免误杀同机的其他 bun/node 程序） */
function looksLikeMoss(info: ProcessInfo, packageRoot: string): boolean {
  if (!isRuntimeImage(info.name)) return false;
  const cmd = info.commandLine.toLowerCase();
  if (!cmd) return false;
  if (cmd.includes('src/main.ts') || cmd.includes('dist/server.js') || cmd.includes('moss')) return true;
  const root = packageRoot.trim().toLowerCase();
  return root.length > 0 && cmd.includes(root);
}

/** 进程是否足够“新”（刚启动保护窗口） */
function startedRecently(info: ProcessInfo): boolean {
  if (!info.createdAt) return false;
  const created = Date.parse(info.createdAt);
  return Number.isFinite(created) && Date.now() - created < RECENT_START_MS;
}

/** 健康检查：该端口是否是活的 MOSS（services 含 server.instance） */
async function isHealthyMoss(host: string, port: number): Promise<boolean> {
  const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  try {
    const resp = await fetch(`http://${target}:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { services?: unknown };
    return Array.isArray(data.services) && data.services.includes('server.instance');
  } catch {
    return false;
  }
}

/** 等待端口空闲（最多 timeoutMs） */
async function waitPortFree(
  opts: StartupPortOptions,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await opts.isPortFree(opts.host, port)) return true;
    await sleep(300);
  }
  return opts.isPortFree(opts.host, port);
}

/** 顺延查找空闲端口（最多 100 个） */
async function findNextFreePort(opts: StartupPortOptions, start: number): Promise<number> {
  for (let offset = 1; offset <= 100; offset++) {
    const candidate = start + offset;
    if (candidate > 65535) break;
    if (await opts.isPortFree(opts.host, candidate)) return candidate;
  }
  throw new Error(`从端口 ${start} 起连续 100 个端口均不可用`);
}

/** 冲突兜底：切换端口或失败（绝不静默漂移） */
async function switchOrFail(
  opts: StartupPortOptions,
  reason: string,
  ownerPid: number | null,
): Promise<StartupPortResult> {
  if (!opts.autoPort) {
    throw new PortOccupiedError(opts.configuredPort, ownerPid, reason);
  }
  const port = await findNextFreePort(opts, opts.configuredPort);
  opts.logger.warn('server: 配置端口不可用，已切换实际端口', {
    configured: opts.configuredPort,
    actual: port,
    ownerPid,
    reason,
  });
  return { port, switched: true };
}

/**
 * 启动前解析实际端口。
 * @throws LiveMossPortError 同一端口已有健康 MOSS
 * @throws PortOccupiedError 非 MOSS 占用且 autoPort=false
 */
export async function resolveStartupPort(opts: StartupPortOptions): Promise<StartupPortResult> {
  const configured = opts.configuredPort;
  if (await opts.isPortFree(opts.host, configured)) {
    return { port: configured, switched: false };
  }

  const ownerPid = findListeningPid(configured);
  if (!ownerPid) {
    return switchOrFail(opts, '监听进程 PID 查不到（僵尸/继承句柄残留）', null);
  }
  if (isSelfOrAncestor(ownerPid)) {
    return switchOrFail(opts, `端口由当前进程/祖先持有（PID ${ownerPid}），拒绝自杀`, ownerPid);
  }

  const info = queryProcessInfo(ownerPid);
  if (!info) {
    return switchOrFail(opts, `PID ${ownerPid} 查不到进程信息（可能为僵尸套接字）`, ownerPid);
  }

  if (!looksLikeMoss(info, opts.packageRoot)) {
    return switchOrFail(
      opts,
      `占用者是 ${info.name || '未知进程'}（非 MOSS）`,
      ownerPid,
    );
  }

  // 是 MOSS：先确认是否健康存活；刚启动的实例给足健康检查时间，绝不误杀。
  if (await isHealthyMoss(opts.host, configured)) {
    throw new LiveMossPortError(ownerPid, configured);
  }
  if (startedRecently(info)) {
    const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await isHealthyMoss(opts.host, configured)) {
        throw new LiveMossPortError(ownerPid, configured);
      }
      await sleep(300);
    }
    // 仍不健康且启动不足 15s：出于“不自杀刚启动 MOSS”的硬约束，不 kill；
    // 交给 autoPort/失败路径，避免误杀正在初始化、暂时无法响应 health 的实例。
    return switchOrFail(opts, `MOSS PID ${ownerPid} 启动不足 15s 且 health 未就绪，保守不回收`, ownerPid);
  }

  // 老 MOSS 且不健康 = 残留：精确 kill 并等待端口释放。
  const expected: PidInfo = {
    pid: ownerPid,
    startedAt: info.createdAt ?? new Date().toISOString(),
    port: configured,
    imageName: info.name,
  };
  opts.logger.warn('server: 回收残留 MOSS 进程', {
    pid: ownerPid,
    commandLine: info.commandLine.slice(0, 300),
  });
  const reclaimed = await killProcess(ownerPid, 5000, expected);
  if (reclaimed && (await waitPortFree(opts, configured, PORT_RELEASE_TIMEOUT_MS))) {
    return { port: configured, switched: false, reclaimedPid: ownerPid };
  }
  return switchOrFail(opts, `残留 MOSS PID ${ownerPid} 回收失败`, ownerPid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
