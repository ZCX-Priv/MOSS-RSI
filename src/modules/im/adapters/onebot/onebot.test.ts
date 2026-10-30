// src/modules/im/adapters/onebot/onebot.test.ts
// OneBot 11 网关三模式测试：反向 WS（含对外 HTTP action）、正向 WS、HTTP 模式。

import { afterEach, describe, expect, test } from 'bun:test';
import type { Logger } from '../../../../core/types';
import type { ImInboundMessage } from '../../types';
import { createAdapter } from './index';

const sockets: Array<{ close(): void }> = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
const adapters: Array<{ stop(): Promise<void> }> = [];

function logger(): Logger {
  const noop = (): void => undefined;
  const log: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => log,
    setLevel: noop,
    getLevel: () => 'error',
  };
  return log;
}

function bot(credentials: Record<string, string>) {
  return {
    botId: 'ob_test',
    channel: 'qq-onebot' as const,
    name: '测试机器人',
    platformId: `onebot:test:${credentials.listenPort ?? credentials.backendUrl}`,
    credentials,
    enabled: true,
    pairingCode: '123456',
    options: { cwd: '', permissionMode: 'auto' as const, groupTrigger: 'mention' as const },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error('等待条件超时');
}

function lifecycle(selfId = 10000): Record<string, unknown> {
  return { post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: selfId };
}

function privateMessage(text: string, messageId = 1): Record<string, unknown> {
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: messageId,
    self_id: 10000,
    user_id: 10001,
    sender: { nickname: '测试用户' },
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
  };
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.stop().catch(() => undefined);
  }
  for (const socket of sockets.splice(0)) {
    try {
      socket.close();
    } catch {
      // 忽略
    }
  }
  for (const server of servers.splice(0)) {
    try {
      server.stop(true);
    } catch {
      // 忽略
    }
  }
});

/** 简单 WS 假协议端：收到 action 自动回 ok */
function fakeWsBackend(
  port: number,
  hooks: {
    onAction?: (action: string, params: Record<string, unknown>) => void;
    onOpen?: (ws: { send(data: string): void }) => void;
  } = {},
) {
  const server = Bun.serve<undefined, string>({
    hostname: '127.0.0.1',
    port,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response('upgrade required', { status: 400 });
    },
    websocket: {
      open(ws) {
        hooks.onOpen?.(ws);
      },
      message(ws, raw) {
        try {
          const payload = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as {
            action?: string;
            params?: Record<string, unknown>;
            echo?: unknown;
          };
          if (!payload.action) return;
          hooks.onAction?.(payload.action, payload.params ?? {});
          ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: payload.echo }));
        } catch {
          // 忽略
        }
      },
    },
  });
  servers.push(server);
  return server;
}

describe('OneBot 反向 WS 模式', () => {
  test('接收事件 + 对外 HTTP action 代理', async () => {
    const listenPort = 16211;
    const actions: string[] = [];

    const messages: ImInboundMessage[] = [];
    const adapter = createAdapter({
      bot: bot({ mode: 'reverse-ws', listenPort: String(listenPort) }),
      logger: logger(),
      signal: new AbortController().signal,
      onMessage: message => messages.push(message),
      onStatus: () => undefined,
    });
    adapters.push(adapter);
    await adapter.start();

    const socket = new WebSocket(`ws://127.0.0.1:${listenPort}/onebot/v11/ws`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('连接失败')), { once: true });
    });
    socket.addEventListener('message', event => {
      const payload = JSON.parse(String(event.data)) as { action?: string; echo?: unknown };
      if (!payload.action) return;
      actions.push(payload.action);
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: payload.echo }));
    });
    socket.send(JSON.stringify(lifecycle()));
    socket.send(JSON.stringify(privateMessage('你好')));
    await waitFor(() => messages.length === 1);
    expect(messages[0]?.text).toBe('你好');

    const response = await fetch(`http://127.0.0.1:${listenPort}/onebot/v11/send_private_msg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: '10001', message: 'hi' }),
    });
    const body = (await response.json()) as { status?: string; message?: string };
    expect(response.status).toBe(200);
    expect(body.status, JSON.stringify(body)).toBe('ok');
    await waitFor(() => actions.includes('send_private_msg'));

    await adapter.stop();
  });

  test('配置了 token 时拒绝未授权请求', async () => {
    const listenPort = 16219;
    const adapter = createAdapter({
      bot: bot({ mode: 'reverse-ws', listenPort: String(listenPort), accessToken: 'secret' }),
      logger: logger(),
      signal: new AbortController().signal,
      onMessage: () => undefined,
      onStatus: () => undefined,
    });
    adapters.push(adapter);
    await adapter.start();
    const response = await fetch(`http://127.0.0.1:${listenPort}/onebot/v11/send_private_msg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    await adapter.stop();
  });
});

describe('OneBot 正向 WS 模式', () => {
  test('MOSS 连出接收事件并发送 action', async () => {
    const backendPort = 16212;
    const received: string[] = [];
    let backendSocket: { send(data: string): void } | null = null;
    let openResolve: (() => void) | null = null;
    const opened = new Promise<void>(resolve => {
      openResolve = resolve;
    });
    fakeWsBackend(backendPort, {
      onAction: action => received.push(action),
      onOpen: ws => {
        backendSocket = ws;
        openResolve?.();
      },
    });

    const messages: ImInboundMessage[] = [];
    const adapter = createAdapter({
      bot: bot({ mode: 'forward-ws', backendUrl: `ws://127.0.0.1:${backendPort}` }),
      logger: logger(),
      signal: new AbortController().signal,
      onMessage: message => messages.push(message),
      onStatus: () => undefined,
    });
    adapters.push(adapter);
    await adapter.start();
    await opened;
    await Bun.sleep(100);

    const socket = backendSocket as { send(data: string): void } | null;
    expect(socket).not.toBeNull();
    socket?.send(JSON.stringify(lifecycle()));
    socket?.send(JSON.stringify(privateMessage('来自正向 WS')));
    await waitFor(() => messages.length === 1);
    expect(messages[0]?.text).toBe('来自正向 WS');

    await adapter.sendText({ channel: 'qq-onebot', kind: 'direct', userId: '10001' }, 'reply');
    expect(received).toContain('send_private_msg');
    await adapter.stop();
  });
});

describe('OneBot HTTP 模式', () => {
  test('HTTP 动作 + 事件推送', async () => {
    const backendPort = 16213;
    const listenPort = 16214;
    const actions: string[] = [];
    const backend = Bun.serve({
      hostname: '127.0.0.1',
      port: backendPort,
      async fetch(req) {
        const action = new URL(req.url).pathname.slice(1);
        actions.push(action);
        await req.text();
        return Response.json({ status: 'ok', retcode: 0, data: { message_id: 1 } });
      },
    });
    servers.push(backend);

    const messages: ImInboundMessage[] = [];
    const adapter = createAdapter({
      bot: bot({
        mode: 'http',
        listenPort: String(listenPort),
        backendUrl: `http://127.0.0.1:${backendPort}`,
      }),
      logger: logger(),
      signal: new AbortController().signal,
      onMessage: message => messages.push(message),
      onStatus: () => undefined,
    });
    adapters.push(adapter);
    await adapter.start();

    const response = await fetch(`http://127.0.0.1:${listenPort}/onebot/v11/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(privateMessage('来自 HTTP 事件')),
    });
    expect(response.status).toBe(200);
    await waitFor(() => messages.length === 1);
    expect(messages[0]?.text).toBe('来自 HTTP 事件');

    await adapter.sendText({ channel: 'qq-onebot', kind: 'direct', userId: '10001' }, 'reply');
    expect(actions).toContain('send_private_msg');
    await adapter.stop();
  });
});
