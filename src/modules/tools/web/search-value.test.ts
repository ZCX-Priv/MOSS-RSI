// src/modules/tools/web/search-value.test.ts
// 搜索结构化值（PTC）与展示文本完整性测试。

import { describe, expect, test } from 'bun:test';
import { buildSearchValue, renderSearchText } from './index';
import type { SearchItem, SearchPage } from './search/types';

function makeItem(index: number): SearchItem {
  return {
    title: `结果标题 ${index}`,
    url: `https://example.com/${index}`,
    snippet: '摘要'.repeat(200),
    source: 'example.com',
    publishedAt: '2026-11-01',
    engines: ['bing'],
    engineRanks: { bing: index },
    score: 100 - index,
    contentExcerpt: '正文摘录'.repeat(300),
    contentQuality: 'high',
  };
}

function makePage(overrides: Partial<SearchPage> = {}): SearchPage {
  const items = Array.from({ length: 20 }, (_unused, index) => makeItem(index));
  return {
    searchId: 'search-1',
    provider: 'default',
    query: 'AI 新闻',
    offset: 0,
    pageSize: 20,
    items,
    pool: items,
    totalAvailable: 100,
    hasMore: true,
    nextOffset: 20,
    engines: { attempted: ['bing', 'baidu', 'sogou'], succeeded: ['bing'], failed: [] },
    stats: { raw: 100, deduped: 100, dropped: 0, queryFiltered: 0 },
    warnings: [],
    partial: false,
    cacheHit: false,
    elapsedMs: 100,
    ...overrides,
  };
}

describe('buildSearchValue', () => {
  test('包含当前页 items、全量 pool 与翻页字段', () => {
    const value = buildSearchValue(makePage());
    expect(value.mode).toBe('search');
    expect(value.searchId).toBe('search-1');
    expect(value.totalAvailable).toBe(100);
    expect(value.hasMore).toBe(true);
    expect(value.nextOffset).toBe(20);
    expect((value.items as unknown[]).length).toBe(20);
    expect((value.pool as unknown[]).length).toBe(20);
    const first = (value.items as Array<Record<string, unknown>>)[0];
    expect(first?.contentExcerpt).toBeTruthy();
    const poolFirst = (value.pool as Array<Record<string, unknown>>)[0];
    expect(String(poolFirst?.snippet).length).toBeLessThanOrEqual(201);
  });
});

describe('renderSearchText', () => {
  test('最低级别仍保留全部条目（不丢结果、不 slice）', () => {
    const page = makePage();
    const text = renderSearchText(page, 'HEADER', [], 3);
    for (const item of page.items) {
      expect(text).toContain(item.title);
      expect(text).toContain(item.url);
    }
    expect(text).not.toContain('正文摘录');
  });

  test('完整级别包含正文摘录', () => {
    const text = renderSearchText(makePage(), 'HEADER', [], 0);
    expect(text).toContain('正文摘录');
  });
});
