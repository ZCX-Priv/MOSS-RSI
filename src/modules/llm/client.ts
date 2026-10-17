// src/modules/llm/client.ts
// 底层 HTTP 调用：超时、重试、错误归一化。

import { t } from '../../core/i18n';
import { LLMError } from './types';
import type { Logger } from '../../core/types';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;

export interface RequestOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** 流式响应则 true，返回 ReadableStream */
  stream?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** 非流式：完整响应体文本 */
  text?: string;
  /** 流式：响应体 ReadableStream */
  stream?: ReadableStream<Uint8Array>;
}

/**
 * 发送 HTTP 请求。
 * - 429 指数退避重试
 * - 5xx 重试
 * - 4xx 不重试
 * - 超时不重试（直接抛 LLMError）
 */
export async function httpRequest(
  opts: RequestOptions,
  logger: Logger,
): Promise<HttpResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = MAX_RETRIES;
  let attempt = 0;

  while (true) {
    attempt++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // 合并外部 signal
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timeout);
        throw new LLMError('Request aborted', undefined, false);
      }
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const body = opts.body !== null && opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;

      const resp = await fetch(opts.url, {
        method: opts.method,
        headers: opts.headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });

      // 流式响应：先校验状态码，非 2xx 时读取错误体抛错
      if (opts.stream && resp.body) {
        if (resp.status >= 400) {
          // 401/403/5xx 等错误：响应体不是 SSE，而是 JSON 错误信息
          // 必须读取并抛出，否则会被 parseSSEStream 静默丢弃
          const errText = await resp.text();
          // 5xx 可重试
          if (resp.status >= 500 && attempt <= maxRetries) {
            const delay = backoffMs(attempt);
            logger.warn(t('llm.httpStreamRetry', { status: resp.status, delay, attempt, maxRetries }));
            await sleep(delay);
            continue;
          }
          if (resp.status === 429 && attempt <= maxRetries) {
            const retryAfter = parseRetryAfter(headers['retry-after']);
            const delay = retryAfter ?? backoffMs(attempt);
            logger.warn(t('llm.http429StreamRetry', { delay, attempt, maxRetries }));
            await sleep(delay);
            continue;
          }
          throw new LLMError(
            describeHttpError(resp.status, errText, logger),
            resp.status,
            false,
            errText,
          );
        }
        return { status: resp.status, headers, stream: resp.body };
      }

      const text = await resp.text();

      // 错误状态码处理
      if (resp.status === 429) {
        if (attempt <= maxRetries) {
          const retryAfter = parseRetryAfter(headers['retry-after']);
          const delay = retryAfter ?? backoffMs(attempt);
          logger.warn(t('llm.http429Retry', { delay, attempt, maxRetries }));
          await sleep(delay);
          continue;
        }
        throw new LLMError(
          `Rate limited (429) after ${maxRetries} retries`,
          429,
          false,
          text,
        );
      }
      if (resp.status >= 500) {
        if (attempt <= maxRetries) {
          const delay = backoffMs(attempt);
          logger.warn(t('llm.httpRetry', { status: resp.status, delay, attempt, maxRetries }));
          await sleep(delay);
          continue;
        }
        throw new LLMError(
          `Server error ${resp.status} after ${maxRetries} retries: ${truncate(text, 500)}`,
          resp.status,
          false,
          text,
        );
      }
      if (resp.status >= 400) {
        throw new LLMError(
          describeHttpError(resp.status, text, logger),
          resp.status,
          false,
          text,
        );
      }

      return { status: resp.status, headers, text };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof LLMError) throw err;

      // 超时 / 网络错误
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      if (isAbort && opts.signal?.aborted) {
        throw new LLMError('Request aborted by caller', undefined, false);
      }
      if (isAbort) {
        // 本地超时（非外部中止）：不重试——120s 已足够长，弱网下快速失败给用户
        // 明确错误远好于 3 连重试 × 120s 的假死（与函数头注释「超时不重试」对齐）
        logger.warn(t('llm.requestTimeoutNoRetry', { timeoutMs }));
        throw new LLMError(`Request timed out after ${timeoutMs}ms`, undefined, false);
      }
      // 网络错误重试
      if (attempt <= maxRetries) {
        const delay = backoffMs(attempt);
        logger.warn(t('llm.networkErrorRetry', { delay, attempt, maxRetries, error: err instanceof Error ? err.message : String(err) }));
        await sleep(delay);
        continue;
      }
      throw new LLMError(
        `Request failed: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        false,
      );
    }
  }
}

function backoffMs(attempt: number): number {
  // 指数退避：1s, 2s, 4s, ... + jitter
  const base = Math.pow(2, attempt - 1) * 1000;
  const jitter = Math.random() * 500;
  return Math.min(base + jitter, 30_000);
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const sec = Number(value);
  if (!Number.isNaN(sec)) return sec * 1000;
  // HTTP-date 格式（极少用）
  const ms = Date.parse(value) - Date.now();
  return ms > 0 ? ms : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * 上游内容审核拦截标记（DeepSeek 返回 `Content Exists Risk`；其他 OpenAI 兼容服务商有同类文案）。
 * 命中时给出可操作的中文提示，而不是把原始 JSON 直接抛给用户。
 */
const MODERATION_MARKERS = [
  'content exists risk',
  'content_exist_risk',
  'data_inspection_failed',
  'data inspection failed',
  'sensitive content',
  'unsafe content',
  'content policy',
  '风险',
  '敏感',
];

/** 是否为「上游内容审核」类 400（原始错误体含审核标记） */
function isModerationError(status: number, body: string): boolean {
  if (status !== 400) return false;
  const lower = body.toLowerCase();
  return MODERATION_MARKERS.some(marker => lower.includes(marker.toLowerCase()));
}

/** 4xx 错误体 → 抛出的 LLMError 文案（审核类替换为可操作提示；其余保留原始片段） */
function describeHttpError(status: number, body: string, logger: Logger): string {
  if (isModerationError(status, body)) {
    // 原始错误体保留在日志与 LLMError.raw 中，便于定位是哪家服务商的审核
    logger.warn(t('llm.moderationBlocked'), { status, raw: truncate(body, 300) });
    return `HTTP ${status}: ${t('llm.moderationBlocked')}`;
  }
  return `HTTP ${status}: ${truncate(body, 500)}`;
}
