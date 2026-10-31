// tools/web/web.test.ts
// web 工具基础单测：HTML 提取、正文可读性、挑战页识别、SSRF 防护、抓取加固。

import { describe, it, expect, afterEach } from 'bun:test';
import iconv from 'iconv-lite';
import {
  extractVisibleTextFromHtml,
  decodeHtmlEntities,
  extractLinks,
  extractTitle,
  stripElement,
} from './html-extract';
import { extractReadableText, looksLikeChallengePage, selectExcerpt } from './readable';
import {
  isPrivateIpAddress,
  assertSafeTarget,
  normalizeFetchUrl,
  runFetch,
  FetchError,
  type LookupFn,
} from './fetcher';

const originalFetch = globalThis.fetch;
const okLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// html-extract（保留基础能力）
// ============================================================================

describe('html-extract', () => {
  it('剥离 script/style/head/noscript/template 与注释', () => {
    const html = `
      <html><head><title>T</title><style>.a{color:red}</style><script>var x = '<p>hidden</p>';</script></head>
      <body><!-- comment --><noscript>noscript text</noscript><template>t</template>
      <p>可见段落</p></body></html>`;
    const { text } = extractVisibleTextFromHtml(html);
    expect(text).toContain('可见段落');
    expect(text).not.toContain('hidden');
    expect(text).not.toContain('color:red');
  });

  it('实体解码与标题提取', () => {
    expect(decodeHtmlEntities('a&amp;b')).toBe('a&b');
    expect(decodeHtmlEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeHtmlEntities('&#xD800;')).toBe('&#xD800;');
    expect(extractTitle('<html><head><title>A &amp; B</title></head></html>')).toBe('A & B');
  });

  it('链接提取：相对链接绝对化、去重、跳过锚点/js', () => {
    const links = extractLinks(
      '<a href="/about">关于</a><a href="https://example.com/about">重复</a><a href="#top">锚点</a>',
      'https://example.com/page',
    );
    const urls = links.map((link) => link.url);
    expect(urls).toContain('https://example.com/about');
    expect(urls.filter((url) => url === 'https://example.com/about')).toHaveLength(1);
    expect(urls).not.toContain('https://example.com/page#top');
  });

  it('stripElement 扫描式剥离', () => {
    expect(stripElement('<div>a<script>1</script>b</div>', 'script')).toBe('<div>a b</div>');
  });
});

// ============================================================================
// readable
// ============================================================================

describe('readable', () => {
  it('抽取 article 正文，去掉导航/页脚/广告/脚本', () => {
    const html = `<html><head><title>文章标题</title></head><body>
      <nav>首页 产品 价格</nav>
      <article><h1>文章标题</h1><p>这是正文第一段，包含足够多的内容用于测试。</p>
      <p>这是正文第二段，继续描述主题。</p><div class="ads">广告位</div></article>
      <footer>版权所有</footer><script>hidden()</script></body></html>`;
    const result = extractReadableText(html);
    expect(result.text).toContain('这是正文第一段');
    expect(result.text).not.toContain('首页 产品 价格');
    expect(result.text).not.toContain('广告位');
    expect(result.text).not.toContain('hidden()');
    expect(result.title).toBe('文章标题');
  });

  it('验证码/反爬页识别', () => {
    expect(looksLikeChallengePage('<html><title>请输入验证码</title><div id="b_captcha"></div></html>')).toBe(true);
    expect(looksLikeChallengePage('<html><body>百度安全验证</body></html>')).toBe(true);
    expect(looksLikeChallengePage('<html><title>正常文章</title><body>正文</body></html>', 200)).toBe(false);
  });

  it('摘录优先选择包含查询词的句子', () => {
    const content = '完全不相关的一段。DeepSeek V4 支持更长的上下文。另一段无关内容。';
    expect(selectExcerpt(content, 'DeepSeek V4', 40)).toContain('DeepSeek V4');
  });
});

// ============================================================================
// SSRF
// ============================================================================

describe('SSRF 防护', () => {
  it('IPv4 私有/保留段全部拒绝，公网放行', () => {
    for (const ip of [
      '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '127.0.0.1', '0.0.0.0', '169.254.169.254', '100.64.0.1', '198.18.0.1',
      '224.0.0.1', '255.255.255.255',
    ]) {
      expect(isPrivateIpAddress(ip)).toBe(true);
    }
    for (const ip of ['172.15.255.255', '172.32.0.1', '8.8.8.8', '93.184.216.34']) {
      expect(isPrivateIpAddress(ip)).toBe(false);
    }
  });

  it('IPv6 保留段拒绝，IPv4-mapped 还原判定', () => {
    for (const ip of ['::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '2001:db8::1']) {
      expect(isPrivateIpAddress(ip)).toBe(true);
    }
    expect(isPrivateIpAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIpAddress('2606:4700::1111')).toBe(false);
  });

  it('normalizeFetchUrl：无协议补 https、非 http(s) 拒绝、内嵌凭证拒绝', () => {
    expect(normalizeFetchUrl('example.com/a').toString()).toBe('https://example.com/a');
    expect(() => normalizeFetchUrl('ftp://example.com')).toThrow();
    expect(() => normalizeFetchUrl('https://user:pass@example.com')).toThrow();
    expect(() => normalizeFetchUrl('  ')).toThrow();
  });

  it('assertSafeTarget：IP 字面量、黑名单域名、DNS 私网、DNS 失败', async () => {
    await expect(assertSafeTarget(new URL('http://127.0.0.1:8080/'))).rejects.toThrow();
    await expect(assertSafeTarget(new URL('http://169.254.169.254/latest/meta-data'))).rejects.toThrow();
    await expect(assertSafeTarget(new URL('http://[::1]/'))).rejects.toThrow();
    await expect(assertSafeTarget(new URL('http://localhost:7766/'), okLookup)).rejects.toThrow();
    await expect(assertSafeTarget(new URL('https://example.com/'), okLookup)).resolves.toBeUndefined();

    const privateLookup: LookupFn = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    await expect(assertSafeTarget(new URL('https://example.com/'), privateLookup)).rejects.toThrow(/private network/);

    const failLookup: LookupFn = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(assertSafeTarget(new URL('https://nx.example.com/'), failLookup)).rejects.toThrow();
  });
});

// ============================================================================
// fetcher 加固
// ============================================================================

describe('runFetch 加固', () => {
  it('使用浏览器 UA 并抽取干净正文', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      const html = `<html><head><title>文章</title></head><body>
        <nav>导航</nav><article><p>${'这是正文内容。'.repeat(80)}</p></article>
        <footer>页脚</footer></body></html>`;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;

    const result = await runFetch({
      url: 'https://example.com/article',
      lookup: okLookup,
      maxChars: 2000,
    });
    expect(capturedHeaders['user-agent']).toContain('Chrome');
    expect(result.text).toContain('这是正文内容');
    expect(result.text).not.toContain('导航');
    expect(result.meta.quality).toBe('high');
  });

  it('GBK 编码页面正确解码', async () => {
    const html = `<html><head><title>中文</title></head><body><article><p>${'这是中文正文。'.repeat(60)}</p></article></body></html>`;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(iconv.encode(html, 'gbk')), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=gbk' },
      })) as unknown as typeof fetch;

    const result = await runFetch({
      url: 'https://example.com/gbk',
      lookup: okLookup,
      maxChars: 2000,
    });
    expect(result.text).toContain('这是中文正文');
    expect(result.title).toBe('中文');
  });

  it('验证码/反爬页抛 FetchError(blocked)', async () => {
    globalThis.fetch = (async () =>
      new Response('<html><title>请输入验证码</title><div id="b_captcha"></div></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;

    try {
      await runFetch({ url: 'https://example.com/blocked', lookup: okLookup });
      throw new Error('should not reach');
    } catch (error) {
      expect(error).toBeInstanceOf(FetchError);
      expect((error as FetchError).code).toBe('blocked');
    }
  });
});
