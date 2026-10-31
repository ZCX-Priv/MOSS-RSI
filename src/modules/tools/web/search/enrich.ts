// tools/web/search/enrich.ts
// default provider 的正文增强：抓取当前页头部结果，抽一段与 query 相关、可读的摘录。
// 只做 HTTP；抓取失败/内容低质/页面与标题不符时保留清洗后的摘要，不阻塞搜索。

import { runFetch } from '../fetcher';
import { selectExcerpt } from '../readable';
import type { SearchItem } from './types';
import { queryCoverage, queryTokens, titleSimilarity } from './clean';

const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX_ENTRIES = 64;
const CONCURRENCY = 3;
const PAGE_TIMEOUT_MS = 8_000;
const TOTAL_BUDGET_MS = 15_000;
const MIN_CONTENT_CHARS = 300;
const MAX_CONTENT_CHARS = 20_000;

interface CachedContent {
  text: string;
  title: string | null;
  fetchedAt: number;
}

const contentCache = new Map<string, CachedContent>();

function getCached(url: string): CachedContent | null {
  const cached = contentCache.get(url);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
    contentCache.delete(url);
    return null;
  }
  return cached;
}

function putCached(url: string, content: CachedContent): void {
  contentCache.delete(url);
  contentCache.set(url, content);
  while (contentCache.size > CACHE_MAX_ENTRIES) {
    const oldest = contentCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    contentCache.delete(oldest);
  }
}

export interface EnrichOptions {
  query: string;
  maxChars: number;
  /** 绝对截止时间（Date.now() 毫秒），超过即停止 */
  deadlineAt: number;
  signal?: AbortSignal;
  proxyUrl?: string;
}

export interface EnrichResult {
  items: SearchItem[];
  enriched: number;
  failed: number;
  lowQuality: number;
  mismatch: number;
  warnings: string[];
}

async function enrichOne(item: SearchItem, options: EnrichOptions): Promise<SearchItem> {
  const tokens = queryTokens(options.query);
  const cached = getCached(item.url);
  if (cached) {
    return applyContent(item, cached.text, cached.title, tokens, options.query, options.maxChars);
  }

  const remaining = options.deadlineAt - Date.now();
  if (remaining <= 500) return item;

  try {
    const page = await runFetch({
      url: item.url,
      timeoutMs: Math.min(PAGE_TIMEOUT_MS, remaining),
      maxChars: MAX_CONTENT_CHARS,
      signal: options.signal,
      referer: undefined,
      proxyUrl: options.proxyUrl,
    });
    if (page.text.length < MIN_CONTENT_CHARS) {
      return { ...item, flags: [...(item.flags ?? []), 'content-short'] };
    }
    putCached(item.url, { text: page.text, title: page.title, fetchedAt: Date.now() });
    return applyContent(item, page.text, page.title, tokens, options.query, options.maxChars);
  } catch {
    return { ...item, flags: [...(item.flags ?? []), 'content-failed'] };
  }
}

function applyContent(
  item: SearchItem,
  text: string,
  pageTitle: string | null,
  tokens: readonly string[],
  query: string,
  maxChars: number,
): SearchItem {
  const titleSim = pageTitle ? titleSimilarity(pageTitle, item.title) : 0;
  const coverage = queryCoverage(text, tokens);

  // 搜索结果标题与落地页完全无关、正文也不含查询词 → 大概率 cloaking/跳转垃圾
  if (pageTitle && titleSim < 0.3 && coverage < 0.2) {
    return { ...item, flags: [...(item.flags ?? []), 'content-mismatch'] };
  }

  const excerpt = selectExcerpt(text, query, maxChars);
  if (!excerpt) return item;

  return {
    ...item,
    contentExcerpt: excerpt,
    contentQuality: text.length >= MIN_CONTENT_CHARS && coverage >= 0.2 ? 'high' : 'low',
  };
}

/**
 * 对当前页头部结果做正文增强（并发 3、单页 8s、总预算 15s）。
 * 返回新数组，未增强的条目原样保留。
 */
export async function enrichItems(items: SearchItem[], options: EnrichOptions): Promise<EnrichResult> {
  if (items.length === 0) return { items, enriched: 0, failed: 0, lowQuality: 0, mismatch: 0, warnings: [] };

  const deadlineAt = Math.min(options.deadlineAt, Date.now() + TOTAL_BUDGET_MS);
  const output = [...items];
  const counters = { enriched: 0, failed: 0, lowQuality: 0, mismatch: 0 };
  let cursor = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      if (Date.now() >= deadlineAt) return;
      const index = cursor++;
      const item = items[index];
      if (!item) continue;
      const enriched = await enrichOne(item, { ...options, deadlineAt });
      output[index] = enriched;
      if (enriched.contentExcerpt) counters.enriched++;
      if (enriched.flags?.includes('content-failed')) counters.failed++;
      if (enriched.flags?.includes('content-short')) counters.lowQuality++;
      if (enriched.flags?.includes('content-mismatch')) counters.mismatch++;
    }
  });
  await Promise.all(workers);

  const warnings: string[] = [];
  if (counters.failed > 0) warnings.push(`${counters.failed} 条结果正文抓取失败，已使用搜索摘要`);
  if (counters.lowQuality > 0) warnings.push(`${counters.lowQuality} 条结果正文过短，已使用搜索摘要`);
  if (counters.mismatch > 0) warnings.push(`${counters.mismatch} 条结果页面内容与标题不符，已丢弃正文`);

  return { items: output, ...counters, warnings };
}

/** 测试重置 */
export function __resetEnrichCacheForTests(): void {
  contentCache.clear();
}
