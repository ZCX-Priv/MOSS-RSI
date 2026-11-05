// src/modules/tools/shared/scan-cache.ts
// 工具级文件列表缓存：glob / grep 各自持有一个独立实例（互不共享状态与生命周期）。
// 只缓存目录枚举结果（不读文件内容、不做全树 stat），TTL + LRU 控制内存，
// 避免重蹈旧文件索引体系「启动全量扫描 + 常驻内存膨胀」的性能问题。

import { walkFiles, type WalkEntry } from './search-core';

export interface ScanCacheOptions {
  /** 缓存有效期（ms）；过期后下次调用重新枚举 */
  ttlMs?: number;
  /** 同时保留的根目录数量（LRU 淘汰） */
  maxRoots?: number;
  /** 单次枚举条目上限（与 walkFiles 的 maxFiles 对齐） */
  maxEntries?: number;
}

interface CacheEntry {
  key: string;
  root: string;
  entries: WalkEntry[];
  at: number;
}

export class ScanCache {
  private readonly ttlMs: number;
  private readonly maxRoots: number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: ScanCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.maxRoots = Math.max(1, opts.maxRoots ?? 2);
    this.maxEntries = Math.max(1, opts.maxEntries ?? 50_000);
  }

  /**
   * 枚举 root 下的文件/目录（带缓存）。
   * 调用方负责在内存中做 glob/类型过滤；mtime 排序仍由调用方对命中项单独 stat。
   */
  async list(
    root: string,
    opts: { noIgnore: boolean; dot: boolean; includeDirs: boolean },
  ): Promise<WalkEntry[]> {
    const key = `${root}\u0000${opts.noIgnore ? 1 : 0}${opts.dot ? 1 : 0}${opts.includeDirs ? 1 : 0}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      // LRU 触碰：最近使用移到末尾
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.entries;
    }

    const entries: WalkEntry[] = [];
    for await (const entry of walkFiles(root, {
      noIgnore: opts.noIgnore,
      dot: opts.dot,
      includeDirs: opts.includeDirs,
      maxFiles: this.maxEntries,
    })) {
      entries.push(entry);
    }

    const record: CacheEntry = { key, root, entries, at: Date.now() };
    this.cache.delete(key);
    this.cache.set(key, record);
    while (this.cache.size > this.maxRoots) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return entries;
  }

  /** 清空指定根（或全部）的缓存 */
  invalidate(root?: string): void {
    if (root === undefined) {
      this.cache.clear();
      return;
    }
    for (const [key, entry] of this.cache) {
      if (entry.root === root) this.cache.delete(key);
    }
  }
}
