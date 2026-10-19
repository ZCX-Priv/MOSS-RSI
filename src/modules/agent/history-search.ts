// src/modules/agent/history-search.ts
// 会话历史检索（BM25）：对「本对话原始上下文 / 跨 session 全量历史」做关键词智能检索。
// 与 memory/retriever 的 BM25 同口径（零依赖自实现 + CJK bigram 分词）。
// 纯函数：给定文档集合与查询，返回命中文档与得分。engine 负责组装文档集合。

import { tokenize } from '../memory/tokenizer';
import type { HistorySearchResult } from '../contracts';

/** 检索文档（会话内一条消息） */
export interface HistorySearchDoc {
  sessionId: string;
  /** 消息在该会话全量数组中的下标 */
  index: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 参与检索与展示的文本（通常为 message.content） */
  text: string;
  /** 该消息是否已被压缩折叠 */
  compacted: boolean;
  timestamp?: string;
}

/** BM25 参数（与 memory/retriever 一致） */
const K1 = 1.2;
const B = 0.75;
/** 命中片段最大字符数 */
const SNIPPET_MAX = 240;

/** 构造命中片段：以首个命中 token 为中心截取，尽量保留上下文 */
function buildSnippet(text: string, hitTokens: readonly string[]): string {
  if (text.length <= SNIPPET_MAX) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const tk of hitTokens) {
    const idx = lower.indexOf(tk.toLowerCase());
    if (idx >= 0 && (at === -1 || idx < at)) at = idx;
  }
  if (at === -1) return `${text.slice(0, SNIPPET_MAX)}…`;
  const half = Math.floor(SNIPPET_MAX / 2);
  const start = Math.max(0, at - half);
  const end = Math.min(text.length, start + SNIPPET_MAX);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * BM25 检索：对文档集合打分并返回 topK 命中（按得分降序）。
 * @param query 查询文本
 * @param docs 文档集合（调用方已按 includeCompacted/includeTool 过滤）
 * @param topK 返回条数上限
 */
export function searchHistoryDocs(
  query: string,
  docs: readonly HistorySearchDoc[],
  topK: number,
): HistorySearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || docs.length === 0) return [];

  // 预分词 + df/avgLen 统计
  const tokenized = docs.map(d => ({ doc: d, tokens: tokenize(d.text) }));
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const t of tokenized) {
    totalLen += t.tokens.length;
    const seen = new Set(t.tokens);
    for (const tk of seen) df.set(tk, (df.get(tk) ?? 0) + 1);
  }
  const avgLen = tokenized.length > 0 ? totalLen / tokenized.length : 0;
  const N = tokenized.length;

  const scored: Array<{ doc: HistorySearchDoc; score: number; hits: string[] }> = [];
  for (const { doc, tokens } of tokenized) {
    const tf = new Map<string, number>();
    for (const tk of tokens) tf.set(tk, (tf.get(tk) ?? 0) + 1);
    let bm25 = 0;
    const hits: string[] = [];
    for (const qt of queryTokens) {
      const f = tf.get(qt);
      if (!f) continue;
      hits.push(qt);
      const n = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const norm = (f * (K1 + 1)) / (f + K1 * (1 - B + B * (tokens.length / (avgLen || 1))));
      bm25 += idf * norm;
    }
    if (bm25 > 0) scored.push({ doc, score: bm25, hits });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK))
    .map(s => ({
      sessionId: s.doc.sessionId,
      index: s.doc.index,
      role: s.doc.role,
      snippet: buildSnippet(s.doc.text, s.hits),
      score: s.score,
      compacted: s.doc.compacted,
      ...(s.doc.timestamp ? { timestamp: s.doc.timestamp } : {}),
    }));
}
