// src/modules/memory/retriever.ts
// 记忆检索器：BM25 打分（自实现零依赖）+ 元数据过滤 + importance×recency 加权。
// 索引惰性构建：存储 mtime 指纹失效后重建；touch 节流写盘（召回计数）。

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from '../../core/types';
import { listAllMemories, memoryRoots, projectWing } from './storage';
import { tokenize } from './tokenizer';
import type { MemoryHall, ScopedMemoryRecord } from './types';

/** 检索过滤条件 */
export interface RecallFilter {
  wing?: string;
  /** 多翼匹配（数组任一命中即可；与单值 wing 并存） */
  wings?: string[];
  room?: string;
  hall?: MemoryHall;
  tag?: string;
  /** 仅置顶 */
  pinnedOnly?: boolean;
}

interface IndexEntry {
  record: ScopedMemoryRecord;
  tokens: string[];
  /** 更新时间毫秒（recency 加权用） */
  updatedMs: number;
}

interface MemoryIndex {
  entries: IndexEntry[];
  /** BM25 统计 */
  df: Map<string, number>;
  avgLen: number;
  /** 存储指纹（双作用域 mtime 合计；变更即重建） */
  fingerprint: number;
}

/** 目录树 mtime 指纹（快速变更检测；只扫 wing/room 两层目录） */
function storageFingerprint(root: string): number {
  let max = 0;
  try {
    max = Math.max(max, statSync(root).mtimeMs);
    for (const wingEntry of readdirSync(root, { withFileTypes: true })) {
      if (!wingEntry.isDirectory()) continue;
      const wingDir = join(root, wingEntry.name);
      max = Math.max(max, statSync(wingDir).mtimeMs);
      for (const roomEntry of readdirSync(wingDir, { withFileTypes: true })) {
        if (!roomEntry.isDirectory()) continue;
        max = Math.max(max, statSync(join(wingDir, roomEntry.name)).mtimeMs);
      }
    }
  } catch {
    return -1;
  }
  return max;
}

/** BM25 参数 */
const K1 = 1.2;
const B = 0.75;

export class MemoryRetriever {
  private readonly env: Environment;
  private index: MemoryIndex | null = null;
  /** 索引构建时的 cwd（项目作用域变化即重建） */
  private indexedCwd = '';

  constructor(env: Environment) {
    this.env = env;
  }

  /** 重建索引（全量读盘 + 分词；惰性调用） */
  private ensureIndex(cwd: string): MemoryIndex {
    const { global: globalRoot, project: projectRoot } = memoryRoots(this.env, cwd);
    const fingerprint =
      storageFingerprint(globalRoot) + (projectRoot ? storageFingerprint(projectRoot) : 0);

    if (this.index && this.index.fingerprint === fingerprint && this.indexedCwd === cwd) {
      return this.index;
    }

    const records = [
      ...listAllMemories(globalRoot, 'global'),
      ...(projectRoot ? listAllMemories(projectRoot, 'project') : []),
    ];
    const entries: IndexEntry[] = records.map(record => ({
      record,
      tokens: tokenize(`${record.insight} ${record.verbatim} ${record.tags.join(' ')}`),
      updatedMs: Date.parse(record.updatedAt) || 0,
    }));

    const df = new Map<string, number>();
    let totalLen = 0;
    for (const e of entries) {
      totalLen += e.tokens.length;
      const seen = new Set(e.tokens);
      for (const tk of seen) {
        df.set(tk, (df.get(tk) ?? 0) + 1);
      }
    }
    const idx: MemoryIndex = {
      entries,
      df,
      avgLen: entries.length > 0 ? totalLen / entries.length : 0,
      fingerprint,
    };
    this.index = idx;
    this.indexedCwd = cwd;
    return idx;
  }

  /**
   * BM25 打分 + importance × recency 加权排序。
   * @param query 查询文本（用户消息）
   * @param filter 元数据过滤（wing/room/hall/tag）
   * @param topK 返回条数上限
   * @param excludeIds 排除的记忆 id（L2 去重）
   */
  recall(
    cwd: string,
    query: string,
    opts?: { filter?: RecallFilter; topK?: number; excludeIds?: ReadonlySet<string> },
  ): ScopedMemoryRecord[] {
    const idx = this.ensureIndex(cwd);
    if (idx.entries.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const topK = opts?.topK ?? 5;
    const exclude = opts?.excludeIds;
    const filter = opts?.filter;
    const N = idx.entries.length;
    const now = Date.now();

    const scored: Array<{ entry: IndexEntry; score: number }> = [];
    for (const entry of idx.entries) {
      const r = entry.record;
      if (exclude?.has(r.id)) continue;
      if (filter?.wing && r.wing !== filter.wing) continue;
      if (filter?.wings && !filter.wings.includes(r.wing)) continue;
      if (filter?.room && r.room !== filter.room) continue;
      if (filter?.hall && r.hall !== filter.hall) continue;
      if (filter?.tag && !r.tags.includes(filter.tag)) continue;
      if (filter?.pinnedOnly && !r.pinned) continue;

      // BM25 得分
      const tf = new Map<string, number>();
      for (const tk of entry.tokens) {
        tf.set(tk, (tf.get(tk) ?? 0) + 1);
      }
      let bm25 = 0;
      for (const qt of queryTokens) {
        const f = tf.get(qt);
        if (!f) continue;
        const n = idx.df.get(qt) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const norm = (f * (K1 + 1)) / (f + K1 * (1 - B + B * (entry.tokens.length / (idx.avgLen || 1))));
        bm25 += idf * norm;
      }
      if (bm25 <= 0) continue;

      // recency：30 天半衰
      const ageDays = (now - entry.updatedMs) / (1000 * 60 * 60 * 24);
      const recency = Math.pow(0.5, ageDays / 30);
      // 加权：BM25 为主，importance 与 recency 为辅
      const score = bm25 * (1 + 0.3 * r.importance + 0.2 * recency);
      scored.push({ entry, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => s.entry.record);
  }

  /**
   * L2 主题召回：当前项目 wing + 全局 user wing（个人偏好/建议的默认归档翼）双翼检索
   * + Tunnel（其他项目 wing 同名 room 跨域关联）。
   */
  recallWithTunnel(
    cwd: string,
    query: string,
    opts?: { topK?: number; excludeIds?: ReadonlySet<string> },
  ): ScopedMemoryRecord[] {
    const topK = opts?.topK ?? 5;
    const currentWing = projectWing(cwd);
    const primary = this.recall(cwd, query, {
      topK,
      filter: { wings: [currentWing, 'user'] },
      ...(opts?.excludeIds ? { excludeIds: opts.excludeIds } : {}),
    });

    // Tunnel：主 wing 命中的 room 集合，在其他 wing 中召回同 room 记忆（配额 1/3）
    if (primary.length > 0) {
      const hitRooms = new Set(primary.map(r => r.room));
      const tunnelQuota = Math.max(1, Math.floor(topK / 3));
      const tunnel: ScopedMemoryRecord[] = [];
      const seen = new Set(primary.map(r => r.id));
      for (const room of hitRooms) {
        const cross = this.recall(cwd, query, {
          topK: tunnelQuota,
          filter: { room },
          ...(opts?.excludeIds ? { excludeIds: opts.excludeIds } : {}),
        });
        for (const r of cross) {
          if (r.wing !== currentWing && !seen.has(r.id)) {
            tunnel.push(r);
            seen.add(r.id);
          }
        }
      }
      const roomOrder = [...hitRooms];
      tunnel.sort((a, b) => roomOrder.indexOf(a.room) - roomOrder.indexOf(b.room));
      return [...primary, ...tunnel.slice(0, tunnelQuota)];
    }
    return primary;
  }

  /**
   * L1 关键事实：全局 user wing + 当前项目 wing 中 pinned 或 importance≥阈值 的记忆，
   * 按 importance 降序截断 l1MaxEntries。
   */
  getL1Facts(
    cwd: string,
    opts: { importanceThreshold: number; maxEntries: number },
  ): ScopedMemoryRecord[] {
    const idx = this.ensureIndex(cwd);
    const wings = new Set(['user', projectWing(cwd)]);
    return idx.entries
      .map(e => e.record)
      .filter(r => wings.has(r.wing) && (r.pinned || r.importance >= opts.importanceThreshold))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.importance - a.importance)
      .slice(0, opts.maxEntries);
  }

  /** 使索引失效（写盘后由 service 调用） */
  invalidate(): void {
    this.index = null;
  }
}
