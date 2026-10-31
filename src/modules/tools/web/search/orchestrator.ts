// tools/web/search/orchestrator.ts
// 搜索编排：default 并行三引擎、直连单引擎、按需翻页、结果池分页、正文增强。
//
// 关键约束：
// - 结果池最多 100 条；单次调用按 offset/pageSize 切片，默认 10-20 条一页。
// - 清洗后不足 offset+pageSize 时继续翻页（最多 10 页/引擎），受总 timeoutMs 预算约束。
// - 单引擎失败不影响 default；所有引擎失败才报错。
// - 只有 default 抓正文；直连 provider 只返回清洗后的 SERP 结果。

import type {
  EngineFailure,
  EngineName,
  EnginePage,
  ProviderName,
  RawResult,
  SearchItem,
  SearchPage,
  SearchParams,
} from './types';
import { SearchError, EngineRequestError } from './types';
import { searchBingPage, buildBingUrl } from './engines/bing';
import { searchBaiduPage, buildBaiduUrl, resolveBaiduRedirects } from './engines/baidu';
import { searchSogouPage, buildSogouUrl } from './engines/sogou';
import { cleanResults, canonicalizeUrl } from './clean';
import { getEngineCooldown } from './http-client';
import { enrichItems } from './enrich';
import {
  MAX_POOL_RESULTS,
  createPool,
  getPoolByKey,
  getPoolBySearchId,
  runPoolBuild,
  updatePool,
  poolKey,
  type PoolEngineState,
  type SearchPool,
} from './store';

const ALL_ENGINES: readonly EngineName[] = ['bing', 'baidu', 'sogou'];
const MAX_PAGES_PER_ENGINE = 10;
const MAX_BATCHES_PER_CALL = 10;
const ENGINE_TIMEOUT_MAX_MS = 10_000;
const ENRICH_TOP_N = 6;

function enginesFor(provider: ProviderName): EngineName[] {
  return provider === 'default' ? [...ALL_ENGINES] : [provider];
}

function makeEngineState(provider: ProviderName): Record<EngineName, PoolEngineState> {
  const active = new Set(enginesFor(provider));
  const state = {} as Record<EngineName, PoolEngineState>;
  for (const engine of ALL_ENGINES) {
    state[engine] = { nextPage: 0, exhausted: !active.has(engine) };
  }
  return state;
}

function upsertFailure(pool: SearchPool, failure: EngineFailure): void {
  const index = pool.failures.findIndex((item) => item.engine === failure.engine);
  if (index >= 0) pool.failures[index] = failure;
  else pool.failures.push(failure);
}

function clearFailure(pool: SearchPool, engine: EngineName): void {
  pool.failures = pool.failures.filter((item) => item.engine !== engine);
}

function failureReason(error: unknown): string {
  if (error instanceof EngineRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function remainingMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

function refreshPool(pool: SearchPool, minKeep: number): void {
  const result = cleanResults(pool.rawItems, pool.query, { minKeep });
  updatePool(pool, pool.rawItems, result.items, result.stats);
}

function usableCount(items: readonly SearchItem[], count: number): number {
  return items
    .slice(0, count)
    .filter((item) => item.snippet.length >= 40 || item.title.length >= 24).length;
}

function isProviderExhausted(pool: SearchPool, provider: ProviderName): boolean {
  const engines = enginesFor(provider);
  return engines.every((engine) => {
    const state = pool.engineState[engine];
    return state.exhausted || state.nextPage >= MAX_PAGES_PER_ENGINE;
  });
}

async function runEnginePage(
  engine: EngineName,
  query: string,
  page: number,
  params: SearchParams,
  deadlineAt: number,
): Promise<EnginePage> {
  const timeoutMs = Math.min(ENGINE_TIMEOUT_MAX_MS, Math.max(1_000, remainingMs(deadlineAt)));
  const common = {
    freshness: params.freshness,
    timeoutMs,
    signal: params.signal,
    proxyUrl: params.proxyUrl,
    referer: page > 0
      ? engine === 'bing'
        ? buildBingUrl(query, page - 1, params.freshness)
        : engine === 'baidu'
          ? buildBaiduUrl(query, page - 1, params.freshness)
          : buildSogouUrl(query, page - 1, params.freshness)
      : undefined,
  };

  switch (engine) {
    case 'bing':
      return searchBingPage(query, page, common);
    case 'baidu':
      return searchBaiduPage(query, page, common);
    case 'sogou':
      return searchSogouPage(query, page, common);
  }
}

interface BatchOutcome {
  attempted: EngineName[];
  succeeded: EngineName[];
  added: number;
}

/** 拉取一批下一页（每引擎一页，引擎间并行） */
async function fetchBatch(
  pool: SearchPool,
  params: SearchParams,
  deadlineAt: number,
): Promise<BatchOutcome> {
  const engines = enginesFor(pool.provider);
  const attempted: EngineName[] = [];
  const succeeded: EngineName[] = [];
  const existing = new Set(pool.rawItems.map((item) => `${item.engine}\u0000${item.url}`));
  let added = 0;

  const tasks = engines.map(async (engine) => {
    const state = pool.engineState[engine];
    if (state.exhausted || state.nextPage >= MAX_PAGES_PER_ENGINE) return;

    attempted.push(engine);
    const cooldown = getEngineCooldown(engine);
    if (cooldown) {
      state.exhausted = true;
      state.lastError = `冷却中（剩余 ${Math.ceil(cooldown.remainingMs / 1000)}s）：${cooldown.reason}`;
      upsertFailure(pool, {
        engine,
        reason: state.lastError,
        cooldownMs: cooldown.remainingMs,
      });
      return;
    }

    if (remainingMs(deadlineAt) < 1_000) {
      state.lastError = '本次调用预算已用完';
      return;
    }

    const page = state.nextPage;
    try {
      const result = await runEnginePage(engine, pool.query, page, params, deadlineAt);
      state.nextPage = page + 1;
      state.exhausted = result.exhausted;
      state.lastError = undefined;
      clearFailure(pool, engine);
      succeeded.push(result.engine);

      const newItems = result.items.filter((item) => {
        const key = `${item.engine}\u0000${item.url}`;
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      if (newItems.length === 0 && page > 0) {
        // 翻页返回的全是已见结果（Bing 越界会静默回到第一页）
        state.exhausted = true;
      }
      if (newItems.length > 0) {
        pool.rawItems.push(...newItems);
        added += newItems.length;
      }
    } catch (error) {
      state.nextPage = page + 1;
      state.exhausted = true;
      const reason = failureReason(error);
      const cooldownMs = error instanceof EngineRequestError ? error.cooldownMs : 0;
      state.lastError = reason;
      upsertFailure(pool, { engine, reason, ...(cooldownMs > 0 ? { cooldownMs } : {}) });
      pool.warnings.push(`${engine} 暂时不可用：${reason}`);
    }
  });

  await Promise.all(tasks);
  pool.fullyExhausted = isProviderExhausted(pool, pool.provider);
  return { attempted, succeeded, added };
}

/** 确保池中至少有 offset+pageSize 条；不足则继续翻页（受预算与页数上限约束） */
async function ensurePool(
  pool: SearchPool,
  params: SearchParams,
  targetCount: number,
  deadlineAt: number,
): Promise<void> {
  const minKeep = Math.min(MAX_POOL_RESULTS, Math.max(params.pageSize, targetCount));
  refreshPool(pool, minKeep);

  let batches = 0;
  while (batches < MAX_BATCHES_PER_CALL && remainingMs(deadlineAt) > 1_000) {
    const needCount = Math.min(MAX_POOL_RESULTS, targetCount);
    const enough = pool.items.length >= needCount;
    const qualityEnough = usableCount(pool.items, needCount) >= Math.ceil(params.pageSize * 0.6);
    if (enough && qualityEnough) break;
    if (isProviderExhausted(pool, pool.provider)) {
      pool.fullyExhausted = true;
      break;
    }

    const outcome = await fetchBatch(pool, params, deadlineAt);
    batches++;
    if (outcome.attempted.length === 0) {
      pool.fullyExhausted = true;
      break;
    }
    refreshPool(pool, minKeep);
    if (outcome.added === 0 && isProviderExhausted(pool, pool.provider)) {
      pool.fullyExhausted = true;
      break;
    }
  }
  pool.fullyExhausted = isProviderExhausted(pool, pool.provider);
}

/** 构造空池；默认引擎状态按 provider 初始化 */
function buildEmptyPool(params: SearchParams): SearchPool {
  return createPool({
    sessionId: params.sessionId,
    provider: params.provider,
    query: params.query.trim(),
    freshness: params.freshness,
    engineState: makeEngineState(params.provider),
  });
}

async function buildPool(params: SearchParams, deadlineAt: number, targetCount: number): Promise<SearchPool> {
  const pool = buildEmptyPool(params);
  await ensurePool(pool, params, targetCount, deadlineAt);

  const active = enginesFor(params.provider);
  const failedActive = active.filter((engine) => pool.failures.some((failure) => failure.engine === engine));
  if (pool.rawItems.length === 0 && failedActive.length === active.length) {
    if (params.provider === 'default') {
      throw new SearchError('all-failed', '所有搜索引擎均失败', pool.failures);
    }
    throw new SearchError('engine-failed', `${params.provider} 调用失败`, pool.failures);
  }
  return pool;
}

/** 输出当前页前解析 Baidu /link 跳转链，失败保留原链 */
async function resolveSliceRedirects(
  items: SearchItem[],
  params: SearchParams,
  deadlineAt: number,
): Promise<SearchItem[]> {
  const redirects = items.filter((item) => item.flags?.includes('baidu-redirect'));
  if (redirects.length === 0) return items;
  const timeoutMs = Math.min(3_000, remainingMs(deadlineAt));
  if (timeoutMs < 500) return items;

  const raw: RawResult[] = redirects.map((item) => ({
    engine: 'baidu',
    rank: 0,
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    redirectUrl: item.url,
  }));
  const resolved = await resolveBaiduRedirects(raw, {
    timeoutMs,
    signal: params.signal,
    proxyUrl: params.proxyUrl,
  });
  const targets = new Map<string, string>();
  for (const item of resolved) {
    if (item.redirectUrl && item.url !== item.redirectUrl) {
      targets.set(item.redirectUrl, canonicalizeUrl(item.url));
    }
  }
  if (targets.size === 0) return items;

  return items.map((item) => {
    const target = targets.get(item.url);
    if (!target) return item;
    return {
      ...item,
      url: target,
      flags: item.flags?.filter((flag) => flag !== 'baidu-redirect'),
    };
  });
}

function failureSummary(pool: SearchPool, provider: ProviderName): EngineFailure[] {
  const active = new Set(enginesFor(provider));
  return pool.failures.filter((failure) => active.has(failure.engine as EngineName));
}

/** 搜索主入口 */
export async function runSearch(params: SearchParams): Promise<SearchPage> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + Math.max(3_000, params.timeoutMs);
  const offset = Math.max(0, Math.min(params.offset, MAX_POOL_RESULTS - 1));
  const pageSize = Math.max(10, Math.min(params.pageSize, 20));
  if (!params.searchId && !params.query.trim()) {
    throw new SearchError('invalid', '搜索需要 query 或 searchId');
  }

  let pool: SearchPool | null = null;
  let cacheHit = false;
  let cacheExpired = false;

  if (params.searchId) {
    pool = getPoolBySearchId(params.searchId, params.sessionId);
    if (!pool) {
      throw new SearchError('cache-expired', '搜索缓存已失效，请带上 query 重新搜索');
    }
    cacheHit = true;
  } else {
    pool = getPoolByKey(params.sessionId, params.provider, params.query, params.freshness);
    if (pool) cacheHit = true;
    else if (offset > 0) cacheExpired = true;
  }

  const effectiveQuery = pool?.query ?? params.query.trim();
  const effectiveProvider = pool?.provider ?? params.provider;
  const effectiveFreshness = pool?.freshness ?? params.freshness;
  const effectiveParams: SearchParams = {
    ...params,
    query: effectiveQuery,
    provider: effectiveProvider,
    freshness: effectiveFreshness,
  };

  const targetCount = Math.min(MAX_POOL_RESULTS, offset + pageSize);
  if (!pool) {
    const key = poolKey(params.sessionId, effectiveProvider, effectiveQuery, effectiveFreshness);
    pool = await runPoolBuild(key, () => buildPool(effectiveParams, deadlineAt, targetCount));
  } else {
    await ensurePool(pool, effectiveParams, targetCount, deadlineAt);
  }

  const currentPool = pool;
  if (!currentPool) throw new SearchError('invalid', '搜索池初始化失败');

  let slice = currentPool.items.slice(offset, offset + pageSize);
  let partial = remainingMs(deadlineAt) <= 0;
  const warnings: string[] = [];
  if (cacheExpired) warnings.push('搜索缓存已失效，已重新搜索，结果顺序可能变化');

  slice = await resolveSliceRedirects(slice, effectiveParams, deadlineAt);

  if (effectiveProvider === 'default' && slice.length > 0) {
    const enrichCount = Math.min(ENRICH_TOP_N, slice.length);
    const prefix = slice.slice(0, enrichCount);
    const result = await enrichItems(prefix, {
      query: effectiveQuery,
      maxChars: pageSize <= 10 ? 320 : 240,
      deadlineAt,
      signal: params.signal,
      proxyUrl: params.proxyUrl,
    });
    slice = [...result.items, ...slice.slice(enrichCount)];
    warnings.push(...result.warnings);
    if (remainingMs(deadlineAt) <= 0 && result.enriched === 0) partial = true;
  }

  const nextOffset = offset + slice.length;
  const canGrow = !currentPool.fullyExhausted && currentPool.items.length < MAX_POOL_RESULTS;
  const hasMore = nextOffset < currentPool.items.length || canGrow;
  if (remainingMs(deadlineAt) <= 0 && hasMore) partial = true;

  const activeEngines = enginesFor(effectiveProvider);
  const succeeded = Array.from(
    new Set(currentPool.items.flatMap((item) => item.engines)),
  ).filter((engine) => activeEngines.includes(engine)) as EngineName[];
  const failures = failureSummary(currentPool, effectiveProvider);
  if (failures.length > 0) partial = true;
  if (offset >= currentPool.items.length && !hasMore) {
    warnings.push('offset 已超出当前结果池，未返回新结果');
  }

  return {
    searchId: currentPool.searchId,
    provider: effectiveProvider,
    query: effectiveQuery,
    offset,
    pageSize,
    items: slice,
    totalAvailable: currentPool.items.length,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
    engines: {
      attempted: activeEngines,
      succeeded,
      failed: failures,
    },
    stats: currentPool.stats,
    warnings: [...new Set(warnings)],
    partial,
    cacheHit,
    elapsedMs: Date.now() - startedAt,
  };
}
