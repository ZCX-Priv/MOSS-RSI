// tools/web/search/clean.test.ts
// 清洗/去重/排序引擎单测：URL 规范化、垃圾过滤、近似去重、相关性过滤、域名多样性。

import { describe, it, expect } from 'bun:test';
import {
  canonicalizeUrl,
  cleanResults,
  cleanTitle,
  queryTokens,
  simHash64,
  hammingDistance,
  titleSimilarity,
} from './clean';
import type { EngineName, RawResult } from './types';

function raw(
  engine: EngineName,
  rank: number,
  title: string,
  url: string,
  snippet: string,
  extra: Partial<RawResult> = {},
): RawResult {
  return { engine, rank, title, url, snippet, ...extra };
}

describe('clean: URL 规范化', () => {
  it('去 fragment/追踪参数、host 小写、默认端口、尾斜杠、query 排序', () => {
    expect(
      canonicalizeUrl('https://Example.COM:443/path/?utm_source=x&b=2&a=1#top'),
    ).toBe('https://example.com/path?a=1&b=2');
    expect(canonicalizeUrl('http://example.com:80/')).toBe('http://example.com/');
    expect(canonicalizeUrl('https://example.com/a?spm=1&from=share&id=3')).toBe('https://example.com/a?id=3');
  });

  it('非法 URL 返回空串', () => {
    expect(canonicalizeUrl('not a url')).toBe('');
    expect(canonicalizeUrl('ftp://example.com/x')).toBe('');
  });
});

describe('clean: 文本与 token', () => {
  it('标题去掉 URL/面包屑残留与站点后缀', () => {
    expect(cleanTitle('deepseek.comhttps://www.deepseek.com › platform')).toBe('deepseek.com');
    expect(cleanTitle('DeepSeek-V4_百度百科')).toBe('DeepSeek-V4');
    expect(cleanTitle('[广告] 立即下载')).toBe('立即下载');
  });

  it('中文 bigram + 英文词 token，过滤停用词', () => {
    const tokens = queryTokens('DeepSeek V4 最新版本 如何');
    expect(tokens).toContain('deepseek');
    expect(tokens).toContain('v4');
    expect(tokens).not.toContain('如何');
    expect(tokens.length).toBeGreaterThan(2);
  });
});

describe('clean: 近似去重', () => {
  it('标题相似度与 SimHash 可比较', () => {
    const a = 'DeepSeek V4 发布，技术报告解读';
    const b = 'DeepSeek V4 发布：技术报告解读';
    expect(titleSimilarity(a, b)).toBeGreaterThan(0.6);
    const ha = simHash64(`${a} 这是同一篇报道的转载`);
    const hb = simHash64(`${b} 这是同一篇报道的转载`);
    expect(ha).not.toBeNull();
    expect(hb).not.toBeNull();
    if (ha !== null && hb !== null) {
      expect(hammingDistance(ha, hb)).toBeLessThan(10);
    }
  });

  it('同 URL 不同追踪参数合并，并合并引擎命中', () => {
    const result = cleanResults(
      [
        raw('bing', 0, 'DeepSeek V4 官方发布', 'https://example.com/post?utm_source=bing', '官方发布内容'),
        raw('baidu', 1, 'DeepSeek V4 官方发布', 'https://example.com/post?from=baidu', '官方发布内容'),
      ],
      'DeepSeek V4',
      { minKeep: 1 },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.engines.sort()).toEqual(['baidu', 'bing']);
    expect(result.stats.deduped).toBe(1);
  });

  it('镜像站与官方同标题时优先保留官方 URL', () => {
    const result = cleanResults(
      [
        raw('bing', 0, 'DeepSeek | 深度求索', 'https://bot.aitexts.cn/deepseek', '深度求索官方页面镜像'),
        raw('baidu', 0, 'DeepSeek | 深度求索', 'https://www.deepseek.com/', '深度求索官方网站'),
        raw('sogou', 0, 'DeepSeek | 深度求索', 'https://bot.aitexts.cn/deepseek', '深度求索官方页面镜像'),
      ],
      'DeepSeek',
      { minKeep: 1 },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.url).toBe('https://www.deepseek.com/');
    expect(result.items[0]?.engines.sort()).toEqual(['baidu', 'bing', 'sogou']);
  });

  it('不同主题不会被合并', () => {
    const result = cleanResults(
      [
        raw('bing', 0, 'DeepSeek V4 发布', 'https://a.com/1', 'DeepSeek V4 发布'),
        raw('baidu', 1, '苹果 iPhone 18 评测', 'https://b.com/2', '苹果 iPhone 18 评测'),
      ],
      'DeepSeek V4',
      { minKeep: 1 },
    );
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    const titles = result.items.map((item) => item.title);
    expect(titles).toContain('DeepSeek V4 发布');
    expect(titles).not.toContain('苹果 iPhone 18 评测');
  });
});

describe('clean: 垃圾过滤与相关性', () => {
  it('过滤软件下载站/破解站与纯域名标题', () => {
    const result = cleanResults(
      [
        raw('sogou', 0, 'deepseekv4模型专业版官方正版下载2026最新版', 'https://www.cr173.com/soft/983077.html', '安卓版下载'),
        raw('sogou', 1, 'DeepSeek V4 正式版下载 安卓满血版', 'http://www.9663.com/downinfo/77489.html', '安装包下载'),
        raw('bing', 2, 'deepseek.comhttps://www.deepseek.com › platform', 'https://www.deepseek.com/platform', 'API 平台'),
        raw('bing', 3, 'DeepSeek V4 官方发布', 'https://www.deepseek.com/news/v4', '官方发布说明'),
      ],
      'DeepSeek V4',
      { minKeep: 1 },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.url).toBe('https://www.deepseek.com/news/v4');
    expect(result.stats.dropped).toBeGreaterThanOrEqual(2);
  });

  it('池充足时丢弃无关结果；池不足时保留避免空结果', () => {
    const data = [
      raw('bing', 0, 'DeepSeek V4 官方发布', 'https://deepseek.com/v4', 'DeepSeek V4 官方发布说明'),
      raw('bing', 1, 'DeepSeek V4 技术报告解读', 'https://example.com/v4', 'DeepSeek V4 技术细节'),
      raw('bing', 2, '红烧肉的家常做法', 'https://food.com/recipe', '红烧肉做法步骤'),
    ];
    const filtered = cleanResults(data, 'DeepSeek V4', { minKeep: 2 });
    expect(filtered.items.map((item) => item.title)).not.toContain('红烧肉的家常做法');
    expect(filtered.stats.queryFiltered).toBe(1);

    const kept = cleanResults(data, 'DeepSeek V4', { minKeep: 3 });
    expect(kept.items.map((item) => item.title)).toContain('红烧肉的家常做法');
    expect(kept.stats.queryFiltered).toBe(0);
  });

  it('同域名最多 2 条进入主列表，其余降级到池尾', () => {
    const data = [
      raw('bing', 0, 'DeepSeek V4 文档一', 'https://docs.deepseek.com/a', '文档一'),
      raw('bing', 1, 'DeepSeek V4 文档二', 'https://docs.deepseek.com/b', '文档二'),
      raw('bing', 2, 'DeepSeek V4 文档三', 'https://docs.deepseek.com/c', '文档三'),
      raw('bing', 3, 'DeepSeek V4 其他资源', 'https://other.com/d', '其他资源'),
    ];
    const result = cleanResults(data, 'DeepSeek V4', { minKeep: 1 });
    const firstTwoHosts = result.items.slice(0, 2).map((item) => item.url.includes('docs.deepseek.com'));
    expect(firstTwoHosts.filter(Boolean).length).toBe(2);
    expect(result.items[result.items.length - 1]?.url).toContain('docs.deepseek.com');
  });
});
