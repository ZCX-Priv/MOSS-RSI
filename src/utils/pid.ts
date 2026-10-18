// src/utils/pid.ts
// PID 文件读写：单例锁、跨平台进程管理。
//
// ⚠️ 进程身份校验（勿简化）：Windows 重启后 PID 号会被系统重新分配，残留 PID 文件里的
// 号很可能落到 svchost.exe 等系统进程上。旧实现只调 tasklist 问「这个号有人用吗」，
// 于是把 svchost 当成活着的 MOSS（表现为「MOSS 已在运行 (PID: 1168)」），
// 更危险的是 cmdStop 随后会 taskkill /T /F 强杀它（可能直接蓝屏）。
// 因此本文件的存活判定一律走 inspectPid()：PID 存在 ∧ 映像名是运行时 ∧ 未跨重启。

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { uptime } from 'node:os';

export interface PidInfo {
  pid: number;
  startedAt: string;
  port?: number;
  /** 写入时该进程的映像名（如 bun.exe）；老 PID 文件可能没有 */
  imageName?: string;
  /** 写入时该进程的可执行文件绝对路径 */
  execPath?: string;
}

// ============================================================================
// 进程身份判定
// ============================================================================

/**
 * 允许被视为 MOSS 的映像名白名单。
 * MOSS 由 bun（源码 / 构建产物）或 node（构建产物兜底）承载；svchost.exe 等系统进程
 * 不在其中，这是挡住误杀的第一道闸。
 */
const MOSS_IMAGE_NAMES = new Set(['bun.exe', 'node.exe', 'bun', 'node', 'moss.exe', 'moss']);

/** 开机时间与 startedAt 比较时的容差，吸收时钟抖动 */
const BOOT_TIME_TOLERANCE_MS = 2000;

export type PidStateReason =
  /** 该 PID 确实是活着的 MOSS 进程 */
  | 'ok'
  /** 该 PID 当前没有任何进程占用 */
  | 'not-running'
  /** 该 PID 被非 MOSS 进程占用（如 svchost.exe）—— Windows PID 复用 */
  | 'image-mismatch'
  /** 映像名像是运行时，但 startedAt 早于本次开机时间 —— 必然是重启前的残留记录 */
  | 'stale-across-boot';

export interface PidInspection {
  pid: number;
  /** 该 PID 当前是否被某进程占用 */
  alive: boolean;
  /** 该 PID 是否确实是活着的 MOSS 进程（唯一可用于单例判定 / 杀进程的信号） */
  isMoss: boolean;
  /** 实际查到的映像名；null 表示查不到（进程不存在或平台不支持） */
  imageName: string | null;
  reason: PidStateReason;
}

/**
 * 纯函数：基于已查得的映像名与开机时间判定身份。
 * 抽成纯函数便于单测覆盖全部四种情形，不触碰真实进程。
 */
export function classifyPid(
  info: PidInfo,
  imageName: string | null,
  bootTimeMs: number,
  nowMs: number,
): PidInspection {
  const pid = info.pid;
  if (!imageName) {
    return { pid, alive: false, isMoss: false, imageName: null, reason: 'not-running' };
  }
  if (!MOSS_IMAGE_NAMES.has(imageName.toLowerCase())) {
    // 最强证据：PID 上蹲着的是别的程序（典型为 svchost.exe）
    return { pid, alive: true, isMoss: false, imageName, reason: 'image-mismatch' };
  }
  // 映像名像运行时，仍需排除「重启后该号恰好又被 bun/node 占用」的情况：
  // 记录里的 startedAt 若早于本次开机时间，必为重启前的残留。
  const startedAtMs = Date.parse(info.startedAt);
  if (
    Number.isFinite(startedAtMs) &&
    Number.isFinite(bootTimeMs) &&
    bootTimeMs > 0 &&
    nowMs >= bootTimeMs &&
    startedAtMs < bootTimeMs - BOOT_TIME_TOLERANCE_MS
  ) {
    return { pid, alive: true, isMoss: false, imageName, reason: 'stale-across-boot' };
  }
  return { pid, alive: true, isMoss: true, imageName, reason: 'ok' };
}

/** 本次开机时刻（毫秒时间戳）；查询失败返回 0 表示「不可用」，此时跳过跨重启判定 */
export function getBootTimeMs(): number {
  try {
    const seconds = uptime();
    if (!Number.isFinite(seconds) || seconds < 0) return 0;
    return Date.now() - seconds * 1000;
  } catch {
    return 0;
  }
}

/**
 * 解析 `tasklist /FO CSV /NH` 输出为 pid → 映像名。
 *
 * 旧实现用 /"?(\d+)"?,/ 扫整行，会把内存列 "34,816 K" 中的 34 也当成 PID，
 * 存在误判空间。CSV 的实际列序为：映像名, PID, 会话名, 会话#, 内存，
 * 因此严格取前两个字段。
 */
export function parseTasklistCsv(csv: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of csv.split(/\r?\n/)) {
    // 只接受以 "映像名","PID" 开头的行；表头 INFO:/信息: 等噪音行自然被排除
    const m = /^\s*"([^"]*)"\s*,\s*"(\d+)"\s*,/.exec(line);
    if (!m) continue;
    const pid = Number(m[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    map.set(pid, m[1]);
  }
  return map;
}

/** 查询单个 PID 的映像名；Windows 专用，查不到返回 null */
function queryImageName(pid: number): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (Bun as any).spawnSync({
      cmd: ['tasklist', '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = result.stdout?.toString() ?? '';
    return parseTasklistCsv(out).get(pid) ?? null;
  } catch {
    return null;
  }
}

/** POSIX 存活探测：不发信号，仅检测存在性 */
function posixAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验 PID 文件记录的进程是否确实是活着的 MOSS。
 * 这是单例判定与杀进程前的唯一判据，不要绕过它直接用 isProcessAlive。
 */
export function inspectPid(info: PidInfo): PidInspection {
  const pid = info.pid;
  const bootTimeMs = getBootTimeMs();
  const nowMs = Date.now();

  if (process.platform === 'win32') {
    return classifyPid(info, queryImageName(pid), bootTimeMs, nowMs);
  }

  // 非 Windows 无 tasklist，映像名未知：退化为「存活 + 未跨重启」双闸。
  // classifyPid 需要映像名，这里用一个占位名走同一套逻辑。
  if (!posixAlive(pid)) {
    return { pid, alive: false, isMoss: false, imageName: null, reason: 'not-running' };
  }
  return classifyPid(info, 'bun', bootTimeMs, nowMs);
}

// ============================================================================
// PID 文件读写
// ============================================================================

export function writePidFile(pidFile: string, info: PidInfo): void {
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, JSON.stringify(info, null, 2), 'utf8');
}

export function readPidFile(pidFile: string): PidInfo | null {
  if (!existsSync(pidFile)) return null;
  try {
    const text = readFileSync(pidFile, 'utf8');
    return JSON.parse(text) as PidInfo;
  } catch {
    return null;
  }
}

export function removePidFile(pidFile: string): void {
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile);
  } catch {
    // 静默
  }
}

/**
 * 检测指定 PID 的进程是否仍在运行（仅「存在性」，不代表是 MOSS）。
 * ⚠️ 不要用它做单例判定或杀进程决策，请用 inspectPid。
 */
export function isProcessAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    return queryImageName(pid) !== null;
  }
  return posixAlive(pid);
}

/** 采集当前进程的身份信息，供 writePidFile 使用 */
export function currentProcessIdentity(): Pick<PidInfo, 'imageName' | 'execPath'> {
  const execPath = process.execPath;
  const base = execPath.split(/[\\/]/).pop() ?? '';
  return { imageName: base || undefined, execPath };
}

// ============================================================================
// 进程终止
// ============================================================================

/**
 * 优雅停止进程：先 SIGTERM，超时后强杀。
 * Windows: taskkill /PID N /T（无 SIGTERM 概念，直接 taskkill）
 *
 * ⚠️ 误杀守卫：执行任何 taskkill 之前都会重新校验身份，身份不符直接拒绝。
 * 这是防止「残留 PID 落到 svchost.exe 上 → 强杀系统服务 → 蓝屏」的最后一道闸，
 * 即使调用方忘了先 inspectPid 也不会造成破坏。
 */
export async function killProcess(pid: number, timeoutMs = 5000, expected?: PidInfo): Promise<boolean> {
  const target: PidInfo =
    expected && expected.pid === pid
      ? expected
      : { ...(expected ?? {}), pid, startedAt: expected?.startedAt ?? new Date().toISOString() };

  const inspection = inspectPid(target);
  if (!inspection.isMoss) {
    // 身份不符（或进程已不存在）→ 一个信号都不发
    return false;
  }

  try {
    if (process.platform === 'win32') {
      // taskkill /T 杀进程树
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Bun as any).spawnSync({
        cmd: ['taskkill', '/PID', String(pid), '/T', '/F'],
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } else {
      process.kill(pid, 'SIGTERM');
      // 等待退出
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) return true;
        await sleep(200);
      }
      // 强杀
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // 静默
  }

  await sleep(300);
  return !isProcessAlive(pid);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
