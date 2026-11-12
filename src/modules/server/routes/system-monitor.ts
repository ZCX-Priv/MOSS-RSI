// src/modules/server/routes/system-monitor.ts
// 系统资源监控：GET /api/system-monitor/snapshot
// 采集范围：系统总量 + MOSS 自身占用（进程树）。
// 性能模型：HTTP 请求只读内存快照（毫秒返回）；慢采集（PowerShell / 磁盘遍历）在后台异步刷新。
// 所有采集点独立 try/catch 降级，任一失败只影响对应字段（置 0/空），接口永不 5xx。

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { Environment } from '../../../core/types';
import { cpus, totalmem, freemem, networkInterfaces } from 'node:os';
import { readdir, stat } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { join } from 'node:path';

export type MossProcessGroup = 'server' | 'terminal' | 'child' | 'other';

export interface MossProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  cpuPercent: number;
  rssBytes: number;
  isMoss: boolean;
  group: MossProcessGroup;
}

export interface ResourceSnapshot {
  cpu: { usagePercent: number; cores: number; model: string; mossPercent: number };
  memory: { totalBytes: number; usedBytes: number; usedPercent: number; mossBytes: number };
  disk: {
    drive: string;
    totalBytes: number;
    freeBytes: number;
    usedPercent: number;
    categories: Array<{ key: string; bytes: number }>;
  };
  network: {
    interfaces: Array<{
      name: string;
      address?: string;
      rxBytes: number;
      txBytes: number;
      rxRate: number;
      txRate: number;
    }>;
  };
  moss: { pid: number; processes: MossProcessInfo[] };
  sampledAt: string;
}

// ============================================================================
// 子进程执行（带超时 + 长度上限；失败返回 null，绝不抛）
// ============================================================================

type ProbeProc = {
  exited: Promise<number>;
  kill: (sig?: string | number) => boolean | void;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
};

const CMD_TIMEOUT_MS = 6000;
const CMD_MAX_BYTES = 4 * 1024 * 1024;

async function runCommand(cmd: string[], timeoutMs = CMD_TIMEOUT_MS): Promise<string | null> {
  let proc: ProbeProc;
  try {
    proc = Bun.spawn({
      cmd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      windowsHide: true,
    }) as unknown as ProbeProc;
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* 忽略 */
      }
      resolve(null);
    }, timeoutMs);
  });
  const read = (async (): Promise<string | null> => {
    try {
      const buf = proc.stdout
        ? await new Response(proc.stdout).arrayBuffer()
        : new ArrayBuffer(0);
      const code = await proc.exited;
      if (code !== 0) return null;
      return Buffer.from(buf.slice(0, CMD_MAX_BYTES)).toString('utf8');
    } catch {
      return null;
    }
  })();
  const result = await Promise.race([read, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

// ============================================================================
// JSON 解析工具（ConvertTo-Json 单项会退化为对象）
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => asRecord(item) !== null);
  }
  const single = asRecord(value);
  return single ? [single] : [];
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ============================================================================
// CPU（模块级保存上一次采样，求 Δidle/Δtotal）
// ============================================================================

let prevCpu: { idle: number; total: number } | null = null;

function sampleCpu(): { usagePercent: number; cores: number; model: string } {
  const list = cpus();
  let idle = 0;
  let total = 0;
  for (const c of list) {
    const t = c.times;
    idle += t.idle;
    total += t.idle + t.user + t.nice + t.sys + t.irq;
  }
  let usagePercent = 0;
  if (prevCpu) {
    const dIdle = idle - prevCpu.idle;
    const dTotal = total - prevCpu.total;
    if (dTotal > 0) usagePercent = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  prevCpu = { idle, total };
  return {
    usagePercent: Math.round(usagePercent * 10) / 10,
    cores: list.length,
    model: list[0]?.model?.trim() || 'Unknown',
  };
}

// ============================================================================
// 进程 / 网卡（Windows 一次 PowerShell 同时取回；Unix 走 ps + /proc/net/dev）
// ============================================================================

interface RawProcess {
  pid: number;
  ppid: number;
  name: string;
  rssBytes: number;
  cpuSec: number | null;
}

interface RawNet {
  name: string;
  rx: number;
  tx: number;
}

let prevProcCpu = new Map<number, number>();
let prevProcAt = 0;

const PS_UTF8 = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';

/** 一次 PowerShell 同时输出进程树与网卡累计字节（避免两次进程启动） */
const PS_RESOURCE =
  PS_UTF8 +
  '$c=@{}; ' +
  'Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $c[[int]$_.Id]=[double]$_.CPU }; ' +
  '$p = Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name; rss=[long]$_.WorkingSetSize; cpu=[double]($c[[int]$_.ProcessId]) } }; ' +
  '$n = Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes; ' +
  '[PSCustomObject]@{ processes=$p; net=$n } | ConvertTo-Json -Depth 5 -Compress';

function parseWindowsProcesses(value: unknown): RawProcess[] {
  return toRecordArray(value).map((p) => ({
    pid: toNum(p.pid),
    ppid: toNum(p.ppid),
    name: typeof p.name === 'string' ? p.name : '',
    rssBytes: toNum(p.rss),
    cpuSec: typeof p.cpu === 'number' && Number.isFinite(p.cpu) ? p.cpu : null,
  }));
}

function parseWindowsNet(value: unknown): RawNet[] {
  return toRecordArray(value).map((r) => ({
    name: typeof r.Name === 'string' ? r.Name : (typeof r.name === 'string' ? r.name : ''),
    rx: toNum(r.ReceivedBytes),
    tx: toNum(r.SentBytes),
  }));
}

function parseUnixProcesses(out: string | null): RawProcess[] {
  if (!out) return [];
  const rows: Array<RawProcess & { pcpu?: number }> = [];
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const pcpu = Number(parts[2]);
    const rssKb = Number(parts[3]);
    if (!Number.isFinite(pid)) continue;
    rows.push({
      pid,
      ppid: Number.isFinite(ppid) ? ppid : 0,
      name: parts.slice(4).join(' '),
      rssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : 0,
      // ps 的 pcpu 为「单核百分比」，能效口径与前端展示一致，直接使用
      cpuSec: null,
      pcpu: Number.isFinite(pcpu) ? pcpu : 0,
    });
  }
  return rows;
}

function parseUnixNet(out: string | null): RawNet[] {
  if (!out) return [];
  const rows: RawNet[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\S+):\s*(\d+\s+){8}(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    // 字段：iface: rx_bytes(1) ... rx_packets ... tx_bytes(9) tx_packets(10)
    const nums = line.split(':')[1]?.trim().split(/\s+/).map(Number) ?? [];
    if (nums.length < 16) continue;
    rows.push({ name: m[1], rx: nums[0], tx: nums[8] });
  }
  return rows;
}

interface RawStats {
  processes: RawProcess[];
  net: RawNet[];
}

async function readStats(env: Environment): Promise<RawStats> {
  if (env.isWindows) {
    const out = await runCommand(['powershell', '-NoProfile', '-NonInteractive', '-Command', PS_RESOURCE]);
    const root = parseJsonObject(out);
    return {
      processes: parseWindowsProcesses(root?.processes),
      net: parseWindowsNet(root?.net),
    };
  }
  const [procOut, netOut] = await Promise.all([
    runCommand(['ps', '-axo', 'pid=,ppid=,pcpu=,rss=,comm=']),
    runCommand(['cat', '/proc/net/dev']),
  ]);
  return { processes: parseUnixProcesses(procOut), net: parseUnixNet(netOut) };
}

const SHELL_NAMES = new Set([
  'powershell.exe', 'powershell', 'pwsh.exe', 'pwsh',
  'cmd.exe', 'cmd', 'bash', 'bash.exe', 'zsh', 'sh', 'fish', 'wsl.exe', 'conhost.exe',
]);

function collectProcesses(env: Environment, raw: RawProcess[], cores: number, now: number): {
  processes: MossProcessInfo[];
  mossPercent: number;
  mossBytes: number;
} {
  const pidMap = new Map<number, number>();
  for (const p of raw) pidMap.set(p.pid, p.ppid);

  const serverPid = process.pid;
  const isMossRelated = (pid: number): boolean => {
    let cur = pid;
    let guard = 0;
    while (cur > 0 && guard++ < 64) {
      if (cur === serverPid) return true;
      const parent = pidMap.get(cur);
      if (!parent || parent === cur) return false;
      cur = parent;
    }
    return false;
  };

  // CPU 百分比：Windows 用 cumulative cpuSec 差值；Unix 直接取 pcpu
  const elapsedSec = prevProcAt > 0 ? Math.max(0.001, (now - prevProcAt) / 1000) : 0;
  const nextCpu = new Map<number, number>();
  let mossPercent = 0;
  let mossBytes = 0;

  const processes: MossProcessInfo[] = raw.map((p) => {
    let cpuPercent = 0;
    const pcpuDirect = (p as RawProcess & { pcpu?: number }).pcpu;
    if (typeof pcpuDirect === 'number') {
      cpuPercent = pcpuDirect / Math.max(1, cores);
    } else if (p.cpuSec !== null) {
      nextCpu.set(p.pid, p.cpuSec);
      const prev = prevProcCpu.get(p.pid);
      if (prev !== undefined && elapsedSec > 0) {
        cpuPercent = ((p.cpuSec - prev) / elapsedSec / Math.max(1, cores)) * 100;
      }
    }
    cpuPercent = Math.max(0, Math.round(cpuPercent * 10) / 10);
    const isMoss = isMossRelated(p.pid);
    let group: MossProcessGroup = 'other';
    if (isMoss) {
      if (p.pid === serverPid) group = 'server';
      else if (SHELL_NAMES.has(p.name.toLowerCase())) group = 'terminal';
      else group = 'child';
      mossPercent += cpuPercent;
      mossBytes += p.rssBytes;
    }
    return { pid: p.pid, ppid: p.ppid, name: p.name, cpuPercent, rssBytes: p.rssBytes, isMoss, group };
  });

  prevProcCpu = nextCpu;
  prevProcAt = now;
  return {
    processes,
    mossPercent: Math.round(mossPercent * 10) / 10,
    mossBytes,
  };
}

// ============================================================================
// 磁盘（系统盘容量 + ~/.moss 分类占用；目录遍历异步化，绝不阻塞事件循环）
// ============================================================================

function driveCapacity(p: string): { totalBytes: number; freeBytes: number } {
  try {
    if (typeof statfsSync !== 'function') return { totalBytes: 0, freeBytes: 0 };
    const s = statfsSync(p);
    return { totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail };
  } catch {
    return { totalBytes: 0, freeBytes: 0 };
  }
}

const DIR_SKIP = new Set(['node_modules', '.git', '__pycache__', '.cache']);
const DIR_MAX_DEPTH = 6;
const DIR_MAX_VISIT = 6000;
const DIR_TIMEOUT_MS = 1500;

/** 递归求目录字节数（深度/节点/时间三重上限，超限即停并返回已累计值） */
async function dirSize(dir: string): Promise<number> {
  const deadline = Date.now() + DIR_TIMEOUT_MS;
  let visited = 0;
  const walk = async (d: string, depth: number): Promise<number> => {
    if (depth > DIR_MAX_DEPTH || visited > DIR_MAX_VISIT || Date.now() > deadline) return 0;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return 0;
    }
    let total = 0;
    for (const e of entries) {
      if (visited++ > DIR_MAX_VISIT || Date.now() > deadline) break;
      if (DIR_SKIP.has(e.name.toLowerCase())) continue;
      const full = join(d, e.name);
      try {
        if (e.isDirectory()) total += await walk(full, depth + 1);
        else if (e.isFile()) total += (await stat(full)).size;
      } catch {
        /* 单个条目失败忽略 */
      }
    }
    return total;
  };
  return walk(dir, 0);
}

const DISK_CATEGORIES: Array<{ key: string; rel: string }> = [
  { key: 'logs', rel: 'logs' },
  { key: 'memory', rel: 'memory' },
  { key: 'live', rel: 'live' },
  { key: 'tasks', rel: 'tasks' },
  { key: 'todo', rel: 'todo' },
  { key: 'terminals', rel: 'terminals' },
];

async function sampleDisk(env: Environment): Promise<ResourceSnapshot['disk']> {
  const driveRoot = env.isWindows ? `${process.env.SystemDrive ?? 'C:'}\\` : '/';
  const cap = driveCapacity(driveRoot);
  const usedPercent = cap.totalBytes > 0
    ? Math.round(((cap.totalBytes - cap.freeBytes) / cap.totalBytes) * 1000) / 10
    : 0;

  const known = await Promise.all(
    DISK_CATEGORIES.map(async (c) => ({ key: c.key, bytes: await dirSize(join(env.dataDir, c.rel)) })),
  );
  const knownTotal = known.reduce((sum, c) => sum + c.bytes, 0);
  const totalData = await dirSize(env.dataDir);
  const categories = [...known, { key: 'other', bytes: Math.max(0, totalData - knownTotal) }];

  return {
    drive: driveRoot,
    totalBytes: cap.totalBytes,
    freeBytes: cap.freeBytes,
    usedPercent,
    categories,
  };
}

/** 磁盘分类变化慢：30s 内复用，避免每次采样重复遍历 */
const DISK_TTL_MS = 30000;
let diskCache: { at: number; value: ResourceSnapshot['disk'] } | null = null;

async function sampleDiskCached(env: Environment): Promise<ResourceSnapshot['disk']> {
  if (diskCache && Date.now() - diskCache.at < DISK_TTL_MS) return diskCache.value;
  const value = await sampleDisk(env);
  diskCache = { at: Date.now(), value };
  return value;
}

// ============================================================================
// 网络（速率由两次采样差值得出）
// ============================================================================

let prevNet = new Map<string, { rx: number; tx: number }>();
let prevNetAt = 0;

function sampleNetwork(counters: RawNet[], now: number): ResourceSnapshot['network'] {
  const elapsedSec = prevNetAt > 0 ? Math.max(0.001, (now - prevNetAt) / 1000) : 0;
  const next = new Map<string, { rx: number; tx: number }>();
  const interfaces: ResourceSnapshot['network']['interfaces'] = [];
  const addrByName = networkInterfaces();
  for (const c of counters) {
    if (!c.name) continue;
    next.set(c.name, { rx: c.rx, tx: c.tx });
    const prev = prevNet.get(c.name);
    const rxRate = prev && elapsedSec > 0 ? Math.max(0, (c.rx - prev.rx) / elapsedSec) : 0;
    const txRate = prev && elapsedSec > 0 ? Math.max(0, (c.tx - prev.tx) / elapsedSec) : 0;
    let address: string | undefined;
    for (const [iname, infos] of Object.entries(addrByName)) {
      if (iname.toLowerCase() !== c.name.toLowerCase()) continue;
      const v4 = infos?.find((i) => i.family === 'IPv4' && !i.internal);
      if (v4) { address = v4.address; break; }
    }
    interfaces.push({
      name: c.name,
      ...(address ? { address } : {}),
      rxBytes: c.rx,
      txBytes: c.tx,
      rxRate: Math.round(rxRate),
      txRate: Math.round(txRate),
    });
  }
  prevNet = next;
  prevNetAt = now;
  return { interfaces };
}

// ============================================================================
// 快照：内存直返 + 后台全量采样
// ============================================================================

/**
 * 全量采样（进程/网络/磁盘）的新鲜窗口。
 * 全量采样在 Windows 上会拉起 PowerShell + CIM 查询，成本高：
 * 前端只在概览页每 15s、CPU/网络标签页每 5s 请求全量；这里取略小于 5s，
 * 既让标签页的 5s 请求能拿到新数据，又不会出现更快的循环。
 * 1s 级的 CPU/内存走 buildFastSnapshot 的轻量路径，不受此阈值影响。
 */
const HEAVY_STALE_MS = 4000;
/** force=1 的最小触发间隔：防止快速切标签/连续点击造成连续全量采样 */
const HEAVY_FORCE_MIN_INTERVAL_MS = 3000;
let latestSnapshot: ResourceSnapshot | null = null;
let latestAt = 0;
let inflight: Promise<unknown> | null = null;

async function fullSample(env: Environment): Promise<ResourceSnapshot> {
  const now = Date.now();
  const cpuSample = sampleCpu();
  const total = totalmem();
  const free = freemem();
  const usedBytes = Math.max(0, total - free);

  const [stats, disk] = await Promise.all([
    readStats(env).catch((): RawStats => ({ processes: [], net: [] })),
    sampleDiskCached(env).catch((): ResourceSnapshot['disk'] => ({
      drive: env.isWindows ? `${process.env.SystemDrive ?? 'C:'}\\` : '/',
      totalBytes: 0,
      freeBytes: 0,
      usedPercent: 0,
      categories: [],
    })),
  ]);

  let processes: MossProcessInfo[] = [];
  let mossPercent = 0;
  let mossBytes = 0;
  try {
    const agg = collectProcesses(env, stats.processes, cpuSample.cores, now);
    processes = agg.processes;
    mossPercent = agg.mossPercent;
    mossBytes = agg.mossBytes;
  } catch {
    /* 进程聚合失败：降级为空 */
  }

  let network: ResourceSnapshot['network'] = { interfaces: [] };
  try {
    network = sampleNetwork(stats.net, now);
  } catch {
    /* 网络采集失败：降级为空 */
  }

  const snapshot: ResourceSnapshot = {
    cpu: { ...cpuSample, mossPercent },
    memory: {
      totalBytes: total,
      usedBytes,
      usedPercent: total > 0 ? Math.round((usedBytes / total) * 1000) / 10 : 0,
      mossBytes,
    },
    disk,
    network,
    moss: { pid: process.pid, processes },
    sampledAt: new Date().toISOString(),
  };
  latestSnapshot = snapshot;
  // TTL 从采样「完成」时刻算起：采样本身可能耗时 1~2s，
  // 若用开头的 now，慢采样一完成就被判过期 → 连续重采样（CPU 规律性尖峰根因）。
  latestAt = Date.now();
  return snapshot;
}

/** 毫秒级快速快照：CPU/内存/磁盘容量同步获取，其余复用上一份完整快照 */
function buildFastSnapshot(env: Environment): ResourceSnapshot {
  const cpuSample = sampleCpu();
  const total = totalmem();
  const free = freemem();
  const usedBytes = Math.max(0, total - free);
  const driveRoot = env.isWindows ? `${process.env.SystemDrive ?? 'C:'}\\` : '/';
  const cap = driveCapacity(driveRoot);
  const disk = latestSnapshot?.disk ?? {
    drive: driveRoot,
    totalBytes: cap.totalBytes,
    freeBytes: cap.freeBytes,
    usedPercent: cap.totalBytes > 0
      ? Math.round(((cap.totalBytes - cap.freeBytes) / cap.totalBytes) * 1000) / 10
      : 0,
    categories: [] as Array<{ key: string; bytes: number }>,
  };
  return {
    cpu: { ...cpuSample, mossPercent: latestSnapshot?.cpu.mossPercent ?? 0 },
    memory: {
      totalBytes: total,
      usedBytes,
      usedPercent: total > 0 ? Math.round((usedBytes / total) * 1000) / 10 : 0,
      mossBytes: latestSnapshot?.memory.mossBytes ?? 0,
    },
    disk,
    network: latestSnapshot?.network ?? { interfaces: [] },
    moss: latestSnapshot?.moss ?? { pid: process.pid, processes: [] },
    sampledAt: new Date().toISOString(),
  };
}

/** 后台全量采样（inflight 去重，不阻塞调用方） */
function refreshResourceSnapshot(env: Environment): void {
  if (inflight !== null) return;
  inflight = fullSample(env)
    .catch(() => {
      /* 采样失败保留旧快照，下次请求重试 */
    })
    .finally(() => {
      inflight = null;
    });
}

/** 服务启动预热（server/index.ts 调用） */
export function warmResourceSnapshot(env: Environment): void {
  refreshResourceSnapshot(env);
}

/** AI 解读等场景：等待一次全量采样并返回最新快照 */
export async function sampleResourceSnapshot(env: Environment): Promise<ResourceSnapshot> {
  if (inflight !== null) {
    await inflight;
    if (latestSnapshot) return latestSnapshot;
  }
  if (latestSnapshot && Date.now() - latestAt < 1000) return latestSnapshot;
  return fullSample(env);
}

/**
 * GET /api/system-monitor/snapshot
 * - ?light=1：只返回 CPU/内存（1s 实时折线用），绝不触发全量采样；
 * - 默认：全量快照（进程/网络/磁盘），按 HEAVY_STALE_MS 低频后台刷新；
 * - &force=1：请求一次立即全量刷新（受 HEAVY_FORCE_MIN_INTERVAL_MS 兜底）。
 * 所有路径的 CPU/内存都由 buildFastSnapshot 现采，成本与请求次数无关。
 */
export function createSystemMonitorSnapshotHandler(env: Environment): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const light = url.searchParams.get('light') === '1';
      const force = url.searchParams.get('force') === '1';
      if (!light) {
        if (force) {
          if (Date.now() - latestAt >= HEAVY_FORCE_MIN_INTERVAL_MS) refreshResourceSnapshot(env);
        } else if (!latestSnapshot || Date.now() - latestAt > HEAVY_STALE_MS) {
          refreshResourceSnapshot(env);
        }
      }
      const snapshot = buildFastSnapshot(env);
      if (light) {
        return {
          status: 200,
          body: { cpu: snapshot.cpu, memory: snapshot.memory, sampledAt: snapshot.sampledAt },
        };
      }
      return { status: 200, body: snapshot };
    } catch {
      // 极端兜底：任何意外都不让接口 5xx
      return {
        status: 200,
        body: {
          cpu: { usagePercent: 0, cores: 0, model: 'Unknown', mossPercent: 0 },
          memory: { totalBytes: 0, usedBytes: 0, usedPercent: 0, mossBytes: 0 },
          disk: { drive: '', totalBytes: 0, freeBytes: 0, usedPercent: 0, categories: [] },
          network: { interfaces: [] },
          moss: { pid: process.pid, processes: [] },
          sampledAt: new Date().toISOString(),
        } satisfies ResourceSnapshot,
      };
    }
  };
}
