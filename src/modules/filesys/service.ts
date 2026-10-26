// src/modules/filesys/service.ts
// FilesysService 实现：统一文件系统操作入口。
// 读缓存（一次 I/O 全派生）+ roots 越权 + 原子写 + 乐观锁（sha256 一律对原始字节，
// 修复 BOM 文件 read→edit expectHash 断裂）+ 变更事件 + 终端命令快照检测。

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { hasUtf8Bom } from '../../utils/encoding';
import { readHeadBytes, atomicWriteFile } from '../../utils/fs-atomic';
import { classifyBufferHead } from '../../utils/fs';
import { FileCache } from './cache';
import { FilesysEventBus } from './events';
import { hashBuffer } from './hash';
import { normalizeRoots, resolveInRoots } from './roots';
import { TerminalWatcher } from './terminal-watch';
import { FileWatchService } from './watcher';
import type {
  FileChangeEvent,
  FilesysConfig,
  FilesysService,
  ReadFileResult,
  TerminalSnapshot,
  TerminalChangeReport,
  WriteFileOptions,
  WriteFileResult,
} from './types';
import type { Logger, ServiceRegistry } from '../../core/types';

const KIND_SAMPLE_BYTES = 8192;

export class FilesysServiceImpl implements FilesysService {
  private readonly cache: FileCache;
  private readonly bus: FilesysEventBus;
  private readonly watcher: TerminalWatcher;
  private readonly fileWatch: FileWatchService;
  /** 工具自身写入的路径 → 时间戳（实时监控据此抑制重复登记） */
  private readonly recentInternalWrites = new Map<string, number>();
  private readonly getConfig: () => FilesysConfig;
  private readonly logger: Logger;

  constructor(
    deps: {
      logger: Logger;
      services: ServiceRegistry;
      getConfig: () => FilesysConfig;
    },
  ) {
    this.logger = deps.logger;
    this.getConfig = deps.getConfig;
    this.cache = new FileCache({
      maxBytes: this.getConfig().cacheMaxBytes,
      maxEntries: this.getConfig().cacheMaxEntries,
      maxFileBytes: this.getConfig().cacheMaxFileBytes,
    });
    this.bus = new FilesysEventBus();
    this.watcher = new TerminalWatcher({
      cache: this.cache,
      logger: deps.logger,
      services: deps.services,
      getConfig: () => this.getConfig().terminalWatch,
    });
    this.fileWatch = new FileWatchService({
      logger: deps.logger,
      services: deps.services,
      emitChange: (e) => this.emitChange(e),
      isRecentlyInternalWritten: (absPath) => this.isRecentlyInternalWritten(absPath),
    });
  }

  resolve(rawPath: string, cwd: string): string | null {
    return resolveInRoots(rawPath, cwd, this.listRoots());
  }

  readFile(absPath: string): ReadFileResult | null {
    const stat = this.statOf(absPath);
    if (!stat) return null;

    const cached = this.cache.get(absPath, stat);
    if (cached) {
      // 派生值（sha256/kind）命中；大文件条目可能未缓存 buffer，此处补读内容
      const rawBuffer = cached.rawBuffer ?? readFileSync(absPath);
      return {
        absPath,
        rawBuffer,
        sha256: cached.sha256,
        kind: cached.kind,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        fromCache: true,
      };
    }

    const rawBuffer = readFileSync(absPath);
    const sha256 = hashBuffer(rawBuffer);
    const kind = classifyBufferHead(rawBuffer.subarray(0, KIND_SAMPLE_BYTES));
    this.cache.set(absPath, { rawBuffer, sha256, kind, mtimeMs: stat.mtimeMs, size: stat.size });
    return { absPath, rawBuffer, sha256, kind, size: stat.size, mtimeMs: stat.mtimeMs, fromCache: false };
  }

  writeFile(absPath: string, data: string | Buffer, opts: WriteFileOptions): WriteFileResult {
    // 1. 乐观锁：expectHash 与磁盘当前原始字节哈希比对（修复旧版 edit 对 BOM 文件误报）
    const existed = existsSync(absPath);
    if (opts.expectHash !== undefined) {
      const cur = this.hashFile(absPath);
      if (!cur || cur.sha256 !== opts.expectHash) {
        return {
          ok: false,
          reason: 'hash-mismatch',
          currentHash: cur?.sha256,
          message: `expectHash mismatch: expected ${opts.expectHash}, disk has ${cur?.sha256 ?? '<missing>'}`,
        };
      }
    }

    // 2. BOM 决策与最终字节（与 atomicWriteFile 内置语义一致，但 service 需要最终字节算哈希）
    let finalBuffer: Buffer;
    const preserveBom = opts.preserveBom ?? true;
    if (typeof data === 'string' && preserveBom && existed) {
      let hadBom = false;
      try {
        hadBom = hasUtf8Bom(readHeadBytes(absPath, 3));
      } catch {
        hadBom = false;
      }
      const dataHasBom = data.charCodeAt(0) === 0xfeff;
      finalBuffer = hadBom && !dataHasBom
        ? Buffer.from('\uFEFF' + data, 'utf8')
        : Buffer.from(data, 'utf8');
    } else if (typeof data === 'string') {
      finalBuffer = Buffer.from(data, 'utf8');
    } else {
      finalBuffer = data;
    }
    const sha256 = hashBuffer(finalBuffer);

    // 3. 原子写（BOM 已由本层处理，禁用 atomicWriteFile 内置分支避免二次前置）
    try {
      if (opts.createDirs !== false) {
        mkdirSync(dirname(absPath), { recursive: true });
      }
      atomicWriteFile(absPath, finalBuffer, {
        fsync: opts.fsync ?? true,
        preserveBom: false,
        preserveMode: true,
      });
    } catch (err) {
      return {
        ok: false,
        reason: 'io-error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 4. 缓存主动更新（写后紧跟的 read / edit expectHash 免读盘）
    const stat = this.statOf(absPath);
    const mtimeMs = stat?.mtimeMs ?? Date.now();
    const kind = classifyBufferHead(finalBuffer.subarray(0, KIND_SAMPLE_BYTES));
    this.cache.set(absPath, {
      rawBuffer: finalBuffer,
      sha256,
      kind,
      mtimeMs,
      size: finalBuffer.length,
    });

    // 5. 变更事件
    this.emitChange({
      kind: existed ? 'edited' : 'created',
      absPath,
      source: opts.source,
      sessionId: opts.sessionId,
      toolCallId: opts.toolCallId,
    });

    return { ok: true, absPath, sha256, bytes: finalBuffer.length, mtimeMs };
  }

  hashFile(absPath: string): { sha256: string; size: number; mtimeMs: number } | null {
    const stat = this.statOf(absPath);
    if (!stat) return null;
    const cached = this.cache.get(absPath, stat);
    if (cached) {
      return { sha256: cached.sha256, size: stat.size, mtimeMs: stat.mtimeMs };
    }
    try {
      const buf = readFileSync(absPath);
      const sha256 = hashBuffer(buf);
      this.cache.set(absPath, {
        rawBuffer: buf,
        sha256,
        kind: classifyBufferHead(buf.subarray(0, KIND_SAMPLE_BYTES)),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
      return { sha256, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  recordExternalWrite(
    absPath: string,
    meta: { sha256: string; bytes: number; kind?: 'utf8' | 'legacy-text' | 'binary' },
    opts: { source: string; sessionId?: string; toolCallId?: string; existed: boolean },
  ): void {
    const stat = this.statOf(absPath);
    this.cache.setMeta(absPath, {
      mtimeMs: stat?.mtimeMs ?? Date.now(),
      size: stat?.size ?? meta.bytes,
      sha256: meta.sha256,
      kind: meta.kind ?? 'utf8',
    });
    this.emitChange({
      kind: opts.existed ? 'edited' : 'created',
      absPath,
      source: opts.source,
      sessionId: opts.sessionId,
      toolCallId: opts.toolCallId,
    });
  }

  onFileChange(handler: (e: FileChangeEvent) => void): () => void {
    return this.bus.on(handler);
  }

  emitChange(event: FileChangeEvent): void {
    // 工具自身写入：记录抑制窗口，实时监控只同步基线、不重复登记。
    // 'watch' / 'terminal' 是监控来源，不算内部写入（否则会把自己的变更也抑制掉）。
    const source = event.source;
    if (
      source === 'write' || source === 'edit' || source === 'delete'
      || source === 'move' || source === 'copy' || source === 'internal'
    ) {
      const now = Date.now();
      this.recentInternalWrites.set(event.absPath, now);
      if (event.destPath) this.recentInternalWrites.set(event.destPath, now);
      if (this.recentInternalWrites.size > 5000) {
        for (const [p, ts] of this.recentInternalWrites) {
          if (now - ts > 30_000) this.recentInternalWrites.delete(p);
        }
      }
    }
    this.bus.emit(event);
  }

  /** 是否在抑制窗口内由工具自身写入（实时监控跳过重复登记） */
  private isRecentlyInternalWritten(absPath: string, windowMs = 3000): boolean {
    const ts = this.recentInternalWrites.get(absPath);
    return ts !== undefined && Date.now() - ts <= windowMs;
  }

  listRoots(): string[] {
    return normalizeRoots(this.getConfig().roots);
  }

  async beginTerminalSnapshot(cwd: string, sessionId?: string): Promise<TerminalSnapshot | null> {
    return this.watcher.begin(cwd, this.listRoots(), sessionId);
  }

  async endTerminalSnapshot(
    snap: TerminalSnapshot,
    sessionId: string,
    toolCallId: string,
  ): Promise<TerminalChangeReport | null> {
    try {
      const report = await this.watcher.end(snap, sessionId, toolCallId);
      if (report.created.length + report.modified.length + report.deleted.length > 0) {
        this.emitChange({
          kind: 'terminal-changed',
          absPath: snap.roots[0] ?? '',
          source: 'terminal',
          sessionId,
          toolCallId,
          report,
        });
      }
      return report;
    } catch (err) {
      this.logger.warn('filesys: terminal snapshot end failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async watchDirectory(cwd: string, sessionId: string): Promise<void> {
    if (!cwd) return;
    await this.fileWatch.watch(cwd, sessionId);
  }

  unwatchSession(sessionId: string): void {
    this.fileWatch.unwatchSession(sessionId);
  }

  /** 模块销毁：关闭全部实时 watcher */
  dispose(): void {
    this.fileWatch.stopAll();
  }

  cacheStats(): { entries: number; bytes: number } {
    return this.cache.stats();
  }

  private statOf(absPath: string): { size: number; mtimeMs: number } | null {
    try {
      const s = statSync(absPath);
      if (!s.isFile()) return null;
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  }
}
