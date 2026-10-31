// tools/web/search/engines/bing.ts
// Bing（cn.bing.com）抓取与解析：
// - 完整浏览器头 + _EDGE_V/_EDGE_S Cookie（http-client 注入）
// - /ck/a?u=a1... 是 base64url 跳转链，必须本地解码，否则结果全是 bing 内链
// - 翻页越界时 Bing 会静默返回第一页，用 sb_count 与「本页是否全重复」双重判定 exhausted

import * as cheerio from 'cheerio';
import { engineRequest, markChallenge } from '../http-client';
import type { EnginePage, Freshness, RawResult } from '../types';
import { EngineRequestError } from '../types';
import { clip, epochDayNumber, extractDate, normalizeSpace } from './common';

export const BING_PAGE_SIZE = 10;
const BING_HOME = 'https://cn.bing.com/';

const BOT_KEYWORDS = [
  'captcha',
  'verification',
  'verify you are human',
  'access denied',
  'blocked',
  'rate limit',
  'too many requests',
  '请验证',
  '验证码',
  '人机验证',
];

function bingTimeFilter(freshness: Freshness): string | null {
  switch (freshness) {
    case 'oneDay':
      return 'ex1:"ez1"';
    case 'oneWeek':
      return 'ex1:"ez2"';
    case 'oneMonth':
      return 'ex1:"ez3"';
    case 'oneYear': {
      const today = epochDayNumber();
      return `ex1:"ez5_${today - 365}_${today}"`;
    }
    case 'noLimit':
      return null;
  }
}

/** 构造 Bing 搜索 URL（导出供单测） */
export function buildBingUrl(query: string, page: number, freshness: Freshness = 'noLimit'): string {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('first', String(1 + page * BING_PAGE_SIZE));
  url.searchParams.set('setlang', 'zh-CN');
  url.searchParams.set('ensearch', '0');
  url.searchParams.set('mkt', 'zh-CN');
  if (page >= 1) url.searchParams.set('FORM', 'PERE');
  const filter = bingTimeFilter(freshness);
  if (filter) {
    url.searchParams.set('filt', 'custom');
    url.searchParams.set('filters', filter);
  }
  return url.toString();
}

/** 解码 Bing /ck/a 跳转链；非跳转链返回原 URL（无效返回空串） */
export function decodeBingUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  let resolved = trimmed;
  if (resolved.startsWith('//')) resolved = `https:${resolved}`;
  if (resolved.startsWith('/')) {
    if (resolved.startsWith('/search') || resolved.startsWith('/ck/a') || resolved.startsWith('/newtabredir')) {
      return '';
    }
    resolved = `https://cn.bing.com${resolved}`;
  }
  if (!/^https?:\/\//i.test(resolved)) return '';

  try {
    const url = new URL(resolved);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (host.endsWith('bing.com') && path.startsWith('/ck/a')) {
      const encoded = url.searchParams.get('u')?.trim() ?? '';
      if (!encoded) return '';
      const payload = encoded.startsWith('a1') ? encoded.slice(2) : encoded;
      try {
        const decoded = Buffer.from(payload, 'base64url').toString('utf8').trim();
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {
        return '';
      }
      return '';
    }
    if (host.endsWith('bing.com') && (path.startsWith('/search') || path.startsWith('/newtabredir'))) {
      return '';
    }
    for (const param of ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source']) {
      url.searchParams.delete(param);
    }
    return url.toString();
  } catch {
    return '';
  }
}

/** 结果总数（`span.sb_count`），拿不到返回 null */
export function parseBingResultCount(html: string): number | null {
  const $ = cheerio.load(html);
  const text = normalizeSpace($('#b_results .sb_count, span.sb_count').first().text());
  const matched = /(\d[\d,]*)/.exec(text);
  if (!matched) return null;
  const count = Number.parseInt(matched[1].replace(/,/g, ''), 10);
  return Number.isFinite(count) ? count : null;
}

function assertBingNotBlocked(html: string): void {
  const $ = cheerio.load(html);
  const hasResults = $('#b_results .b_algo, #b_results li.b_algo, .b_algo, .b_ans').length > 0;
  if (hasResults) return;

  const normalized = html.toLowerCase();
  const title = normalizeSpace($('title').first().text()).toLowerCase();
  const hit = BOT_KEYWORDS.filter((keyword) => normalized.includes(keyword));
  const hasCaptchaUi = $([
    'iframe[src*="captcha"]',
    '[id*="captcha"]',
    '[class*="captcha"]',
    'form[action*="validate"]',
    'input[name*="captcha"]',
    '#b_captcha',
    '.b_captcha',
  ].join(',')).length > 0;
  const titleSignal = ['captcha', 'verify you are human', 'access denied', 'too many requests', '验证码', '人机验证', '请验证']
    .some((keyword) => title.includes(keyword));

  if (hasCaptchaUi || titleSignal || hit.length >= 2) {
    throw new EngineRequestError('bing', `Bing 返回验证/反爬页面（命中: ${hit.join(', ') || 'captcha'}）`, {
      challenge: true,
    });
  }
}

/** 解析 Bing 结果页（纯函数，供单测） */
export function parseBingResults(html: string): RawResult[] {
  assertBingNotBlocked(html);
  const $ = cheerio.load(html);
  const results: RawResult[] = [];
  const seen = new Set<string>();

  const selectors = [
    '#b_results > li.b_algo',
    '#b_results > li.b_ans',
    '#b_topw > li.b_algo',
    '#b_topw > li.b_ans',
    '.b_algo',
    '.b_ans',
  ];

  for (const selector of selectors) {
    $(selector).each((_, node) => {
      if (results.length >= 20) return false;
      const element = $(node);
      if (
        element.hasClass('b_ad') ||
        element.closest('.b_ad').length > 0 ||
        element.hasClass('b_pag') ||
        element.hasClass('b_msg')
      ) {
        return;
      }

      // 按优先级逐个尝试：Bing 卡片的 b_tpcn/a.tilk 在 h2 之前，统一 find 会被站点图标链接抢占
      const h2 = element.find('h2').first();
      const h2Link = h2.find('a[href]').first();
      const titleLink = h2Link.length > 0
        ? h2Link
        : element.find('.b_title a[href]').first().length > 0
          ? element.find('.b_title a[href]').first()
          : element.find('a.tilk[href]').first();
      const url = decodeBingUrl(
        titleLink.attr('href') || titleLink.attr('redirecturl') || titleLink.attr('data-h') || '',
      );
      if (!url || seen.has(url)) return;

      const title =
        normalizeSpace(h2.text()) ||
        normalizeSpace(element.find('.b_title, .tptt').first().text()) ||
        normalizeSpace(titleLink.text());
      if (!title) return;

      const snippet = normalizeSpace(
        element.find('.b_caption p').first().text() ||
        element.find('.b_caption').first().text() ||
        element.find('.b_snippet, .b_lineclamp2, .b_lineclamp3').first().text(),
      ) || normalizeSpace(element.text()).replace(title, '').trim();

      const sourceText = normalizeSpace(
        element.find('.tptt').first().text() ||
        element.find('a.tilk').first().attr('aria-label') ||
        element.find('.b_attribution cite').first().text() ||
        element.find('cite').first().text(),
      );
      let source = sourceText;
      if (!source) {
        try {
          source = new URL(url).hostname;
        } catch {
          source = '';
        }
      }

      const publishedAt = extractDate(element.text());
      seen.add(url);
      results.push({
        engine: 'bing',
        rank: results.length,
        title: clip(title, 200),
        url,
        snippet: clip(snippet, 600),
        ...(source ? { source: clip(source, 120) } : {}),
        ...(publishedAt ? { publishedAt } : {}),
      });
    });
    if (results.length >= 20) break;
  }

  // 兜底：结果页结构异常但仍有外链时，从候选容器里提取
  if (results.length === 0) {
    $('#b_results a[href], #b_topw a[href], .b_algo a[href], .b_ans a[href]').each((_, node) => {
      if (results.length >= 20) return false;
      const link = $(node);
      const url = decodeBingUrl(link.attr('href') || link.attr('redirecturl') || link.attr('data-h') || '');
      if (!url || seen.has(url)) return;
      const container = link.closest('li, .b_algo, .b_ans');
      const title = normalizeSpace(container.find('h2, h3, .b_title, .tptt').first().text()) ||
        normalizeSpace(link.text());
      if (!title) return;
      seen.add(url);
      results.push({
        engine: 'bing',
        rank: results.length,
        title: clip(title, 200),
        url,
        snippet: clip(normalizeSpace(container.text()).replace(title, '').trim(), 600),
      });
    });
  }

  return results;
}

export interface BingSearchOptions {
  freshness: Freshness;
  timeoutMs: number;
  signal?: AbortSignal;
  proxyUrl?: string;
  /** 上一页搜索 URL（翻页时作为 Referer） */
  referer?: string;
}

/** 抓取并解析 Bing 单页 */
export async function searchBingPage(
  query: string,
  page: number,
  options: BingSearchOptions,
): Promise<EnginePage> {
  const url = buildBingUrl(query, page, options.freshness);
  const response = await engineRequest({
    engine: 'bing',
    url,
    referer: options.referer ?? BING_HOME,
    site: 'same-origin',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    proxyUrl: options.proxyUrl,
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? '';
    if (/captcha|verify|challenge|accessdenied/i.test(location)) {
      markChallenge('bing', 'Bing 重定向到验证页');
      throw new EngineRequestError('bing', 'Bing 重定向到验证页', { challenge: true });
    }
    throw new EngineRequestError('bing', `Bing 意外重定向：${location || response.status}`);
  }
  if (!response.ok) {
    throw new EngineRequestError('bing', `Bing 返回 HTTP ${response.status}`);
  }

  const html = await response.text();
  let items: RawResult[];
  try {
    items = parseBingResults(html);
  } catch (error) {
    if (error instanceof EngineRequestError && error.challenge) {
      markChallenge('bing', error.message);
    }
    throw error;
  }

  const total = parseBingResultCount(html);
  const exhausted = items.length === 0 || (total !== null && (page + 1) * BING_PAGE_SIZE >= total);
  return { engine: 'bing', items, exhausted };
}
