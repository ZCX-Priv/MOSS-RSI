// tools/web/search/engines/sogou.ts
// Sogou 抓取与解析。真机实测关键点：
// - 结果链接是 /link?url=...，真实地址在卡片内的 data-url 属性；
// - 需要首页 Cookie + Referer，302 只在 sogou.com 域内跟随；
// - 302 到 antispider 即验证码，必须识别而不是当普通重定向。

import * as cheerio from 'cheerio';
import { engineRequest, markChallenge, warmUpEngine } from '../http-client';
import type { EnginePage, Freshness, RawResult } from '../types';
import { EngineRequestError } from '../types';
import { clip, extractDate, normalizeSpace } from './common';

export const SOGOU_PAGE_SIZE = 10;
const SOGOU_HOME = 'https://www.sogou.com/';

function sogouTimeParams(freshness: Freshness): { s_from?: string; tsn?: string } {
  switch (freshness) {
    case 'oneDay':
      return { s_from: 'inttime_day', tsn: '1' };
    case 'oneWeek':
      return { s_from: 'inttime_week', tsn: '1' };
    case 'oneMonth':
      return { s_from: 'inttime_month', tsn: '1' };
    case 'oneYear':
      return { s_from: 'inttime_year', tsn: '1' };
    case 'noLimit':
      return {};
  }
}

/** 构造 Sogou 搜索 URL（page 为 0 基，URL 的 page 从 1 开始） */
export function buildSogouUrl(query: string, page: number, freshness: Freshness = 'noLimit'): string {
  const url = new URL('https://www.sogou.com/web');
  url.searchParams.set('query', query);
  url.searchParams.set('page', String(page + 1));
  url.searchParams.set('ie', 'utf8');
  const time = sogouTimeParams(freshness);
  if (time.s_from) url.searchParams.set('s_from', time.s_from);
  if (time.tsn) url.searchParams.set('tsn', time.tsn);
  return url.toString();
}

function isSogouChallengePage(html: string): boolean {
  const normalized = html.toLowerCase();
  const $ = cheerio.load(html);
  const title = normalizeSpace($('title').first().text());
  return (
    normalized.includes('antispider') ||
    normalized.includes('请输入验证码') ||
    normalized.includes('访问过于频繁') ||
    title.includes('搜狗搜索验证')
  );
}

/** 从 /link?url= 或 data-url 还原真实地址 */
export function resolveSogouResultUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed) && !/sogou\.com\/link/i.test(trimmed)) {
    return trimmed;
  }
  try {
    const absolute = new URL(trimmed, 'https://www.sogou.com/web').toString();
    const parsed = new URL(absolute);
    const target =
      parsed.searchParams.get('url') ||
      parsed.searchParams.get('u') ||
      parsed.searchParams.get('link');
    if (target && /^https?:\/\//i.test(target)) return target;
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return absolute;
  } catch {
    return '';
  }
  return '';
}

/** 解析 Sogou 结果页（纯函数，供单测） */
export function parseSogouResults(html: string): RawResult[] {
  if (isSogouChallengePage(html)) {
    throw new EngineRequestError('sogou', 'Sogou 返回验证/反爬页面', { challenge: true });
  }

  const $ = cheerio.load(html);
  const results: RawResult[] = [];
  const seen = new Set<string>();

  const selectors = [
    '#main .rb',
    '#main .vrwrap:not(.special-wrap)',
    '#results .vrwrap',
    '.results .vrwrap',
    '.results .rb',
  ].join(',');

  $(selectors).each((_, node) => {
    if (results.length >= 20) return false;
    const card = $(node);
    if (card.hasClass('special-wrap') || card.find('.special-wrap').length > 0) return;

    const titleLink = card
      .find('h3.pt a[href], h3.vr-title a[href], h3 a[href], .vr-title a[href], .pt a[href]')
      .first();
    const rawHref = titleLink.attr('href') ?? '';
    const dataUrl = card.find('[data-url]').first().attr('data-url') ?? '';
    const url = resolveSogouResultUrl(dataUrl) || resolveSogouResultUrl(rawHref);
    const title = normalizeSpace(titleLink.text());
    if (!title || !url || seen.has(url)) return;

    const snippet =
      normalizeSpace(card.find('.ft').first().text()) ||
      normalizeSpace(card.find('.attribute-centent').first().text()) ||
      normalizeSpace(card.find('.fz-mid.space-txt').first().text()) ||
      normalizeSpace(card.find('.str_info').first().text()) ||
      normalizeSpace(card.find('p').first().text());

    const sourceText = normalizeSpace(
      card.find('cite').first().text() || card.find('.citeurl, .g, .url').first().text(),
    );
    let source = sourceText;
    if (!source) {
      try {
        source = new URL(url).hostname;
      } catch {
        source = '';
      }
    }
    const publishedAt = extractDate(card.find('.cite-date').first().text() || card.find('cite').first().text());

    seen.add(url);
    results.push({
      engine: 'sogou',
      rank: results.length,
      title: clip(title, 200),
      url,
      snippet: clip(snippet, 600),
      ...(source ? { source: clip(source, 120) } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
  });

  return results;
}

function isAllowedSogouRedirect(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    (host === 'sogou.com' || host.endsWith('.sogou.com'))
  );
}

export interface SogouSearchOptions {
  freshness: Freshness;
  timeoutMs: number;
  signal?: AbortSignal;
  proxyUrl?: string;
  referer?: string;
}

/** 抓取 Sogou 搜索页：预热 Cookie + 仅域内重定向跟随（≤5 跳） */
async function fetchSogouHtml(initialUrl: string, options: SogouSearchOptions): Promise<string> {
  await warmUpEngine('sogou', SOGOU_HOME, {
    engine: 'sogou',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    proxyUrl: options.proxyUrl,
  });

  let currentUrl = initialUrl;
  for (let hop = 0; hop <= 5; hop++) {
    const response = await engineRequest({
      engine: 'sogou',
      url: currentUrl,
      referer: hop === 0 ? options.referer ?? SOGOU_HOME : SOGOU_HOME,
      site: 'same-origin',
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      proxyUrl: options.proxyUrl,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new EngineRequestError('sogou', `Sogou 重定向（HTTP ${response.status}）缺少 Location`);
      }
      const redirectUrl = new URL(location, currentUrl);
      if (!isAllowedSogouRedirect(redirectUrl)) {
        throw new EngineRequestError('sogou', `Sogou 重定向到意外主机：${redirectUrl.hostname}`);
      }
      if (/antispider|captcha|verify/i.test(redirectUrl.pathname + redirectUrl.search)) {
        markChallenge('sogou', 'Sogou 重定向到验证页');
        throw new EngineRequestError('sogou', 'Sogou 重定向到验证页', { challenge: true });
      }
      currentUrl = redirectUrl.toString();
      continue;
    }
    if (!response.ok) {
      throw new EngineRequestError('sogou', `Sogou 返回 HTTP ${response.status}`);
    }
    return response.text();
  }
  throw new EngineRequestError('sogou', 'Sogou 重定向次数过多');
}

/** 抓取并解析 Sogou 单页 */
export async function searchSogouPage(
  query: string,
  page: number,
  options: SogouSearchOptions,
): Promise<EnginePage> {
  const html = await fetchSogouHtml(buildSogouUrl(query, page, options.freshness), options);
  let items: RawResult[];
  try {
    items = parseSogouResults(html);
  } catch (error) {
    if (error instanceof EngineRequestError && error.challenge) {
      markChallenge('sogou', error.message);
    }
    throw error;
  }
  return {
    engine: 'sogou',
    items,
    exhausted: items.length === 0 || items.length < SOGOU_PAGE_SIZE,
  };
}
