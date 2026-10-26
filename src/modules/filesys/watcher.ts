// src/modules/filesys/watcher.ts
// 实时文件监控（FileWatchService）：独立于 AI 工具调用的工作区文件变更捕获。
//
// 设计目标（修复「外部脚本/终端改写文件没有 diff」）：
//   - fs.watch(recursive) 监听任务工作目录，300ms 防抖后主动读取文件内容并与基线比对；
//   - 基线保存「路径 → mtime/size/hash/文本内容」，变化时计算 before → after 的 unified diff；
//   - 通过 file-history 的 recordWatchChange 持久化（before 自动备份，供净差异与 undo）；
//   - 工具自身写入（write/edit/delete/move/copy）通过 isRecentlyInternalWritten 抑制，
//     避免同一变更被工具与监控重复记录；
//   - 忽略 node_modules/.git/dist 等产物目录，但**不忽略项目内 .moss、.log、隐藏配置**；
//   - 限流 + 内容内存预算 + watcher 异常重建，保证长跑稳定。
//
// 说明：本例不依赖 file-history 的具体类型（走最小结构类型 + 运行时 tryResolve），
// 避免 filesys → file-history 的模块级循环依赖（与 terminal-watch 同一约定）。

import { watch as fsWatch, readFileSync, statSync, type FSWatcher, type Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { hashBuffer } from './hash';
import { computeAddedFileDiff, computeDeletedFileDiff, computeLineDiff } from '../file-history/diff';
import { ServiceNames, type Logger, type ServiceRegistry } from '../../core/types';
import type { FileChangeEvent } from './types';

/** 防抖窗口（ms）：Windows 一次保存常拆成多个 fs.watch 事件 */
const DEBOUNCE_MS = 300;

/** 基线文件数上限（超出停止扫描，但已监听路径仍继续处理） */
const MAX_FILES = 20000;

/** 单文件内容读取上限（超过只记录元数据，不生成 diff） */
const MAX_FILE_BYTES = 512 * 1024;

/** 基线文本内容内存预算（LRU 淘汰最旧内容） */
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;

/** 每分钟最多登记条目数（防构建/批量生成风暴） */
const MAX_RECORDS_PER_MINUTE = 120;

/** Linux 无 recursive watch 时的兜底扫描间隔 */
const FALLBACK_SCAN_INTERVAL_MS = 30_000;

/** watcher 异常重建：5s 后重试，每分钟最多 3 次 */
const RESTART_DELAY_MS = 5000;
const MAX_RESTARTS_PER_MINUTE = 3;

/** 忽略的目录名（仅明确的产物/依赖目录；项目内 .moss 与 .log 不忽略） */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '.cache', '.turbo', '.output', '.vercel', 'coverage', '__pycache__',
  '.venv', 'venv', 'target', '.trash',
]);

/** 忽略的临时文件后缀 */
const IGNORE_FILE_SUFFIXES = ['.tmp', '.swp', '.swo', '~'];

/** file-history 侧的最小结构类型（运行时 tryResolve，避免模块循环依赖） */
export interface WatchHistorySupport {
  recordWatchChange(req: {
    sessionId: string;
    absPath: string;
    operation: 'create' | 'edit' | 'delete';
    before: Buffer | null;
    after: Buffer | null;
    diff?: string;
    toolCallId?: string;
  }): void;
  listTrackedPaths?(sessionId: string): string[];
}

export interface FileWatchDeps {
  logger: Logger;
  services: ServiceRegistry;
  /** 变更事件出口（由 FilesysServiceImpl 注入，内部会触发 WS 广播） */
  emitChange: (e: FileChangeEvent) => void;
  /** 工具自身写入的近期路径（命中则只更新基线，不重复登记） */
  isRecentlyInternalWritten: (absPath: string) => boolean;
}

/** 基线文件状态 */
interface BaselineFile {
  mtimeMs: number;
  size: number;
  /** 内容 sha256；超过读取上限时为 null（只按 size/mtime 比对） */
  hash: string | null;
  /** 文本内容（≤MAX_FILE_BYTES 且非二进制时保存；淘汰后为 null） */
  buffer: Buffer | null;
}

interface WatchEntry {
  cwd: string;
  sessionId: string;
  watcher: FSWatcher | null;
  baseline: Map<string, BaselineFile>;
  /** 基线文本内容总字节（LRU 淘汰用） */
  textBytes: number;
  pending: Set<string>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  fallbackTimer: ReturnType<typeof setInterval> | null;
  /** 基线扫描完成标记：false 时事件排队等待，避免把扫描中的文件误判为 create */
  ready: boolean;
  /** 最近 60s 内登记条目的时间戳（限流） */
  recentRecords: number[];
  /** 最近 60s 内 watcher 重建次数 */
  recentRestarts: number[];
}

/** 相对路径归一化（Windows 反斜杠 → 正斜杠） */
function normalizeRel(rel: string): string {
  return rel.split('\\').join('/');
}

/** 是否忽略该相对路径（目录黑名单 / 临时文件 / 系统垃圾文件） */
export function shouldIgnoreWatchPath(relPath: string): boolean {
  const segments = normalizeRel(relPath).split('/').filter(Boolean);
  if (segments.length === 0) return true;
  for (let i = 0; i < segments.length - 1; i++) {
    if (IGNORE_DIRS.has(segments[i].toLowerCase())) return true;
  }
  const name = segments[segments.length - 1];
  if (!name) return true;
  if (name === '.DS_Store' || name === 'Thumbs.db') return true;
  const lower = name.toLowerCase();
  return IGNORE_FILE_SUFFIXES.some(s => lower.endsWith(s));
}

/** cwd 归一化 key（Windows 大小写不敏感；分隔符统一） */
function cwdKey(cwd: string): string {
  return normalizeRel(cwd).replace(/\/+$/, '').toLowerCase();
}

/** 从磁盘读取基线（异步，供启动扫描；内容超限/二进制只保留元数据） */
async function readBaseline(absPath: string): Promise<BaselineFile | null> {
  try {
    const s = await stat(absPath);
    if (!s.isFile()) return null;
    if (s.size > MAX_FILE_BYTES) {
      return { mtimeMs: s.mtimeMs, size: s.size, hash: null, buffer: null };
    }
    const buf = await readFile(absPath);
    const isBinary = buf.includes(0);
    return {
      mtimeMs: s.mtimeMs,
      size: s.size,
      hash: hashBuffer(buf),
      buffer: isBinary ? null : buf,
    };
  } catch {
    return null;
  }
}

/**
 * 实时文件监控服务。
 * 生命周期：FilesysServiceImpl 构造时创建，watchDirectory() 注册任务目录，stopAll() 销毁。
 */
export class FileWatchService {
  private readonly entries = new Map<string, WatchEntry>();

  constructor(private readonly deps: FileWatchDeps) {}

  /**
   * 注册工作目录监控：同 cwd 只保留一个 watcher，重复注册仅更新绑定的会话
   * （最近打开/运行的任务优先）。
   */
  async watch(cwd: string, sessionId: string): Promise<void> {
    const key = cwdKey(cwd);
    const existing = this.entries.get(key);
    if (existing) {
      existing.sessionId = sessionId;
      return;
    }

    const entry: WatchEntry = {
      cwd,
      sessionId,
      watcher: null,
      baseline: new Map(),
      textBytes: 0,
      pending: new Set(),
      debounceTimer: null,
      restartTimer: null,
      fallbackTimer: null,
      ready: false,
      recentRecords: [],
      recentRestarts: [],
    };
    this.entries.set(key, entry);
    // 先建立 fs.watch（扫描期间的事件先入 pending），基线扫描完成后统一处理
    this.startWatcher(entry);
    try {
      await this.scanBaseline(entry);
    } catch (err) {
      this.deps.logger.warn('filesys: watch baseline scan failed', {
        cwd,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    entry.ready = true;
    this.flush(entry);
  }

  /** 任务删除时解除该会话的监控 */
  unwatchSession(sessionId: string): void {
    for (const [key, entry] of [...this.entries.entries()]) {
      if (entry.sessionId !== sessionId) continue;
      this.stopEntry(entry);
      this.entries.delete(key);
    }
  }

  /** 模块销毁：关闭全部 watcher */
  stopAll(): void {
    for (const entry of this.entries.values()) this.stopEntry(entry);
    this.entries.clear();
  }

  /** 立即处理某个 cwd 的待定变更（测试与手动触发用；正常路径由防抖自动调用） */
  flushNow(cwd: string): void {
    const entry = this.entries.get(cwdKey(cwd));
    if (!entry) return;
    this.flush(entry);
  }

  /** 立即处理单个路径（测试用：不依赖 fs.watch 事件到达时机） */
  processPathNow(cwd: string, absPath: string): void {
    const entry = this.entries.get(cwdKey(cwd));
    if (!entry || !entry.ready) return;
    this.processPaths(entry, [absPath]);
  }

  /**
   * 处理一批变更路径（由 flush() 在防抖窗口结束后调用）。
   */
  private processPaths(entry: WatchEntry, paths: readonly string[]): void {
    for (const absPath of paths) {
      const rel = normalizeRel(relative(entry.cwd, absPath));
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      if (shouldIgnoreWatchPath(rel)) continue;

      // 工具自身写入：只同步基线，避免重复登记
      if (this.deps.isRecentlyInternalWritten(absPath)) {
        this.refreshBaseline(entry, absPath);
        continue;
      }

      let s: Stats | null = null;
      try {
        s = statSync(absPath);
      } catch {
        s = null;
      }
      if (s && s.isFile()) {
        this.handleFileChange(entry, absPath, s);
      } else {
        this.handleFileDelete(entry, absPath);
      }
    }
  }

  // ==========================================================================
  // watcher 生命周期
  // ==========================================================================

  private startWatcher(entry: WatchEntry): void {
    try {
      entry.watcher = fsWatch(entry.cwd, { recursive: true }, (_event, filename) => {
        if (!entry.ready) {
          // 基线未就绪：先排队，扫描完成后 flush
          if (filename) {
            const rel = String(filename);
            if (!shouldIgnoreWatchPath(rel)) entry.pending.add(join(entry.cwd, rel));
          }
          return;
        }
        if (!filename) return;
        const rel = String(filename);
        if (shouldIgnoreWatchPath(rel)) return;
        entry.pending.add(join(entry.cwd, rel));
        this.scheduleFlush(entry);
      });
      entry.watcher.on('error', (err) => {
        this.deps.logger.warn('filesys: watch error, restarting', {
          cwd: entry.cwd,
          error: err instanceof Error ? err.message : String(err),
        });
        this.restart(entry);
      });
    } catch {
      // Linux：recursive 不支持 → 30s 全量扫描兜底
      this.deps.logger.debug('filesys: recursive watch unsupported, using fallback scan', {
        cwd: entry.cwd,
      });
      this.startFallback(entry);
    }
  }

  private stopEntry(entry: WatchEntry): void {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    if (entry.fallbackTimer) clearInterval(entry.fallbackTimer);
    entry.debounceTimer = null;
    entry.restartTimer = null;
    entry.fallbackTimer = null;
    try {
      entry.watcher?.close();
    } catch {
      // 关闭异常忽略
    }
    entry.watcher = null;
    entry.pending.clear();
    entry.baseline.clear();
    entry.textBytes = 0;
  }

  private restart(entry: WatchEntry): void {
    const now = Date.now();
    entry.recentRestarts = entry.recentRestarts.filter(t => now - t < 60_000);
    if (entry.recentRestarts.length >= MAX_RESTARTS_PER_MINUTE) {
      this.deps.logger.warn('filesys: watch restart throttled', { cwd: entry.cwd });
      return;
    }
    entry.recentRestarts.push(now);
    try {
      entry.watcher?.close();
    } catch {
      // 忽略
    }
    entry.watcher = null;
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      this.startWatcher(entry);
    }, RESTART_DELAY_MS);
  }

  // ==========================================================================
  // 基线
  // ==========================================================================

  /** 启动时异步扫描工作目录，建立「路径 → 内容/hash」基线（不产生条目） */
  private async scanBaseline(entry: WatchEntry): Promise<void> {
    const stack: string[] = [entry.cwd];
    let count = 0;
    while (stack.length > 0) {
      if (count >= MAX_FILES) break;
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (count >= MAX_FILES) break;
        const absPath = join(dir, ent.name);
        const rel = normalizeRel(relative(entry.cwd, absPath));
        if (shouldIgnoreWatchPath(rel)) continue;
        if (ent.isDirectory()) {
          stack.push(absPath);
          continue;
        }
        if (!ent.isFile()) continue;
        const baseline = await readBaseline(absPath);
        if (baseline) {
          this.setBaseline(entry, absPath, baseline);
          count++;
        }
      }
    }
    // 不丢弃扫描期间入队的路径：扫描完成后交由 flush 做 hash 比对（真实变更不会被静默吞掉）
  }

  /** 读取当前磁盘状态更新基线（不产生历史条目） */
  private refreshBaseline(entry: WatchEntry, absPath: string): void {
    let s: Stats;
    try {
      s = statSync(absPath);
    } catch {
      entry.baseline.delete(absPath);
      return;
    }
    if (!s.isFile()) {
      entry.baseline.delete(absPath);
      return;
    }
    let buffer: Buffer | null = null;
    if (s.size <= MAX_FILE_BYTES) {
      try {
        buffer = readFileSync(absPath);
      } catch {
        buffer = null;
      }
    }
    this.setBaseline(entry, absPath, {
      mtimeMs: s.mtimeMs,
      size: s.size,
      hash: buffer ? hashBuffer(buffer) : null,
      buffer: buffer && !buffer.includes(0) ? buffer : null,
    });
  }

  private setBaseline(entry: WatchEntry, absPath: string, file: BaselineFile): void {
    const prev = entry.baseline.get(absPath);
    if (prev?.buffer) entry.textBytes -= prev.buffer.length;
    entry.baseline.set(absPath, file);
    if (file.buffer) entry.textBytes += file.buffer.length;
    this.evictContent(entry);
  }

  /** 内容预算 LRU：超出后按插入顺序淘汰最早条目的文本（保留元数据） */
  private evictContent(entry: WatchEntry): void {
    if (entry.textBytes <= MAX_CONTENT_BYTES) return;
    for (const [absPath, file] of entry.baseline) {
      if (entry.textBytes <= MAX_CONTENT_BYTES) break;
      if (!file.buffer) continue;
      entry.textBytes -= file.buffer.length;
      entry.baseline.set(absPath, { ...file, buffer: null });
    }
  }

  // ==========================================================================
  // 变更处理
  // ==========================================================================

  private scheduleFlush(entry: WatchEntry): void {
    if (entry.debounceTimer) return;
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      this.flush(entry);
    }, DEBOUNCE_MS);
  }

  private flush(entry: WatchEntry): void {
    if (!entry.ready) {
      // 基线未就绪：稍后再试（scanBaseline 完成后会主动 flush 一次）
      if (entry.pending.size > 0 && !entry.debounceTimer) {
        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = null;
          this.flush(entry);
        }, DEBOUNCE_MS);
      }
      return;
    }
    if (entry.pending.size === 0) return;
    const paths = [...entry.pending];
    entry.pending.clear();
    this.processPaths(entry, paths);
  }

  private handleFileChange(entry: WatchEntry, absPath: string, s: Stats): void {
    const prev = entry.baseline.get(absPath);

    let buffer: Buffer | null = null;
    if (s.size <= MAX_FILE_BYTES) {
      try {
        buffer = readFileSync(absPath);
      } catch {
        buffer = null;
      }
    }
    const hash = buffer ? hashBuffer(buffer) : null;

    // 幽灵事件（atime 等）：内容 hash 未变，或大文件 mtime/size 未变
    if (prev) {
      if (hash && prev.hash && hash === prev.hash) return;
      if (!hash && !prev.hash && prev.size === s.size && prev.mtimeMs === s.mtimeMs) return;
    }

    const isBinary = buffer ? buffer.includes(0) : false;
    const afterText = buffer && !isBinary ? buffer.toString('utf8') : null;
    const beforeBuffer = prev?.buffer ?? null;
    const beforeText = beforeBuffer ? beforeBuffer.toString('utf8') : null;

    let diff: string | undefined;
    if (afterText !== null) {
      if (!prev) diff = computeAddedFileDiff(afterText);
      else if (beforeText !== null) diff = computeLineDiff(beforeText, afterText);
    }

    if (this.canRecord(entry)) {
      this.resolveHistory()?.recordWatchChange({
        sessionId: entry.sessionId,
        absPath,
        operation: prev ? 'edit' : 'create',
        before: beforeBuffer,
        after: buffer && !isBinary ? buffer : null,
        diff,
      });
      entry.recentRecords.push(Date.now());
      this.deps.emitChange({
        kind: prev ? 'edited' : 'created',
        absPath,
        source: 'watch',
        sessionId: entry.sessionId,
      });
    }

    this.setBaseline(entry, absPath, {
      mtimeMs: s.mtimeMs,
      size: s.size,
      hash,
      buffer: buffer && !isBinary ? buffer : null,
    });
  }

  private handleFileDelete(entry: WatchEntry, absPath: string): void {
    const prev = entry.baseline.get(absPath);
    if (!prev) return;

    const beforeText = prev.buffer ? prev.buffer.toString('utf8') : null;
    const diff = beforeText !== null ? computeDeletedFileDiff(beforeText) : undefined;

    if (this.canRecord(entry)) {
      this.resolveHistory()?.recordWatchChange({
        sessionId: entry.sessionId,
        absPath,
        operation: 'delete',
        before: prev.buffer,
        after: null,
        diff,
      });
      entry.recentRecords.push(Date.now());
      this.deps.emitChange({
        kind: 'deleted',
        absPath,
        source: 'watch',
        sessionId: entry.sessionId,
      });
    }

    if (prev.buffer) entry.textBytes -= prev.buffer.length;
    entry.baseline.delete(absPath);
  }

  /** 限流：每分钟最多登记 MAX_RECORDS_PER_MINUTE 条 */
  private canRecord(entry: WatchEntry): boolean {
    const now = Date.now();
    entry.recentRecords = entry.recentRecords.filter(t => now - t < 60_000);
    return entry.recentRecords.length < MAX_RECORDS_PER_MINUTE;
  }

  private resolveHistory(): WatchHistorySupport | null {
    try {
      const svc = this.deps.services.tryResolve<Partial<WatchHistorySupport>>(ServiceNames.FILE_HISTORY);
      if (svc && typeof svc.recordWatchChange === 'function') return svc as WatchHistorySupport;
    } catch {
      // 服务未注册
    }
    return null;
  }

  // ==========================================================================
  // Linux / recursive 不可用时的兜底扫描
  // ==========================================================================

  private startFallback(entry: WatchEntry): void {
    if (entry.fallbackTimer) return;
    entry.fallbackTimer = setInterval(() => {
      void this.fallbackScan(entry);
    }, FALLBACK_SCAN_INTERVAL_MS);
  }

  private async fallbackScan(entry: WatchEntry): Promise<void> {
    const seen = new Set<string>();
    const stack: string[] = [entry.cwd];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const absPath = join(dir, ent.name);
        const rel = normalizeRel(relative(entry.cwd, absPath));
        if (shouldIgnoreWatchPath(rel)) continue;
        if (ent.isDirectory()) stack.push(absPath);
        else if (ent.isFile()) seen.add(absPath);
      }
    }
    for (const absPath of seen) entry.pending.add(absPath);
    for (const absPath of entry.baseline.keys()) {
      if (!seen.has(absPath)) entry.pending.add(absPath);
    }
    this.flush(entry);
  }
}
