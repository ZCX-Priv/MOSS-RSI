// src/modules/context/store/context-store.ts
// 上下文制品 SQLite 存储（B1/B3/B4/C3/C5 的共用底座）：
//   compactions       每次折叠的元数据 + 摘要
//   archived_messages 被物理折叠的原文（可 decompress / 检索）
//   externalized      大工具结果外置索引（context retrieve）
//   summary_blocks    分层摘要账本（T1/T2/T3）
// 刻意独立于 session JSON：会话主存储保持向后兼容，本库只承载“压缩后可回溯”的制品。
// 运行时为 Bun（bun:sqlite）；所有查询失败都向上抛，由调用方决定降级策略。

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Environment } from '../../../core/types';
import type { ContextMessage } from '../types';

export interface ArchivedCompactionMeta {
  id: string;
  sessionId: string;
  createdAt: string;
  tier: number;
  refs: string[];
  summary: string;
  beforeTokens: number;
  afterTokens: number;
  trigger: string;
  count: number;
}

export interface ArchivedMessage {
  ref?: string;
  index: number;
  role: ContextMessage['role'];
  name?: string;
  content: string;
  toolCalls?: ContextMessage['toolCalls'];
  toolCallId?: string;
  timestamp?: string;
}

export interface ArchiveSearchHit {
  sessionId: string;
  compactionId: string;
  tier: number;
  ref?: string;
  index: number;
  role: ContextMessage['role'];
  snippet: string;
  score: number;
  timestamp?: string;
}

export interface ExternalizedRecord {
  ref: string;
  sessionId: string;
  path: string;
  tokens: number;
  createdAt: string;
}

interface CompactionRow {
  id: string;
  session_id: string;
  created_at: string;
  tier: number;
  refs: string | null;
  summary: string;
  before_tokens: number | null;
  after_tokens: number | null;
  trigger: string | null;
  count: number | null;
}

interface ArchivedRow {
  compaction_id: string;
  session_id: string;
  ref: string | null;
  idx: number;
  role: ContextMessage['role'];
  name: string | null;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  ts: string | null;
}

interface ExternalizedRow {
  ref: string;
  session_id: string;
  path: string;
  tokens: number | null;
  created_at: string;
}

const dbCache = new Map<string, Database>();

/** 上下文 SQLite 路径（~/.moss/context/context.db） */
export function contextDbPath(env: Environment): string {
  return join(env.dataDir, 'context', 'context.db');
}

function openDb(env: Environment): Database {
  const path = contextDbPath(env);
  const cached = dbCache.get(path);
  if (cached) return cached;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS compactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      tier INTEGER NOT NULL DEFAULT 1,
      refs TEXT,
      summary TEXT NOT NULL,
      before_tokens INTEGER,
      after_tokens INTEGER,
      trigger TEXT,
      count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_compactions_session
      ON compactions(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS archived_messages (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      compaction_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ref TEXT,
      idx INTEGER NOT NULL,
      role TEXT NOT NULL,
      name TEXT,
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_call_id TEXT,
      ts TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_archived_compaction
      ON archived_messages(compaction_id, idx);
    CREATE INDEX IF NOT EXISTS idx_archived_session_ref
      ON archived_messages(session_id, ref);

    CREATE TABLE IF NOT EXISTS externalized (
      ref TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      tokens INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_externalized_session
      ON externalized(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS summary_blocks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tier INTEGER NOT NULL DEFAULT 1,
      refs TEXT,
      summary TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_summary_blocks_session
      ON summary_blocks(session_id, tier, created_at DESC);
  `);
  dbCache.set(path, db);
  return db;
}

/** 测试/模块销毁用：关闭并清空连接缓存 */
export function closeContextDb(env: Environment): void {
  const path = contextDbPath(env);
  const db = dbCache.get(path);
  if (db) {
    db.close();
    dbCache.delete(path);
  }
}

function parseRefs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 归档一次折叠：元数据 + 被折叠原文。调用方必须在物理删除前调用；
 * 本函数抛错时折叠应整体放弃（“可逆”是硬承诺）。
 */
export function archiveCompaction(
  env: Environment,
  input: {
    id: string;
    sessionId: string;
    tier: number;
    refs: string[];
    summary: string;
    beforeTokens: number;
    afterTokens: number;
    trigger: string;
    messages: readonly ContextMessage[];
  },
): void {
  const db = openDb(env);
  const insertMeta = db.query(
    `INSERT OR REPLACE INTO compactions
      (id, session_id, created_at, tier, refs, summary, before_tokens, after_tokens, trigger, count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMsg = db.query(
    `INSERT INTO archived_messages
      (compaction_id, session_id, ref, idx, role, name, content, tool_calls, tool_call_id, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBlock = db.query(
    `INSERT OR REPLACE INTO summary_blocks
      (id, session_id, tier, refs, summary, tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const createdAt = new Date().toISOString();
  const tokens = Math.max(0, Math.round(input.summary.length * 0.4));
  db.transaction(() => {
    insertMeta.run(
      input.id,
      input.sessionId,
      createdAt,
      input.tier,
      JSON.stringify(input.refs),
      input.summary,
      input.beforeTokens,
      input.afterTokens,
      input.trigger,
      input.messages.length,
    );
    for (let i = 0; i < input.messages.length; i++) {
      const m = input.messages[i];
      // 大工具结果在会话里是预览占位符；归档要保存磁盘上的原文，保证 decompress 无损。
      let content = m.content;
      const externalizedPath = m.metadata?.externalizedPath;
      if (m.metadata?.externalized === true && typeof externalizedPath === 'string') {
        try {
          content = readFileSync(externalizedPath, 'utf8');
        } catch {
          // 原文不可读时保留占位符（至少能定位到路径）
        }
      }
      insertMsg.run(
        input.id,
        input.sessionId,
        m.ref ?? null,
        m.metadata && typeof m.metadata.sourceIndex === 'number' ? m.metadata.sourceIndex : i,
        m.role,
        m.name ?? null,
        content,
        m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        m.toolCallId ?? null,
        m.timestamp ?? null,
      );
    }
    insertBlock.run(input.id, input.sessionId, input.tier, JSON.stringify(input.refs), input.summary, tokens, createdAt);
  })();
}

/** 会话的折叠记录（新→旧） */
export function listCompactions(
  env: Environment,
  sessionId: string,
  limit = 20,
): ArchivedCompactionMeta[] {
  const db = openDb(env);
  const rows = db
    .query<CompactionRow, [string, number]>(
      `SELECT id, session_id, created_at, tier, refs, summary, before_tokens, after_tokens, trigger, count
       FROM compactions WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionId, Math.max(1, Math.min(200, limit)));
  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    createdAt: r.created_at,
    tier: r.tier,
    refs: parseRefs(r.refs),
    summary: r.summary,
    beforeTokens: r.before_tokens ?? 0,
    afterTokens: r.after_tokens ?? 0,
    trigger: r.trigger ?? 'auto',
    count: r.count ?? 0,
  }));
}

function toArchivedMessage(row: ArchivedRow): ArchivedMessage {
  let toolCalls: ContextMessage['toolCalls'];
  if (row.tool_calls) {
    try {
      const parsed: unknown = JSON.parse(row.tool_calls);
      if (Array.isArray(parsed)) toolCalls = parsed as ContextMessage['toolCalls'];
    } catch {
      toolCalls = undefined;
    }
  }
  return {
    ...(row.ref ? { ref: row.ref } : {}),
    index: row.idx,
    role: row.role,
    ...(row.name ? { name: row.name } : {}),
    content: row.content,
    ...(toolCalls ? { toolCalls } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    ...(row.ts ? { timestamp: row.ts } : {}),
  };
}

/** 读取一次折叠的原文（按会话校验，防跨会话越权） */
export function readCompaction(
  env: Environment,
  sessionId: string,
  compactionId: string,
  limit = 500,
): { meta: ArchivedCompactionMeta | null; messages: ArchivedMessage[] } {
  const db = openDb(env);
  const metaRow = db
    .query<CompactionRow, [string, string]>(
      `SELECT id, session_id, created_at, tier, refs, summary, before_tokens, after_tokens, trigger, count
       FROM compactions WHERE id = ? AND session_id = ?`,
    )
    .get(compactionId, sessionId);
  if (!metaRow) return { meta: null, messages: [] };
  const rows = db
    .query<ArchivedRow, [string, string, number]>(
      `SELECT compaction_id, session_id, ref, idx, role, name, content, tool_calls, tool_call_id, ts
       FROM archived_messages WHERE compaction_id = ? AND session_id = ? ORDER BY idx ASC LIMIT ?`,
    )
    .all(compactionId, sessionId, Math.max(1, Math.min(2000, limit)));
  return {
    meta: {
      id: metaRow.id,
      sessionId: metaRow.session_id,
      createdAt: metaRow.created_at,
      tier: metaRow.tier,
      refs: parseRefs(metaRow.refs),
      summary: metaRow.summary,
      beforeTokens: metaRow.before_tokens ?? 0,
      afterTokens: metaRow.after_tokens ?? 0,
      trigger: metaRow.trigger ?? 'auto',
      count: metaRow.count ?? 0,
    },
    messages: rows.map(toArchivedMessage),
  };
}

/** 按 ref 在归档中查找消息（支持父链会话列表） */
export function findArchivedByRef(
  env: Environment,
  sessionIds: readonly string[],
  ref: string,
): { meta: ArchivedCompactionMeta; message: ArchivedMessage } | null {
  if (sessionIds.length === 0) return null;
  const db = openDb(env);
  const placeholders = sessionIds.map(() => '?').join(',');
  const row = db
    .query<ArchivedRow, (string | number)[]>(
      `SELECT compaction_id, session_id, ref, idx, role, name, content, tool_calls, tool_call_id, ts
       FROM archived_messages WHERE session_id IN (${placeholders}) AND ref = ? ORDER BY row_id DESC LIMIT 1`,
    )
    .get(...sessionIds, ref);
  if (!row) return null;
  const metaRow = db
    .query<CompactionRow, [string, string]>(
      `SELECT id, session_id, created_at, tier, refs, summary, before_tokens, after_tokens, trigger, count
       FROM compactions WHERE id = ? AND session_id = ?`,
    )
    .get(row.compaction_id, row.session_id);
  if (!metaRow) return null;
  return {
    meta: {
      id: metaRow.id,
      sessionId: metaRow.session_id,
      createdAt: metaRow.created_at,
      tier: metaRow.tier,
      refs: parseRefs(metaRow.refs),
      summary: metaRow.summary,
      beforeTokens: metaRow.before_tokens ?? 0,
      afterTokens: metaRow.after_tokens ?? 0,
      trigger: metaRow.trigger ?? 'auto',
      count: metaRow.count ?? 0,
    },
    message: toArchivedMessage(row),
  };
}

/** 关键词检索归档（简单确定性计分：完整查询 > 词项；中文按 2-gram 补充） */
export function searchArchive(
  env: Environment,
  sessionIds: readonly string[],
  query: string,
  topK: number,
  includeTool: boolean,
): ArchiveSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q || sessionIds.length === 0) return [];
  const db = openDb(env);
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db
    .query<ArchivedRow, string[]>(
      `SELECT compaction_id, session_id, ref, idx, role, name, content, tool_calls, tool_call_id, ts
       FROM archived_messages WHERE session_id IN (${placeholders})
       ORDER BY row_id DESC LIMIT 4000`,
    )
    .all(...sessionIds);
  const terms = buildTerms(q);
  // 一次构建 tier 映射，避免逐行查询 compactions（4000 行时是 4000 次查询）
  const tierByCompaction = new Map<string, number>();
  for (const sid of sessionIds) {
    for (const meta of listCompactions(env, sid, 200)) tierByCompaction.set(meta.id, meta.tier);
  }
  const hits: ArchiveSearchHit[] = [];
  for (const row of rows) {
    if (!includeTool && row.role === 'tool') continue;
    const text = row.content.toLowerCase();
    let score = text.includes(q) ? 5 : 0;
    for (const term of terms) {
      if (text.includes(term)) score += 1 + Math.min(3, Math.floor(text.split(term).length - 1) / 3);
    }
    if (score <= 0) continue;
    const at = text.indexOf(q) >= 0 ? text.indexOf(q) : Math.max(0, text.indexOf(terms[0] ?? q));
    const start = Math.max(0, at - 80);
    const snippet = row.content.slice(start, start + 240).replace(/\s+/g, ' ').trim();
    hits.push({
      sessionId: row.session_id,
      compactionId: row.compaction_id,
      tier: tierByCompaction.get(row.compaction_id) ?? 1,
      ...(row.ref ? { ref: row.ref } : {}),
      index: row.idx,
      role: row.role,
      snippet,
      score,
      ...(row.ts ? { timestamp: row.ts } : {}),
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, topK)));
}

function buildTerms(q: string): string[] {
  const raw = q.split(/[\s,，。;；:：/\\|]+/).filter(t => t.length > 0);
  const terms = new Set(raw);
  // 中文没有空格：对连续 CJK 片段补 2-gram，提升召回
  for (const chunk of raw) {
    if (chunk.length >= 2 && /[\u4e00-\u9fff]/.test(chunk)) {
      for (let i = 0; i < chunk.length - 1; i++) terms.add(chunk.slice(i, i + 2));
    }
  }
  return [...terms].slice(0, 12);
}

/** 记录大工具结果外置索引 */
export function recordExternalized(env: Environment, record: ExternalizedRecord): void {
  const db = openDb(env);
  db.query(
    `INSERT OR REPLACE INTO externalized (ref, session_id, path, tokens, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(record.ref, record.sessionId, record.path, record.tokens, record.createdAt);
}

/** 读取外置记录（按会话校验） */
export function getExternalized(
  env: Environment,
  sessionId: string,
  ref: string,
): ExternalizedRecord | null {
  const db = openDb(env);
  const row = db
    .query<ExternalizedRow, [string, string]>(
      `SELECT ref, session_id, path, tokens, created_at FROM externalized
       WHERE session_id = ? AND ref = ?`,
    )
    .get(sessionId, ref);
  if (!row) return null;
  return {
    ref: row.ref,
    sessionId: row.session_id,
    path: row.path,
    tokens: row.tokens ?? 0,
    createdAt: row.created_at,
  };
}

/** 全库会话 id（scope=all 归档检索用） */
export function listArchiveSessionIds(env: Environment): string[] {
  const db = openDb(env);
  const rows = db
    .query<{ session_id: string }, []>(
      // 留出 SQLite 变量上限余量（检索查询还要带 query/topK 参数）
      `SELECT DISTINCT session_id FROM compactions ORDER BY created_at DESC LIMIT 900`,
    )
    .all();
  return rows.map(r => r.session_id);
}

/** 清理超过 N 天的归档（维护命令/GC 用） */
export function gcArchive(env: Environment, olderThanDays: number): { compactions: number; messages: number } {
  const db = openDb(env);
  const cutoff = new Date(Date.now() - Math.max(1, olderThanDays) * 86400_000).toISOString();
  const ids = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM compactions WHERE created_at < ?`,
    )
    .all(cutoff)
    .map(r => r.id);
  if (ids.length === 0) return { compactions: 0, messages: 0 };
  let msgCount = 0;
  // SQLite 变量上限约 999：分批删除，避免大库 GC 直接报错
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const placeholders = chunk.map(() => '?').join(',');
    msgCount +=
      db
        .query<{ n: number }, string[]>(
          `SELECT COUNT(*) AS n FROM archived_messages WHERE compaction_id IN (${placeholders})`,
        )
        .get(...chunk)?.n ?? 0;
    db.transaction(() => {
      db.query(`DELETE FROM archived_messages WHERE compaction_id IN (${placeholders})`).run(...chunk);
      db.query(`DELETE FROM compactions WHERE id IN (${placeholders})`).run(...chunk);
      db.query(`DELETE FROM summary_blocks WHERE id IN (${placeholders})`).run(...chunk);
    })();
  }
  return { compactions: ids.length, messages: msgCount };
}

/**
 * 上下文制品 GC：清理过期折叠归档 + 外置工具结果（文件与索引）。
 * 只删除超过保留期的制品；session JSON 与当前消息不受影响。
 */
export function gcContextStore(
  env: Environment,
  olderThanDays: number,
): { compactions: number; messages: number; externalized: number; files: number } {
  const db = openDb(env);
  const cutoff = new Date(Date.now() - Math.max(1, olderThanDays) * 86400_000).toISOString();
  const rows = db
    .query<{ ref: string; path: string }, [string]>(
      `SELECT ref, path FROM externalized WHERE created_at < ?`,
    )
    .all(cutoff);
  let files = 0;
  for (const row of rows) {
    try {
      if (existsSync(row.path)) {
        unlinkSync(row.path);
        files++;
      }
    } catch {
      // 单文件失败忽略（索引行仍删除，避免无限重试）
    }
  }
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const placeholders = chunk.map(() => '?').join(',');
    db.query(`DELETE FROM externalized WHERE ref IN (${placeholders})`).run(...chunk.map(r => r.ref));
  }
  const archived = gcArchive(env, olderThanDays);
  return { ...archived, externalized: rows.length, files };
}
