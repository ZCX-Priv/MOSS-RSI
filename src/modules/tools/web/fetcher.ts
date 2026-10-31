// tools/web/fetcher.ts
// 本地网页抓取（Bun 运行时适配）。
// 安全设计（SSRF 防护，这是承重面：agent 会毫不犹豫地抓取网页里出现的 URL）：
//   - 协议仅 http/https；拒绝 URL 内嵌凭证
//   - 主机名黑名单（localhost / *.localhost / 云元数据主机）
//   - IP 字面量直接判定私有/保留段；域名经 DNS 解析后逐地址判定，
//     任一命中即拒绝（VPN/代理把公网域名映射进保留段也会被拦）
//   - 重定向手动跟随：每一跳重新完整校验，最多 5 跳
// 已知限制（Bun 与 Node/undici 差异）：用 undici 自定义 lookup 把
// socket 钉死在校验过的 IP 上以封死 DNS rebinding；Bun fetch 不支持 dispatcher，
// 本实现只能「校验后放行」，校验与连接之间理论上存在 DNS 变化的 TOCTOU 窗口，
// 属 Bun 下的最优近似，代码注释已如实声明。

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import iconv from 'iconv-lite';
import {
  extractVisibleTextFromHtml,
  extractLinks,
  normalizeWhitespace,
} from './html-extract';
import { extractReadableText, looksLikeChallengePage } from './readable';

/** DNS 查找函数签名（注入便于单测 mock） */
export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

/** fetcher 错误码（index.ts 映射 i18n 消息） */
export type FetchErrorCode =
  | 'invalid-url'
  | 'unsafe-target'
  | 'timeout'
  | 'too-large'
  | 'unsupported-type'
  | 'too-many-redirects'
  | 'blocked'
  | 'network';

/** 类型化错误：携带错误码与原因，供工具层转换用户可读消息 */
export class FetchError extends Error {
  readonly code: FetchErrorCode;
  readonly causeMessage?: string;

  constructor(code: FetchErrorCode, message: string, causeMessage?: string) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.causeMessage = causeMessage;
  }
}

export interface FetchOptions {
  url: string;
  /** 整体超时（含 DNS、所有重定向跳、body 读取），默认 20000ms */
  timeoutMs?: number;
  /** 正文最大字符数，默认 20000 */
  maxChars?: number;
  /** 中断信号（会话取消时透传） */
  signal?: AbortSignal;
  /** DNS 查找注入（测试用），默认 node:dns/promises.lookup */
  lookup?: LookupFn;
  /** 正文增强时携带搜索引擎结果页作为 Referer */
  referer?: string;
  /** HTTP 代理（工具配置；空 = 不使用） */
  proxyUrl?: string;
}

export interface FetchResult {
  requestUrl: string;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  title: string | null;
  text: string;
  links: Array<{ text: string; url: string }>;
  warnings: string[];
  meta: {
    bytes: number;
    truncated: boolean;
    redirectChain: string[];
    elapsedMs: number;
    quality: 'high' | 'low';
  };
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_FETCH_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

/** 抓取 URL 归一化：无协议时补 https://，仅允许 http/https，拒绝内嵌凭证 */
export function normalizeFetchUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new FetchError('invalid-url', 'Fetch URL is required.');
  }
  // 已带任意 scheme（ftp:/javascript: 等）时不能盲目补 https://，否则会被拼成 https://ftp//...
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new FetchError('invalid-url', `Invalid URL: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FetchError('invalid-url', 'Only http/https URLs are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new FetchError('invalid-url', 'URL with embedded credentials is not allowed.');
  }
  return parsed;
}

/** 主机名黑名单：本机解析与云元数据端点 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.amazonaws.com',
  'metadata.azure.internal',
]);

export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  return normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal');
}

/** 判定 IP 是否私有/保留段（IPv4 与 IPv6，含 IPv4-mapped 与展开运算） */
export function isPrivateIpAddress(ipAddress: string): boolean {
  const normalized = ipAddress.trim().toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return isPrivateIPv4(normalized);
  if (family === 6) return isPrivateIPv6(normalized);
  // 不是合法 IP 一律按不安全处理（保守拒绝）
  return true;
}

/**
 * SSRF 校验：黑名单主机名 → IP 字面量判定 → DNS 解析逐地址判定。
 * 校验通过不返回目标（Bun 无法 pin IP，见文件头注释）。
 */
export async function assertSafeTarget(url: URL, lookup: LookupFn = dnsLookup): Promise<void> {
  if (isBlockedHostname(url.hostname)) {
    throw new FetchError('unsafe-target', `Blocked hostname: ${url.hostname}`);
  }

  const hostname = stripIpv6Brackets(url.hostname);
  const ipFamily = isIP(hostname);
  if (ipFamily > 0) {
    if (isPrivateIpAddress(hostname)) {
      throw new FetchError('unsafe-target', `Blocked private network target: ${hostname}`);
    }
    return;
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new FetchError(
      'unsafe-target',
      `DNS lookup failed for host ${hostname}`,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (resolved.length === 0) {
    throw new FetchError('unsafe-target', `Host ${hostname} did not resolve to any IP address.`);
  }

  const blocked = resolved.find((record) => isPrivateIpAddress(record.address));
  if (blocked) {
    // VPN/代理客户端常把公网域名映射进保留段（尤其 198.18/15 fake-IP），
    // 拒绝并说明，用户可在配置中关掉 fetch 或自行取舍
    throw new FetchError(
      'unsafe-target',
      `Blocked private network target: ${hostname} -> ${blocked.address}`,
    );
  }
}

/** 执行一次完整抓取：SSRF 校验 → 逐跳重定向 → 白名单 content-type → 限量读取 → 文本提取 */
export async function runFetch(options: FetchOptions): Promise<FetchResult> {
  const requestUrl = normalizeFetchUrl(options.url);
  const timeoutMs = clampInt(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 3_000, 60_000);
  const maxChars = clampInt(options.maxChars ?? DEFAULT_MAX_CHARS, 1_000, 100_000);
  const lookup = options.lookup ?? dnsLookup;
  const startedAt = Date.now();

  // 整体 deadline：DNS、每一跳重定向、body 读取共用一个超时（外层 signal 同样透传）
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  let currentUrl = requestUrl;
  const redirectChain: string[] = [];
  const warnings: string[] = [];

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // 每一跳都重新做完整 SSRF 校验（含重新 DNS 解析），防止中途跳向内网
      await assertSafeTarget(currentUrl, lookup);

      const response = await fetchOnceWithRetry(currentUrl, signal, options);

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new FetchError('network', `Redirect response (${response.status}) missing location header.`);
        }
        if (hop === MAX_REDIRECTS) {
          throw new FetchError('too-many-redirects', `Too many redirects. Max redirects: ${MAX_REDIRECTS}.`);
        }
        const nextUrl = new URL(location, currentUrl);
        redirectChain.push(currentUrl.toString());
        currentUrl = nextUrl;
        continue;
      }

      const contentTypeHeader = response.headers.get('content-type') || '';
      if (!isTextLikeContentType(contentTypeHeader)) {
        throw new FetchError(
          'unsupported-type',
          `Unsupported content-type: ${contentTypeHeader || 'unknown'}. Only text-like content is allowed.`,
        );
      }

      const { body, bytes } = await readBodyWithLimit(response, signal);
      const decoded = decodeBody(body, contentTypeHeader);

      const normalizedContentType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() || '';
      const isHtml = normalizedContentType.includes('html') || normalizedContentType.includes('xhtml');

      // 反爬挑战页不能当正文返回：显式报 blocked，避免 Agent 拿到「精心构造的垃圾」
      if (isHtml && looksLikeChallengePage(decoded, response.status)) {
        throw new FetchError('blocked', 'Target returned a verification or anti-bot page.');
      }

      const readable = isHtml ? extractReadableText(decoded) : null;
      const fallback = isHtml
        ? extractVisibleTextFromHtml(decoded)
        : { title: null, text: normalizeWhitespace(decoded) };
      const extraction = readable && readable.text
        ? { title: readable.title, text: readable.text }
        : fallback;
      const quality: 'high' | 'low' = readable?.quality ?? (extraction.text.length >= 300 ? 'high' : 'low');

      // 提取链接需要原始 HTML（只对 HTML 做）
      const links = isHtml ? extractLinks(decoded, currentUrl.toString()) : [];

      const trimmed = trimToMaxChars(extraction.text, maxChars);
      if (trimmed.truncated) {
        warnings.push(`Content truncated at ${maxChars} characters.`);
      }
      if (redirectChain.length > 0) {
        warnings.push(`Followed ${redirectChain.length} redirect(s) to ${currentUrl.toString()}.`);
      }
      // 正文极短大概率是 JS 渲染页：如实告知而非静默返回空白
      if (extraction.text.length < 200) {
        warnings.push(
          'Very little text came back. The page is probably rendered by JavaScript, which this fetcher does not run.',
        );
      } else if (quality === 'low') {
        warnings.push('Page text looks noisy (navigation/ads dominate); treat the extracted text with caution.');
      }

      return {
        requestUrl: requestUrl.toString(),
        finalUrl: currentUrl.toString(),
        status: response.status,
        statusText: response.statusText,
        contentType: contentTypeHeader,
        title: extraction.title,
        text: trimmed.text,
        links,
        warnings,
        meta: {
          bytes,
          truncated: trimmed.truncated,
          redirectChain,
          elapsedMs: Date.now() - startedAt,
          quality,
        },
      };
    }
    throw new FetchError('network', 'Failed to fetch target URL.');
  } catch (err) {
    if (err instanceof FetchError) throw err;
    if (options.signal?.aborted) {
      throw new FetchError('network', 'Fetch cancelled.');
    }
    if (isAbortError(err)) {
      throw new FetchError('timeout', `Request timed out after ${timeoutMs} ms.`);
    }
    throw new FetchError(
      'network',
      `Request failed for ${requestUrl.toString()}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** 单次请求（redirect: manual 由调用方逐跳处理） */
async function fetchOnce(url: URL, signal: AbortSignal, options: FetchOptions): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': USER_AGENT,
        accept:
          'text/html,application/xhtml+xml,application/json,text/plain,application/xml,text/xml;q=0.9,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'sec-ch-ua': '"Chromium";v="133", "Not(A:Brand";v="24", "Google Chrome";v="133"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': options.referer ? 'same-origin' : 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        ...(options.referer ? { referer: options.referer } : {}),
      },
      ...(options.proxyUrl?.trim() ? { proxy: options.proxyUrl.trim() } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new FetchError(
      'network',
      `Request failed for ${url.toString()}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** 网络错误重试一次（超时/取消不重试，避免在已耗尽的 deadline 上再等一轮） */
async function fetchOnceWithRetry(
  url: URL,
  signal: AbortSignal,
  options: FetchOptions,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchOnce(url, signal, options);
    } catch (err) {
      if (attempt === 0 && err instanceof FetchError && err.code === 'network') {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw err;
    }
  }
  throw new FetchError('network', `Request failed for ${url.toString()}`);
}

/** 流式读取 body，超过 MAX_FETCH_BYTES 立即中止（Content-Length 预检 + 累计双保险） */
async function readBodyWithLimit(
  response: Response,
  signal: AbortSignal,
): Promise<{ body: Uint8Array; bytes: number }> {
  const body = response.body;
  if (!body) {
    return { body: new Uint8Array(), bytes: 0 };
  }

  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_FETCH_BYTES) {
      throw new FetchError('too-large', `Response body exceeds max size ${MAX_FETCH_BYTES} bytes.`);
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > MAX_FETCH_BYTES) {
      throw new FetchError('too-large', `Response body exceeds max size ${MAX_FETCH_BYTES} bytes.`);
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return { body: result, bytes: total };
}

/** 按 content-type / <meta charset> 解码 body；GBK 系走 iconv-lite */
function decodeBody(body: Uint8Array, contentTypeHeader: string): string {
  const buffer = Buffer.from(body);
  const charset = parseCharset(contentTypeHeader) || sniffMetaCharset(buffer) || 'utf-8';
  const normalized = charset.toLowerCase();
  try {
    if (/^(gbk|gb2312|gb18030|big5|shift_jis|euc-jp)$/i.test(normalized)) {
      return iconv.decode(buffer, normalized);
    }
    return new TextDecoder(normalized).decode(buffer);
  } catch {
    try {
      return iconv.decode(buffer, 'utf-8');
    } catch {
      return buffer.toString('utf8');
    }
  }
}

function parseCharset(contentTypeHeader: string): string | null {
  const matched = /charset=([^;]+)/i.exec(contentTypeHeader);
  if (!matched) return null;
  return matched[1].trim().toLowerCase().replace(/^"|"$/g, '');
}

/** 从 HTML 前 4KB 的 <meta charset> / http-equiv 嗅探编码 */
function sniffMetaCharset(buffer: Buffer): string | null {
  const head = buffer.subarray(0, 4096).toString('utf8');
  const direct = /<meta\s+charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/i.exec(head);
  if (direct) {
    return (direct[1] ?? direct[2] ?? direct[3] ?? '').trim().toLowerCase();
  }
  const equiv = /<meta\s+http-equiv\s*=\s*(?:"content-type"|'content-type')[^>]*content\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(head);
  if (equiv) {
    const content = equiv[1] ?? equiv[2] ?? '';
    const matched = /charset=([^;]+)/i.exec(content);
    if (matched) return matched[1].trim().toLowerCase();
  }
  return null;
}

function isTextLikeContentType(contentTypeHeader: string): boolean {
  const normalized = contentTypeHeader.trim().toLowerCase();
  if (!normalized) return true; // 无 content-type 时按文本尝试
  if (normalized.startsWith('text/')) return true;
  return (
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('html') ||
    normalized.includes('javascript') ||
    normalized.includes('x-www-form-urlencoded')
  );
}

function trimToMaxChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxChars), truncated: true };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isAbortError(error: unknown): boolean {
  // AbortSignal.timeout 拒绝的是 TimeoutError 而非 AbortError，只查名字会把真实超时报成普通失败
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return true;
  }
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: string; code?: string };
  return err.name === 'AbortError' || err.code === 'ABORT_ERR';
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

// ============================================================================
// IPv4 / IPv6 私有与保留段判定（纯函数）
// ============================================================================

function isPrivateIPv4(ipAddress: string): boolean {
  const octets = ipAddress.split('.').map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isFinite(value) || value < 0 || value > 255)
  ) {
    return true;
  }
  const value = ipv4ToNumber(ipAddress);
  return (
    inRange(value, '0.0.0.0', '0.255.255.255') ||           // 本网络
    inRange(value, '10.0.0.0', '10.255.255.255') ||          // RFC1918
    inRange(value, '100.64.0.0', '100.127.255.255') ||       // CGNAT
    inRange(value, '127.0.0.0', '127.255.255.255') ||        // 回环
    inRange(value, '169.254.0.0', '169.254.255.255') ||      // 链路本地（含云元数据）
    inRange(value, '172.16.0.0', '172.31.255.255') ||        // RFC1918
    inRange(value, '192.0.0.0', '192.0.0.255') ||            // IETF 协议分配
    inRange(value, '192.168.0.0', '192.168.255.255') ||      // RFC1918
    inRange(value, '198.18.0.0', '198.19.255.255') ||        // 基准测试（代理 fake-IP 常用段）
    inRange(value, '224.0.0.0', '255.255.255.255')           // 组播 + 保留
  );
}

function inRange(value: number, start: string, end: string): boolean {
  return value >= ipv4ToNumber(start) && value <= ipv4ToNumber(end);
}

function ipv4ToNumber(ipAddress: string): number {
  const octets = ipAddress.split('.').map((part) => Number.parseInt(part, 10));
  return octets[0] * 256 ** 3 + octets[1] * 256 ** 2 + octets[2] * 256 + octets[3];
}

function isPrivateIPv6(ipAddress: string): boolean {
  // ::ffff:127.0.0.1 归一化为 ::ffff:7f00:1：末两组是 IPv4 的十六进制，
  // 按 IPv6 判定会放行回环地址，必须先还原成 IPv4 再判
  const groups = expandIpv6(ipAddress);
  if (groups && groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mapped = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
    return isPrivateIPv4(mapped);
  }

  const normalized = ipAddress.split('%')[0]; // 去 zone id（fe80::1%eth0）
  const mapped = extractMappedIpv4(normalized);
  if (mapped && isPrivateIPv4(mapped)) {
    return true;
  }

  const value = ipv6ToBigInt(normalized);
  if (value === null) {
    return true; // 解析失败按不安全处理
  }

  return (
    inIpv6Range(value, '::', 128) ||            // 未指定地址
    inIpv6Range(value, '::1', 128) ||           // 回环
    inIpv6Range(value, 'fc00::', 7) ||          // ULA
    inIpv6Range(value, 'fe80::', 10) ||         // 链路本地
    inIpv6Range(value, 'ff00::', 8) ||          // 组播
    inIpv6Range(value, '2001:db8::', 32)        // 文档保留段
  );
}

function extractMappedIpv4(ipAddress: string): string | null {
  const lower = ipAddress.toLowerCase();
  const marker = '::ffff:';
  if (!lower.startsWith(marker)) return null;
  const candidate = lower.slice(marker.length);
  return isIP(candidate) === 4 ? candidate : null;
}

function inIpv6Range(value: bigint, start: string, prefixLength: number): boolean {
  const startValue = ipv6ToBigInt(start);
  if (startValue === null) return false;
  const mask =
    prefixLength === 0 ? 0n : ((1n << BigInt(prefixLength)) - 1n) << BigInt(128 - prefixLength);
  return (value & mask) === (startValue & mask);
}

function ipv6ToBigInt(ipAddress: string): bigint | null {
  const expanded = expandIpv6(ipAddress);
  if (!expanded) return null;
  return expanded.reduce((acc, group) => (acc << 16n) + BigInt(group), 0n);
}

/** 展开 IPv6（含 :: 压缩形式）为 8 组数值 */
function expandIpv6(ipAddress: string): number[] | null {
  const value = ipAddress.toLowerCase();
  if (value.includes('::')) {
    const [left, right] = value.split('::');
    const leftGroups = left ? left.split(':').filter(Boolean) : [];
    const rightGroups = right ? right.split(':').filter(Boolean) : [];
    if (leftGroups.length + rightGroups.length > 8) return null;
    const middle = new Array(8 - leftGroups.length - rightGroups.length).fill('0');
    return parseIpv6Groups([...leftGroups, ...middle, ...rightGroups]);
  }
  return parseIpv6Groups(value.split(':'));
}

function parseIpv6Groups(groups: string[]): number[] | null {
  if (groups.length !== 8) return null;
  const parsed = groups.map((group) => Number.parseInt(group || '0', 16));
  if (parsed.some((value) => !Number.isFinite(value) || value < 0 || value > 0xffff)) {
    return null;
  }
  return parsed;
}
