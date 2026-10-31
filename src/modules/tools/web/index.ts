// tools/web/index.ts
// web 工具：mode=search 走 AI 原生元搜索引擎；mode=fetch 走加固后的正文抓取。
//
// search 契约：
// - provider = default | bing | baidu | sogou（省略 = default 元搜索）
// - pageSize 10-20，offset 0-99；首次返回 searchId，后续可只传 searchId+offset 翻页
// - 同一 query/provider/freshness 命中结果池缓存（15 分钟），避免重复打引擎被风控

import { t } from '../../../core/i18n';
import type { ToolContext, ToolResult } from '../types';
import type { Freshness, ProviderName, SearchPage } from './search/types';
import { SearchError } from './search/types';
import { runSearch } from './search/orchestrator';
import { runFetch, FetchError } from './fetcher';

interface WebParams {
  mode?: 'search' | 'fetch';
  query?: string;
  url?: string;
  provider?: string;
  pageSize?: number;
  offset?: number;
  searchId?: string;
  freshness?: Freshness;
  timeoutMs?: number;
}

interface WebToolConfig {
  timeoutMs?: number;
  pageSize?: number;
  maxFetchChars?: number;
  proxyUrl?: string;
}

const MAX_QUERY_LENGTH = 500;
const MAX_TITLE_CHARS = 120;
const MAX_URL_CHARS = 500;
const MAX_OUTPUT_CHARS = 7_800;

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = (params ?? {}) as WebParams;
    if (p.mode !== 'search' && p.mode !== 'fetch') {
      return {
        content: [{ type: 'text', text: `Error: ${t('tools.webModeInvalid')}` }],
        isError: true,
      };
    }
    const cfg = (ctx.toolConfig ?? {}) as WebToolConfig;
    return p.mode === 'search'
      ? executeSearch(p, cfg, ctx)
      : executeFetch(p, cfg, ctx);
  },
};

function normalizeProvider(value: string | undefined): ProviderName | null {
  if (!value || value.trim() === '') return 'default';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'default') return 'default';
  if (normalized === 'bing') return 'bing';
  if (normalized === 'baidu') return 'baidu';
  if (normalized === 'sogou' || normalized === 'sougou') return 'sogou';
  return null;
}

// ============================================================================
// search
// ============================================================================

async function executeSearch(
  p: WebParams,
  cfg: WebToolConfig,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!p.searchId?.trim()) {
    if (!p.query || typeof p.query !== 'string' || !p.query.trim()) {
      return { content: [{ type: 'text', text: `Error: ${t('tools.webQueryRequired')}` }], isError: true };
    }
    if (p.query.length > MAX_QUERY_LENGTH) {
      return {
        content: [{ type: 'text', text: `Error: ${t('tools.webQueryTooLong', { max: MAX_QUERY_LENGTH })}` }],
        isError: true,
      };
    }
  }

  const provider = normalizeProvider(p.provider);
  if (!provider) {
    return {
      content: [{ type: 'text', text: `Error: ${t('tools.webProviderInvalid')}` }],
      isError: true,
    };
  }

  const pageSize = clampInt(p.pageSize ?? cfg.pageSize ?? 10, 10, 20);
  const offset = clampInt(p.offset ?? 0, 0, 99);
  const timeoutMs = clampInt(p.timeoutMs ?? cfg.timeoutMs ?? 30_000, 3_000, 120_000);
  const freshness: Freshness = p.freshness ?? 'noLimit';

  ctx.emit?.({ type: 'progress', message: t('tools.webSearching') });

  try {
    const page = await runSearch({
      sessionId: ctx.sessionId,
      query: p.query?.trim() ?? '',
      provider,
      pageSize,
      offset,
      ...(p.searchId?.trim() ? { searchId: p.searchId.trim() } : {}),
      freshness,
      timeoutMs,
      signal: ctx.signal,
      ...(cfg.proxyUrl?.trim() ? { proxyUrl: cfg.proxyUrl.trim() } : {}),
    });
    return formatSearchResult(page);
  } catch (err) {
    return formatSearchError(err);
  }
}

function formatSearchResult(page: SearchPage): ToolResult {
  const from = page.items.length > 0 ? page.offset + 1 : 0;
  const to = page.offset + page.items.length;
  const range = `${from}-${to}/${page.totalAvailable}`;
  const engineLabel = page.engines.succeeded.length > 0
    ? page.engines.succeeded.join('+')
    : page.engines.attempted.join('+');
  const header = t('tools.webResultHeader', {
    provider: page.provider,
    range,
    engines: engineLabel,
    elapsed: page.elapsedMs,
  });

  const warnings = [...page.warnings];
  if (page.engines.failed.length > 0) {
    warnings.push(
      `${t('tools.webEngineFailed')}: ${page.engines.failed
        .map((failure) => `[${failure.engine}] ${failure.reason}`)
        .join('；')}`,
    );
  }
  if (page.partial) warnings.push(t('tools.webSearchPartial'));

  if (page.items.length === 0) {
    const lines = [header, t('tools.webNoResults')];
    if (warnings.length > 0) {
      lines.push('', `${t('tools.webWarningLabel')}:`, ...warnings.map((item) => `- ${item}`));
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      metadata: searchMetadata(page),
    };
  }

  const baseText = renderSearchText(page, header, warnings, false);
  const fullText = renderSearchText(page, header, warnings, true);
  let text = fullText.length <= MAX_OUTPUT_CHARS ? fullText : baseText;
  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n${t('tools.webSearchTruncated')}`;
  }

  return { content: [{ type: 'text', text }], metadata: searchMetadata(page) };
}

function renderSearchText(
  page: SearchPage,
  header: string,
  warnings: string[],
  includeContent: boolean,
): string {
  const snippetCap = page.pageSize <= 10 ? 260 : 180;
  const excerptCap = page.pageSize <= 10 ? 320 : 240;
  const blocks = page.items.map((item, index) => {
    const number = page.offset + index + 1;
    const lines: string[] = [];
    lines.push(`[${number}] ${truncate(item.title || item.url, MAX_TITLE_CHARS)}`);
    if (item.url) lines.push(`    URL: ${truncate(item.url, MAX_URL_CHARS)}`);
    const metaParts: string[] = [];
    if (item.source) metaParts.push(`${t('tools.webSourceLabel')}: ${item.source}`);
    if (item.publishedAt) metaParts.push(item.publishedAt);
    if (item.engines.length > 0) metaParts.push(`${t('tools.webHitLabel')}: ${item.engines.join('+')}`);
    if (metaParts.length > 0) lines.push(`    ${metaParts.join(' | ')}`);
    if (item.snippet) lines.push(`    ${t('tools.webSnippetLabel')}: ${truncate(item.snippet, snippetCap)}`);
    if (includeContent && item.contentExcerpt) {
      lines.push(`    ${t('tools.webContentLabel')}: ${truncate(item.contentExcerpt, excerptCap)}`);
    }
    return lines.join('\n');
  });

  const sections: string[] = [header, '', blocks.join('\n\n')];
  if (page.hasMore && page.nextOffset !== undefined) {
    sections.push(
      '',
      t('tools.webSearchNextHint', {
        searchId: page.searchId,
        offset: page.nextOffset,
        pageSize: page.pageSize,
      }),
    );
  } else {
    sections.push('', t('tools.webSearchNoMore'));
  }
  if (warnings.length > 0) {
    sections.push('', `${t('tools.webWarningLabel')}:`, ...warnings.map((item) => `- ${item}`));
  }
  return sections.join('\n');
}

function searchMetadata(page: SearchPage): Record<string, unknown> {
  return {
    mode: 'search',
    searchId: page.searchId,
    provider: page.provider,
    query: page.query,
    offset: page.offset,
    pageSize: page.pageSize,
    returned: page.items.length,
    totalAvailable: page.totalAvailable,
    hasMore: page.hasMore,
    ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
    engines: page.engines,
    stats: page.stats,
    partial: page.partial,
    cacheHit: page.cacheHit,
    warnings: page.warnings,
    elapsedMs: page.elapsedMs,
    items: page.items,
  };
}

function formatSearchError(err: unknown): ToolResult {
  if (err instanceof SearchError) {
    if (err.code === 'all-failed') {
      const lines = err.failures
        .map((failure) => `[${failure.engine}] ${failure.reason}${failure.cooldownMs ? `（冷却 ${Math.ceil(failure.cooldownMs / 1000)}s）` : ''}`)
        .join('\n');
      return {
        content: [{ type: 'text', text: `Error: ${t('tools.webAllEnginesFailed')}\n${lines}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

// ============================================================================
// fetch
// ============================================================================

async function executeFetch(
  p: WebParams,
  cfg: WebToolConfig,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!p.url || typeof p.url !== 'string' || !p.url.trim()) {
    return { content: [{ type: 'text', text: `Error: ${t('tools.webUrlRequired')}` }], isError: true };
  }

  const timeoutMs = clampInt(p.timeoutMs ?? cfg.timeoutMs ?? 20_000, 3_000, 60_000);
  const maxChars = clampInt(cfg.maxFetchChars ?? 20_000, 1_000, 100_000);

  ctx.emit?.({ type: 'progress', message: t('tools.webFetching', { url: p.url }) });

  try {
    const result = await runFetch({
      url: p.url,
      timeoutMs,
      maxChars,
      signal: ctx.signal,
      ...(cfg.proxyUrl?.trim() ? { proxyUrl: cfg.proxyUrl.trim() } : {}),
    });
    return formatFetchResult(result);
  } catch (err) {
    return formatFetchError(err, timeoutMs);
  }
}

function formatFetchResult(result: Awaited<ReturnType<typeof runFetch>>): ToolResult {
  const header = t('tools.webFetchHeader', {
    url: result.finalUrl,
    status: `${result.status} ${result.statusText}`.trim(),
    bytes: formatBytes(result.meta.bytes),
    elapsed: result.meta.elapsedMs,
  });

  const sections: string[] = [header];
  if (result.title) sections.push(`${t('tools.webTitleLabel')}: ${result.title}`);
  sections.push('', result.text);
  if (result.meta.truncated) sections.push('', t('tools.webTruncated'));
  if (result.links.length > 0) {
    const linkLines = result.links.map((link, index) => `${index + 1}. ${link.text} → ${link.url}`);
    sections.push('', t('tools.webLinksLabel'), linkLines.join('\n'));
  }
  if (result.warnings.length > 0) {
    sections.push('', result.warnings.map((warning) => `${t('tools.webWarningLabel')}: ${warning}`).join('\n'));
  }

  return {
    content: [{ type: 'text', text: sections.join('\n') }],
    metadata: {
      mode: 'fetch',
      url: result.requestUrl,
      finalUrl: result.finalUrl,
      status: result.status,
      contentType: result.contentType,
      bytes: result.meta.bytes,
      truncated: result.meta.truncated,
      redirectChain: result.meta.redirectChain,
      title: result.title,
      quality: result.meta.quality,
      elapsedMs: result.meta.elapsedMs,
      links: result.links,
    },
  };
}

function formatFetchError(err: unknown, timeoutMs: number): ToolResult {
  if (err instanceof FetchError) {
    const reason = [err.message, err.causeMessage].filter(Boolean).join(': ');
    switch (err.code) {
      case 'invalid-url':
        return { content: [{ type: 'text', text: `Error: ${t('tools.webUrlInvalid', { reason })}` }], isError: true };
      case 'unsafe-target':
        return { content: [{ type: 'text', text: `Error: ${t('tools.webUnsafeUrl', { reason })}` }], isError: true };
      case 'timeout':
        return { content: [{ type: 'text', text: `Error: ${t('tools.webTimeout', { ms: timeoutMs })}` }], isError: true };
      case 'too-large':
        return { content: [{ type: 'text', text: `Error: ${t('tools.webTooLarge')}` }], isError: true };
      case 'unsupported-type':
        return { content: [{ type: 'text', text: `Error: ${t('tools.webUnsupportedType', { reason: err.message })}` }], isError: true };
      case 'too-many-redirects':
        return { content: [{ type: 'text', text: `Error: ${t('tools.webTooManyRedirects')}` }], isError: true };
      case 'blocked':
        return { content: [{ type: 'text', text: `Error: ${t('tools.webBlockedPage')}` }], isError: true };
      default:
        return { content: [{ type: 'text', text: `Error: ${t('tools.webFetchFailed', { reason })}` }], isError: true };
    }
  }
  return {
    content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

// ============================================================================
// helpers
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
