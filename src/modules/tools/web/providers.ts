// tools/web/providers.ts
// 联网搜索：搜索服务商引擎（智谱 search_pro / 博查 / Tavily）+ 本地免费引擎降级。
// 架构（用户要求的回退语义）：
//   - 搜索服务商来自「设置页 → 服务商」体系（api.json providers，kind='search'），
//     key 唯一来源是服务商配置（不再内置工具级 key / 环境变量）
//   - 调用链：默认搜索服务商（若配置）→ 失败自动降级本地引擎链（bing→baidu→sogou）
//   - engine=local 或未配置默认服务商 → 直接本地链
//   - 错误文本 redact：API key 绝不进消息（网关错误页常回显 Authorization 头）

import {
  runLocalSearch,
  LocalSearchError,
  type LocalSearchItem,
} from './local-engines';

/** 统一搜索结果条目（本地/服务商引擎共用） */
export interface SearchItem {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
}

/** 搜索结果（统一出口） */
export interface SearchOutcome {
  engineKind: 'local' | 'provider';
  /** 实际引擎：本地 bing/baidu/sogou 或服务商名 */
  engine: string;
  items: SearchItem[];
  /** 引擎附带的总述（如 Tavily answer），无则省略 */
  note?: string;
  /** 降级来源：默认服务商失败后降级本地时记录该服务商名 */
  degradedFrom?: string;
  /** 本地链中先前引擎的失败记录 */
  fallbackFrom?: Array<{ engine: string; reason: string }>;
}

/** 搜索服务商引用（来自 api.json kind='search' 的 provider） */
export interface SearchProviderRef {
  id: string;
  name: string;
  searchEngine: 'zhipu' | 'bocha' | 'tavily';
  apiKey: string;
  /** 自定义 API 端点（服务商 endpoint，可选；覆盖官方端点） */
  baseURL?: string;
}

export type EngineName = 'zhipu' | 'bocha' | 'tavily';

/** 搜索错误码（index.ts 映射 i18n 消息） */
export type SearchErrorCode = 'invalid' | 'no-provider' | 'engine-failed' | 'all-failed';

/** 类型化搜索错误 */
export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly failures: Array<{ engine: string; reason: string }>;

  constructor(
    code: SearchErrorCode,
    message: string,
    failures: Array<{ engine: string; reason: string }> = [],
  ) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
    this.failures = failures;
  }
}

export interface SearchParams {
  query: string;
  /** 结果条数 1-20 */
  maxResults: number;
  /** 时效过滤（智谱/博查支持；本地引擎与 Tavily 忽略） */
  freshness?: 'noLimit' | 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear';
  /** 单引擎请求超时 */
  timeoutMs: number;
}

/** fetch 函数签名（注入便于单测 mock） */
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** 搜索路由上下文 */
export interface SearchRouteContext {
  /** 默认搜索服务商（web.searchProviderId 解析出的、有 key 的服务商）；undefined = 直接本地链 */
  provider?: SearchProviderRef;
}

/** 把所有已知 key 从文本中抹除（网关错误体常回显 Authorization 头） */
function redactKeys(text: string, keys: string[]): string {
  let out = text;
  // 长 key 优先：短 key 先替换会把长 key 切成两半泄漏残段
  for (const key of [...keys].sort((a, b) => b.length - a.length)) {
    if (key.length > 0) {
      out = out.split(key).join('[redacted]');
    }
  }
  return out;
}

/**
 * 搜索主入口：
 *   - ctx.provider 存在 → 该服务商，任何失败降级本地引擎链（结果标记 degradedFrom）
 *   - ctx.provider 缺失 → 直接本地引擎链
 */
export async function runSearch(
  params: SearchParams,
  ctx: SearchRouteContext,
  fetchFn: FetchFn = fetch,
): Promise<SearchOutcome> {
  if (ctx.provider) {
    try {
      return await executeProviderEngine(ctx.provider, params, fetchFn);
    } catch (err) {
      // 服务商任何失败（网络/超时/HTTP/key/配额）→ 降级本地引擎链
      const reason = err instanceof Error ? err.message : String(err);
      try {
        const local = await runLocalSearch({
          query: params.query,
          maxResults: params.maxResults,
          timeoutMs: params.timeoutMs,
          fetchFn: fetchFn as typeof fetch,
        });
        return {
          ...localOutcomeToOutcome(local),
          degradedFrom: ctx.provider.name,
          fallbackFrom: [
            { engine: ctx.provider.name, reason },
            ...local.fallbackFrom,
          ],
        };
      } catch (localErr) {
        if (localErr instanceof LocalSearchError) {
          throw new SearchError('all-failed', '', [
            { engine: ctx.provider.name, reason },
            ...localErr.failures,
          ]);
        }
        throw localErr;
      }
    }
  }

  // 无默认服务商：直接本地链
  try {
    const local = await runLocalSearch({
      query: params.query,
      maxResults: params.maxResults,
      timeoutMs: params.timeoutMs,
      fetchFn: fetchFn as typeof fetch,
    });
    return localOutcomeToOutcome(local);
  } catch (err) {
    if (err instanceof LocalSearchError) {
      throw new SearchError('all-failed', '', err.failures);
    }
    throw err;
  }
}

/** 本地链结果 → 统一 SearchOutcome */
function localOutcomeToOutcome(local: {
  engineKind: 'local';
  engine: string;
  items: LocalSearchItem[];
  fallbackFrom: Array<{ engine: string; reason: string }>;
}): SearchOutcome {
  return {
    engineKind: 'local',
    engine: local.engine,
    items: local.items.map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      ...(item.source ? { source: item.source } : {}),
    })),
    fallbackFrom: local.fallbackFrom,
  };
}

/** 按服务商引擎分发 */
async function executeProviderEngine(
  provider: SearchProviderRef,
  params: SearchParams,
  fetchFn: FetchFn,
): Promise<SearchOutcome> {
  if (!provider.apiKey) {
    throw new Error(`服务商「${provider.name}」未配置 API Key，请在设置页补全`);
  }
  switch (provider.searchEngine) {
    case 'zhipu':
      return searchZhipu(provider, params, fetchFn);
    case 'bocha':
      return searchBocha(provider, params, fetchFn);
    case 'tavily':
      return searchTavily(provider, params, fetchFn);
  }
}

// ============================================================================
// 智谱 Web Search API
// POST https://open.bigmodel.cn/api/paas/v4/web_search
// Bearer key；响应 search_result[]{title,content,link,media,publish_date}
// ============================================================================

interface ZhipuResult {
  title?: string;
  content?: string;
  link?: string;
  media?: string;
  publish_date?: string;
}

interface ZhipuResponse {
  search_result?: ZhipuResult[];
  error?: { code?: string; message?: string };
}

/** 解析智谱响应为统一结果（纯函数，供测试） */
export function parseZhipuResponse(data: ZhipuResponse): SearchItem[] {
  if (data.error) {
    throw new SearchError(
      'engine-failed',
      `智谱搜索失败: ${data.error.message ?? data.error.code ?? 'unknown error'}`,
    );
  }
  return (data.search_result ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.content ?? '',
    source: r.media || undefined,
    publishedAt: r.publish_date || undefined,
  }));
}

async function searchZhipu(
  provider: SearchProviderRef,
  params: SearchParams,
  fetchFn: FetchFn,
): Promise<SearchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const base = provider.baseURL?.trim()
      ? provider.baseURL.trim().replace(/\/$/, '')
      : 'https://open.bigmodel.cn/api/paas/v4';
    const response = await fetchFn(`${base}/web_search`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        search_query: params.query,
        search_engine: 'search_pro',
        search_intent: false,
        count: clampInt(params.maxResults, 1, 50),
        search_recency_filter: params.freshness ?? 'noLimit',
        content_size: 'medium',
      }),
    });
    if (!response.ok) {
      const detail = redactKeys(await response.text().catch(() => ''), [provider.apiKey]);
      throw new Error(
        `智谱返回 ${response.status} ${response.statusText}.${detail ? ` ${detail.slice(0, 300)}` : ''}`,
      );
    }
    const data = (await response.json()) as ZhipuResponse;
    return { engineKind: 'provider', engine: provider.name, items: parseZhipuResponse(data) };
  } catch (err) {
    throw toEngineError(provider.name, err, params.timeoutMs, [provider.apiKey]);
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// 博查 Web Search API
// POST https://api.bochaai.com/v1/web-search
// Bearer key；响应 data.webPages.value[]{name,url,snippet,summary,siteName,datePublished}
// ============================================================================

interface BochaResult {
  name?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  siteName?: string;
  datePublished?: string;
  dateLastCrawled?: string;
}

interface BochaResponse {
  code?: number;
  msg?: string;
  message?: string;
  data?: { webPages?: { value?: BochaResult[] } };
}

/** 解析博查响应为统一结果（纯函数，供测试） */
export function parseBochaResponse(data: BochaResponse): SearchItem[] {
  if (data.code !== undefined && data.code !== 200) {
    throw new SearchError(
      'engine-failed',
      `博查搜索失败: ${data.msg ?? data.message ?? `code ${data.code}`}`,
    );
  }
  return (data.data?.webPages?.value ?? []).map((r) => ({
    title: r.name ?? '',
    url: r.url ?? '',
    snippet: r.summary || r.snippet || '',
    source: r.siteName || undefined,
    publishedAt: r.datePublished || r.dateLastCrawled || undefined,
  }));
}

async function searchBocha(
  provider: SearchProviderRef,
  params: SearchParams,
  fetchFn: FetchFn,
): Promise<SearchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const base = provider.baseURL?.trim()
      ? provider.baseURL.trim().replace(/\/$/, '')
      : 'https://api.bochaai.com/v1';
    const response = await fetchFn(`${base}/web-search`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        query: params.query,
        freshness: params.freshness ?? 'noLimit',
        summary: true,
        count: clampInt(params.maxResults, 1, 50),
        page: 1,
      }),
    });
    if (!response.ok) {
      const detail = redactKeys(await response.text().catch(() => ''), [provider.apiKey]);
      throw new Error(
        `博查返回 ${response.status} ${response.statusText}.${detail ? ` ${detail.slice(0, 300)}` : ''}`,
      );
    }
    const data = (await response.json()) as BochaResponse;
    return { engineKind: 'provider', engine: provider.name, items: parseBochaResponse(data) };
  } catch (err) {
    throw toEngineError(provider.name, err, params.timeoutMs, [provider.apiKey]);
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Tavily Search API
// POST https://api.tavily.com/search
// Bearer key；响应 { answer, results[]{title,url,content} }
// 432/433 = 月配额耗尽；401/403/429 = key 问题
// ============================================================================

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
}

/** 解析 Tavily 响应为统一结果（纯函数，供测试）；note 为引擎生成的总述 */
export function parseTavilyResponse(data: TavilyResponse): {
  items: SearchItem[];
  note?: string;
} {
  const items = (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
    source: safeHostname(r.url ?? ''),
  }));
  return { items, note: data.answer || undefined };
}

async function searchTavily(
  provider: SearchProviderRef,
  params: SearchParams,
  fetchFn: FetchFn,
): Promise<SearchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const base = provider.baseURL?.trim()
      ? provider.baseURL.trim().replace(/\/$/, '')
      : 'https://api.tavily.com';
    const response = await fetchFn(`${base}/search`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        query: params.query,
        search_depth: 'basic',
        include_answer: true,
        max_results: clampInt(params.maxResults, 1, 20),
      }),
    });
    if (!response.ok) {
      const detail = redactKeys(await response.text().catch(() => ''), [provider.apiKey]);
      if (response.status === 432 || response.status === 433) {
        throw new Error(
          `Tavily 月配额已耗尽（HTTP ${response.status}）。可充值 https://app.tavily.com 或改用其他引擎。`,
        );
      }
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        throw new Error(`Tavily 拒绝了该 API key（HTTP ${response.status}）。请检查服务商 API Key 配置。`);
      }
      throw new Error(
        `Tavily 返回 ${response.status} ${response.statusText}.${detail ? ` ${detail.slice(0, 300)}` : ''}`,
      );
    }
    const data = (await response.json()) as TavilyResponse;
    const { items, note } = parseTavilyResponse(data);
    return {
      engineKind: 'provider',
      engine: provider.name,
      items,
      ...(note ? { note } : {}),
    };
  } catch (err) {
    throw toEngineError(provider.name, err, params.timeoutMs, [provider.apiKey]);
  } finally {
    clearTimeout(timer);
  }
}

/** 引擎内部异常归一（超时/网络错误识别；key redact） */
function toEngineError(engine: string, err: unknown, timeoutMs: number, keys: string[]): Error {
  if (err instanceof SearchError) {
    return err;
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new Error(`${engine} 请求超时（${timeoutMs}ms）`);
  }
  const message = redactKeys(err instanceof Error ? err.message : String(err), keys);
  return new Error(`${engine} 请求失败: ${message}`);
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
