// src/modules/migration/backup.ts
// MOSS 备份包的文件层：收集 → zip → 解包 → 合并。
//
// 职责边界：
//   - 本文件只做「文件与 zip」的搬运和会话 JSON 的还原；
//   - 会话热写入（engine.importSessions）与配置合并（config 服务）由 index.ts 编排。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig, ApiConfig } from '../../core/types';
import type { Session } from '../agent/session';
import { ErrorCode } from '../../core/error-codes';
import { MigrationError } from './errors';
import {
  BACKUP_API_FILE,
  BACKUP_CONFIG_FILE,
  BACKUP_DIRS,
  BACKUP_FILES,
  BACKUP_SUBDIRS,
  DATA_PREFIX,
  MANIFEST_ENTRY,
  MANIFEST_FORMAT_VERSION,
  SKIP_DIR_NAMES,
  parseManifest,
  sanitizeApiConfig,
  sanitizeAppConfig,
  type BackupManifest,
} from './manifest';

export interface BackupEntry {
  /** zip 内路径（data/<相对 ~/.moss 的路径> 或 manifest.json） */
  path: string;
  data: Uint8Array;
}

/** 从备份包还原出的会话条目（供 engine 热写入） */
export interface BackupSessionItem {
  sessionId: string;
  title: string;
  groupName: string;
  session: Session;
}

// ============================================================================
// 导出：收集
// ============================================================================

/** 递归收集目录下全部文件（跳过噪声目录） */
function collectDir(absDir: string, relDir: string, out: BackupEntry[]): void {
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = readdirSync(absDir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
    }));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDir) {
      collectDir(join(absDir, entry.name), rel, out);
      continue;
    }
    try {
      out.push({ path: `${DATA_PREFIX}${rel}`, data: readFileSync(join(absDir, entry.name)) });
    } catch {
      // 单文件读失败（权限/占用）不阻断整体备份
    }
  }
}

/** 收集备份条目（配置经清洗后写入） */
export function collectBackupEntries(opts: {
  dataDir: string;
  appConfig: AppConfig;
  apiConfig: ApiConfig;
  includeSecrets: boolean;
}): BackupEntry[] {
  const out: BackupEntry[] = [];

  for (const dir of BACKUP_DIRS) {
    const absDir = join(opts.dataDir, dir);
    if (!existsSync(absDir)) continue;
    collectDir(absDir, dir, out);
  }
  for (const sub of BACKUP_SUBDIRS) {
    const absDir = join(opts.dataDir, sub);
    if (!existsSync(absDir)) continue;
    collectDir(absDir, sub, out);
  }
  for (const file of BACKUP_FILES) {
    const absPath = join(opts.dataDir, file);
    if (!existsSync(absPath)) continue;
    try {
      out.push({ path: `${DATA_PREFIX}${file}`, data: readFileSync(absPath) });
    } catch {
      // 读失败跳过
    }
  }

  // 配置文件不直接拷贝：写入清洗后的结构（跨机器字段已剔除）
  out.push({
    path: `${DATA_PREFIX}${BACKUP_CONFIG_FILE}`,
    data: Buffer.from(JSON.stringify(sanitizeAppConfig(opts.appConfig), null, 2), 'utf8'),
  });
  out.push({
    path: `${DATA_PREFIX}${BACKUP_API_FILE}`,
    data: Buffer.from(JSON.stringify(sanitizeApiConfig(opts.apiConfig, opts.includeSecrets), null, 2), 'utf8'),
  });

  return out;
}

/** 统计条目数量（供 manifest 与前端预览） */
export function countBackupEntries(entries: BackupEntry[]): Record<string, number> {
  const counts: Record<string, number> = {
    sessions: 0,
    groups: 0,
    skills: 0,
    mcps: 0,
    commands: 0,
    memories: 0,
    todos: 0,
    files: entries.length,
  };
  for (const entry of entries) {
    const rel = entry.path.slice(DATA_PREFIX.length);
    if (rel.startsWith('skills/')) counts.skills++;
    else if (rel.startsWith('mcps/')) counts.mcps++;
    else if (rel.startsWith('commands/')) counts.commands++;
    else if (rel.startsWith('memory/')) counts.memories++;
    else if (rel.startsWith('todo/')) counts.todos++;
    else if (rel.startsWith('tasks/') && !rel.endsWith('/task.json') && rel.endsWith('.json')) counts.sessions++;
    else if (rel === 'task.json') {
      try {
        const parsed = JSON.parse(Buffer.from(entry.data).toString('utf8')) as { groups?: unknown[] };
        counts.groups = Array.isArray(parsed.groups) ? parsed.groups.length : 0;
      } catch {
        counts.groups = 0;
      }
    }
  }
  return counts;
}

// ============================================================================
// 导出：zip 打包
// ============================================================================

/** 生成 zip 字节（DEFLATE 压缩） */
export async function zipEntries(entries: BackupEntry[], manifest: BackupManifest): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file(MANIFEST_ENTRY, JSON.stringify(manifest, null, 2));
  for (const entry of entries) zip.file(entry.path, entry.data);
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/** 构造 manifest（版本、时间、平台、条目计数） */
export function buildManifest(counts: Record<string, number>): BackupManifest {
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    counts,
  };
}

// ============================================================================
// 导入：解包与合并
// ============================================================================

/** 解包 zip；拒绝路径穿越与非法条目 */
export async function unzipEntries(buffer: Uint8Array): Promise<BackupEntry[]> {
  const JSZip = (await import('jszip')).default;
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new MigrationError(ErrorCode.MIGRATION_ARCHIVE_INVALID);
  }

  const out: BackupEntry[] = [];
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    // Zip Slip：绝对路径与 .. 段一律拒绝
    if (name.startsWith('/') || name.includes('..') || name.includes('\\')) continue;
    if (!name.startsWith(DATA_PREFIX) && name !== MANIFEST_ENTRY) continue;
    out.push({ path: name, data: await file.async('uint8array') });
  }
  if (out.length === 0) throw new MigrationError(ErrorCode.MIGRATION_ARCHIVE_INVALID);
  return out;
}

/** 读取 manifest（缺失/损坏返回 null，由调用方决定是否降级） */
export function readManifestFromEntries(entries: BackupEntry[]): BackupManifest | null {
  const entry = entries.find((e) => e.path === MANIFEST_ENTRY);
  if (!entry) return null;
  try {
    return parseManifest(JSON.parse(Buffer.from(entry.data).toString('utf8')));
  } catch {
    return null;
  }
}

/** 配置类条目（由 index.ts 交给 config 服务合并，不直接落盘） */
export const CONFIG_ENTRY_PATHS = {
  app: `${DATA_PREFIX}${BACKUP_CONFIG_FILE}`,
  api: `${DATA_PREFIX}${BACKUP_API_FILE}`,
} as const;

/** 读取 JSON 配置条目 */
export function readConfigEntry<T>(entries: BackupEntry[], path: string): T | null {
  const entry = entries.find((e) => e.path === path);
  if (!entry) return null;
  try {
    return JSON.parse(Buffer.from(entry.data).toString('utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * 合并目录资源到 ~/.moss。
 * 跳过：tasks/**（会话走热写入）、config/**（走配置服务）、manifest.json。
 * 策略：目标文件已存在即跳过（不覆盖现有数据）。
 */
export function mergeResourceEntries(
  entries: BackupEntry[],
  dataDir: string,
): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (entry.path === MANIFEST_ENTRY) continue;
    const rel = entry.path.slice(DATA_PREFIX.length);
    if (!rel) continue;
    if (rel.startsWith('tasks/') || rel.startsWith('config/')) continue;

    const target = join(dataDir, rel);
    if (existsSync(target)) {
      skipped.push(rel);
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
      copied.push(rel);
    } catch {
      skipped.push(rel);
    }
  }
  return { copied, skipped };
}

// ============================================================================
// 导入：会话还原
// ============================================================================

interface TaskRootSnapshot {
  groups?: Array<{ id?: unknown; name?: unknown; dir?: unknown }>;
  index?: Record<string, { groupId?: unknown }>;
}

/** 会话 JSON 基础校验（结构不合规返回 null） */
function parseSessionJson(raw: string): Session | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !Array.isArray(obj.messages)) return null;
  const messages = obj.messages
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .filter((m) => typeof m.role === 'string' && typeof m.content === 'string')
    // 跨机绝对路径引用在目标机无意义，导入前剥离
    .map((m) => {
      const copy = { ...m } as Record<string, unknown>;
      delete copy.attachments;
      delete copy.images;
      delete copy.imagesSentAt;
      return copy;
    });
  return {
    id: obj.id,
    messages: messages as unknown as Session['messages'],
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
    totalTokens: typeof obj.totalTokens === 'number' ? obj.totalTokens : 0,
    contextFiles: Array.isArray(obj.contextFiles) ? (obj.contextFiles as Session['contextFiles']) : [],
    ...(typeof obj.lastCwd === 'string' ? { lastCwd: obj.lastCwd } : {}),
    ...(typeof obj.msgSeq === 'number' ? { msgSeq: obj.msgSeq } : {}),
    ...(typeof obj.permissionMode === 'string'
      ? { permissionMode: obj.permissionMode as Session['permissionMode'] }
      : {}),
  };
}

/** 首条用户消息文本（标题兜底） */
function firstUserText(session: Session): string | undefined {
  const msg = session.messages.find((m) => m.role === 'user' && m.content.trim().length > 0);
  if (!msg) return undefined;
  const text = msg.content.replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * 从备份包还原会话条目。
 * 标题来源优先级：组内 task.json 的 TaskItem.title → 首条用户消息。
 * 分组来源优先级：task.json index → 目录反查 groups → 「默认任务」。
 */
export function parseBackupSessions(entries: BackupEntry[]): BackupSessionItem[] {
  const rootEntry = entries.find((e) => e.path === `${DATA_PREFIX}task.json`);
  let root: TaskRootSnapshot = {};
  if (rootEntry) {
    try {
      root = JSON.parse(Buffer.from(rootEntry.data).toString('utf8')) as TaskRootSnapshot;
    } catch {
      root = {};
    }
  }
  const groups = Array.isArray(root.groups) ? root.groups : [];
  const index = root.index ?? {};

  // 组目录 → 组内 task.json（TaskItem[]，用于取标题）
  const groupTasks = new Map<string, Array<{ id?: unknown; title?: unknown }>>();
  for (const entry of entries) {
    const rel = entry.path.slice(DATA_PREFIX.length);
    if (!rel.startsWith('tasks/') || !rel.endsWith('/task.json')) continue;
    const dir = rel.slice('tasks/'.length, -'/task.json'.length);
    try {
      const list = JSON.parse(Buffer.from(entry.data).toString('utf8')) as unknown;
      if (Array.isArray(list)) groupTasks.set(dir, list as Array<{ id?: unknown; title?: unknown }>);
    } catch {
      // 组元信息损坏不影响会话本体
    }
  }

  const out: BackupSessionItem[] = [];
  for (const entry of entries) {
    const rel = entry.path.slice(DATA_PREFIX.length);
    if (!rel.startsWith('tasks/') || !rel.endsWith('.json') || rel.endsWith('/task.json')) continue;
    const session = parseSessionJson(Buffer.from(entry.data).toString('utf8'));
    if (!session) continue;

    const dir = rel.slice('tasks/'.length, rel.lastIndexOf('/'));
    const groupId =
      (typeof index[session.id]?.groupId === 'string' ? (index[session.id].groupId as string) : undefined) ??
      (groups.find((g) => (typeof g.dir === 'string' ? g.dir : typeof g.id === 'string' ? g.id : '') === dir)
        ?.id as string | undefined);
    const group = groups.find((g) => g.id === groupId);
    const groupName = typeof group?.name === 'string' ? group.name : '默认任务';

    const taskTitle = groupTasks
      .get(dir)
      ?.find((t) => t.id === session.id)
      ?.title;
    const title =
      typeof taskTitle === 'string' && taskTitle.trim()
        ? taskTitle.trim()
        : (firstUserText(session) ?? `备份会话 ${session.id.slice(0, 8)}`);

    out.push({ sessionId: session.id, title, groupName, session });
  }
  return out;
}
