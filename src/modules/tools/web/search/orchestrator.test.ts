// tools/web/search/orchestrator.test.ts
// 编排单测：default 并行、直连单引擎、失败降级、分页缓存、清洗不足自动翻页、正文增强。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { runSearch } from './orchestrator';
import { SearchError, type SearchParams } from './types';
import { __resetStoreForTests } from './store';
import { __resetHttpStateForTests, __setFastModeForTests } from './http-client';
import { __resetBaiduRedirectCacheForTests } from './engines/baidu';
import { __resetEnrichCacheForTests } from './enrich';

const originalFetch = globalThis.fetch;

const TOPICS = [
  '发布会', '评测', '教程', '对比', '价格', '参数', '入门', '进阶', '社区', '新闻',
  '问答', '案例', '实测', '文档', '更新', '生态', '下载', '安全', '性能', '部署',
];

function titleFor(query: string, index: number): string {
  // 追加唯一 CJK 字，避免 fixture 标题因数字被忽略而被误判为近似重复
  const uniqueMark = String.fromCharCode(0x4e00 + index);
  return `${TOPICS[index % TOPICS.length]}：${query} 第${index}篇${uniqueMark}`;
}

function snippetFor(query: string, index: number): string {
  return `${query} 的第${index}条摘要，${TOPICS[index % TOPICS.length]}相关内容的详细介绍与说明文字，并附带可核对的来源与时间信息，帮助判断相关性。`;
}

function urlFor(index: number): string {
  return `https://93.184.216.34/article/${index}`;
}

function bingHtml(query: string, page: number, perPage = 10): string {
  const start = page * 10;
  const items = Array.from({ length: perPage }, (_, offset) => {
    const index = start + offset;
    return `<li class="b_algo"><h2><a href="${urlFor(index)}">${titleFor(query, index)}</a></h2>
      <div class="b_caption"><p>${snippetFor(query, index)}</p></div><cite>example.com</cite></li>`;
  }).join('');
  return `<html><body><div id="b_results">${items}</div></body></html>`;
}

function baiduHtml(query: string, page: number, perPage = 10): string {
  const start = page * 10;
  const items = Array.from({ length: perPage }, (_, offset) => {
    const index = start + offset;
    return `<div class="result c-container"><h3><a href="${urlFor(index)}">${titleFor(query, index)}</a></h3>
      <div class="cos-row">${snippetFor(query, index)}</div></div>`;
  }).join('');
  return `<html><body><div id="content_left">${items}</div></body></html>`;
}

function sogouHtml(query: string, page: number, perPage = 10): string {
  const start = page * 10;
  const items = Array.from({ length: perPage }, (_, offset) => {
    const index = start + offset;
    return `<div class="vrwrap"><h3 class="vr-title"><a href="/link?url=abc">${titleFor(query, index)}</a></h3>
      <div class="attribute-centent">${snippetFor(query, index)}</div>
      <div data-url="${urlFor(index)}"></div></div>`;
  }).join('');
  return `<html><body><div id="main">${items}</div></body></html>`;
}

function articleHtml(query: string): string {
  const text = `${query} 的正文内容。`.repeat(50);
  return `<html><head><title>${query} 内容页</title></head><body>
    <header>导航</header><article><h1>${query}</h1><p>${text}</p></article>
    <footer>页脚</footer></body></html>`;
}

interface MockOptions {
  challengeAll?: boolean;
  firstPageOnlyOne?: boolean;
  failBing?: boolean;
  failSogou?: boolean;
}

function installFetch(options: MockOptions = {}) {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = String(input);
    requests.push(raw);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return new Response('bad', { status: 400 });
    }
    const host = url.hostname;
    const query = url.searchParams.get('q') ?? url.searchParams.get('wd') ?? url.searchParams.get('query') ?? '测试查询';

    if (options.challengeAll && (
      (host.includes('bing') && url.pathname === '/search') ||
      (host.includes('baidu') && url.pathname === '/s') ||
      (host.includes('sogou') && url.pathname === '/web')
    )) {
      return new Response('<html><title>请输入验证码</title><div id="b_captcha"></div>百度安全验证 antispider</html>', { status: 200 });
    }

    if (host === 'cn.bing.com' && url.pathname === '/search') {
      if (options.failBing) {
        return new Response('<html><title>请输入验证码</title><div id="b_captcha"></div></html>', { status: 200 });
      }
      const page = Math.max(0, (Number.parseInt(url.searchParams.get('first') ?? '1', 10) - 1) / 10);
      const perPage = options.firstPageOnlyOne && page === 0 ? 1 : 10;
      if (page > 2) return new Response('<html><div id="b_results"></div></html>', { status: 200 });
      return new Response(bingHtml(query, page, perPage), { status: 200, headers: { 'content-type': 'text/html' } });
    }

    if (host === 'www.baidu.com' && url.pathname === '/') {
      return new Response('<html><body>baidu home</body></html>', {
        status: 200,
        headers: { 'set-cookie': 'BAIDUID=test; Path=/' },
      });
    }
    if (host === 'www.baidu.com' && url.pathname === '/s') {
      const page = Math.max(0, Number.parseInt(url.searchParams.get('pn') ?? '0', 10) / 10);
      const perPage = options.firstPageOnlyOne && page === 0 ? 1 : 10;
      if (page > 2) return new Response('<html><div id="content_left"></div></html>', { status: 200 });
      return new Response(baiduHtml(query, page, perPage), { status: 200 });
    }

    if (host === 'www.sogou.com' && url.pathname === '/') {
      return new Response('<html><body>sogou home</body></html>', {
        status: 200,
        headers: { 'set-cookie': 'SUV=test; Path=/' },
      });
    }
    if (host === 'www.sogou.com' && url.pathname === '/web') {
      if (options.failSogou) {
        return new Response('<html><body>antispider</body></html>', { status: 200 });
      }
      const page = Math.max(0, Number.parseInt(url.searchParams.get('page') ?? '1', 10) - 1);
      const perPage = options.firstPageOnlyOne && page === 0 ? 1 : 10;
      if (page > 2) return new Response('<html><div id="main"></div></html>', { status: 200 });
      return new Response(sogouHtml(query, page, perPage), { status: 200 });
    }

    return new Response(articleHtml(query), { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  return requests;
}

function searchRequestCount(requests: string[]): number {
  return requests.filter((raw) => {
    try {
      const url = new URL(raw);
      return (
        (url.hostname === 'cn.bing.com' && url.pathname === '/search') ||
        (url.hostname === 'www.baidu.com' && url.pathname === '/s') ||
        (url.hostname === 'www.sogou.com' && url.pathname === '/web')
      );
    } catch {
      return false;
    }
  }).length;
}

function baseParams(overrides: Partial<SearchParams> = {}): SearchParams {
  return {
    sessionId: 'test-session',
    query: '测试查询',
    provider: 'default',
    pageSize: 10,
    offset: 0,
    freshness: 'noLimit',
    timeoutMs: 20_000,
    ...overrides,
  };
}

beforeEach(() => {
  __resetStoreForTests();
  __resetHttpStateForTests();
  __resetEnrichCacheForTests();
  __resetBaiduRedirectCacheForTests();
  __setFastModeForTests(true);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setFastModeForTests(false);
});

describe('runSearch: default 元搜索', () => {
  it('并行三引擎、清洗去重、返回首页与 sources', async () => {
    const requests = installFetch();
    const result = await runSearch(baseParams());
    expect(result.provider).toBe('default');
    expect(result.items.length).toBe(10);
    expect(result.totalAvailable).toBeGreaterThanOrEqual(10);
    expect(result.cacheHit).toBe(false);
    expect(result.engines.succeeded.sort()).toEqual(['baidu', 'bing', 'sogou']);
    expect(result.items.every((item) => item.engines.length >= 1)).toBe(true);
    expect(searchRequestCount(requests)).toBe(3);
  });

  it('searchId + offset=10 命中缓存，不再请求搜索引擎', async () => {
    const requests = installFetch();
    const first = await runSearch(baseParams({ pageSize: 20 }));
    const firstSearchRequests = searchRequestCount(requests);

    const second = await runSearch(baseParams({ searchId: first.searchId, offset: 10 }));
    expect(second.cacheHit).toBe(true);
    expect(second.items.length).toBeGreaterThan(0);
    expect(searchRequestCount(requests)).toBe(firstSearchRequests);
    expect(second.nextOffset).toBe(20);
  });

  it('直连 provider 只请求指定引擎，不做正文增强', async () => {
    const requests = installFetch();
    const result = await runSearch(baseParams({ provider: 'bing' }));
    expect(result.provider).toBe('bing');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.engines.succeeded).toEqual(['bing']);
    expect(searchRequestCount(requests)).toBe(1);
    expect(result.items.every((item) => !item.contentExcerpt)).toBe(true);
  });

  it('单引擎验证码不影响其他引擎，partial=true', async () => {
    installFetch({ failBing: true });
    const result = await runSearch(baseParams());
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.engines.failed.some((failure) => failure.engine === 'bing')).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.engines.succeeded).not.toContain('bing');
  });

  it('所有引擎失败抛 all-failed', async () => {
    installFetch({ challengeAll: true });
    try {
      await runSearch(baseParams());
      throw new Error('should not reach');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchError);
      const searchError = error as SearchError;
      expect(searchError.code).toBe('all-failed');
      expect(searchError.failures.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('首页清洗后不足 pageSize 时自动翻页补足', async () => {
    installFetch({ firstPageOnlyOne: true });
    const result = await runSearch(baseParams());
    expect(result.items.length).toBe(10);
    expect(result.totalAvailable).toBeGreaterThanOrEqual(10);
  });

  it('default 抓取头部结果正文并生成摘录', async () => {
    installFetch();
    const result = await runSearch(baseParams());
    const enriched = result.items.filter((item) => item.contentExcerpt);
    expect(enriched.length).toBeGreaterThan(0);
    expect(result.items.some((item) => item.contentQuality === 'high')).toBe(true);
  });

  it('offset 超出池时返回空并给出 warning', async () => {
    installFetch();
    const first = await runSearch(baseParams());
    const beyond = await runSearch(baseParams({ searchId: first.searchId, offset: 99 }));
    expect(beyond.items).toHaveLength(0);
    expect(beyond.warnings.some((warning) => warning.includes('offset'))).toBe(true);
  });
});
