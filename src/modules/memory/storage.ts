// src/modules/memory/storage.ts
// 记忆宫殿存储：{scope}/memory/{wing}/{room}/{hash}.json。
// 全局 ~/.moss/memory/（wing='user' 为个人记忆；项目 wing 复用全局宫殿做 Tunnel 关联）；
// 项目级 {cwd}/.moss/memory/（wing=项目目录名）。
// 写盘节流的 touch（召回时更新访问计数，异步合并写）。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Environment } from '../../core/types';
import { MEMORY_HALLS } from './types';
import type { MemoryHall, MemoryRecord, MemoryScope, MemoryUpsertInput, ScopedMemoryRecord } from './types';

/** 计算记忆内容哈希（sha256 前 16 位 hex） */
export function computeMemoryId(input: {
  wing: string;
  room: string;
  verbatim: string;
  insight: string;
}): string {
  const canonical = JSON.stringify({
    wing: input.wing,
    room: input.room,
    verbatim: input.verbatim,
    insight: input.insight,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

/** 全局记忆宫殿根目录 */
export function globalMemoryRoot(env: Environment): string {
  return join(env.dataDir, 'memory');
}

/** 项目级记忆宫殿根目录 */
export function projectMemoryRoot(cwd: string): string {
  return join(cwd, '.moss', 'memory');
}

/** 系统作用域标记（本机全盘模式；无单一项目根） */
export const SYSTEM_SCOPE = '__system__';

/** 是否为系统作用域（无单一项目根：记忆入全局、不建项目根，避免相对路径写入进程目录） */
export function isSystemScope(cwd: string): boolean {
  return !cwd || cwd === SYSTEM_SCOPE;
}

/**
 * 记忆双作用域根解析：
 * - global 恒为全局宫殿；
 * - project 仅非系统作用域存在（系统作用域无项目根，项目翼记忆归档到全局）。
 */
export function memoryRoots(env: Environment, cwd: string): { global: string; project: string | null } {
  return {
    global: globalMemoryRoot(env),
    project: isSystemScope(cwd) ? null : projectMemoryRoot(cwd),
  };
}

/** 项目 wing 名（目录名；用于项目记忆归档与 Tunnel 关联）。系统作用域固定 'system'。 */
export function projectWing(cwd: string): string {
  if (isSystemScope(cwd)) return 'system';
  return basename(cwd) || 'default';
}

/** 目录名安全化（wing/room 作为目录名：去非法字符） */
function safeDirName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 单文件解析（无效文件跳过返回 null） */
function readMemoryFile(file: string, scope: MemoryScope): ScopedMemoryRecord | null {
  try {
    const raw = readFileSync(file, 'utf8');
    const rec = JSON.parse(raw) as Partial<MemoryRecord>;
    if (
      typeof rec.id !== 'string' ||
      typeof rec.wing !== 'string' ||
      typeof rec.room !== 'string' ||
      typeof rec.insight !== 'string'
    ) {
      return null;
    }
    return {
      id: rec.id,
      wing: rec.wing,
      room: rec.room,
      hall: MEMORY_HALLS.includes(rec.hall as MemoryHall) ? (rec.hall as MemoryHall) : 'event',
      verbatim: rec.verbatim ?? '',
      insight: rec.insight,
      source: rec.source ?? { at: new Date().toISOString() },
      tags: Array.isArray(rec.tags) ? rec.tags.filter((x): x is string => typeof x === 'string') : [],
      importance: typeof rec.importance === 'number' ? Math.min(1, Math.max(0, rec.importance)) : 0.5,
      pinned: rec.pinned === true,
      accessCount: typeof rec.accessCount === 'number' ? rec.accessCount : 0,
      ...(rec.lastAccessedAt ? { lastAccessedAt: rec.lastAccessedAt } : {}),
      createdAt: rec.createdAt ?? new Date().toISOString(),
      updatedAt: rec.updatedAt ?? new Date().toISOString(),
      scope,
    };
  } catch {
    return null;
  }
}

/** 枚举某作用域宫殿全部记忆 */
export function listAllMemories(root: string, scope: MemoryScope): ScopedMemoryRecord[] {
  if (!existsSync(root)) return [];
  const out: ScopedMemoryRecord[] = [];
  for (const wingEntry of readdirSync(root, { withFileTypes: true })) {
    if (!wingEntry.isDirectory() || wingEntry.name === 'scripts') continue;
    const wingDir = join(root, wingEntry.name);
    for (const roomEntry of readdirSync(wingDir, { withFileTypes: true })) {
      if (!roomEntry.isDirectory()) continue;
      const roomDir = join(wingDir, roomEntry.name);
      for (const file of readdirSync(roomDir)) {
        if (!file.endsWith('.json')) continue;
        const rec = readMemoryFile(join(roomDir, file), scope);
        if (rec) out.push(rec);
      }
    }
  }
  return out;
}

/** 落盘前剔除运行期 scope 字段（记忆文件只应含 MemoryRecord 字段） */
function toDiskRecord(record: MemoryRecord | ScopedMemoryRecord): MemoryRecord {
  const copy = { ...record } as MemoryRecord & { scope?: MemoryScope };
  delete copy.scope;
  return copy;
}

/** 写入记忆（wing/room 目录自动创建；内容寻址去重） */
export function writeMemory(
  root: string,
  record: MemoryRecord,
): MemoryRecord {
  const wingDir = join(root, safeDirName(record.wing));
  const roomDir = join(wingDir, safeDirName(record.room));
  ensureDir(roomDir);
  writeFileSync(join(roomDir, `${record.id}.json`), JSON.stringify(toDiskRecord(record), null, 2), 'utf8');
  return record;
}

/** 构造新记忆记录（id 推导 + 时间戳填充） */
export function buildMemoryRecord(input: MemoryUpsertInput, at = new Date().toISOString()): MemoryRecord {
  const importance = typeof input.importance === 'number' ? Math.min(1, Math.max(0, input.importance)) : 0.5;
  return {
    id: computeMemoryId({
      wing: input.wing,
      room: input.room,
      verbatim: input.verbatim,
      insight: input.insight,
    }),
    wing: input.wing,
    room: input.room,
    hall: input.hall,
    verbatim: input.verbatim,
    insight: input.insight,
    source: { ...(input.source ?? {}), at },
    tags: input.tags ?? [],
    importance,
    pinned: input.pinned === true,
    accessCount: 0,
    createdAt: at,
    updatedAt: at,
  };
}

/** 双作用域按 id 查找记忆文件路径与记录 */
export function findMemoryAnywhere(
  env: Environment,
  cwd: string,
  id: string,
): { record: ScopedMemoryRecord; file: string; root: string } | null {
  const { global: globalRoot, project } = memoryRoots(env, cwd);
  const roots: Array<{ root: string; scope: MemoryScope }> = [
    ...(project ? [{ root: project, scope: 'project' as const }] : []),
    { root: globalRoot, scope: 'global' as const },
  ];
  for (const { root, scope } of roots) {
    if (!existsSync(root)) continue;
    for (const wingEntry of readdirSync(root, { withFileTypes: true })) {
      if (!wingEntry.isDirectory()) continue;
      const wingDir = join(root, wingEntry.name);
      for (const roomEntry of readdirSync(wingDir, { withFileTypes: true })) {
        if (!roomEntry.isDirectory()) continue;
        const file = join(wingDir, roomEntry.name, `${id}.json`);
        if (existsSync(file)) {
          const rec = readMemoryFile(file, scope);
          if (rec) return { record: rec, file, root };
        }
      }
    }
  }
  return null;
}

/** 更新记忆（原地重写；保留 id 与 createdAt） */
export function rewriteMemory(file: string, record: MemoryRecord, scope: MemoryScope): ScopedMemoryRecord {
  writeFileSync(file, JSON.stringify(toDiskRecord(record), null, 2), 'utf8');
  return { ...record, scope };
}

/** 删除记忆 */
export function removeMemoryFile(file: string): boolean {
  try {
    if (existsSync(file)) {
      rmSync(file);
      return true;
    }
  } catch {
    // 删除失败
  }
  return false;
}

/** 宫殿树枚举（WebUI 三栏数据源） */
export function buildPalaceTree(
  env: Environment,
  cwd: string,
): {
  wings: Array<{
    wing: string;
    scope: MemoryScope;
    rooms: Array<{ room: string; count: number; halls: Array<{ hall: MemoryHall; count: number }> }>;
    total: number;
  }>;
} {
  const { global: globalRoot, project } = memoryRoots(env, cwd);
  const all = [
    ...listAllMemories(globalRoot, 'global'),
    ...(project ? listAllMemories(project, 'project') : []),
  ];
  const wingMap = new Map<string, { wing: string; scope: MemoryScope; rooms: Map<string, Map<MemoryHall, number>>; total: number }>();
  for (const m of all) {
    let w = wingMap.get(m.wing);
    if (!w || (w.scope === 'global' && m.scope === 'project')) {
      w = w ?? { wing: m.wing, scope: m.scope, rooms: new Map(), total: 0 };
      w.scope = m.scope;
      wingMap.set(m.wing, w);
    }
    let room = w.rooms.get(m.room);
    if (!room) {
      room = new Map();
      w.rooms.set(m.room, room);
    }
    room.set(m.hall, (room.get(m.hall) ?? 0) + 1);
    w.total++;
  }
  return {
    wings: [...wingMap.values()]
      .map(w => ({
        wing: w.wing,
        scope: w.scope,
        rooms: [...w.rooms.entries()]
          .map(([room, halls]) => ({
            room,
            count: [...halls.values()].reduce((s, x) => s + x, 0),
            halls: [...halls.entries()].map(([hall, count]) => ({ hall, count })),
          }))
          .sort((a, b) => b.count - a.count),
        total: w.total,
      }))
      .sort((a, b) => b.total - a.total),
  };
}
