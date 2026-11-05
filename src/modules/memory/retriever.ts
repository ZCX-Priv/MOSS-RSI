// src/modules/memory/retriever.ts
// 记忆检索器：字段加权 BM25 + 短语加成 + 元数据加权 + 近重复去重 + 分房间配额。
//
// 索引策略（增量）：
// - 磁盘扫描只 stat（mtime/size），内容与分词结果按文件缓存；
// - 文件未变化时复用缓存，仅重读变化文件；
// - 索引重建后再次召回在 TTL 内直接命中，避免一次请求内多次全量扫描；
// - invalidate() 保留文件缓存（CRUD 后只重读真正变化的文件）。

import type { Environment } from '../../core/types';
import { memoryRoots, projectWing, readMemoryFile, scanMemoryFileInfos } from './storage';
import { tokenize, tokenOverlap } from './tokenizer';
import type { MemoryHall, ScoredMemoryRecord, ScopedMemoryRecord } from './types';

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

/** 召回权重与阈值（设置页可调；默认值保持保守） */
export interface RecallWeights {
  /** insight 字段权重 */
  insight: number;
  /** tags 字段权重 */
  tag: number;
  /** verbatim 字段权重 */
  verbatim: number;
  /** room 字段权重 */
  room: number;
  /** wing 字段权重 */
  wing: number;
  /** 重要性加成系数（1 + k × importance） */
  importance: number;
  /** recency 半衰期（天） */
  recencyHalfLifeDays: number;
  /** 置顶加成倍数 */
  pinnedBoost: number;
  /** 近重复去重阈值（Jaccard；>= 阈值跳过） */
  dedupThreshold: number;
  /** 最低分 / 最高分比例（过滤弱相关） */
  minScoreRatio: number;
  /** 每个 room 最多入选条数（0 = 不限制） */
  maxPerRoom: number;
}

export const DEFAULT_RECALL_WEIGHTS: RecallWeights = {
  insight: 2.0,
  tag: 1.5,
  verbatim: 1.0,
  room: 1.0,
  wing: 1.0,
  importance: 0.3,
  recencyHalfLifeDays: 30,
  pinnedBoost: 1.15,
  dedupThreshold: 0.8,
  minScoreRatio: 0.25,
  maxPerRoom: 0,
};

/** 召回选项（weight 缺省用 DEFAULT_RECALL_WEIGHTS） */
export interface RecallOptions {
  filter?: RecallFilter;
  topK?: number;
  excludeIds?: ReadonlySet<string>;
  weights?: Partial<RecallWeights>;
}

type FieldKey = 'insight' | 'tags' | 'verbatim' | 'room' | 'wing';

interface IndexEntry {
  file: string;
  mtimeMs: number;
  size: number;
  record: ScopedMemoryRecord;
  fields: Record<FieldKey, string[]>;
  /** 全字段 token 并集（document frequency / 去重统计） */
  allTokens: string[];
  /** 更新时间毫秒（recency 加权用） */
  updatedMs: number;
}

interface MemoryIndex {
  entries: IndexEntry[];
  /** token 文档频次（出现在任一分词集合即计一次） */
  df: Map<string, number>;
  /** 各字段平均文档长度 */
  avgLen: Record<FieldKey, number>;
  /** 索引构建时的 cwd（项目作用域变化即重扫） */
  cwd: string;
  lastScanAt: number;
}

/** 单文件缓存（跨索引重建复用；仅内容/大小变化时重读+分词） */
interface CachedMemoryFile {
  mtimeMs: number;
  size: number;
  record: ScopedMemoryRecord;
  fields: Record<FieldKey, string[]>;
  allTokens: string[];
  updatedMs: number;
}

/** BM25 参数 */
const K1 = 1.2;
const B = 0.75;
/** 索引 TTL：同一请求内的多次召回直接复用（外部改动最多延迟这么久可见） */
const INDEX_TTL_MS = 2_000;

/** 文本归一化（短语匹配用）：小写 + 压缩空白 */
function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 单字段 BM25 */
function bm25For(
  fieldTokens: readonly string[],
  queryTokens: readonly string[],
  df: Map<string, number>,
  total: number,
  avgLen: number,
): number {
  if (fieldTokens.length === 0 || queryTokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const tk of fieldTokens) tf.set(tk, (tf.get(tk) ?? 0) + 1);
  const normBase = 1 - B + B * (fieldTokens.length / (avgLen || 1));
  let score = 0;
  for (const qt of queryTokens) {
    const f = tf.get(qt);
    if (!f) continue;
    const n = df.get(qt) ?? 0;
    const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
    score += idf * ((f * (K1 + 1)) / (f + K1 * normBase));
  }
  return score;
}

export class MemoryRetriever {
  private readonly env: Environment;
  private index: MemoryIndex | null = null;
  /** 文件级缓存：绝对路径 → 已解析记录与分词（invalidate 不清空） */
  private fileCache = new Map<string, CachedMemoryFile>();

  constructor(env: Environment) {
    this.env = env;
  }

  /** 构建/刷新索引（增量：仅重读 mtime/size 变化的文件） */
  private ensureIndex(cwd: string): MemoryIndex {
    const now = Date.now();
    if (this.index && this.index.cwd === cwd && now - this.index.lastScanAt < INDEX_TTL_MS) {
      return this.index;
    }

    const { global: globalRoot, project: projectRoot } = memoryRoots(this.env, cwd);
    const infos = [
      ...scanMemoryFileInfos(globalRoot, 'global'),
      ...(projectRoot ? scanMemoryFileInfos(projectRoot, 'project') : []),
    ];

    const nextCache = new Map<string, CachedMemoryFile>();
    const entries: IndexEntry[] = [];
    for (const info of infos) {
      let cached = this.fileCache.get(info.file);
      if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
        const record = readMemoryFile(info.file, info.scope);
        if (!record) continue;
        const fields: Record<FieldKey, string[]> = {
          insight: tokenize(record.insight),
          tags: tokenize(record.tags.join(' ')),
          verbatim: tokenize(record.verbatim),
          room: tokenize(record.room),
          wing: tokenize(record.wing),
        };
        const allTokens = [
          ...new Set([
            ...fields.insight,
            ...fields.tags,
            ...fields.verbatim,
            ...fields.room,
            ...fields.wing,
          ]),
        ];
        cached = {
          mtimeMs: info.mtimeMs,
          size: info.size,
          record,
          fields,
          allTokens,
          updatedMs: Date.parse(record.updatedAt) || 0,
        };
      }
      nextCache.set(info.file, cached);
      entries.push({
        file: info.file,
        mtimeMs: info.mtimeMs,
        size: info.size,
        record: cached.record,
        fields: cached.fields,
        allTokens: cached.allTokens,
        updatedMs: cached.updatedMs,
      });
    }
    this.fileCache = nextCache;

    const df = new Map<string, number>();
    const sums: Record<FieldKey, number> = { insight: 0, tags: 0, verbatim: 0, room: 0, wing: 0 };
    for (const e of entries) {
      for (const tk of e.allTokens) df.set(tk, (df.get(tk) ?? 0) + 1);
      for (const key of Object.keys(sums) as FieldKey[]) {
        sums[key] += e.fields[key].length;
      }
    }
    const n = entries.length || 1;
    this.index = {
      entries,
      df,
      avgLen: {
        insight: sums.insight / n,
        tags: sums.tags / n,
        verbatim: sums.verbatim / n,
        room: sums.room / n,
        wing: sums.wing / n,
      },
      cwd,
      lastScanAt: now,
    };
    return this.index;
  }

  /** 元数据过滤 */
  private passesFilter(r: ScopedMemoryRecord, filter?: RecallFilter): boolean {
    if (!filter) return true;
    if (filter.wing && r.wing !== filter.wing) return false;
    if (filter.wings && !filter.wings.includes(r.wing)) return false;
    if (filter.room && r.room !== filter.room) return false;
    if (filter.hall && r.hall !== filter.hall) return false;
    if (filter.tag && !r.tags.includes(filter.tag)) return false;
    if (filter.pinnedOnly && !r.pinned) return false;
    return true;
  }

  /**
   * 带分数的召回：字段加权 BM25 + 短语/重要性/时间/置顶加成，
   * 再按 minScoreRatio 过滤、近重复去重、room 配额后截断 topK。
   */
  recallScored(cwd: string, query: string, opts?: RecallOptions): ScoredMemoryRecord[] {
    const idx = this.ensureIndex(cwd);
    if (idx.entries.length === 0) return [];

    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0) return [];

    const weights: RecallWeights = { ...DEFAULT_RECALL_WEIGHTS, ...(opts?.weights ?? {}) };
    const topK = opts?.topK ?? 5;
    const exclude = opts?.excludeIds;
    const filter = opts?.filter;
    const total = idx.entries.length;
    const now = Date.now();
    const phrase = normalizePhrase(query);

    const scored: Array<{ entry: IndexEntry; score: number; breakdown: ScoredMemoryRecord['breakdown'] }> = [];
    for (const entry of idx.entries) {
      const r = entry.record;
      if (exclude?.has(r.id)) continue;
      if (!this.passesFilter(r, filter)) continue;

      const bm25 =
        weights.insight * bm25For(entry.fields.insight, queryTokens, idx.df, total, idx.avgLen.insight) +
        weights.tag * bm25For(entry.fields.tags, queryTokens, idx.df, total, idx.avgLen.tags) +
        weights.verbatim * bm25For(entry.fields.verbatim, queryTokens, idx.df, total, idx.avgLen.verbatim) +
        weights.room * bm25For(entry.fields.room, queryTokens, idx.df, total, idx.avgLen.room) +
        weights.wing * bm25For(entry.fields.wing, queryTokens, idx.df, total, idx.avgLen.wing);
      if (bm25 <= 0) continue;

      // 短语精确命中（CJK 与英文均适用；长度 <2 不启用）
      let phraseBoost = 1;
      if (phrase.length >= 2) {
        const insightText = normalizePhrase(r.insight);
        const tagText = normalizePhrase(`${r.tags.join(' ')} ${r.room}`);
        const verbatimText = normalizePhrase(r.verbatim);
        if (insightText.includes(phrase)) phraseBoost = 1.5;
        else if (tagText.includes(phrase)) phraseBoost = 1.2;
        else if (verbatimText.includes(phrase)) phraseBoost = 1.1;
      }

      const importanceBoost = 1 + weights.importance * r.importance;
      const ageDays = (now - entry.updatedMs) / (1000 * 60 * 60 * 24);
      const recency = Math.pow(0.5, ageDays / Math.max(1, weights.recencyHalfLifeDays));
      const recencyBoost = 1 + 0.2 * recency;
      const pinnedBoost = r.pinned ? weights.pinnedBoost : 1;
      const final = bm25 * phraseBoost * importanceBoost * recencyBoost * pinnedBoost;

      scored.push({
        entry,
        score: final,
        breakdown: { bm25, phraseBoost, importanceBoost, recencyBoost, pinnedBoost, final },
      });
    }

    if (scored.length === 0) return [];
    scored.sort((a, b) => b.score - a.score);

    // 最低分阈值（相对最高分）
    const topScore = scored[0].score;
    const minScore = topScore * Math.max(0, weights.minScoreRatio);
    const selected: typeof scored = [];
    const selectedTokens: string[][] = [];
    const roomCounts = new Map<string, number>();

    for (const hit of scored) {
      if (hit.score < minScore) break; // 已降序：后续全部低于阈值
      // 近重复去重：与已选记忆 token 重合度过高则跳过
      if (
        weights.dedupThreshold > 0 &&
        selectedTokens.some(tokens => tokenOverlap(tokens, hit.entry.allTokens) >= weights.dedupThreshold)
      ) {
        continue;
      }
      if (weights.maxPerRoom > 0) {
        const count = roomCounts.get(hit.entry.record.room) ?? 0;
        if (count >= weights.maxPerRoom) continue;
        roomCounts.set(hit.entry.record.room, count + 1);
      }
      selected.push(hit);
      selectedTokens.push(hit.entry.allTokens);
      if (selected.length >= topK) break;
    }

    return selected.map(hit => ({
      ...hit.entry.record,
      score: hit.score,
      breakdown: hit.breakdown,
    }));
  }

  /**
   * 召回（兼容旧接口）：返回记录数组（丢弃分数）。
   * @param query 查询文本（用户消息）
   */
  recall(cwd: string, query: string, opts?: RecallOptions): ScopedMemoryRecord[] {
    return this.recallScored(cwd, query, opts).map(hit => {
      const record: Record<string, unknown> = { ...hit };
      delete record.score;
      delete record.breakdown;
      return record as unknown as ScopedMemoryRecord;
    });
  }

  /**
   * L2 主题召回：当前项目 wing + 全局 user wing（个人偏好/建议的默认归档翼）双翼检索
   * + Tunnel（其他项目 wing 同名 room 跨域关联）。
   */
  recallWithTunnel(
    cwd: string,
    query: string,
    opts?: { topK?: number; excludeIds?: ReadonlySet<string>; weights?: Partial<RecallWeights> },
  ): ScopedMemoryRecord[] {
    const topK = opts?.topK ?? 5;
    const currentWing = projectWing(cwd);
    const primary = this.recall(cwd, query, {
      topK,
      filter: { wings: [currentWing, 'user'] },
      ...(opts?.excludeIds ? { excludeIds: opts.excludeIds } : {}),
      ...(opts?.weights ? { weights: opts.weights } : {}),
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
          ...(opts?.weights ? { weights: opts.weights } : {}),
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

  /** 使索引失效（写盘后由 service 调用；文件缓存保留以复用未变文件的分词） */
  invalidate(): void {
    this.index = null;
  }
}
