// src/modules/server/routes/system-monitor.ts
// 系统资源监控：GET /api/system-monitor/snapshot
// 采集范围：系统总量 + MOSS 自身占用（进程树）。所有采集点独立 try/catch 降级，
// 任一失败只影响对应字段（置 0/空），接口永不 5xx。不引入任何新依赖。

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { Environment } from '../../../core/types';
import { cpus, totalmem, freemem, networkInterfaces } from 'node:os';
import { readdirSync, statSync, statfsSync } from 'node:fs';
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

/** ConvertTo-Json 输出可能是对象或数组（单项时退化为对象）→ 统一为数组 */
function parseJsonArray(text: string | null): Array<Record<string, unknown>> {
  if (!text) return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const raw: unknown = JSON.parse(trimmed);
    if (Array.isArray(raw)) return raw.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
    if (raw && typeof raw === 'object') return [raw as Record<string, unknown>];
    return [];
  } catch {
    return [];
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
// 进程（Windows: PowerShell；Unix: ps）
// ============================================================================

interface RawProcess {
  pid: number;
  ppid: number;
  name: string;
  rssBytes: number;
  cpuSec: number | null;
}

let prevProcCpu = new Map<number, number>();
let prevProcAt = 0;

const PS_UTF8 = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';

const PS_PROCESS =
  PS_UTF8 +
  '$c=@{}; ' +
  'Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $c[[int]$_.Id]=[double]$_.CPU }; ' +
  'Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name; rss=[long]$_.WorkingSetSize; cpu=[double]($c[[int]$_.ProcessId]) } } | ConvertTo-Json -Compress';

async function readProcesses(env: Environment): Promise<RawProcess[]> {
  if (env.isWindows) {
    const out = await runCommand([
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      PS_PROCESS,
    ]);
    const arr = parseJsonArray(out);
    return arr.map((p) => ({
      pid: toNum(p.pid),
      ppid: toNum(p.ppid),
      name: typeof p.name === 'string' ? p.name : '',
      rssBytes: toNum(p.rss),
      cpuSec: typeof p.cpu === 'number' && Number.isFinite(p.cpu) ? p.cpu : null,
    }));
  }
  const out = await runCommand(['ps', '-axo', 'pid=,ppid=,pcpu=,rss=,comm=']);
  if (!out) return [];
  const rows: RawProcess[] = [];
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
      // 占位：由下方计算时替换
    });
    // 记录 pcpu 到临时字段
    (rows[rows.length - 1] as RawProcess & { pcpu?: number }).pcpu = Number.isFinite(pcpu) ? pcpu : 0;
  }
  return rows;
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
// 磁盘（系统盘容量 + ~/.moss 分类占用）
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
function dirSize(dir: string): number {
  const deadline = Date.now() + DIR_TIMEOUT_MS;
  let visited = 0;
  const walk = (d: string, depth: number): number => {
    if (depth > DIR_MAX_DEPTH || visited > DIR_MAX_VISIT || Date.now() > deadline) return 0;
    let total = 0;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      if (visited++ > DIR_MAX_VISIT || Date.now() > deadline) break;
      if (DIR_SKIP.has(e.name.toLowerCase())) continue;
      const full = join(d, e.name);
      try {
        if (e.isDirectory()) total += walk(full, depth + 1);
        else if (e.isFile()) total += statSync(full).size;
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
  { key: 'file-index', rel: 'file-index' },
  { key: 'memory', rel: 'memory' },
  { key: 'live', rel: 'live' },
  { key: 'tasks', rel: 'tasks' },
  { key: 'todo', rel: 'todo' },
  { key: 'terminals', rel: 'terminals' },
];

function sampleDisk(env: Environment): ResourceSnapshot['disk'] {
  const driveRoot = env.isWindows ? `${process.env.SystemDrive ?? 'C:'}\\` : '/';
  const cap = driveCapacity(driveRoot);
  const usedPercent = cap.totalBytes > 0
    ? Math.round(((cap.totalBytes - cap.freeBytes) / cap.totalBytes) * 1000) / 10
    : 0;

  const categories: Array<{ key: string; bytes: number }> = [];
  let knownTotal = 0;
  for (const c of DISK_CATEGORIES) {
    const bytes = dirSize(join(env.dataDir, c.rel));
    knownTotal += bytes;
    categories.push({ key: c.key, bytes });
  }
  const totalData = dirSize(env.dataDir);
  categories.push({ key: 'other', bytes: Math.max(0, totalData - knownTotal) });

  return {
    drive: driveRoot,
    totalBytes: cap.totalBytes,
    freeBytes: cap.freeBytes,
    usedPercent,
    categories,
  };
}

// ============================================================================
// 网络（Windows: Get-NetAdapterStatistics；Linux: /proc/net/dev；其余降级）
// ============================================================================

let prevNet = new Map<string, { rx: number; tx: number }>();
let prevNetAt = 0;

const PS_NET = `${PS_UTF8}Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress`;

interface RawNet { name: string; rx: number; tx: number }

async function readNetCounters(env: Environment): Promise<RawNet[]> {
  if (env.isWindows) {
    const out = await runCommand(['powershell', '-NoProfile', '-NonInteractive', '-Command', PS_NET]);
    return parseJsonArray(out).map((r) => ({
      name: typeof r.Name === 'string' ? r.Name : (typeof r.name === 'string' ? r.name : ''),
      rx: toNum(r.ReceivedBytes),
      tx: toNum(r.SentBytes),
    }));
  }
  // Linux: 解析 /proc/net/dev
  const out = await runCommand(['cat', '/proc/net/dev']);
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

function sampleNetwork(env: Environment, counters: RawNet[], now: number): ResourceSnapshot['network'] {
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
// 快照聚合（< 800ms 直接返回缓存，减轻 PowerShell 轮询压力）
// ============================================================================

let cachedSnapshot: ResourceSnapshot | null = null;
let cachedAt = 0;
const SNAPSHOT_CACHE_MS = 800;

export async function sampleResourceSnapshot(env: Environment): Promise<ResourceSnapshot> {
  const now = Date.now();
  if (cachedSnapshot && now - cachedAt < SNAPSHOT_CACHE_MS) return cachedSnapshot;

  const cpuSample = sampleCpu();
  const total = totalmem();
  const free = freemem();
  const usedBytes = Math.max(0, total - free);

  let processes: MossProcessInfo[] = [];
  let mossPercent = 0;
  let mossBytes = 0;
  try {
    const raw = await readProcesses(env);
    const agg = collectProcesses(env, raw, cpuSample.cores, now);
    processes = agg.processes;
    mossPercent = agg.mossPercent;
    mossBytes = agg.mossBytes;
  } catch {
    /* 进程采集失败：降级为空 */
  }

  let network: ResourceSnapshot['network'] = { interfaces: [] };
  try {
    const counters = await readNetCounters(env);
    network = sampleNetwork(env, counters, now);
  } catch {
    /* 网络采集失败：降级为空 */
  }

  const disk = sampleDisk(env);

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
  cachedSnapshot = snapshot;
  cachedAt = now;
  return snapshot;
}

/** GET /api/system-monitor/snapshot */
export function createSystemMonitorSnapshotHandler(env: Environment): RouteHandler {
  return async (_req: HttpRequest): Promise<HttpResponse> => {
    try {
      const snapshot = await sampleResourceSnapshot(env);
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
