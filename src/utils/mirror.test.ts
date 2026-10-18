// src/utils/mirror.test.ts
// 多镜像测速选源的单测：全程注入 fetch stub，不触网。

import { describe, test, expect, beforeEach } from 'vitest';
import {
  GITHUB_ASSET_MIRRORS,
  cachedRankMirrors,
  clearMirrorCache,
  githubAssetCandidates,
  mirrorLabel,
  rankMirrors,
  type MirrorCandidate,
} from './mirror';

type FetchLike = typeof fetch;

/** 把「按 URL 决策」的处理函数包装成 fetch 兼容签名（不引入 any）。 */
function makeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): FetchLike {
  const fn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  };
  return fn as FetchLike;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 单块固定字节数的响应体（读一次即结束）。 */
function singleChunkResponse(bytes: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** 多块响应体：用于验证「读满 probeBytes 即提前取消」。 */
function manyChunkResponse(
  chunkBytes: number,
  chunks: number,
): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(stream, { status: 200 }), cancelled: () => cancelled };
}

beforeEach(() => {
  clearMirrorCache();
});

describe('githubAssetCandidates / mirrorLabel', () => {
  test('官方直连前缀（空串）产出原始 URL，且候选数与源池一致（无重复前缀）', () => {
    const raw = 'https://github.com/cloudflare/cloudflared/releases/latest/download/x.exe';
    const cands = githubAssetCandidates(raw);
    expect(cands.length).toBe(GITHUB_ASSET_MIRRORS.length);
    expect(cands[0]?.url).toBe(raw);
    expect(cands[0]?.id).toBe('github.com');
    expect(new Set(cands.map(c => c.url)).size).toBe(cands.length);
  });

  test('mirrorLabel 取主机名，非法 URL 原样返回', () => {
    expect(mirrorLabel('https://gh-proxy.com/https://github.com/a/b')).toBe('gh-proxy.com');
    expect(mirrorLabel('not a url')).toBe('not a url');
  });
});

describe('rankMirrors：排序口径', () => {
  // A = 低延迟小包（5ms/64B）；B = 高延迟大包（40ms/1024B）
  // throughput 应 B 优先（25.6 > 12.8 B/ms）；latency 应 A 优先（5 < 40 ms）
  const cands: MirrorCandidate[] = [
    { id: 'A', url: 'https://a.example/low-latency' },
    { id: 'B', url: 'https://b.example/high-throughput' },
  ];
  const fetchImpl = makeFetch(async url => {
    if (url.includes('low-latency')) {
      await delay(5);
      return singleChunkResponse(64);
    }
    await delay(40);
    return singleChunkResponse(1024);
  });

  test('throughput：吞吐高者在前', async () => {
    const ranked = await rankMirrors(cands, { fetchImpl, probeBytes: 4096, maxMs: 500 });
    expect(ranked.map(r => r.id)).toEqual(['B', 'A']);
    expect(ranked[0]?.ok).toBe(true);
    expect(ranked[0]?.bytes).toBe(1024);
  });

  test('latency：延迟低者在前', async () => {
    const ranked = await rankMirrors(cands, {
      fetchImpl,
      probeBytes: 4096,
      maxMs: 500,
      metric: 'latency',
    });
    expect(ranked.map(r => r.id)).toEqual(['A', 'B']);
  });
});

describe('rankMirrors：失败源与提前取消', () => {
  test('非 2xx / 抛错 的源落到尾部，且保持入参顺序', async () => {
    const cands: MirrorCandidate[] = [
      { id: 'ok1', url: 'https://ok1.example/a' },
      { id: 'bad1', url: 'https://bad1.example/a' },
      { id: 'ok2', url: 'https://ok2.example/a' },
      { id: 'bad2', url: 'https://bad2.example/a' },
    ];
    const fetchImpl = makeFetch(async url => {
      if (url.includes('bad1')) return new Response('nope', { status: 500 });
      if (url.includes('bad2')) throw new Error('boom');
      await delay(3);
      return singleChunkResponse(256);
    });
    const ranked = await rankMirrors(cands, { fetchImpl, probeBytes: 4096, maxMs: 500 });
    // 两个可用源在前（同为 3ms/256B，彼此相对顺序受毫秒抖动影响，故按集合校验）；
    // 失败源落到尾部且保持入参顺序
    expect(ranked.slice(0, 2).map(r => r.id).sort()).toEqual(['ok1', 'ok2']);
    expect(ranked.slice(2).map(r => r.id)).toEqual(['bad1', 'bad2']);
    expect(ranked.slice(0, 2).every(r => r.ok)).toBe(true);
    expect(ranked[2]?.error).toContain('HTTP 500');
    expect(ranked[3]?.error).toContain('boom');
  });

  test('读满 probeBytes 即提前取消（防不支持 Range 的源被整包拉取）', async () => {
    const { response, cancelled } = manyChunkResponse(512, 100);
    const fetchImpl = makeFetch(async () => response);
    const ranked = await rankMirrors([{ id: 'big', url: 'https://big.example/x' }], {
      fetchImpl,
      probeBytes: 1024,
      maxMs: 1000,
    });
    expect(ranked[0]?.ok).toBe(true);
    expect(ranked[0]?.bytes).toBe(1024); // 恰好读满探针上限，未读完整包（100 × 512B）
    expect(cancelled()).toBe(true);
  });

  test('外部 signal 已 abort：全部判失败但不抛出', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = makeFetch(async (_url, init) => {
      if (init?.signal?.aborted) throw new Error('aborted');
      return singleChunkResponse(64);
    });
    const ranked = await rankMirrors([{ id: 'a', url: 'https://a.example/x' }], {
      fetchImpl,
      signal: ac.signal,
      probeBytes: 4096,
      maxMs: 500,
    });
    expect(ranked[0]?.ok).toBe(false);
    expect(ranked[0]?.error).toContain('aborted');
  });
});

describe('cachedRankMirrors：缓存与单飞', () => {
  test('TTL 内二次调用不再触网', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(async () => {
      calls += 1;
      return singleChunkResponse(64);
    });
    const build = (): MirrorCandidate[] => [{ id: 'a', url: 'https://a.example/x' }];

    const first = await cachedRankMirrors('ttl-key', build, { fetchImpl, probeBytes: 4096, maxMs: 500 });
    const afterFirst = calls;
    const second = await cachedRankMirrors('ttl-key', build, { fetchImpl, probeBytes: 4096, maxMs: 500 });

    expect(afterFirst).toBe(1);
    expect(calls).toBe(1);
    expect(second.map(r => r.id)).toEqual(first.map(r => r.id));
  });

  test('并发同 key 只探测一次（单飞）', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const fetchImpl = makeFetch(async () => {
      calls += 1;
      await gate;
      return singleChunkResponse(64);
    });
    const build = (): MirrorCandidate[] => [{ id: 'a', url: 'https://a.example/x' }];

    const p1 = cachedRankMirrors('sf-key', build, { fetchImpl, probeBytes: 4096, maxMs: 5000 });
    const p2 = cachedRankMirrors('sf-key', build, { fetchImpl, probeBytes: 4096, maxMs: 5000 });
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(calls).toBe(1);
    expect(r1[0]?.ok).toBe(true);
    expect(r2[0]?.ok).toBe(true);
  });

  test('全部源失败时不缓存（下次会重新探测）', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(async () => {
      calls += 1;
      return new Response('nope', { status: 502 });
    });
    const build = (): MirrorCandidate[] => [{ id: 'a', url: 'https://a.example/x' }];

    const first = await cachedRankMirrors('fail-key', build, { fetchImpl, probeBytes: 4096, maxMs: 500 });
    expect(first.every(r => !r.ok)).toBe(true);
    const before = calls;
    await cachedRankMirrors('fail-key', build, { fetchImpl, probeBytes: 4096, maxMs: 500 });
    expect(calls).toBeGreaterThan(before);
  });
});
