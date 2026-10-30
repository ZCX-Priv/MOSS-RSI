// src/modules/im/adapters/onebot/reverse-ws.ts
// 反向 WS 服务端 + 本地 HTTP API/事件端点：
// - WS /onebot/v11/ws：协议端连入，双向收发；
// - POST /onebot/v11/event：HTTP 模式事件推送；
// - POST /onebot/v11/:action：对外 HTTP action（代理到当前后端）；
// - GET /onebot/v11/：健康检查。

import type { Logger } from '../../../../core/types';
import { asRecord, idText, str } from '../util';
import type { OneBotActionClient, OneBotResponse } from './protocol';
import { failedResponse, normalizeResponse, okResponse } from './protocol';

const ONEBOT_PATH = '/onebot/v11';
const WS_PATH = `${ONEBOT_PATH}/ws`;
const EVENT_PATH = `${ONEBOT_PATH}/event`;
const ACTION_TIMEOUT_MS = 10_000;

interface Pending {
  resolve: (value: OneBotResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface OneBotServerOptions {
  port: number;
  accessToken: string;
  logger: Logger;
  /** HTTP 模式下不需要反向 WS 接入 */
  allowWs?: boolean;
  onEvent(event: Record<string, unknown>): void;
  onConnection(connected: boolean): void;
  /** 外部 HTTP 客户端调用 action 时的分发器（由 gateway 按模式注入） */
  dispatch(action: string, params: Record<string, unknown>, echo?: unknown): Promise<OneBotResponse>;
  selfInfo(): { selfId: string; mode: string };
}

export class OneBotReverseServer implements OneBotActionClient {
  private readonly options: OneBotServerOptions;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private socket: { send(data: string): void; close(): void } | null = null;
  private echoSeq = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(options: OneBotServerOptions) {
    this.options = options;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.options.port}${WS_PATH}`;
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = Bun.serve<undefined, string>({
      hostname: '127.0.0.1',
      port: this.options.port,
      fetch: (req, srv) => {
        const url = new URL(req.url);
        if (url.pathname === WS_PATH) {
          if (this.options.allowWs === false) return new Response('WebSocket disabled in HTTP mode', { status: 404 });
          if (!this.authorized(req, url)) return new Response('Unauthorized', { status: 401 });
          if (srv.upgrade(req)) return undefined;
          return new Response('Expected WebSocket', { status: 400 });
        }
        if (!this.authorized(req, url)) return new Response('Unauthorized', { status: 401 });
        if (req.method === 'GET' && (url.pathname === ONEBOT_PATH || url.pathname === `${ONEBOT_PATH}/`)) {
          return Response.json({ ...this.options.selfInfo(), status: 'ok' });
        }
        if (req.method === 'POST' && url.pathname === EVENT_PATH) {
          return this.handleEventPost(req);
        }
        if (req.method === 'POST' && url.pathname.startsWith(`${ONEBOT_PATH}/`)) {
          const action = decodeURIComponent(url.pathname.slice(ONEBOT_PATH.length + 1));
          if (action && action !== 'event' && action !== 'ws') return this.handleActionPost(req, action);
        }
        return new Response('Not Found', { status: 404 });
      },
      websocket: {
        open: ws => {
          this.socket = ws;
          this.options.onConnection(true);
          this.options.logger.info('im: OneBot 协议端已连接反向 WS', { port: this.options.port });
        },
        message: (_ws, message) => {
          try {
            const payload = asRecord(JSON.parse(typeof message === 'string' ? message : String(message)));
            if (!payload) return;
            if (this.resolveResponse(payload)) return;
            if (str(payload.post_type)) this.options.onEvent(payload);
          } catch (error) {
            this.options.logger.warn('im: OneBot 消息解析失败', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        close: () => {
          this.socket = null;
          this.options.onConnection(false);
          this.failPending('协议端连接已断开');
        },
      },
    });
    this.options.onConnection(false);
  }

  async stop(): Promise<void> {
    this.failPending('OneBot 服务已停止');
    try {
      this.socket?.close();
    } catch {
      // 忽略
    }
    this.socket = null;
    try {
      this.server?.stop(true);
    } catch {
      // 忽略
    }
    this.server = null;
  }

  /** 通过反向 WS 调用协议端 action */
  call(action: string, params: Record<string, unknown>, echo?: unknown): Promise<OneBotResponse> {
    if (!this.socket) return Promise.reject(new Error('协议端尚未连接'));
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

  // ---------------------------------------------------------------- HTTP

  private async handleEventPost(req: Request): Promise<Response> {
    try {
      const body = asRecord(await req.json());
      if (body && str(body.post_type)) this.options.onEvent(body);
      return Response.json({ status: 'ok', retcode: 0 });
    } catch (error) {
      return Response.json(failedResponse(error instanceof Error ? error.message : String(error)), { status: 400 });
    }
  }

  private async handleActionPost(req: Request, action: string): Promise<Response> {
    let body: Record<string, unknown> = {};
    try {
      body = asRecord(await req.json()) ?? {};
    } catch {
      body = {};
    }
    const echo = body.echo;
    try {
      const response = await this.options.dispatch(action, body, echo);
      return Response.json(response);
    } catch (error) {
      return Response.json(
        failedResponse(error instanceof Error ? error.message : String(error), 100, echo),
        { status: 200 },
      );
    }
  }

  private authorized(req: Request, url: URL): boolean {
    const token = this.options.accessToken;
    if (!token) return true;
    const header = req.headers.get('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (bearer === token) return true;
    return url.searchParams.get('access_token') === token;
  }

  // ---------------------------------------------------------------- 响应

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

/** 本地可直接回答的 action（不依赖协议端） */
export function localAction(
  action: string,
  selfId: string,
  version = 'moss-onebot/1.0.0',
): OneBotResponse | null {
  switch (action) {
    case 'get_status':
      return okResponse({ online: true, good: true, app_initialized: true, app_enabled: true });
    case 'get_version_info':
      return okResponse({ app_name: 'MOSS OneBot Gateway', app_version: '1.0.0', protocol_version: 'v11', version });
    case 'get_login_info':
      return selfId
        ? okResponse({ user_id: Number(selfId) || selfId, nickname: 'MOSS' })
        : failedResponse('机器人尚未登录（未收到生命周期事件）', 1404);
    case 'can_send_image':
      return okResponse({ yes: true });
    case 'can_send_record':
      return okResponse({ yes: true });
    default:
      return null;
  }
}

/** 从事件中提取 self_id（lifecycle/heartbeat/消息事件都带） */
export function selfIdFromEvent(event: Record<string, unknown>): string {
  return idText(event.self_id);
}
