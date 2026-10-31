// tools/web/search/engines.test.ts
// 三引擎解析器与 URL 构造单测（纯 fixture，不联网）。

import { describe, it, expect } from 'bun:test';
import { decodeBingUrl, parseBingResults, buildBingUrl } from './engines/bing';
import { parseBaiduResults, buildBaiduUrl } from './engines/baidu';
import { parseSogouResults, buildSogouUrl } from './engines/sogou';
import { EngineRequestError } from './types';

const BING_HTML = `
<html><body><div id="b_results">
  <li class="b_algo">
    <div class="b_tpcn"><a class="tilk" href="https://example.com/">example.comhttps://example.com › path</a></div>
    <h2><a href="https://example.com/1">结果一 标题</a></h2>
    <div class="b_caption"><p>结果一摘要内容</p></div>
    <cite>example.com</cite>
  </li>
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9jay1yZWFs">结果二 跳转链</a></h2>
    <div class="b_caption"><p>结果二摘要</p></div>
  </li>
  <li class="b_ad"><h2><a href="https://ad.example.com/x">广告条目</a></h2></li>
  <li class="b_algo"><h2><a href="https://example.com/1">重复 URL</a></h2></li>
</div></body></html>`;

const BAIDU_HTML = `
<html><body><div id="content_left">
  <div class="result c-container">
    <h3><a href="/link?url=abc">百度结果一</a></h3>
    <div class="c-font-normal c-color-text" aria-label="aria 摘要一"></div>
    <div class="cosc-source">来源一站</div>
    <span>2026-10-30</span>
  </div>
  <div class="result c-container">
    <h3><a href="https://example.com/baidu2">百度结果二</a></h3>
    <div class="cos-row">百度摘要二</div>
  </div>
  <div class="result-op ec_ad_results"><h3>广告</h3><a href="https://ad.example.com/x">x</a></div>
</div></body></html>`;

const SOGOU_HTML = `
<html><body><div id="main">
  <div class="vrwrap">
    <h3 class="vr-title"><a href="/link?url=abc">搜狗结果一</a></h3>
    <div class="attribute-centent">搜索摘要一</div>
    <div class="cite-date">2026-10-30</div>
    <div data-url="https://example.com/real1"></div>
  </div>
  <div class="vrwrap">
    <h3 class="pt"><a href="/link?url=https%3A%2F%2Fexample.com%2Freal2">搜狗结果二</a></h3>
    <div class="ft">搜索摘要二</div>
    <cite>example.com</cite>
  </div>
  <div class="vrwrap special-wrap"><h3><a href="/link?url=javascript:x">特别卡片</a></h3></div>
  <div class="rb"><h3 class="pt"><a href="/link?url=abc">重复结果</a></h3><div data-url="https://example.com/real1"></div></div>
</div></body></html>`;

describe('Bing', () => {
  it('解析 h2 标题/URL/摘要/来源，跳过广告与重复', () => {
    const results = parseBingResults(BING_HTML);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: '结果一 标题',
      url: 'https://example.com/1',
      snippet: '结果一摘要内容',
      source: 'example.com',
      engine: 'bing',
    });
    // b_tpcn 的 a.tilk 在 h2 之前，不能抢走标题
    expect(results[0]?.title).not.toContain('example.com');
  });

  it('解码 /ck/a 跳转链', () => {
    const target = 'https://example.com/ck-real';
    const encoded = `a1${Buffer.from(target, 'utf8').toString('base64url')}`;
    expect(
      decodeBingUrl(`https://www.bing.com/ck/a?u=${encoded}&u3=https%3A%2F%2Fexample.com`),
    ).toBe(target);
  });

  it('验证码页抛 EngineRequestError(challenge)', () => {
    const html = '<html><title>请输入验证码</title><div id="b_captcha"></div></html>';
    expect(() => parseBingResults(html)).toThrow(EngineRequestError);
    try {
      parseBingResults(html);
    } catch (error) {
      expect((error as EngineRequestError).challenge).toBe(true);
    }
  });

  it('URL 构造含 first/FORM/freshness', () => {
    const url = new URL(buildBingUrl('DeepSeek V4', 2, 'oneWeek'));
    expect(url.searchParams.get('first')).toBe('21');
    expect(url.searchParams.get('FORM')).toBe('PERE');
    expect(url.searchParams.get('filt')).toBe('custom');
    expect(url.searchParams.get('filters')).toBe('ex1:"ez2"');
  });
});

describe('Baidu', () => {
  it('解析 #content_left：aria 摘要优先、跳转链标记、广告跳过', () => {
    const results = parseBaiduResults(BAIDU_HTML);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: '百度结果一',
      snippet: 'aria 摘要一',
      source: '来源一站',
      engine: 'baidu',
      publishedAt: '2026-10-30',
    });
    expect(results[0]?.redirectUrl).toBe('https://www.baidu.com/link?url=abc');
    expect(results[0]?.flags).toContain('baidu-redirect');
    expect(results[1]?.url).toBe('https://example.com/baidu2');
    expect(results[1]?.snippet).toBe('百度摘要二');
  });

  it('安全验证页抛 challenge', () => {
    expect(() => parseBaiduResults('<html><body>百度安全验证</body></html>')).toThrow(EngineRequestError);
  });

  it('URL 构造含 tn/pn/rn/gpc', () => {
    const url = new URL(buildBaiduUrl('测试', 2, 'oneDay'));
    expect(url.searchParams.get('tn')).toBe('88093251_62_hao_pg');
    expect(url.searchParams.get('pn')).toBe('20');
    expect(url.searchParams.get('rn')).toBe('10');
    expect(url.searchParams.get('gpc')).toContain('stftype=1');
  });
});

describe('Sogou', () => {
  it('优先使用 data-url 真链，跳过 special-wrap，去重', () => {
    const results = parseSogouResults(SOGOU_HTML);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: '搜狗结果一',
      url: 'https://example.com/real1',
      snippet: '搜索摘要一',
      publishedAt: '2026-10-30',
      engine: 'sogou',
    });
    expect(results[1]?.url).toBe('https://example.com/real2');
    expect(results.map((item) => item.title)).not.toContain('特别卡片');
  });

  it('验证码/反爬页抛 challenge', () => {
    expect(() => parseSogouResults('<html><body>antispider</body></html>')).toThrow(EngineRequestError);
  });

  it('URL 构造 page 从 1 开始，含 s_from/tsn', () => {
    const url = new URL(buildSogouUrl('测试', 1, 'oneMonth'));
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('s_from')).toBe('inttime_month');
    expect(url.searchParams.get('tsn')).toBe('1');
  });
});
