// src/modules/filesys/cache.ts
// 读缓存层：文件内容 + mtimeMs/size 双字段校验 + LRU 淘汰。
// 目标：read 的"内容读取 / sha256 / 编码分类"共享一次磁盘 I/O（旧实现同文件读 3 次盘）；
//       写路径完成后主动更新缓存，写后紧跟的 read / edit expectHash 免读盘。

import type { FileContentKind } from '../../utils/fs';

export interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  /** 原始字节（含 BOM）；超过 maxFileBytes 的大文件为 null（派生值算完即弃） */
  rawBuffer: Buffer | null;
  /** sha256(rawBuffer) */
  sha256: string;
  kind: FileContentKind;
  /** 上次被 read 工具读取的时间戳（dedup 语义，替代旧 read/shared/dedup.ts） */
  lastReadAt: number;
}

export interface CacheLimits {
  maxBytes: number;
  maxEntries: number;
  maxFileBytes: number;
}

/** 待写入缓存的派生数据（rawBuffer 是否入缓存由 maxFileBytes 决定） */
export interface CacheUpsertInput {
  rawBuffer: Buffer;
  sha256: string;
  kind: FileContentKind;
  mtimeMs: number;
  size: number;
  lastReadAt?: number;
}

export class FileCache {
  /** Map 迭代序 = 插入序，配合 get 时重插入实现 LRU（最旧在头部） */
  private readonly entries = new Map<string, FileCacheEntry>();
  private totalBytes = 0;
  private limits: CacheLimits;

  constructor(limits: CacheLimits) {
    this.limits = limits;
  }

  /** 运行期更新上限（config 热变更时收缩/扩容，收缩后立即淘汰） */
  updateLimits(limits: CacheLimits): void {
    this.limits = limits;
    this.evictIfNeeded();
  }

  /**
   * 校验式读取：stat 与缓存条目 mtimeMs/size 双字段全等才命中（防 mtime 精度/回绕）；
   * 不匹配（文件已变）删除过期条目并返回 null。
   */
  get(absPath: string, stat: { mtimeMs: number; size: number }): FileCacheEntry | null {
    const entry = this.entries.get(absPath);
    if (!entry) return null;
    if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      this.delete(absPath);
      return null;
    }
    // LRU 提升：移到迭代序尾（最新）
    this.entries.delete(absPath);
    this.entries.set(absPath, entry);
    return entry;
  }

  /**
   * 无校验窥视：直接取缓存条目（不过期）。
   * 供 terminal-watch 拿"执行前内容"——终端命令修改后 mtime 已变，get 会判定失效，
   * 但旧 buffer 正是我们要的执行前状态。
   */
  peek(absPath: string): FileCacheEntry | null {
    return this.entries.get(absPath) ?? null;
  }

  /** 写入/更新条目（写路径完成后调用；超 maxFileBytes 的内容只存派生值） */
  set(absPath: string, input: CacheUpsertInput): FileCacheEntry {
    const keepBuffer = input.rawBuffer.length <= this.limits.maxFileBytes;
    const prev = this.entries.get(absPath);
    if (prev?.rawBuffer) this.totalBytes -= prev.rawBuffer.length;
    const entry: FileCacheEntry = {
      mtimeMs: input.mtimeMs,
      size: input.size,
      rawBuffer: keepBuffer ? input.rawBuffer : null,
      sha256: input.sha256,
      kind: input.kind,
      lastReadAt: input.lastReadAt ?? prev?.lastReadAt ?? 0,
    };
    if (keepBuffer) this.totalBytes += input.rawBuffer.length;
    this.entries.delete(absPath);
    this.entries.set(absPath, entry);
    this.evictIfNeeded();
    return entry;
  }

  /** 仅更新 lastReadAt（read 工具 dedup 标记，条目可能无 buffer——大文件） */
  touchRead(absPath: string): void {
    const entry = this.entries.get(absPath);
    if (!entry) return;
    entry.lastReadAt = Date.now();
  }

  /**
   * 仅登记派生值（rawBuffer 置 null）：供外部流式写入后同步缓存（内容不在内存，
   * 但 sha256/元数据已知，后续哈希比对免读盘；readFile 命中时自动补读内容）。
   */
  setMeta(
    absPath: string,
    meta: { mtimeMs: number; size: number; sha256: string; kind: FileContentKind },
  ): FileCacheEntry {
    const prev = this.entries.get(absPath);
    if (prev?.rawBuffer) this.totalBytes -= prev.rawBuffer.length;
    const entry: FileCacheEntry = {
      mtimeMs: meta.mtimeMs,
      size: meta.size,
      rawBuffer: null,
      sha256: meta.sha256,
      kind: meta.kind,
      lastReadAt: prev?.lastReadAt ?? 0,
    };
    this.entries.delete(absPath);
    this.entries.set(absPath, entry);
    this.evictIfNeeded();
    return entry;
  }

  delete(absPath: string): void {
    const entry = this.entries.get(absPath);
    if (!entry) return;
    if (entry.rawBuffer) this.totalBytes -= entry.rawBuffer.length;
    this.entries.delete(absPath);
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.totalBytes };
  }

  /** LRU 淘汰：从迭代序头（最旧）开始驱逐，直到满足双上限 */
  private evictIfNeeded(): void {
    while (this.entries.size > this.limits.maxEntries || this.totalBytes > this.limits.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }
}
