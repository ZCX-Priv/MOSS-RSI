// tools/web/search/store.ts
// 搜索结果池缓存：首次搜索构建最多 100 条清洗结果，后续 offset 翻页直接切片。
// 缓存按 session + provider + query + freshness 隔离；LRU 32 条，TTL 15 分钟。

import type { CleanStats, EngineFailure, EngineName, Freshness, ProviderName, RawResult, SearchItem } from './types';

export const MAX_POOL_RESULTS = 100;
export const POOL_TTL_MS = 15 * 60_000;
export const POOL_MAX_ENTRIES = 32;

export interface PoolEngineState {
  nextPage: number;
  exhausted: boolean;
  lastError?: string;
}

export interface SearchPool {
  searchId: string;
  sessionId: string;
  query: string;
  provider: ProviderName;
  freshness: Freshness;
  createdAt: number;
  lastAccessAt: number;
  rawItems: RawResult[];
  items: SearchItem[];
  stats: CleanStats;
  engineState: Record<EngineName, PoolEngineState>;
  failures: EngineFailure[];
  warnings: string[];
  /** 是否已经耗尽所有引擎的翻页能力 */
  fullyExhausted: boolean;
}

const poolsByKey = new Map<string, SearchPool>();
const poolsById = new Map<string, SearchPool>();
const inflight = new Map<string, Promise<SearchPool>>();

export function poolKey(
  sessionId: string,
  provider: ProviderName,
  query: string,
  freshness: Freshness,
): string {
  return `${sessionId}\u0000${provider}\u0000${freshness}\u0000${query.trim()}`;
}

function isExpired(pool: SearchPool): boolean {
  return Date.now() - pool.createdAt > POOL_TTL_MS;
}

function evictIfNeeded(): void {
  while (poolsByKey.size > POOL_MAX_ENTRIES) {
    const oldestKey = poolsByKey.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    const pool = poolsByKey.get(oldestKey);
    if (pool) poolsById.delete(pool.searchId);
    poolsByKey.delete(oldestKey);
  }
}

function touch(pool: SearchPool): SearchPool {
  pool.lastAccessAt = Date.now();
  const currentKey = poolKey(pool.sessionId, pool.provider, pool.query, pool.freshness);
  if (poolsByKey.has(currentKey)) poolsByKey.delete(currentKey);
  poolsByKey.set(currentKey, pool);
  return pool;
}

/** 按 searchId 取池（校验会话，防止跨会话串读） */
export function getPoolBySearchId(searchId: string, sessionId: string): SearchPool | null {
  const pool = poolsById.get(searchId);
  if (!pool) return null;
  if (pool.sessionId !== sessionId || isExpired(pool)) {
    poolsById.delete(searchId);
    poolsByKey.delete(poolKey(pool.sessionId, pool.provider, pool.query, pool.freshness));
    return null;
  }
  return touch(pool);
}

/** 按搜索条件取池；过期返回 null */
export function getPoolByKey(
  sessionId: string,
  provider: ProviderName,
  query: string,
  freshness: Freshness,
): SearchPool | null {
  const key = poolKey(sessionId, provider, query, freshness);
  const pool = poolsByKey.get(key);
  if (!pool) return null;
  if (isExpired(pool)) {
    poolsByKey.delete(key);
    poolsById.delete(pool.searchId);
    return null;
  }
  return touch(pool);
}

/** 创建并入池（覆盖同 key 旧池，重建时使用） */
export function createPool(params: {
  sessionId: string;
  provider: ProviderName;
  query: string;
  freshness: Freshness;
  engineState: Record<EngineName, PoolEngineState>;
}): SearchPool {
  const now = Date.now();
  const pool: SearchPool = {
    searchId: crypto.randomUUID(),
    sessionId: params.sessionId,
    query: params.query,
    provider: params.provider,
    freshness: params.freshness,
    createdAt: now,
    lastAccessAt: now,
    rawItems: [],
    items: [],
    stats: { raw: 0, deduped: 0, dropped: 0, queryFiltered: 0 },
    engineState: params.engineState,
    failures: [],
    warnings: [],
    fullyExhausted: false,
  };

  const key = poolKey(params.sessionId, params.provider, params.query, params.freshness);
  const previous = poolsByKey.get(key);
  if (previous) poolsById.delete(previous.searchId);
  poolsByKey.set(key, pool);
  poolsById.set(pool.searchId, pool);
  evictIfNeeded();
  return pool;
}

/** 写入清洗结果（保留 rawItems 供补页后重新聚类） */
export function updatePool(
  pool: SearchPool,
  rawItems: RawResult[],
  items: SearchItem[],
  stats: CleanStats,
): void {
  pool.rawItems = rawItems;
  pool.items = items.slice(0, MAX_POOL_RESULTS);
  pool.stats = stats;
  touch(pool);
}

/** 同一 key 的并发构建共享 Promise，避免重复请求搜索引擎 */
export function runPoolBuild(
  key: string,
  factory: () => Promise<SearchPool>,
): Promise<SearchPool> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = factory().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/** 测试重置 */
export function __resetStoreForTests(): void {
  poolsByKey.clear();
  poolsById.clear();
  inflight.clear();
}
