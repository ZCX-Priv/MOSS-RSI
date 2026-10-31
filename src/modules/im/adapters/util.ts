// src/modules/im/adapters/util.ts
// 适配器共享的小工具：安全取值、带超时的 fetch、可中断 sleep。

/** 安全取对象（非对象返回 null） */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 安全取字符串（trim 后空串返回 ''） */
export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 平台 ID 取值：数字 ID 也要转成字符串 */
export function idText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 安全取数字 */
export function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 非 2xx 响应：保留状态码，供适配器区分凭据失效（401/403）与一般错误 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, text: string) {
    super(`HTTP ${status}: ${text.slice(0, 200)}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** 带超时的 fetch（返回 JSON；非 2xx 抛 HttpError 并附响应文本前 200 字） */
export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(response.status, text);
    }
    return text ? (JSON.parse(text) as unknown) : null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 下载二进制（带超时；非 2xx 抛错） */
export async function fetchBuffer(
  url: string,
  options: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('下载超时')), options.timeoutMs ?? 20_000);
  const onAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const response = await fetch(url, { headers: options.headers, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** 可被 abort 打断的等待 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 错误 → 可读文本 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
