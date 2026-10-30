// src/modules/im/adapters/onebot/gateway.ts
// OneBot 11 网关：按配置选择反向 WS / 正向 WS / HTTP 三种模式，
// 统一事件分发、action 代理与文本发送。

import type { ImAdapterContext, ImChannelAdapter, ImInboundMessage, ImReplyTarget } from '../../types';
import { asRecord, str } from '../util';
import { textToOneBotSegments, toInboundMessage } from './protocol';
import type { OneBotActionClient, OneBotResponse } from './protocol';
import { failedResponse } from './protocol';
import { OneBotForwardClient } from './forward-ws';
import { OneBotHttpClient } from './http-client';
import { localAction, OneBotReverseServer, selfIdFromEvent } from './reverse-ws';

export type OneBotMode = 'reverse-ws' | 'forward-ws' | 'http';

export const ONEBOT_DEFAULT_PORT = 6199;

export interface OneBotConfig {
  mode: OneBotMode;
  listenPort: number;
  backendUrl: string;
  accessToken: string;
}

export function readOneBotConfig(credentials: Record<string, string>): OneBotConfig {
  const modeRaw = str(credentials.mode);
  const mode: OneBotMode =
    modeRaw === 'forward-ws' || modeRaw === 'http' ? modeRaw : 'reverse-ws';
  const portValue = Number(str(credentials.listenPort) || str(credentials.port) || ONEBOT_DEFAULT_PORT);
  const listenPort = Number.isFinite(portValue) && portValue >= 1 && portValue <= 65535
    ? Math.floor(portValue)
    : ONEBOT_DEFAULT_PORT;
  return {
    mode,
    listenPort,
    backendUrl: str(credentials.backendUrl).replace(/\/$/, ''),
    accessToken: str(credentials.accessToken),
  };
}

export class OneBotGateway implements ImChannelAdapter {
  private readonly ctx: ImAdapterContext;
  private readonly config: OneBotConfig;
  private backend: OneBotActionClient | null = null;
  private server: OneBotReverseServer | null = null;
  private forward: OneBotForwardClient | null = null;
  private http: OneBotHttpClient | null = null;
  private selfId = '';
  private stopped = false;

  constructor(ctx: ImAdapterContext) {
    this.ctx = ctx;
    this.config = readOneBotConfig(ctx.bot.credentials);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.publishExtra();
    if (this.config.mode === 'reverse-ws') {
      await this.startReverse();
      return;
    }
    if (this.config.mode === 'forward-ws') {
      this.startForward();
      return;
    }
    await this.startHttp();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.forward?.stop();
    this.forward = null;
    this.backend = null;
    this.http = null;
    await this.server?.stop();
    this.server = null;
    this.ctx.onStatus({ connected: false });
  }

  async sendText(target: ImReplyTarget, text: string): Promise<void> {
    if (!this.backend) throw new Error('OneBot 网关尚未启动');
    // URL 作为纯文本发送时保留换行；不做 CQ 转义
    const message = textToOneBotSegments(text);
    const response = target.kind === 'group'
      ? await this.callAction('send_group_msg', { group_id: str(target.groupId), message })
      : await this.callAction('send_private_msg', { user_id: str(target.userId), message });
    if (response.status !== 'ok') {
      throw new Error(response.message || response.wording || 'OneBot 发送失败');
    }
    this.markConnected();
  }

  // ---------------------------------------------------------------- 模式

  private async startReverse(): Promise<void> {
    const server = new OneBotReverseServer({
      port: this.config.listenPort,
      accessToken: this.config.accessToken,
      logger: this.ctx.logger,
      onEvent: event => this.handleEvent(event),
      onConnection: connected => {
        this.ctx.onStatus({ connected, lastError: connected ? null : undefined });
        this.publishExtra();
      },
      dispatch: (action, params, echo) => this.callAction(action, params, echo),
      selfInfo: () => ({ selfId: this.selfId, mode: this.config.mode }),
    });
    await server.start();
    this.server = server;
    this.backend = server;
    this.ctx.onStatus({ connected: false });
    this.ctx.logger.info('im: OneBot 反向 WS 服务已启动', {
      botId: this.ctx.bot.botId,
      wsUrl: server.wsUrl,
    });
  }

  private startForward(): void {
    if (!this.config.backendUrl) throw new Error('正向 WS 模式需要填写协议端 WS 地址');
    const forward = new OneBotForwardClient({
      url: this.config.backendUrl,
      accessToken: this.config.accessToken,
      logger: this.ctx.logger,
      onEvent: event => this.handleEvent(event),
      onConnection: connected => {
        this.ctx.onStatus({ connected, lastError: connected ? null : undefined });
        this.publishExtra();
      },
    });
    forward.start();
    this.forward = forward;
    this.backend = forward;
    this.ctx.onStatus({ connected: false });
  }

  private async startHttp(): Promise<void> {
    if (!this.config.backendUrl) throw new Error('HTTP 模式需要填写协议端 HTTP 地址');
    const http = new OneBotHttpClient({
      baseUrl: this.config.backendUrl,
      accessToken: this.config.accessToken,
      logger: this.ctx.logger,
    });
    this.http = http;
    this.backend = http;
    const server = new OneBotReverseServer({
      port: this.config.listenPort,
      accessToken: this.config.accessToken,
      logger: this.ctx.logger,
      allowWs: false,
      onEvent: event => {
        http.touch();
        this.handleEvent(event);
      },
      onConnection: connected => {
        if (connected) this.markConnected();
      },
      dispatch: (action, params, echo) => this.callAction(action, params, echo),
      selfInfo: () => ({ selfId: this.selfId, mode: this.config.mode }),
    });
    await server.start();
    this.server = server;
    this.ctx.onStatus({ connected: false });
    this.ctx.logger.info('im: OneBot HTTP 事件端点已启动', {
      botId: this.ctx.bot.botId,
      port: this.config.listenPort,
      backendUrl: this.config.backendUrl,
    });
  }

  // ---------------------------------------------------------------- 事件

  private handleEvent(event: Record<string, unknown>): void {
    const nextSelf = selfIdFromEvent(event);
    if (nextSelf && nextSelf !== this.selfId) {
      this.selfId = nextSelf;
      this.publishExtra();
    }
    const postType = str(event.post_type);
    if (postType === 'meta_event') {
      this.markConnected();
      return;
    }
    if (postType !== 'message') {
      this.ctx.logger.debug('im: OneBot 非消息事件', {
        botId: this.ctx.bot.botId,
        post_type: postType,
        notice_type: str(event.notice_type),
        request_type: str(event.request_type),
        sub_type: str(event.sub_type),
      });
      return;
    }
    if (str(event.message_type) === 'private' || str(event.message_type) === 'group') {
      this.markConnected();
    }
    const backend = this.backend;
    if (!backend) return;
    const inbound: ImInboundMessage | null = toInboundMessage(
      event,
      this.ctx.bot.botId,
      'qq-onebot',
      this.selfId,
      backend,
    );
    if (inbound) this.ctx.onMessage(inbound);
  }

  // ---------------------------------------------------------------- action

  private async callAction(
    action: string,
    params: Record<string, unknown>,
    echo?: unknown,
  ): Promise<OneBotResponse> {
    const local = localAction(action, this.selfId);
    if (local) return local;
    const backend = this.backend;
    if (!backend) return failedResponse('OneBot 网关尚未启动');
    if (!backend.isConnected()) return failedResponse('协议端尚未连接', 1403);
    try {
      const response = await backend.call(action, params, echo);
      if (response.status === 'ok') this.markConnected();
      return response;
    } catch (error) {
      return failedResponse(error instanceof Error ? error.message : String(error), 100, echo);
    }
  }

  // ---------------------------------------------------------------- 状态

  private markConnected(): void {
    if (this.stopped) return;
    this.ctx.onStatus({ connected: true, lastError: null });
  }

  private publishExtra(): void {
    const extra: Record<string, string> = { mode: this.config.mode };
    if (this.config.mode !== 'forward-ws') {
      extra.wsUrl = `ws://127.0.0.1:${this.config.listenPort}/onebot/v11/ws`;
      extra.eventUrl = `http://127.0.0.1:${this.config.listenPort}/onebot/v11/event`;
    }
    if (this.config.backendUrl) extra.backendUrl = this.config.backendUrl;
    if (this.selfId) extra.selfId = this.selfId;
    this.ctx.onStatus({ extra });
  }
}

/** 校验并返回 OneBot 平台身份（供 descriptor.verify 使用） */
export function verifyOneBotConfig(
  credentials: Record<string, string>,
): { platformId: string; name: string; extra: Record<string, string> } {
  const config = readOneBotConfig(credentials);
  if (config.mode === 'reverse-ws' || config.mode === 'http') {
    if (config.listenPort < 1 || config.listenPort > 65535) throw new Error('端口必须在 1-65535 之间');
  }
  if (config.mode === 'forward-ws') {
    if (!/^wss?:\/\//.test(config.backendUrl)) throw new Error('正向 WS 地址必须以 ws:// 或 wss:// 开头');
  }
  if (config.mode === 'http') {
    if (!/^https?:\/\//.test(config.backendUrl)) throw new Error('HTTP 地址必须以 http:// 或 https:// 开头');
  }
  const identity = config.mode === 'reverse-ws'
    ? `onebot:reverse:${config.listenPort}`
    : `onebot:${config.mode}:${config.backendUrl}`;
  return {
    platformId: identity,
    name: `QQ用户模式 ${config.mode}`,
    extra: {
      mode: config.mode,
      listenPort: String(config.listenPort),
      ...(config.mode !== 'forward-ws'
        ? { wsUrl: `ws://127.0.0.1:${config.listenPort}/onebot/v11/ws` }
        : {}),
      ...(config.backendUrl ? { backendUrl: config.backendUrl } : {}),
    },
  };
}

/** 从 action 响应 data 中取数组（供未来扩展使用） */
export function responseArray(response: OneBotResponse): unknown[] {
  return Array.isArray(response.data) ? response.data : [];
}

/** 读取响应 data 对象 */
export function responseRecord(response: OneBotResponse): Record<string, unknown> {
  return asRecord(response.data) ?? {};
}
