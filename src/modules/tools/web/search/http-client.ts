// tools/web/search/http-client.ts
// 搜索引擎 HTTP 加固层：浏览器头 / CookieJar / 限速 / 冷却熔断 / 单次重试 / 代理。
//
// 设计依据（真机实测）：
// - Baidu 裸请求会 302 到 wappass 验证码，必须先访问首页拿 Cookie；
// - 三引擎都需要与浏览器一致的 UA / sec-* / Referer，否则容易进入验证页；
// - 单引擎集中请求会触发 429/验证码，因此每引擎串行 + 最小间隔 + 冷却。

import type { EngineName } from './types';
import { EngineRequestError } from './types';

/** 每引擎最小请求间隔（ms） */
const MIN_INTERVAL_MS: Record<EngineName, number> = {
  bing: 1_200,
  baidu: 2_200,
  sogou: 1_800,
};

/** 抖动范围（ms），模拟人工操作间隔 */
const JITTER_MIN_MS = 200;
const JITTER_MAX_MS = 500;

/** 单测快速模式：关闭限速/抖动等待 */
let fastModeForTests = false;

export function __setFastModeForTests(enabled: boolean): void {
  fastModeForTests = enabled;
}

/** Cookie 预热有效期 */
const WARMUP_TTL_MS = 30 * 60_000;

/** 冷却时长（ms） */
const COOLDOWN = {
  challenge: 180_000,
  forbidden: 180_000,
  rateLimited: 120_000,
  network: 30_000,
  serverError: 30_000,
} as const;

/** 每引擎固定一个 UA（与 Cookie 保持一致） */
const USER_AGENTS: Record<EngineName, string> = {
  bing: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  baidu: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  sogou: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const SEC_CH_UA: Record<EngineName, string> = {
  bing: '"Chromium";v="133", "Not(A:Brand";v="24", "Google Chrome";v="133"',
  baidu: '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  sogou: '"Chromium";v="120", "Not(A:Brand";v="24", "Google Chrome";v="120"',
};

const SEC_CH_PLATFORM: Record<EngineName, string> = {
  bing: '"Windows"',
  baidu: '"Windows"',
  sogou: '"macOS"',
};

/** 简单 CookieJar：按引擎共用（搜索与跳转都在同一站点域内） */
class CookieJar {
  private readonly cookies = new Map<string, { value: string; expiresAt: number }>();

  put(name: string, value: string): void {
    if (!name) return;
    this.cookies.set(name, { value, expiresAt: Number.POSITIVE_INFINITY });
  }

  /** 合并 Set-Cookie（支持 Bun 的 getSetCookie；不支持时退回单条 set-cookie） */
  mergeFrom(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const list = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie') ?? ''];
    for (const raw of list) {
      if (!raw) continue;
      const pair = raw.split(';', 1)[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const lower = raw.toLowerCase();
      const maxAge = /max-age=(\d+)/i.exec(lower);
      const expires = /expires=([^;]+)/i.exec(raw);
      let expiresAt = Number.POSITIVE_INFINITY;
      if (maxAge) {
        expiresAt = Date.now() + Number.parseInt(maxAge[1], 10) * 1000;
      } else if (expires) {
        const parsed = Date.parse(expires[1].trim());
        if (Number.isFinite(parsed)) expiresAt = parsed;
      }
      if (expiresAt <= Date.now()) {
        this.cookies.delete(name);
        continue;
      }
      this.cookies.set(name, { value, expiresAt });
    }
  }

  header(): string {
    const now = Date.now();
    const parts: string[] = [];
    for (const [name, cookie] of this.cookies) {
      if (cookie.expiresAt <= now) {
        this.cookies.delete(name);
        continue;
      }
      parts.push(`${name}=${cookie.value}`);
    }
    return parts.join('; ');
  }
}

interface EngineSession {
  engine: EngineName;
  cookies: CookieJar;
  lastRequestAt: number;
  lastWarmupAt: number;
  warmupPromise: Promise<void> | null;
  cooldownUntil: number;
  cooldownReason: string;
  failureCount: number;
}

const sessions = new Map<EngineName, EngineSession>();

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out.slice(0, length);
}

function getSession(engine: EngineName): EngineSession {
  let session = sessions.get(engine);
  if (session) return session;

  const cookies = new CookieJar();
  if (engine === 'bing') {
    // SearXNG 同款：_EDGE_V/_EDGE_S 是 Bing 的客户端标识 Cookie，可显著降低验证页概率
    cookies.put('_EDGE_V', '1');
    cookies.put(
      '_EDGE_S',
      `F=1&SID=${randomHex(32)}&mkt=zh-cn&ui=zh-cn`,
    );
  }

  session = {
    engine,
    cookies,
    lastRequestAt: 0,
    lastWarmupAt: 0,
    warmupPromise: null,
    cooldownUntil: 0,
    cooldownReason: '',
    failureCount: 0,
  };
  sessions.set(engine, session);
  return session;
}

/** 冷却状态（编排器据此跳过引擎） */
export function getEngineCooldown(engine: EngineName): { remainingMs: number; reason: string } | null {
  const session = getSession(engine);
  const remainingMs = session.cooldownUntil - Date.now();
  if (remainingMs <= 0) return null;
  return { remainingMs, reason: session.cooldownReason };
}

/** 标记引擎成功：清除冷却与失败计数 */
export function markEngineSuccess(engine: EngineName): void {
  const session = getSession(engine);
  session.cooldownUntil = 0;
  session.cooldownReason = '';
  session.failureCount = 0;
}

/** 主动设置冷却（引擎解析器识别到验证码页时调用） */
export function setEngineCooldown(engine: EngineName, ms: number, reason: string): void {
  const session = getSession(engine);
  session.cooldownUntil = Math.max(session.cooldownUntil, Date.now() + ms);
  session.cooldownReason = reason;
}

/** 测试重置：清空 Cookie/冷却/限速状态 */
export function __resetHttpStateForTests(): void {
  sessions.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 代理地址：工具配置优先，其次环境变量 */
export function resolveProxyUrl(explicit?: string): string | undefined {
  const candidates = [
    explicit,
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    } catch {
      // 忽略非法代理配置，继续尝试下一个来源
    }
  }
  return undefined;
}

export interface EngineRequestOptions {
  engine: EngineName;
  url: string;
  /** 页面来源；第 0 页用站点首页，翻页用上一页搜索 URL */
  referer?: string;
  /** 导航来源：首页预热 none，站内搜索 same-origin */
  site?: 'none' | 'same-origin';
  timeoutMs: number;
  signal?: AbortSignal;
  proxyUrl?: string;
  /** 附加请求头（引擎专用，如 Baidu 的 Accept） */
  extraHeaders?: Record<string, string>;
  /** 跳过最小间隔（Baidu /link 解析等非搜索请求用独立限速器） */
  skipRateLimit?: boolean;
}

function buildHeaders(
  session: EngineSession,
  options: EngineRequestOptions,
): Record<string, string> {
  const cookie = session.cookies.header();
  const headers: Record<string, string> = {
    'user-agent': USER_AGENTS[session.engine],
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-ch-ua': SEC_CH_UA[session.engine],
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': SEC_CH_PLATFORM[session.engine],
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': options.site ?? 'same-origin',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    ...(options.referer ? { referer: options.referer } : {}),
    ...(cookie ? { cookie } : {}),
    ...(options.extraHeaders ?? {}),
  };
  return headers;
}

/** 按最小间隔 + 抖动顺序放行同一引擎的请求（不同引擎互不阻塞） */
async function waitForRateLimit(session: EngineSession): Promise<void> {
  if (fastModeForTests) {
    session.lastRequestAt = Date.now();
    return;
  }
  const minInterval = MIN_INTERVAL_MS[session.engine];
  const jitter = JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1));
  const target = session.lastRequestAt + minInterval + jitter;
  const waitMs = target - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  session.lastRequestAt = Date.now();
}

function parseRetryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 300_000);
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  const delta = date - Date.now();
  return delta > 0 ? Math.min(delta, 300_000) : null;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return true;
  }
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * 首页/站点预热：获取 Cookie 并缓存 30 分钟。
 * 失败不抛出（搜索本身会给出真实失败原因）；并发调用共享同一个 Promise。
 */
export async function warmUpEngine(
  engine: EngineName,
  url: string,
  options: Omit<EngineRequestOptions, 'url' | 'site'> & { site?: 'none' | 'same-origin'; force?: boolean },
): Promise<void> {
  const session = getSession(engine);
  if (!options.force && Date.now() - session.lastWarmupAt < WARMUP_TTL_MS) return;
  if (session.warmupPromise) {
    await session.warmupPromise;
    return;
  }
  session.warmupPromise = (async () => {
    try {
      const response = await engineRequest({
        ...options,
        engine,
        url,
        site: 'none',
      });
      session.cookies.mergeFrom(response);
      await response.text().catch(() => '');
      session.lastWarmupAt = Date.now();
    } catch {
      // 预热失败不阻塞搜索；真正请求会暴露错误并进入冷却
    }
  })().finally(() => {
    session.warmupPromise = null;
  });
  await session.warmupPromise;
}

/**
 * 单引擎请求：限速 → 冷却检查 → fetch（redirect: manual）→ 状态分类/重试。
 * 3xx 原样返回，由各引擎按域名规则处理重定向与验证码。
 */
export async function engineRequest(options: EngineRequestOptions): Promise<Response> {
  const session = getSession(options.engine);
  const cooldownRemaining = session.cooldownUntil - Date.now();
  if (cooldownRemaining > 0) {
    throw new EngineRequestError(
      options.engine,
      `${options.engine} 冷却中（剩余 ${Math.ceil(cooldownRemaining / 1000)}s）：${session.cooldownReason}`,
      { cooldownMs: cooldownRemaining },
    );
  }

  if (!options.skipRateLimit) await waitForRateLimit(session);
  if (options.signal?.aborted) {
    throw new EngineRequestError(options.engine, '请求已取消');
  }

  const proxy = resolveProxyUrl(options.proxyUrl);
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs, 30_000));

  for (let attempt = 0; attempt < 2; attempt++) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(options.url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: buildHeaders(session, options),
        ...(proxy ? { proxy } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new EngineRequestError(options.engine, '请求已取消');
      }
      if (attempt === 0) {
        await sleep(300 + Math.floor(Math.random() * 300));
        continue;
      }
      setEngineCooldown(options.engine, COOLDOWN.network, isAbortError(error) ? '请求超时' : '网络错误');
      throw new EngineRequestError(
        options.engine,
        isAbortError(error) ? `请求超时（${timeoutMs}ms）` : `网络错误：${error instanceof Error ? error.message : String(error)}`,
        { cooldownMs: COOLDOWN.network },
      );
    }

    session.cookies.mergeFrom(response);

    if (response.status === 403) {
      setEngineCooldown(options.engine, COOLDOWN.forbidden, 'HTTP 403');
      throw new EngineRequestError(options.engine, 'HTTP 403（被拒绝访问）', { cooldownMs: COOLDOWN.forbidden });
    }
    if (response.status === 429) {
      const waitMs = parseRetryAfterMs(response) ?? COOLDOWN.rateLimited;
      setEngineCooldown(options.engine, waitMs, 'HTTP 429 限流');
      throw new EngineRequestError(options.engine, `HTTP 429（请求过于频繁，需等待 ${Math.ceil(waitMs / 1000)}s）`, {
        cooldownMs: waitMs,
      });
    }
    if (response.status >= 500) {
      if (attempt === 0) {
        await sleep(300);
        continue;
      }
      setEngineCooldown(options.engine, COOLDOWN.serverError, `HTTP ${response.status}`);
      throw new EngineRequestError(options.engine, `HTTP ${response.status}`, {
        cooldownMs: COOLDOWN.serverError,
      });
    }

    if (response.ok || (response.status >= 300 && response.status < 400)) {
      markEngineSuccess(options.engine);
      return response;
    }

    setEngineCooldown(options.engine, COOLDOWN.forbidden, `HTTP ${response.status}`);
    throw new EngineRequestError(options.engine, `HTTP ${response.status}`, {
      cooldownMs: COOLDOWN.forbidden,
    });
  }

  throw new EngineRequestError(options.engine, '请求失败');
}

/** 挑战页冷却（解析器识别到验证码 HTML 后调用） */
export function markChallenge(engine: EngineName, reason: string): void {
  setEngineCooldown(engine, COOLDOWN.challenge, reason);
}
