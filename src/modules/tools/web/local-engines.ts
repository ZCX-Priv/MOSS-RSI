// tools/web/local-engines.ts
// 本地免费搜索引擎（无需 API key）：bing + baidu + sogou 三引擎自动回退。
// 实现 HTTP 抓取方案，
// 传输层改用 Bun 内置 fetch（redirect: manual 手动处理重定向），解析层用 cheerio。
// 引擎细节：
//   - bing：cn.bing.com/search 直连；反爬页（无结果 + captcha 关键词）抛 ChallengeError 降级
//   - baidu：固定 tn=88093251_62_hao_pg 是绕过 302 验证码的关键；302 Location 命中
//     wappass/captcha 即验证码拦截
//   - sogou：需合并 set-cookie 并仅跟随 sogou.com 域内重定向（防跳出）；结果链接是
//     sogou 跳转链，需解 url/u/link 参数还原真实 URL
// 回退链：bing → baidu → sogou；单引擎失败（超时/网络/反爬/0 结果）记录原因降级下一个。

import * as cheerio from 'cheerio';

/** 本地引擎统一结果条目 */
export interface LocalSearchItem {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  engine: 'bing' | 'baidu' | 'sogou';
}

/** 本地链搜索结果 */
export interface LocalSearchOutcome {
  engineKind: 'local';
  engine: 'bing' | 'baidu' | 'sogou';
  items: LocalSearchItem[];
  /** 逐引擎失败记录（成功引擎之前的失败原因） */
  fallbackFrom: Array<{ engine: string; reason: string }>;
}

/** 本地引擎错误：全链失败时抛出，携带逐引擎原因 */
export class LocalSearchError extends Error {
  readonly failures: Array<{ engine: string; reason: string }>;

  constructor(failures: Array<{ engine: string; reason: string }>) {
    const summary = failures.map((f) => `[${f.engine}] ${f.reason}`).join('；');
    super(`本地引擎（bing/baidu/sogou）全部失败：${summary}`);
    this.name = 'LocalSearchError';
    this.failures = failures;
  }
}

/** 反爬/验证码拦截（区别于普通网络错误，语义上不可重试该引擎） */
class ChallengeError extends Error {}

/** 本地引擎 fetch 签名（注入便于单测 mock；默认用内置 fetch） */
export type LocalFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface LocalSearchOptions {
  query: string;
  /** 结果条数上限（1-20） */
  maxResults: number;
  /** 单引擎整体超时 */
  timeoutMs: number;
  /** fetch 注入（单测 mock） */
  fetchFn?: LocalFetchFn;
}

/** 引擎执行器签名 */
type EngineExecutor = (
  query: string,
  maxResults: number,
  timeoutMs: number,
  fetchFn: LocalFetchFn,
) => Promise<LocalSearchItem[]>;

/** 回退链顺序：bing → baidu → sogou */
const ENGINE_CHAIN: Array<{ name: 'bing' | 'baidu' | 'sogou'; execute: EngineExecutor }> = [
  { name: 'bing', execute: searchBing },
  { name: 'baidu', execute: searchBaidu },
  { name: 'sogou', execute: searchSogou },
];

/** 通用浏览器请求头（Chrome/zh-CN） */
const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/**
 * 执行本地链搜索：按 bing → baidu → sogou 依次尝试，
 * 失败（超时/网络/反爬/0 结果）降级下一个；全失败抛 LocalSearchError。
 */
export async function runLocalSearch(options: LocalSearchOptions): Promise<LocalSearchOutcome> {
  const fetchFn: LocalFetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  const failures: Array<{ engine: string; reason: string }> = [];

  for (const { name, execute } of ENGINE_CHAIN) {
    try {
      const items = await execute(
        options.query.trim(),
        clampInt(options.maxResults, 1, 20),
        options.timeoutMs,
        fetchFn,
      );
      if (items.length === 0) {
        failures.push({ engine: name, reason: '未解析到结果' });
        continue;
      }
      return { engineKind: 'local', engine: name, items, fallbackFrom: failures };
    } catch (err) {
      failures.push({
        engine: name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new LocalSearchError(failures);
}

// ============================================================================
// Bing（cn.bing.com，国内直连）
// ============================================================================

/** Bing 反爬关键词（页面无结果且命中 ≥2 个 → 判定拦截） */
const BING_BOT_KEYWORDS = [
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

function buildBingUrl(query: string, page: number): string {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('setlang', 'zh-CN');
  url.searchParams.set('ensearch', '0');
  url.searchParams.set('first', String(1 + page * 10));
  return url.toString();
}

/** 解析 Bing 结果页（纯函数，供测试）：.b_algo 卡片（h2>a 标题链接 + caption 摘要） */
export function parseBingResults(html: string): LocalSearchItem[] {
  const $ = cheerio.load(html);
  const results: LocalSearchItem[] = [];
  const seen = new Set<string>();

  // 反爬判定：无结构化结果 且（captcha UI 或 标题强信号 或 命中关键词 ≥2）
  const hasResults = $('#b_results .b_algo, .b_algo').length > 0;
  if (!hasResults) {
    const normalized = html.toLowerCase();
    const title = $('title').first().text().trim().toLowerCase();
    const hit = BING_BOT_KEYWORDS.filter((kw) => normalized.includes(kw));
    const titleSignal = ['captcha', 'verify you are human', 'access denied', '验证码', '人机验证', '请验证'].some(
      (kw) => title.includes(kw),
    );
    const hasCaptchaUi = $(
      ['iframe[src*="captcha"]', '[id*="captcha"]', '[class*="captcha"]', '#b_captcha'].join(','),
    ).length > 0;
    if (hasCaptchaUi || titleSignal || hit.length >= 2) {
      throw new ChallengeError(`Bing 返回验证/反爬页面（命中: ${hit.join(', ') || 'captcha'}）`);
    }
  }

  $('#b_results .b_algo, .b_algo').each((_, el) => {
    if (results.length >= 20) return false;
    const card = $(el);
    const titleLink = card.find('h2 a').first();
    const title = titleLink.text().trim();
    const url = titleLink.attr('href') || '';
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    const snippet = card.find('.b_caption p, .b_lineclamp2, .b_paractl').first().text().trim();
    const source = card.find('cite').first().text().trim();
    results.push({
      title,
      url,
      snippet,
      ...(source ? { source } : {}),
      engine: 'bing',
    });
  });

  return results;
}

async function searchBing(
  query: string,
  maxResults: number,
  timeoutMs: number,
  fetchFn: LocalFetchFn,
): Promise<LocalSearchItem[]> {
  const all: LocalSearchItem[] = [];
  const seen = new Set<string>();
  const signal = AbortSignal.timeout(timeoutMs);

  // 最多翻 2 页凑够 maxResults
  for (let page = 0; page < 2 && all.length < maxResults; page++) {
    const response = await fetchFn(buildBingUrl(query, page), {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { ...BROWSER_HEADERS, referer: 'https://cn.bing.com/' },
    });
    if (response.status >= 300 && response.status < 400) {
      // Bing 正常不该 302；视为异常降级
      throw new Error(`Bing 意外重定向（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      throw new Error(`Bing 返回 HTTP ${response.status}`);
    }
    const html = await response.text();
    const pageResults = parseBingResults(html);
    for (const item of pageResults) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      all.push(item);
    }
    if (pageResults.length === 0) break;
  }

  return all.slice(0, maxResults);
}

// ============================================================================
// Baidu（固定 tn 参数绕过 302 验证码）
// ============================================================================

const BAIDU_TN = '88093251_62_hao_pg';
const BAIDU_PAGE_SIZE = 10;

function buildBaiduUrl(query: string, page: number): string {
  const url = new URL('https://www.baidu.com/s');
  url.searchParams.set('wd', query);
  url.searchParams.set('tn', BAIDU_TN);
  url.searchParams.set('ie', 'utf-8');
  url.searchParams.set('pn', String(page * BAIDU_PAGE_SIZE));
  return url.toString();
}

/** baidu 302 目标命中这些关键词 = 安全验证拦截（非普通跳转） */
function isBaiduChallengeRedirect(location: string): boolean {
  return /wappass|captcha|antispider|verify/i.test(location);
}

/** 解析 Baidu 结果页（纯函数，供测试）：#content_left 卡片；验证码页抛 ChallengeError */
export function parseBaiduResults(html: string): LocalSearchItem[] {
  const normalized = html.toLowerCase();
  if (
    normalized.includes('wappass') ||
    normalized.includes('百度安全验证') ||
    normalized.includes('请输入验证码') ||
    normalized.includes('antispider')
  ) {
    throw new ChallengeError('Baidu 返回安全验证页');
  }

  const $ = cheerio.load(html);
  const results: LocalSearchItem[] = [];
  const seen = new Set<string>();

  $('#content_left')
    .children()
    .each((_, el) => {
      if (results.length >= 20) return false;
      const card = $(el);
      const titleElement = card.find('h3').first();
      const linkElement = card.find('a').first();
      const title = titleElement.text().replace(/\s+/g, ' ').trim();
      const url = linkElement.attr('href') || '';
      if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) return;
      seen.add(url);
      // 摘要：aria-label 优先（新前端），否则 .cos-row 文本
      const snippetEl = card.find('.cos-row').first();
      const snippet =
        card.find('.c-font-normal.c-color-text').first().attr('aria-label') ||
        snippetEl.text().replace(/\s+/g, ' ').trim();
      const source = card.find('.cosc-source').first().text().replace(/\s+/g, ' ').trim();
      results.push({
        title,
        url,
        snippet,
        ...(source ? { source } : {}),
        engine: 'baidu',
      });
    });

  return results;
}

async function searchBaidu(
  query: string,
  maxResults: number,
  timeoutMs: number,
  fetchFn: LocalFetchFn,
): Promise<LocalSearchItem[]> {
  const all: LocalSearchItem[] = [];
  const seen = new Set<string>();
  const maxPage = Math.max(1, Math.ceil(maxResults / BAIDU_PAGE_SIZE));
  const signal = AbortSignal.timeout(timeoutMs);

  for (let page = 0; page < maxPage && all.length < maxResults; page++) {
    // redirect: manual —— 302 不静默跟随：wappass 验证码跳转必须显式识别为拦截
    const response = await fetchFn(buildBaiduUrl(query, page), {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: BROWSER_HEADERS,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') || '';
      if (isBaiduChallengeRedirect(location)) {
        throw new ChallengeError('Baidu 重定向到安全验证页');
      }
      throw new Error(`Baidu 意外重定向: ${location || response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Baidu 返回 HTTP ${response.status}`);
    }

    const html = await response.text();
    const pageResults = parseBaiduResults(html);
    for (const item of pageResults) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      all.push(item);
    }
    if (pageResults.length === 0) break;
  }

  return all.slice(0, maxResults);
}

// ============================================================================
// Sogou（cookie 跟随 + 域内重定向 + 跳转链还原）
// ============================================================================

const SOGOU_PAGE_SIZE = 10;

function buildSogouUrl(query: string, page: number): string {
  const url = new URL('https://www.sogou.com/web');
  url.searchParams.set('query', query);
  url.searchParams.set('page', String(page));
  url.searchParams.set('ie', 'utf8');
  return url.toString();
}

/** sogou 结果链接是跳转链：解 url/u/link 参数还原真实地址 */
function resolveSogouResultUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
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

/** 合并 set-cookie 到请求 cookie 头（sogou 重定向要求带回 cookie） */
function mergeSetCookie(cookieHeader: string, response: Response): string {
  const getSetCookie =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
  if (getSetCookie.length === 0) return cookieHeader;
  const cookieMap = new Map<string, string>();
  for (const cookie of cookieHeader.split(';')) {
    const trimmed = cookie.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const name = eq > 0 ? trimmed.slice(0, eq) : trimmed;
    cookieMap.set(name, trimmed);
  }
  for (const value of getSetCookie) {
    const pair = value.split(';')[0]?.trim();
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = eq > 0 ? pair.slice(0, eq) : pair;
    cookieMap.set(name, pair);
  }
  return Array.from(cookieMap.values()).join('; ');
}

/** 仅允许 sogou.com 域内重定向（防跳出钓鱼） */
function isAllowedSogouRedirect(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    (hostname === 'sogou.com' || hostname.endsWith('.sogou.com'))
  );
}

/** 解析 Sogou 结果页（纯函数，供测试）：#main .vrwrap/.rb/.result；验证码页抛 ChallengeError */
export function parseSogouResults(html: string): LocalSearchItem[] {
  const normalized = html.toLowerCase();
  if (
    normalized.includes('antispider') ||
    normalized.includes('请输入验证码') ||
    normalized.includes('访问过于频繁')
  ) {
    throw new ChallengeError('Sogou 返回验证/反爬页面');
  }

  const $ = cheerio.load(html);
  const results: LocalSearchItem[] = [];
  const seen = new Set<string>();

  const resultSelectors = ['#main .vrwrap', '#main .rb', '#main .result'].join(',');
  $(resultSelectors).each((_, el) => {
    if (results.length >= 20) return false;
    const card = $(el);
    const titleLink = card
      .find('h3 a[href], h2 a[href], .vr-title a[href], .pt a[href]')
      .first();
    const rawUrl = titleLink.attr('href') || '';
    const url = resolveSogouResultUrl(rawUrl);
    const title = titleLink.text().replace(/\s+/g, ' ').trim();
    if (!title || !url || seen.has(url)) return;
    seen.add(url);
    const snippet = card
      .find('.str_info, .ft, .text-layout, .fz-mid, p')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const sourceText = card.find('cite, .citeurl, .g, .url').first().text().replace(/\s+/g, ' ').trim();
    let source = sourceText;
    if (!source) {
      try {
        source = new URL(url).hostname;
      } catch {
        source = '';
      }
    }
    results.push({
      title,
      url,
      snippet,
      ...(source ? { source } : {}),
      engine: 'sogou',
    });
  });

  return results;
}

/** 抓取 sogou 搜索页（含 cookie 合并 + 域内重定向跟随，≤5 跳） */
async function fetchSogouHtml(
  initialUrl: string,
  timeoutMs: number,
  fetchFn: LocalFetchFn,
): Promise<string> {
  let currentUrl = initialUrl;
  let cookieHeader = '';
  const signal = AbortSignal.timeout(timeoutMs);

  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchFn(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        ...BROWSER_HEADERS,
        referer: 'https://www.sogou.com/',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
    });
    cookieHeader = mergeSetCookie(cookieHeader, response);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Sogou 重定向（HTTP ${response.status}）缺少 Location`);
      }
      const redirectUrl = new URL(location, currentUrl);
      if (!isAllowedSogouRedirect(redirectUrl)) {
        throw new Error(`Sogou 重定向到意外主机: ${redirectUrl.hostname}`);
      }
      currentUrl = redirectUrl.toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(`Sogou 返回 HTTP ${response.status}`);
    }
    return response.text();
  }

  throw new Error('Sogou 重定向次数过多');
}

async function searchSogou(
  query: string,
  maxResults: number,
  timeoutMs: number,
  fetchFn: LocalFetchFn,
): Promise<LocalSearchItem[]> {
  const all: LocalSearchItem[] = [];
  const seen = new Set<string>();
  const maxPage = Math.max(1, Math.ceil(maxResults / SOGOU_PAGE_SIZE));

  for (let page = 1; page <= maxPage && all.length < maxResults; page++) {
    const html = await fetchSogouHtml(buildSogouUrl(query, page), timeoutMs, fetchFn);
    const pageResults = parseSogouResults(html);
    for (const item of pageResults) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      all.push(item);
    }
    if (pageResults.length === 0) break;
  }

  return all.slice(0, maxResults);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
