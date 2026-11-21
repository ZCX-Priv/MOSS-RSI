// src/modules/agent/session-mirror.ts
// 会话元数据 SQLite 镜像（C3）：
// - session JSON 仍是唯一主存储（向后兼容、可回滚）；
// - 本模块把会话元数据与压缩块索引镜像到 ~/.moss/tasks/index.db，供跨会话查询/维护/GC；
// - 只写元数据，不复制消息正文（正文归档在 context.db），写入成本与消息体积无关；
// - 所有失败静默（镜像不是正确性依赖，绝不能阻断会话落盘）。

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Session } from './session';

const dbCache = new Map<string, Database>();

function openDb(dataDir: string): Database {
  const path = join(dataDir, 'tasks', 'index.db');
  const cached = dbCache.get(path);
  if (cached) return cached;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      compaction_count INTEGER NOT NULL DEFAULT 0,
      derived_from TEXT,
      ref_cursor INTEGER,
      permission_mode TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS compaction_index (
      block_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tier INTEGER NOT NULL DEFAULT 1,
      refs TEXT,
      tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      archive_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_compaction_index_session
      ON compaction_index(session_id, created_at DESC);
  `);
  // 旧库遗留列清理：已废除的 skill 模式；不支持 DROP COLUMN 的旧 SQLite 忽略即可
  try {
    db.exec('ALTER TABLE sessions DROP COLUMN active_skill');
  } catch {
    // 列不存在或 SQLite 版本不支持：不影响功能（不再写入该列）
  }
  dbCache.set(path, db);
  return db;
}

/** 镜像一个会话的元数据与压缩块索引（同步、best-effort） */
export function mirrorSession(dataDir: string, session: Session): void {
  try {
    const db = openDb(dataDir);
    const compacted = session.compactions ?? [];
    db.query(
      `INSERT OR REPLACE INTO sessions
        (id, updated_at, message_count, total_tokens, compaction_count, derived_from, ref_cursor, permission_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      session.updatedAt,
      session.messages.length,
      session.totalTokens ?? 0,
      compacted.length,
      session.derivedFrom ?? null,
      session.refCursor ?? null,
      session.permissionMode ?? null,
    );
    const stmt = db.query(
      `INSERT OR REPLACE INTO compaction_index
        (block_id, session_id, tier, refs, tokens, created_at, archive_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of compacted) {
      const blockId = c.blockId ?? c.id;
      stmt.run(
        blockId,
        session.id,
        c.tier ?? 1,
        JSON.stringify(c.refs ?? []),
        Math.max(0, Math.round(c.summary.length * 0.4)),
        c.at,
        c.compactedCount,
      );
    }
  } catch {
    // 镜像失败不阻断主存储
  }
}

/** 删除会话的镜像行（会话删除时调用） */
export function removeSessionMirror(dataDir: string, sessionId: string): void {
  try {
    const db = openDb(dataDir);
    db.transaction(() => {
      db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
      db.query('DELETE FROM compaction_index WHERE session_id = ?').run(sessionId);
    })();
  } catch {
    // 忽略
  }
}
