// tools/web/search/http-client.test.ts
// HTTP 加固层单测：浏览器头、CookieJar、冷却、代理、单次重试。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  engineRequest,
  getEngineCooldown,
  warmUpEngine,
  __resetHttpStateForTests,
  __setFastModeForTests,
} from './http-client';
import { EngineRequestError } from './types';

const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  __resetHttpStateForTests();
  __setFastModeForTests(true);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setFastModeForTests(false);
});

describe('engineRequest', () => {
  it('发送浏览器头、Referer 与引擎 Cookie', async () => {
    const calls = installFetch(() => new Response('<html></html>', { status: 200 }));
    await engineRequest({
      engine: 'bing',
      url: 'https://cn.bing.com/search?q=x',
      referer: 'https://cn.bing.com/',
      timeoutMs: 3000,
    });
    const headers = headersOf(calls[0]!.init);
    expect(headers['user-agent']).toContain('Chrome');
    expect(headers['sec-ch-ua']).toContain('Chromium');
    expect(headers['sec-fetch-site']).toBe('same-origin');
    expect(headers.referer).toBe('https://cn.bing.com/');
    expect(headers.cookie).toContain('_EDGE_V=1');
  });

  it('CookieJar 合并 Set-Cookie 并在下一次请求带回', async () => {
    const calls = installFetch((call) => {
      if (call.url === 'https://www.sogou.com/') {
        return new Response('<html>home</html>', {
          status: 200,
          headers: { 'set-cookie': 'sogou_sid=abc123; Path=/; Max-Age=3600' },
        });
      }
      return new Response('<html>search</html>', { status: 200 });
    });
    await warmUpEngine('sogou', 'https://www.sogou.com/', {
      engine: 'sogou',
      timeoutMs: 3000,
    });
    await engineRequest({
      engine: 'sogou',
      url: 'https://www.sogou.com/web?query=x',
      timeoutMs: 3000,
    });
    const searchHeaders = headersOf(calls[calls.length - 1]!.init);
    expect(searchHeaders.cookie).toContain('sogou_sid=abc123');
  });

  it('403 触发冷却，冷却期内不再发起请求', async () => {
    const calls = installFetch(() => new Response('forbidden', { status: 403 }));
    await expect(
      engineRequest({ engine: 'bing', url: 'https://cn.bing.com/search?q=x', timeoutMs: 3000 }),
    ).rejects.toBeInstanceOf(EngineRequestError);
    expect(calls).toHaveLength(1);
    const cooldown = getEngineCooldown('bing');
    expect(cooldown).not.toBeNull();
    expect(cooldown?.remainingMs).toBeGreaterThan(0);

    await expect(
      engineRequest({ engine: 'bing', url: 'https://cn.bing.com/search?q=y', timeoutMs: 3000 }),
    ).rejects.toBeInstanceOf(EngineRequestError);
    expect(calls).toHaveLength(1);
  });

  it('代理地址透传到 fetch', async () => {
    const calls = installFetch(() => new Response('<html></html>', { status: 200 }));
    await engineRequest({
      engine: 'baidu',
      url: 'https://www.baidu.com/s?wd=x',
      timeoutMs: 3000,
      proxyUrl: 'http://127.0.0.1:7890',
    });
    expect((calls[0]!.init as RequestInit & { proxy?: string }).proxy).toBe('http://127.0.0.1:7890/');
  });

  it('网络错误重试一次后成功', async () => {
    let count = 0;
    const calls = installFetch(() => {
      count++;
      if (count === 1) throw new Error('ECONNRESET');
      return new Response('<html></html>', { status: 200 });
    });
    const response = await engineRequest({
      engine: 'bing',
      url: 'https://cn.bing.com/search?q=x',
      timeoutMs: 3000,
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});
