// src/modules/im/adapters/onebot/forward-ws.ts
// 正向 WS 客户端：MOSS 主动连接协议端的 OneBot WS 地址，收事件、发 action。
// 断线指数退避重连（1s → 30s），stop 后不再重连。

import type { Logger } from '../../../../core/types';
import { asRecord, str } from '../util';
import type { OneBotActionClient, OneBotResponse } from './protocol';
import { normalizeResponse } from './protocol';

const ACTION_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface Pending {
  resolve: (value: OneBotResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface OneBotForwardOptions {
  url: string;
  accessToken: string;
  logger: Logger;
  onEvent(event: Record<string, unknown>): void;
  onConnection(connected: boolean): void;
}

export class OneBotForwardClient implements OneBotActionClient {
  private readonly options: OneBotForwardOptions;
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private echoSeq = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(options: OneBotForwardOptions) {
    this.options = options;
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending('正向 WS 已停止');
    try {
      this.socket?.close();
    } catch {
      // 忽略
    }
    this.socket = null;
  }

  call(action: string, params: Record<string, unknown>, echo?: unknown): Promise<OneBotResponse> {
    if (!this.isConnected() || !this.socket) {
      return Promise.reject(new Error('协议端尚未连接'));
    }
    const requestEcho = echo ?? `moss-${Date.now()}-${this.echoSeq++}`;
    return new Promise<OneBotResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(requestEcho));
        reject(new Error(`OneBot 动作超时：${action}`));
      }, ACTION_TIMEOUT_MS);
      this.pending.set(String(requestEcho), { resolve, reject, timer });
      try {
        this.socket?.send(JSON.stringify({ action, params, echo: requestEcho }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(requestEcho));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  // ---------------------------------------------------------------- 内部

  private connect(): void {
    if (this.stopped) return;
    const withToken = this.options.accessToken
      ? `${this.options.url}${this.options.url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.options.accessToken)}`
      : this.options.url;
    let socket: WebSocket;
    try {
      socket = new WebSocket(withToken);
    } catch (error) {
      this.options.logger.warn('im: OneBot 正向 WS 地址无效', {
        url: this.options.url,
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.options.onConnection(true);
      this.options.logger.info('im: OneBot 正向 WS 已连接', { url: this.options.url });
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      try {
        const payload = asRecord(JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)));
        if (!payload) return;
        if (this.resolveResponse(payload)) return;
        if (str(payload.post_type)) this.options.onEvent(payload);
      } catch (error) {
        this.options.logger.warn('im: OneBot 正向 WS 消息解析失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    const onDown = (): void => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.options.onConnection(false);
      this.failPending('正向 WS 连接已断开');
      this.scheduleReconnect();
    };
    socket.addEventListener('close', onDown);
    socket.addEventListener('error', onDown);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private resolveResponse(payload: Record<string, unknown>): boolean {
    const echo = payload.echo;
    if (echo === undefined) return false;
    const key = String(echo);
    const entry = this.pending.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    entry.resolve(normalizeResponse(payload));
    return true;
  }

  private failPending(reason: string): void {
    for (const [key, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(key);
    }
  }
}
