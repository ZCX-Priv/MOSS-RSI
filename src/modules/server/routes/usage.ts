// src/modules/server/routes/usage.ts
// 设置-概览「用量」聚合：GET /api/usage/overview?range=today|7d|30d|all
// 数据来源：只读扫描 ~/.moss/tasks/<dir>/<sessionId>.json（排除 task.json 元信息），
// 提取 tokens / 工具调用 / 命令执行 / 技能加载 / 活跃日，跨会话聚合。
// 精度口径：
//   - tokens 优先 contextTelemetry.usageTotals（本次升级后精确累计）
//   - 历史会话回退 lastRunStats（每会话最近一轮）→ lastUsage（单轮）
//   - 按天 tokens 仅 cacheHits 样本带真实时间戳（近 50 轮）；无样本时归入会话 updatedAt 当天
// 性能：进程内 mtime/size 缓存 + ~/.moss/cache/usage-index.json 磁盘索引 + 5s 聚合 TTL。
// 接口永不 5xx（任何采集失败按空数据返回）。

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { Environment } from '../../../core/types';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

// ============================================================================
// 对外类型
// ============================================================================

export type UsageRange = 'today' | '7d' | '30d' | 'all';

export interface UsageTallyStat {
  name: string;
  count: number;
  /** 出现过该名称的会话数 */
  sessions: number;
  /** 最近一次出现时间（ISO）；无时间戳为 '' */
  lastAt: string;
}

export interface UsageSessionRow {
  id: string;
  title: string;
  groupId: string;
  groupName: string;
  hidden: boolean;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  tokens: { prompt: number; cached: number; completion: number; total: number };
  cacheHitRate: number | null;
  toolCalls: number;
  skillLoads: number;
  commandRuns: number;
  lastUser: string;
  /** 会话 Token 构成（环形图数据源） */
  parts: Array<{ key: 'cached' | 'prompt' | 'completion'; value: number }>;
  /** 该会话出现过的名称（前端本地筛选） */
  tools: string[];
  skills: string[];
  commands: string[];
  /** 有活动的自然日（YYYY-MM-DD；热力图按天筛选会话） */
  activeDays: string[];
}

export interface UsageOverview {
  range: UsageRange;
  generatedAt: string;
  totals: {
    sessions: number;
    sessionsTotal: number;
    turns: number;
    tokens: { prompt: number; cached: number; completion: number; total: number };
    cacheHitRate: number | null;
    toolCalls: number;
    skillLoads: number;
    commandRuns: number;
    /** 各会话最近一轮 run 的耗时/速度汇总（口径：仅最近一轮） */
    llmMs: number;
    toolMs: number;
    outputTps: number | null;
  };
  /** 近 56 天连续序列（热力图 8 周；7 天图由前端裁切） */
  days: Array<{ day: string; tokens: number; sessions: number; toolCalls: number }>;
  /** 当前统计范围的逐日序列（两张趋势图数据源） */
  series: Array<{
    day: string;
    requests: number;
    cachedTokens: number;
    promptTokens: number;
    completionTokens: number;
  }>;
  skills: UsageTallyStat[];
  tools: UsageTallyStat[];
  commands: UsageTallyStat[];
  sessions: UsageSessionRow[];
}

// ============================================================================
// 内部结构
// ============================================================================

interface UsageEntry {
  id: string;
  dir: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  usage: { prompt: number; cached: number; completion: number; requests: number };
  turns: number;
  toolCalls: Record<string, number>;
  commands: Record<string, number>;
  skills: Record<string, number>;
  toolLastAt: Record<string, string>;
  cmdLastAt: Record<string, string>;
  skillLastAt: Record<string, string>;
  dayTokens: Record<string, number>;
  /** 按日输入（含缓存命中） */
  dayPrompt: Record<string, number>;
  /** 按日缓存命中输入 */
  dayCached: Record<string, number>;
  /** 按日输出 */
  dayCompletion: Record<string, number>;
  /** 按日模型请求次数 */
  dayRequests: Record<string, number>;
  dayActive: string[];
  dayToolCalls: Record<string, number>;
  lastUser: string;
  llmMs: number;
  toolMs: number;
  decodeMs: number;
  outputTokens: number;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  entry: UsageEntry;
}

interface DiskIndex {
  version: number;
  entries: Record<string, CachedFile>;
}

interface TaskMeta {
  title: string;
  groupId: string;
  groupName: string;
  hidden: boolean;
}

const INDEX_VERSION = 5;
const AGGREGATE_TTL_MS = 5000;
const SCAN_CONCURRENCY = 4;
const DAYS_WINDOW = 56;
const LAST_USER_MAX = 120;

/** 进程内文件缓存（绝对路径 → 轻量统计） */
const fileCache = new Map<string, CachedFile>();
/** 磁盘索引是否已加载 */
let diskIndexLoaded = false;
/** 磁盘索引待写回标记 */
let diskDirty = false;
/** 聚合结果缓存（四个 range 一次扫描后全部预计算，切范围毫秒返回） */
const aggregateCache = new Map<UsageRange, { at: number; value: UsageOverview }>();
/** 后台重建去重 */
let rebuilding: Promise<void> | null = null;

// ============================================================================
// JSON 取值工具（unknown 安全收窄，不使用 any）
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ============================================================================
// 时间工具（本地时区自然日）
// ============================================================================

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** ISO 时间 → 本地自然日键 YYYY-MM-DD；非法返回 null */
function dayKeyOf(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dayKeyOfDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 范围起点（本地自然日 0 点毫秒；all 返回 null） */
function rangeStartOf(range: UsageRange): number | null {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === 'today') return todayStart;
  if (range === '7d') return todayStart - 6 * 86_400_000;
  if (range === '30d') return todayStart - 29 * 86_400_000;
  return null;
}

// ============================================================================
// 名称提取
// ============================================================================

/** shell 内建/占位命令：不作为「程序」统计 */
const SHELL_BUILTINS = new Set([
  'cd', 'set', 'export', 'pwd', 'echo', 'pushd', 'popd', 'if', 'for', 'while', 'foreach', 'rem', 'cls', 'clear', 'source',
]);

/**
 * 命令主程序名：按 ; && || | 换行 分段，取第一个非 shell 内建/非变量赋值的 token。
 * 例：`cd X; python a.py` → python；`& "C:\bin\git.exe" status` → git；纯 cd 命令 → null。
 */
function programOf(command: string): string | null {
  for (const segment of command.split(/[\r\n;]+|&&|\|\||\|/)) {
    const head = segment.trim().split(/\s+/).find((token) => token !== '');
    if (!head) continue;
    let name = head.replace(/^["']+|["']+$/g, '');
    name = basename(name.replace(/\\/g, '/'));
    name = name.replace(/\.(exe|cmd|bat|ps1|com)$/i, '');
    if (name === '' || name.startsWith('$') || name.startsWith('@') || name === '&' || name === '.') continue;
    if (SHELL_BUILTINS.has(name.toLowerCase())) continue;
    return name;
  }
  return null;
}

/** 技能名：metadata.skillName → '# Active Skill: x' → 会话当前 skill */
function skillNameOf(msg: Record<string, unknown>, activeSkill: string | undefined): string {
  const meta = asRecord(msg.metadata);
  const fromMeta = asString(meta?.skillName);
  if (fromMeta) return fromMeta;
  const content = asString(msg.content) ?? '';
  const matched = /^# Active Skill: (.+)$/m.exec(content)?.[1]?.trim();
  if (matched) return matched;
  return activeSkill ?? 'unknown';
}

/** 用户消息（排除锚定/系统类消息） */
function isUserMessage(msg: Record<string, unknown>): boolean {
  if (msg.role !== 'user') return false;
  const name = asString(msg.name);
  return name === undefined;
}

// ============================================================================
// 单文件解析
// ============================================================================

function extractEntry(raw: unknown, dir: string, fallbackUpdatedAt: string): UsageEntry | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  if (!id) return null;
  const createdAt = asString(rec.createdAt) ?? fallbackUpdatedAt;
  const updatedAt = asString(rec.updatedAt) ?? fallbackUpdatedAt;
  const telemetry = asRecord(rec.contextTelemetry);
  const totals = asRecord(telemetry?.usageTotals);
  const lastUsage = asRecord(telemetry?.lastUsage);
  const lastRun = asRecord(rec.lastRunStats);

  // tokens：精确累计 → 最近一轮 run → 最近单轮
  let prompt = 0;
  let cached = 0;
  let completion = 0;
  let requests = 0;
  if (totals) {
    prompt = asNumber(totals.promptTokens) ?? 0;
    cached = asNumber(totals.cachedTokens) ?? 0;
    completion = asNumber(totals.completionTokens) ?? 0;
    requests = asNumber(totals.requests) ?? 0;
  } else if (lastRun) {
    prompt = asNumber(lastRun.inputTokens) ?? 0;
    cached = asNumber(lastRun.cachedTokens) ?? 0;
    completion = asNumber(lastRun.outputTokens) ?? 0;
    requests = asNumber(lastRun.turns) ?? 0;
  } else if (lastUsage) {
    prompt = asNumber(lastUsage.promptTokens) ?? 0;
    cached = asNumber(lastUsage.cachedTokens) ?? 0;
    completion = asNumber(lastUsage.completionTokens) ?? 0;
    requests = 1;
  }

  const entry: UsageEntry = {
    id,
    dir,
    cwd: asString(rec.lastCwd) ?? '',
    createdAt,
    updatedAt,
    usage: {
      prompt: Math.max(0, prompt),
      cached: Math.max(0, Math.min(cached, Math.max(0, prompt))),
      completion: Math.max(0, completion),
      requests: Math.max(0, requests),
    },
    turns: 0,
    toolCalls: {},
    commands: {},
    skills: {},
    toolLastAt: {},
    cmdLastAt: {},
    skillLastAt: {},
    dayTokens: {},
    dayPrompt: {},
    dayCached: {},
    dayCompletion: {},
    dayRequests: {},
    dayActive: [],
    dayToolCalls: {},
    lastUser: '',
    llmMs: Math.max(0, asNumber(lastRun?.llmMs) ?? 0),
    toolMs: Math.max(0, asNumber(lastRun?.toolMs) ?? 0),
    decodeMs: Math.max(0, asNumber(lastRun?.decodeMs) ?? 0),
    outputTokens: Math.max(0, asNumber(lastRun?.outputTokens) ?? 0),
  };

  const activeSkill = asString(asRecord(rec.activeSkill)?.name);
  const activeDays = new Set<string>();
  const bump = (map: Record<string, number>, key: string, delta = 1): void => {
    map[key] = (map[key] ?? 0) + delta;
  };
  const touch = (map: Record<string, string>, key: string, at: string): void => {
    const prev = map[key];
    if (!prev || at > prev) map[key] = at;
  };

  for (const item of asArray(rec.messages)) {
    const msg = asRecord(item);
    if (!msg) continue;
    if (asString(msg.deletedAt) !== undefined) continue;
    if (msg.compacted === true) continue;
    const at = asString(msg.timestamp) ?? updatedAt;
    const day = dayKeyOf(at);
    if (day) activeDays.add(day);
    if (isUserMessage(msg)) {
      entry.turns += 1;
      const text = (asString(msg.content) ?? '').replace(/\s+/g, ' ').trim();
      if (text !== '') entry.lastUser = text.slice(0, LAST_USER_MAX);
    }
    if (msg.role === 'system' && msg.name === 'skill-inject') {
      const name = skillNameOf(msg, activeSkill);
      bump(entry.skills, name);
      touch(entry.skillLastAt, name, at);
    }
    const calls = asArray(msg.toolCalls);
    if (calls.length > 0 && day) {
      entry.dayToolCalls[day] = (entry.dayToolCalls[day] ?? 0) + calls.length;
    }
    for (const callItem of calls) {
      const call = asRecord(callItem);
      const name = asString(call?.name);
      if (!name) continue;
      bump(entry.toolCalls, name);
      touch(entry.toolLastAt, name, at);
      if (name === 'terminal') {
        const argsRaw = asString(call?.arguments);
        let command = '';
        if (argsRaw) {
          try {
            command = asString(asRecord(JSON.parse(argsRaw))?.command) ?? '';
          } catch {
            command = '';
          }
        }
        if (command !== '') {
          const program = programOf(command);
          if (program !== null) {
            bump(entry.commands, program);
            touch(entry.cmdLastAt, program, at);
          }
        }
      }
    }
  }

  entry.dayActive = [...activeDays];

  // 按日用量：新遥测 usageDaily 精确累加；历史会话回退 cacheHits 样本。
  // 余量（升级前历史 / 无逐日来源的输出 tokens）统一归入 updatedAt 当天，保证与总量守恒。
  const dailyRecord = asRecord(telemetry?.usageDaily);
  if (dailyRecord) {
    for (const [day, value] of Object.entries(dailyRecord)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const rec = asRecord(value);
      if (!rec) continue;
      bump(entry.dayPrompt, day, Math.max(0, asNumber(rec.promptTokens) ?? 0));
      bump(entry.dayCached, day, Math.max(0, asNumber(rec.cachedTokens) ?? 0));
      bump(entry.dayCompletion, day, Math.max(0, asNumber(rec.completionTokens) ?? 0));
      bump(entry.dayRequests, day, Math.max(0, asNumber(rec.requests) ?? 0));
    }
  } else {
    for (const sampleItem of asArray(telemetry?.cacheHits)) {
      const sample = asRecord(sampleItem);
      const day = dayKeyOf(asString(sample?.at));
      if (!day) continue;
      const prompt = Math.max(0, asNumber(sample?.promptTokens) ?? 0);
      const cached = Math.max(0, Math.min(asNumber(sample?.cachedTokens) ?? 0, prompt));
      bump(entry.dayPrompt, day, prompt);
      bump(entry.dayCached, day, cached);
      bump(entry.dayRequests, day, 1);
    }
  }

  const sumOf = (map: Record<string, number>): number =>
    Object.values(map).reduce((sum, value) => sum + value, 0);
  const restPrompt = Math.max(0, entry.usage.prompt - sumOf(entry.dayPrompt));
  const restCached = Math.max(0, Math.min(restPrompt, entry.usage.cached - sumOf(entry.dayCached)));
  const restCompletion = Math.max(0, entry.usage.completion - sumOf(entry.dayCompletion));
  const restRequests = Math.max(0, entry.usage.requests - sumOf(entry.dayRequests));
  const restDay = dayKeyOf(updatedAt);
  if (restDay !== null) {
    if (restPrompt > 0) bump(entry.dayPrompt, restDay, restPrompt);
    if (restCached > 0) bump(entry.dayCached, restDay, restCached);
    if (restCompletion > 0) bump(entry.dayCompletion, restDay, restCompletion);
    if (restRequests > 0) bump(entry.dayRequests, restDay, restRequests);
  }

  // 热力图沿用 dayTokens：每日 prompt + completion
  const tokenDays = new Set([...Object.keys(entry.dayPrompt), ...Object.keys(entry.dayCompletion)]);
  for (const day of tokenDays) {
    entry.dayTokens[day] = (entry.dayPrompt[day] ?? 0) + (entry.dayCompletion[day] ?? 0);
  }

  return entry;
}

// ============================================================================
// 索引：磁盘加载 / 扫描
// ============================================================================

function indexPathOf(env: Environment): string {
  return join(env.dataDir, 'cache', 'usage-index.json');
}

async function loadDiskIndex(env: Environment): Promise<void> {
  if (diskIndexLoaded) return;
  diskIndexLoaded = true;
  try {
    const raw = await readFile(indexPathOf(env), 'utf8');
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed || asNumber(parsed.version) !== INDEX_VERSION) return;
    const entries = asRecord(parsed.entries);
    if (!entries) return;
    for (const [path, value] of Object.entries(entries)) {
      const cached = asRecord(value);
      const entry = asRecord(cached?.entry) as UsageEntry | null;
      const mtimeMs = asNumber(cached?.mtimeMs);
      const size = asNumber(cached?.size);
      if (!entry || mtimeMs === undefined || size === undefined) continue;
      fileCache.set(path, { mtimeMs, size, entry });
    }
  } catch {
    // 索引缺失/损坏：按冷启动处理
  }
}

async function persistDiskIndex(env: Environment): Promise<void> {
  if (!diskDirty) return;
  diskDirty = false;
  try {
    const entries: Record<string, CachedFile> = {};
    for (const [path, cached] of fileCache) entries[path] = cached;
    const payload: DiskIndex = { version: INDEX_VERSION, entries };
    await mkdir(join(env.dataDir, 'cache'), { recursive: true });
    await writeFile(indexPathOf(env), JSON.stringify(payload), 'utf8');
  } catch {
    // 写回失败不阻塞请求（下次扫描重建）
  }
}

/** 递归列出会话文件（排除 task.json 元信息） */
async function listSessionFiles(tasksDir: string): Promise<Array<{ path: string; dir: string }>> {
  const out: Array<{ path: string; dir: string }> = [];
  const walk = async (dirAbs: string): Promise<void> => {
    const items = await readdir(dirAbs, { withFileTypes: true }).catch(() => null);
    if (items === null) return;
    for (const item of items) {
      const abs = join(dirAbs, item.name);
      if (item.isDirectory()) {
        await walk(abs);
      } else if (item.isFile() && item.name.endsWith('.json') && item.name !== 'task.json') {
        out.push({ path: abs, dir: relative(tasksDir, dirAbs).replace(/\\/g, '/') });
      }
    }
  };
  await walk(tasksDir);
  return out;
}

async function readJsonOrNull(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 任务标题/分组元信息（~/.moss/task.json 总管 + 各组 task.json；缺总管时扫描组目录兜底） */
async function loadTaskMeta(env: Environment): Promise<Map<string, TaskMeta>> {
  const tasksDir = join(env.dataDir, 'tasks');
  const map = new Map<string, TaskMeta>();
  const root = asRecord(await readJsonOrNull(join(env.dataDir, 'task.json')));
  const groupIndex = new Map<string, { name: string; dir: string; hidden: boolean }>();
  for (const groupItem of asArray(root?.groups)) {
    const group = asRecord(groupItem);
    const gid = asString(group?.id);
    if (!gid) continue;
    groupIndex.set(gid, {
      name: asString(group?.name) ?? gid,
      dir: asString(group?.dir) ?? gid,
      hidden: group?.hidden === true,
    });
  }
  // 无总管 groups 时兜底：遍历 tasks 一级子目录（目录名即分组键）
  if (groupIndex.size === 0) {
    const entries = await readdir(tasksDir, { withFileTypes: true }).catch(() => null);
    for (const entry of entries ?? []) {
      if (!entry.isDirectory()) continue;
      groupIndex.set(entry.name, { name: entry.name, dir: entry.name, hidden: entry.name === 'subagent' });
    }
  }
  // 根索引兜底（组文件缺失时仍能定位分组）
  const indexRecord = asRecord(root?.index);
  if (indexRecord) {
    for (const [sid, value] of Object.entries(indexRecord)) {
      const row = asRecord(value);
      const gid = asString(row?.groupId);
      if (!gid) continue;
      const group = groupIndex.get(gid);
      map.set(sid, {
        title: '',
        groupId: gid,
        groupName: group?.name ?? gid,
        hidden: group?.hidden === true,
      });
    }
  }
  for (const [gid, group] of groupIndex) {
    const tasksRaw = await readJsonOrNull(join(tasksDir, group.dir, 'task.json'));
    for (const taskItem of asArray(tasksRaw)) {
      const task = asRecord(taskItem);
      const sid = asString(task?.sessionId) ?? asString(task?.id);
      if (!sid) continue;
      map.set(sid, {
        title: asString(task?.title) ?? '',
        groupId: gid,
        groupName: group.name,
        hidden: group.hidden,
      });
    }
  }
  return map;
}

/** 并发受限的 map */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 扫描全部会话文件（mtime/size 命中则复用缓存） */
async function scanEntries(env: Environment): Promise<UsageEntry[]> {
  const tasksDir = join(env.dataDir, 'tasks');
  await loadDiskIndex(env);
  const files = await listSessionFiles(tasksDir);
  const live = new Set<string>();
  const extracted = await mapLimit(files, SCAN_CONCURRENCY, async (file) => {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(file.path);
    } catch {
      return null;
    }
    live.add(file.path);
    const cached = fileCache.get(file.path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.entry;
    const raw = await readJsonOrNull(file.path);
    if (raw === null) return null;
    const entry = extractEntry(raw, file.dir, info.mtime.toISOString());
    if (!entry) return null;
    fileCache.set(file.path, { mtimeMs: info.mtimeMs, size: info.size, entry });
    diskDirty = true;
    return entry;
  });
  // 清理已删除文件
  for (const path of [...fileCache.keys()]) {
    if (!live.has(path)) {
      fileCache.delete(path);
      diskDirty = true;
    }
  }
  void persistDiskIndex(env);
  return extracted.filter((entry): entry is UsageEntry => entry !== null);
}

// ============================================================================
// 聚合
// ============================================================================

function emptyTokens(): { prompt: number; cached: number; completion: number; total: number } {
  return { prompt: 0, cached: 0, completion: 0, total: 0 };
}

function tallyStatsOf(
  counts: Map<string, { count: number; sessions: number; lastAt: string }>,
): UsageTallyStat[] {
  return [...counts.entries()]
    .map(([name, value]) => ({ name, count: value.count, sessions: value.sessions, lastAt: value.lastAt }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** 趋势图窗口：today 1 天 / 7d 7 天 / 30d 30 天 / all 最早活动日至今（最多 365 天） */
function seriesWindowDays(range: UsageRange, now: Date, entries: UsageEntry[]): string[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === 'today') return [dayKeyOfDate(today)];
  const count = range === '7d' ? 7 : range === '30d' ? 30 : 365;
  const start = new Date(today);
  start.setDate(today.getDate() - (count - 1));
  if (range === 'all') {
    let earliestMs: number | null = null;
    for (const entry of entries) {
      for (const day of [...entry.dayActive, ...Object.keys(entry.dayTokens)]) {
        const ms = new Date(`${day}T00:00:00`).getTime();
        if (Number.isFinite(ms) && (earliestMs === null || ms < earliestMs)) earliestMs = ms;
      }
    }
    // 无任何历史活动：只返回今天一个点，避免渲染 365 天空柱
    if (earliestMs === null) return [dayKeyOfDate(today)];
    const earliest = new Date(earliestMs);
    const earliestDay = new Date(earliest.getFullYear(), earliest.getMonth(), earliest.getDate());
    const cap = new Date(today);
    cap.setDate(today.getDate() - 364);
    if (earliestDay > cap) start.setTime(earliestDay.getTime());
  }
  const days: string[] = [];
  for (const cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
    days.push(dayKeyOfDate(cursor));
  }
  return days;
}

/** 当前范围逐日序列（请求次数 + 三段 token 构成） */
function buildSeries(
  entries: UsageEntry[],
  range: UsageRange,
  now: Date,
): UsageOverview['series'] {
  return seriesWindowDays(range, now, entries).map((day) => {
    let requests = 0;
    let cachedTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    for (const entry of entries) {
      requests += entry.dayRequests[day] ?? 0;
      const prompt = entry.dayPrompt[day] ?? 0;
      const cached = Math.max(0, Math.min(entry.dayCached[day] ?? 0, prompt));
      promptTokens += Math.max(0, prompt - cached);
      cachedTokens += cached;
      completionTokens += entry.dayCompletion[day] ?? 0;
    }
    return { day, requests, cachedTokens, promptTokens, completionTokens };
  });
}

function aggregate(
  entries: UsageEntry[],
  meta: Map<string, TaskMeta>,
  range: UsageRange,
  now: Date,
): UsageOverview {
  const startMs = rangeStartOf(range);
  const inRange = startMs === null
    ? entries
    : entries.filter((entry) => {
      const t = new Date(entry.updatedAt).getTime();
      return Number.isFinite(t) && t >= startMs;
    });

  const tokens = emptyTokens();
  let turns = 0;
  let toolCalls = 0;
  let skillLoads = 0;
  let commandRuns = 0;
  let llmMs = 0;
  let toolMs = 0;
  let decodeMs = 0;
  let outputTokens = 0;

  const skills = new Map<string, { count: number; sessions: number; lastAt: string }>();
  const tools = new Map<string, { count: number; sessions: number; lastAt: string }>();
  const commands = new Map<string, { count: number; sessions: number; lastAt: string }>();

  const mergeTally = (
    target: Map<string, { count: number; sessions: number; lastAt: string }>,
    counts: Record<string, number>,
    lastAt: Record<string, string>,
  ): void => {
    for (const [name, count] of Object.entries(counts)) {
      const row = target.get(name) ?? { count: 0, sessions: 0, lastAt: '' };
      row.count += count;
      row.sessions += 1;
      const at = lastAt[name] ?? '';
      if (at > row.lastAt) row.lastAt = at;
      target.set(name, row);
    }
  };

  const rows: UsageSessionRow[] = [];
  for (const entry of inRange) {
    const entryTokens = entry.usage.prompt + entry.usage.completion;
    tokens.prompt += entry.usage.prompt;
    tokens.cached += entry.usage.cached;
    tokens.completion += entry.usage.completion;
    tokens.total += entryTokens;
    turns += entry.turns;
    const entryCallCount = Object.values(entry.toolCalls).reduce((sum, n) => sum + n, 0);
    const entrySkillCount = Object.values(entry.skills).reduce((sum, n) => sum + n, 0);
    const entryCommandCount = Object.values(entry.commands).reduce((sum, n) => sum + n, 0);
    toolCalls += entryCallCount;
    skillLoads += entrySkillCount;
    commandRuns += entryCommandCount;
    llmMs += entry.llmMs;
    toolMs += entry.toolMs;
    decodeMs += entry.decodeMs;
    outputTokens += entry.outputTokens;

    mergeTally(skills, entry.skills, entry.skillLastAt);
    mergeTally(tools, entry.toolCalls, entry.toolLastAt);
    mergeTally(commands, entry.commands, entry.cmdLastAt);

    const info = meta.get(entry.id);
    rows.push({
      id: entry.id,
      title: info?.title || `会话 ${entry.id.slice(0, 8)}`,
      groupId: info?.groupId ?? entry.dir.split('/')[0] ?? '',
      groupName: info?.groupName ?? (entry.dir !== '' ? entry.dir.split('/')[0] : '未分组'),
      hidden: info?.hidden === true,
      cwd: entry.cwd,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      turns: entry.turns,
      tokens: {
        prompt: entry.usage.prompt,
        cached: entry.usage.cached,
        completion: entry.usage.completion,
        total: entryTokens,
      },
      cacheHitRate: entry.usage.prompt > 0 ? entry.usage.cached / entry.usage.prompt : null,
      toolCalls: entryCallCount,
      skillLoads: entrySkillCount,
      commandRuns: entryCommandCount,
      lastUser: entry.lastUser,
      parts: [
        { key: 'cached', value: entry.usage.cached },
        { key: 'prompt', value: Math.max(0, entry.usage.prompt - entry.usage.cached) },
        { key: 'completion', value: entry.usage.completion },
      ],
      tools: Object.keys(entry.toolCalls),
      skills: Object.keys(entry.skills),
      commands: Object.keys(entry.commands),
      activeDays: entry.dayActive,
    });
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  // 近 56 天连续序列（含今天）
  const dayBuckets = new Map<string, { tokens: number; sessions: number; toolCalls: number }>();
  for (let offset = DAYS_WINDOW - 1; offset >= 0; offset -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    dayBuckets.set(dayKeyOfDate(d), { tokens: 0, sessions: 0, toolCalls: 0 });
  }
  for (const entry of entries) {
    const entryDays = new Set<string>([...entry.dayActive, ...Object.keys(entry.dayTokens)]);
    for (const day of entryDays) {
      const bucket = dayBuckets.get(day);
      if (!bucket) continue;
      bucket.tokens += entry.dayTokens[day] ?? 0;
      bucket.sessions += 1;
      bucket.toolCalls += entry.dayToolCalls[day] ?? 0;
    }
  }

  return {
    range,
    generatedAt: now.toISOString(),
    totals: {
      sessions: inRange.length,
      sessionsTotal: entries.length,
      turns,
      tokens,
      cacheHitRate: tokens.prompt > 0 ? tokens.cached / tokens.prompt : null,
      toolCalls,
      skillLoads,
      commandRuns,
      llmMs,
      toolMs,
      outputTps: decodeMs > 0 ? outputTokens / (decodeMs / 1000) : null,
    },
    days: [...dayBuckets.entries()].map(([day, value]) => ({ day, ...value })),
    series: buildSeries(entries, range, now),
    skills: tallyStatsOf(skills),
    tools: tallyStatsOf(tools),
    commands: tallyStatsOf(commands),
    sessions: rows,
  };
}

function emptyOverview(range: UsageRange): UsageOverview {
  const now = new Date();
  const days: Array<{ day: string; tokens: number; sessions: number; toolCalls: number }> = [];
  for (let offset = DAYS_WINDOW - 1; offset >= 0; offset -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    days.push({ day: dayKeyOfDate(d), tokens: 0, sessions: 0, toolCalls: 0 });
  }
  return {
    range,
    generatedAt: now.toISOString(),
    totals: {
      sessions: 0,
      sessionsTotal: 0,
      turns: 0,
      tokens: emptyTokens(),
      cacheHitRate: null,
      toolCalls: 0,
      skillLoads: 0,
      commandRuns: 0,
      llmMs: 0,
      toolMs: 0,
      outputTps: null,
    },
    days,
    series: [],
    skills: [],
    tools: [],
    commands: [],
    sessions: [],
  };
}

// ============================================================================
// 路由
// ============================================================================

const ALL_RANGES: UsageRange[] = ['today', '7d', '30d', 'all'];

/**
 * 一次扫描 + 四范围预计算。
 * 之后任意 range 请求都从内存读取（毫秒返回），扫描仅在后台刷新。
 */
async function rebuildAll(env: Environment): Promise<void> {
  const nowMs = Date.now();
  const [entries, meta] = await Promise.all([scanEntries(env), loadTaskMeta(env)]);
  const now = new Date(nowMs);
  for (const range of ALL_RANGES) {
    aggregateCache.set(range, { at: Date.now(), value: aggregate(entries, meta, range, now) });
  }
}

/** 后台重建去重；调用方无需等待 */
function requestRebuild(env: Environment): Promise<void> {
  if (rebuilding === null) {
    rebuilding = rebuildAll(env)
      .catch(() => {
        /* 扫描失败保留旧缓存，下次请求重试 */
      })
      .finally(() => {
        rebuilding = null;
      });
  }
  return rebuilding;
}

/** 服务启动预热（server/index.ts 调用）：让首次打开概览即可毫秒出数 */
export function warmUsageOverview(env: Environment): void {
  void requestRebuild(env);
}

/** GET /api/usage/overview?range=today|7d|30d|all */
export function createUsageOverviewHandler(env: Environment): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const rawRange = req.query.range;
    const range: UsageRange = rawRange === 'today' || rawRange === '7d' || rawRange === '30d' || rawRange === 'all'
      ? rawRange
      : '7d';
    const cached = aggregateCache.get(range);
    if (cached) {
      // 过期不阻塞：先返回旧值，后台刷新
      if (Date.now() - cached.at > AGGREGATE_TTL_MS) void requestRebuild(env);
      return { status: 200, body: cached.value };
    }
    try {
      await requestRebuild(env);
      const value = aggregateCache.get(range)?.value;
      return { status: 200, body: value ?? emptyOverview(range) };
    } catch {
      // 极端兜底：任何意外都不让接口 5xx
      return { status: 200, body: emptyOverview(range) };
    }
  };
}
