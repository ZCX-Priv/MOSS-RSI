// tools/web/search/engines/baidu.ts
// Baidu 抓取与解析。真机实测关键点：
// - 裸请求 / tn=json 会 302 到 wappass 验证码；
// - 首页预热 Cookie + tn=88093251_62_hao_pg 才能稳定拿到 #content_left；
// - 结果 href 多为 /link?url= 跳转链，输出当前页时按需解析为真实地址。

import * as cheerio from 'cheerio';
import { engineRequest, markChallenge, warmUpEngine } from '../http-client';
import type { EnginePage, Freshness, RawResult } from '../types';
import { EngineRequestError } from '../types';
import { clip, extractDate, normalizeSpace } from './common';

export const BAIDU_PAGE_SIZE = 10;
const BAIDU_HOME = 'https://www.baidu.com/';
const BAIDU_TN = '88093251_62_hao_pg';
const REDIRECT_CACHE_TTL_MS = 10 * 60_000;
const REDIRECT_CACHE_MAX = 200;
const REDIRECT_CONCURRENCY = 4;
const REDIRECT_INTERVAL_MS = 100;

const redirectCache = new Map<string, { target: string; expiresAt: number }>();

function baiduTimeRangeMs(freshness: Freshness): number | null {
  switch (freshness) {
    case 'oneDay':
      return 86_400_000;
    case 'oneWeek':
      return 604_800_000;
    case 'oneMonth':
      return 2_592_000_000;
    case 'oneYear':
      return 31_536_000_000;
    case 'noLimit':
      return null;
  }
}

/** 构造 Baidu 搜索 URL（导出供单测） */
export function buildBaiduUrl(query: string, page: number, freshness: Freshness = 'noLimit'): string {
  const url = new URL('https://www.baidu.com/s');
  url.searchParams.set('wd', query);
  url.searchParams.set('tn', BAIDU_TN);
  url.searchParams.set('ie', 'utf-8');
  url.searchParams.set('pn', String(page * BAIDU_PAGE_SIZE));
  url.searchParams.set('rn', String(BAIDU_PAGE_SIZE));
  const range = baiduTimeRangeMs(freshness);
  if (range) {
    const now = Math.floor(Date.now() / 1000);
    url.searchParams.set('gpc', `stf=${now - Math.floor(range / 1000)},${now}|stftype=1`);
  }
  return url.toString();
}

function isBaiduChallengeRedirect(location: string): boolean {
  return /wappass|captcha|antispider|verify/i.test(location);
}

function isBaiduChallengePage(html: string): boolean {
  const normalized = html.toLowerCase();
  return (
    normalized.includes('wappass') ||
    normalized.includes('百度安全验证') ||
    normalized.includes('请输入验证码') ||
    normalized.includes('antispider') ||
    normalized.includes('antiflag')
  );
}

function absoluteBaiduLink(href: string): string {
  try {
    const url = new URL(href, 'https://www.baidu.com/');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.hostname.toLowerCase().endsWith('baidu.com') && url.pathname.startsWith('/link')) {
      // 跳转链统一用 https，减少一次明文 302
      url.protocol = 'https:';
      return url.toString();
    }
    return url.toString();
  } catch {
    return '';
  }
}

/** 解析 Baidu 结果页（纯函数，供单测） */
export function parseBaiduResults(html: string): RawResult[] {
  if (isBaiduChallengePage(html)) {
    throw new EngineRequestError('baidu', 'Baidu 返回安全验证页', { challenge: true });
  }

  const $ = cheerio.load(html);
  const results: RawResult[] = [];
  const seen = new Set<string>();

  $('#content_left').children().each((_, node) => {
    if (results.length >= 20) return false;
    const card = $(node);
    if (card.hasClass('ec_ad_results') || card.find('.ec-tuiguang, .c-ad, .ad-tag').length > 0) return;

    const titleElement = card.find('h3').first();
    const linkElement = card.find('h3 a[href]').first().length > 0
      ? card.find('h3 a[href]').first()
      : card.find('a[href]').first();
    const title = normalizeSpace(titleElement.text());
    const href = linkElement.attr('href') ?? '';
    const url = absoluteBaiduLink(href);
    if (!title || !url) return;

    const isRedirect = /baidu\.com\/link/.test(url);
    if (seen.has(url)) return;

    const snippet =
      normalizeSpace(card.find('.c-font-normal.c-color-text').first().attr('aria-label') ?? '') ||
      normalizeSpace(card.find('.cos-row').first().text()) ||
      normalizeSpace(card.find('.c-abstract').first().text()) ||
      normalizeSpace(card.find('.content-right_8Zs40').first().text());

    const sourceText = normalizeSpace(
      card.find('.cosc-source').first().text() || card.find('.c-showurl').first().text(),
    );
    if (normalizeSpace(card.text()).startsWith('广告') && !snippet) return;

    seen.add(url);
    results.push({
      engine: 'baidu',
      rank: results.length,
      title: clip(title, 200),
      url,
      snippet: clip(snippet, 600),
      ...(sourceText ? { source: clip(sourceText, 120) } : {}),
      ...(extractDate(card.text()) ? { publishedAt: extractDate(card.text()) } : {}),
      ...(isRedirect ? { redirectUrl: url, flags: ['baidu-redirect'] } : {}),
    });
  });

  return results;
}

export interface BaiduSearchOptions {
  freshness: Freshness;
  timeoutMs: number;
  signal?: AbortSignal;
  proxyUrl?: string;
  referer?: string;
}

/** 抓取并解析 Baidu 单页（首页预热 → 搜索） */
export async function searchBaiduPage(
  query: string,
  page: number,
  options: BaiduSearchOptions,
): Promise<EnginePage> {
  const common = {
    engine: 'baidu' as const,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    proxyUrl: options.proxyUrl,
    referer: options.referer ?? BAIDU_HOME,
  };

  await warmUpEngine('baidu', BAIDU_HOME, common);

  const response = await engineRequest({
    ...common,
    url: buildBaiduUrl(query, page, options.freshness),
    referer: page === 0 ? BAIDU_HOME : options.referer ?? BAIDU_HOME,
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? '';
    if (isBaiduChallengeRedirect(location)) {
      markChallenge('baidu', 'Baidu 重定向到安全验证页');
      throw new EngineRequestError('baidu', 'Baidu 重定向到安全验证页', { challenge: true });
    }
    throw new EngineRequestError('baidu', `Baidu 意外重定向：${location || response.status}`);
  }
  if (!response.ok) {
    throw new EngineRequestError('baidu', `Baidu 返回 HTTP ${response.status}`);
  }

  const html = await response.text();
  let items: RawResult[];
  try {
    items = parseBaiduResults(html);
  } catch (error) {
    if (error instanceof EngineRequestError && error.challenge) {
      markChallenge('baidu', error.message);
    }
    throw error;
  }

  return {
    engine: 'baidu',
    items,
    exhausted: items.length === 0 || items.length < BAIDU_PAGE_SIZE,
  };
}

function isBaiduSelfHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower.endsWith('baidu.com') || lower.endsWith('wappass.baidu.com');
}

/** 解析单条跳转链（带缓存 + 轻量限速），失败返回 null */
async function resolveOneRedirect(
  item: RawResult,
  options: Omit<BaiduSearchOptions, 'freshness'>,
): Promise<string | null> {
  if (!item.redirectUrl) return null;
  const key = item.redirectUrl;
  const cached = redirectCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.target;

  try {
    const response = await engineRequest({
      engine: 'baidu',
      url: key,
      referer: 'https://www.baidu.com/',
      site: 'same-origin',
      timeoutMs: Math.min(5_000, options.timeoutMs),
      signal: options.signal,
      proxyUrl: options.proxyUrl,
      skipRateLimit: true,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '';
      if (!/^https?:\/\//i.test(location)) return null;
      const target = new URL(location);
      if (isBaiduSelfHost(target.hostname)) return null;
      const value = target.toString();
      if (redirectCache.size >= REDIRECT_CACHE_MAX) {
        const oldest = redirectCache.keys().next().value;
        if (typeof oldest === 'string') redirectCache.delete(oldest);
      }
      redirectCache.set(key, { target: value, expiresAt: Date.now() + REDIRECT_CACHE_TTL_MS });
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 输出当前页前解析 Baidu 跳转链（并发 4，非搜索请求走 100ms 轻量间隔）。
 * 解析失败保留原跳转链并保留 flag，不影响搜索结果本身。
 */
export async function resolveBaiduRedirects(
  items: RawResult[],
  options: Omit<BaiduSearchOptions, 'freshness'>,
): Promise<RawResult[]> {
  const redirects = items.filter((item) => item.redirectUrl);
  if (redirects.length === 0) return items;

  const resolved = new Map<string, string>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(REDIRECT_CONCURRENCY, redirects.length) }, async () => {
    while (cursor < redirects.length) {
      const current = redirects[cursor++];
      if (!current) return;
      if (cursor > 1) {
        await new Promise((resolve) => setTimeout(resolve, REDIRECT_INTERVAL_MS));
      }
      const target = await resolveOneRedirect(current, options);
      if (target) resolved.set(current.url, target);
    }
  });
  await Promise.all(workers);

  if (resolved.size === 0) return items;
  return items.map((item) => {
    const target = resolved.get(item.url);
    if (!target) return item;
    return {
      ...item,
      url: target,
      flags: item.flags?.filter((flag) => flag !== 'baidu-redirect'),
    };
  });
}

/** 测试重置：清空跳转缓存 */
export function __resetBaiduRedirectCacheForTests(): void {
  redirectCache.clear();
}
