// src/modules/im/adapters/onebot/http-client.ts
// HTTP 模式 action 客户端：POST {backendUrl}/{action}，按 OneBot 信封解析。

import type { Logger } from '../../../../core/types';
import { asRecord } from '../util';
import type { OneBotActionClient, OneBotResponse } from './protocol';
import { failedResponse, normalizeResponse } from './protocol';

const ACTION_TIMEOUT_MS = 10_000;
/** 超过该时间没有成功调用/事件，视为离线（事件由 gateway 调 touch 刷新） */
const ONLINE_WINDOW_MS = 60_000;

export interface OneBotHttpOptions {
  baseUrl: string;
  accessToken: string;
  logger: Logger;
}

export class OneBotHttpClient implements OneBotActionClient {
  private readonly options: OneBotHttpOptions;
  private lastSuccessAt = 0;

  constructor(options: OneBotHttpOptions) {
    this.options = options;
  }

  /** 收到 HTTP 事件推送时刷新在线状态 */
  touch(): void {
    this.lastSuccessAt = Date.now();
  }

  isConnected(): boolean {
    return this.lastSuccessAt > 0 && Date.now() - this.lastSuccessAt < ONLINE_WINDOW_MS;
  }

  async call(action: string, params: Record<string, unknown>): Promise<OneBotResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('OneBot HTTP 动作超时')), ACTION_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/${encodeURIComponent(action)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.accessToken ? { authorization: `Bearer ${this.options.accessToken}` } : {}),
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        return failedResponse(`HTTP ${response.status}: ${text.slice(0, 200)}`, response.status);
      }
      const payload = asRecord(text ? JSON.parse(text) : null);
      this.lastSuccessAt = Date.now();
      return normalizeResponse(payload);
    } catch (error) {
      this.options.logger.warn('im: OneBot HTTP 动作失败', {
        action,
        error: error instanceof Error ? error.message : String(error),
      });
      return failedResponse(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}
