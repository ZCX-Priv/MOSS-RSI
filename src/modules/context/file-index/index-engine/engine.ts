// src/modules/context/file-index/index-engine/engine.ts
// 索引引擎：一次全量扫描 → SQLite 快照持久化 → watcher 增量更新。
// 内存为主（Map<pathKey, FileEntry>），SQLite 为持久层（启动秒级恢复 + 落盘防抖）。
// 状态机：disabled → scanning → ready（error 可恢复重试）。

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { IgnoreGlobs } from '../shared/ignore';
import { scanIncremental, statEntry, pathKey, type KnownSnapshot } from '../shared/scanner';
import { ProjectWatcher } from '../shared/watcher';
import type {
  FileChangeBatch,
  FileEntry,
  FileIndexRuntimeDeps,
  IndexingEngineStatus,
} from '../types';
import { queryEntries, type FileQuery, type FileQueryResult } from './query';

const FLUSH_IDLE_MS = 2000;
const FLUSH_THRESHOLD = 500;

export class IndexEngine {
  private db: Database | null = null;
  private watcher: ProjectWatcher | null = null;
  private memory = new Map<string, FileEntry>();
  private dirtyUpserts: FileEntry[] = [];
  private dirtyDeletes = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private abort: AbortController | null = null;

  private state: IndexingEngineStatus = {
    enabled: true,
    state: 'disabled',
    progress: null,
    fileCount: 0,
    dirCount: 0,
    storeBytes: 0,
    error: null,
  };

  /** 变更订阅者（图谱/SAG 引擎；多播） */
  private changeListeners: Array<(batch: FileChangeBatch) => void> = [];

  /** 订阅变更批次；返回取消订阅函数 */
  subscribeChanges(listener: (batch: FileChangeBatch) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      const idx = this.changeListeners.indexOf(listener);
      if (idx >= 0) this.changeListeners.splice(idx, 1);
    };
  }

  private notifyChanges(batch: FileChangeBatch): void {
    for (const listener of this.changeListeners) {
      try {
        listener(batch);
      } catch (err) {
        // 消费者异常不阻断索引引擎
        this.deps.logger.warn('file-index 消费者异常', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  constructor(
    private readonly root: string,
    private readonly dataDir: string,
    private readonly customIgnore: IgnoreGlobs | null,
    private readonly deps: FileIndexRuntimeDeps,
  ) {}

  get status(): Readonly<IndexingEngineStatus> {
    return this.state;
  }

  /** 引擎是否可对外服务（查询/枚举） */
  get ready(): boolean {
    return this.state.state === 'ready';
  }

  /** 内存条目（供外部只读遍历） */
  get entries(): ReadonlyMap<string, FileEntry> {
    return this.memory;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      this.openDb();
      this.restoreFromDb();
      this.state = { ...this.state, state: 'scanning', progress: { phase: 'scan', percent: 0 }, error: null };
      this.deps.onStatusChange();

      // 后台增量校正（首次全量 / 二次启动增量）
      this.abort = new AbortController();
      const known: KnownSnapshot | null = this.memory.size > 0 ? this.buildKnownSnapshot() : null;
      const batch = await scanIncremental(this.root, known, {
        signal: this.abort.signal,
        customIgnore: this.customIgnore,
        onProgress: count => {
          const percent = known ? 100 : Math.min(99, Math.round((count / 20000) * 100));
          this.state = { ...this.state, progress: { phase: 'scan', percent } };
          this.deps.onStatusChange();
        },
      });
      if (this.stopped) return;
      this.applyBatchInternal(batch);
      this.state = { ...this.state, state: 'ready', progress: null };
      this.refreshStats();
      this.deps.onStatusChange();
      this.flush();

      // 启动 watcher（Linux 退化定时扫描由 fallback 处理）
      this.watcher = new ProjectWatcher(this.root, this.customIgnore, {
        onBatch: relPaths => void this.handleWatcherBatch(relPaths),
        onError: err => this.deps.logger.warn('file-index watcher error', { err: err.message }),
      });
      const native = this.watcher.start();
      if (!native) this.deps.logger.info('file-index watcher 退化为定时增量扫描（平台不支持 recursive watch）');
    } catch (err) {
      this.state = {
        ...this.state,
        state: 'error',
        progress: null,
        error: err instanceof Error ? err.message : String(err),
      };
      this.deps.onStatusChange();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    this.watcher?.stop();
    this.watcher = null;
    this.flush();
    try {
      // checkpoint 收拢 WAL 文件句柄（Windows 下防句柄延迟锁目录）
      this.db?.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      this.db?.close();
    } catch {
      // 忽略关闭异常
    }
    this.db = null;
    this.state = { ...this.state, state: 'disabled', progress: null };
    this.deps.onStatusChange();
  }

  /** watcher 批次 → stat diff → 更新内存/落库 → 通知消费者 */
  private async handleWatcherBatch(relPaths: string[]): Promise<void> {
    if (this.stopped) return;
    try {
      if (relPaths.length === 0) {
        // 空批次 = 兜底定时全量增量扫描（Linux fallback）
        const batch = await scanIncremental(this.root, this.buildKnownSnapshot(), {
          customIgnore: this.customIgnore,
        });
        if (this.stopped) return;
        if (batch.added.length + batch.modified.length + batch.removed.length > 0) {
          this.applyBatchInternal(batch);
          this.refreshStats();
          this.deps.onStatusChange();
        }
        return;
      }

      const added: FileEntry[] = [];
      const modified: FileEntry[] = [];
      const removed: string[] = [];
      for (const rel of relPaths) {
        const key = pathKey(rel);
        const prev = this.memory.get(key);
        // 目录变更：目录自身 + 其下条目可能整树增删（前缀匹配处理）
        if (prev?.isDir) {
          for (const [k, e] of this.memory) {
            if (k.startsWith(`${key}/`)) removed.push(k);
          }
        }
        const entry = await statEntry(this.root, rel);
        if (!entry) {
          if (prev) {
            removed.push(key);
            this.memory.delete(key);
          }
          continue;
        }
        if (!prev) {
          added.push(entry);
        } else if (prev.size !== entry.size || prev.mtimeMs !== entry.mtimeMs) {
          modified.push(entry);
        }
      }
      if (added.length + modified.length + removed.length === 0) return;

      const batch: FileChangeBatch = { added, modified, removed };
      this.applyBatchInternal(batch);
      this.refreshStats();
      this.deps.onStatusChange();
    } catch (err) {
      this.deps.logger.warn('file-index watcher batch 处理失败', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 应用变更批次到内存 + 落库队列 + 通知消费者 */
  private applyBatchInternal(batch: FileChangeBatch): void {
    for (const key of batch.removed) {
      this.memory.delete(key);
      this.dirtyDeletes.add(key);
    }
    for (const e of [...batch.added, ...batch.modified]) {
      const key = pathKey(e.rel);
      this.memory.set(key, e);
      this.dirtyUpserts.push(e);
    }
    this.scheduleFlush();
    this.notifyChanges(batch);
  }

  /** glob 查询（内存匹配） */
  query(q: FileQuery): FileQueryResult {
    return queryEntries(this.memory.values(), q);
  }

  /** 按相对路径取条目 */
  getEntry(rel: string): FileEntry | undefined {
    return this.memory.get(pathKey(rel));
  }

  private buildKnownSnapshot(): KnownSnapshot {
    const entries = new Map<string, { size: number; mtimeMs: number }>();
    for (const [key, e] of this.memory) entries.set(key, { size: e.size, mtimeMs: e.mtimeMs });
    return { entries };
  }

  private refreshStats(): void {
    let fileCount = 0;
    let dirCount = 0;
    for (const e of this.memory.values()) {
      if (e.isDir) dirCount++;
      else fileCount++;
    }
    this.state = { ...this.state, fileCount, dirCount };
  }

  // ==========================================================================
  // SQLite 持久层
  // ==========================================================================

  private openDb(): void {
    this.db = new Database(join(this.dataDir, 'files.db'), { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path_key TEXT PRIMARY KEY,
        rel TEXT NOT NULL,
        name TEXT NOT NULL,
        ext TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        is_dir INTEGER NOT NULL,
        kind TEXT NOT NULL
      );
    `);
  }

  private restoreFromDb(): void {
    if (!this.db) return;
    const rows = this.db
      .query<{
        path_key: string;
        rel: string;
        name: string;
        ext: string;
        size: number;
        mtime_ms: number;
        is_dir: number;
        kind: string;
      }, SQLQueryBindings[]>('SELECT * FROM files')
      .all();
    for (const r of rows) {
      this.memory.set(r.path_key, {
        rel: r.rel,
        name: r.name,
        ext: r.ext,
        size: r.size,
        mtimeMs: r.mtime_ms,
        isDir: r.is_dir === 1,
        kind: r.kind as FileEntry['kind'],
      });
    }
    this.refreshStats();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || !this.db) return;
    const fire = (): void => {
      this.flushTimer = null;
      this.flush();
    };
    if (this.dirtyUpserts.length + this.dirtyDeletes.size >= FLUSH_THRESHOLD) {
      this.flushTimer = setTimeout(fire, 0);
    } else {
      this.flushTimer = setTimeout(fire, FLUSH_IDLE_MS);
    }
  }

  /** 落盘（防抖静默 2s 或累计 500 条触发；stop 时强制 flush） */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.db) return;
    const upserts = this.dirtyUpserts;
    const deletes = [...this.dirtyDeletes];
    this.dirtyUpserts = [];
    this.dirtyDeletes.clear();
    if (upserts.length === 0 && deletes.length === 0) return;
    try {
      const upsert = this.db.query(
        'INSERT OR REPLACE INTO files (path_key, rel, name, ext, size, mtime_ms, is_dir, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const del = this.db.query('DELETE FROM files WHERE path_key = ?');
      this.db.transaction(() => {
        for (const e of upserts) {
          upsert.run(pathKey(e.rel), e.rel, e.name, e.ext, e.size, e.mtimeMs, e.isDir ? 1 : 0, e.kind);
        }
        for (const key of deletes) del.run(key);
      })();
    } catch (err) {
      this.deps.logger.warn('file-index 落盘失败', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
