// src/modules/browser/bridge.ts
// 扩展桥接 WebSocket 服务：只监听 127.0.0.1，接收扩展的 hello/命令回复/调试器事件。
// 命令模型：MOSS 发 {type:cmd,id,method,params}，扩展回 {type:reply,id,ok,result|error}。

import type { Server, ServerWebSocket } from 'bun';
import type { Logger } from '../../core/types';
import type { BridgeHello, BrowserInstanceInfo, BrowserInstanceKind, NativeTabInfo } from './types';

const PROTOCOL_VERSION = 1;
const PORT_SCAN_COUNT = 10;
const HELLO_TIMEOUT_MS = 8000;
const SERVER_PING_MS = 20_000;

export interface BridgeSocketData {
  connectionId: string;
  instanceId: string | null;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BridgeInstance {
  id: string;
  kind: BrowserInstanceKind;
  info: BrowserInstanceInfo;
  socket: ServerWebSocket<BridgeSocketData>;
  pending: Map<number, PendingCommand>;
  seq: number;
  pingTimer: ReturnType<typeof setInterval>;
}

export type BridgeEventPayload =
  | {
      instanceId: string;
      event: 'debugger';
      tabId: number;
      method: string;
      params?: unknown;
    }
  | {
      instanceId: string;
      event: 'debugger.detached';
      tabId: number;
      reason?: string;
    }
  | {
      instanceId: string;
      event: 'tab.created';
      tab: NativeTabInfo;
    }
  | {
      instanceId: string;
      event: 'tab.updated';
      tab: NativeTabInfo;
    }
  | {
      instanceId: string;
      event: 'tab.removed';
      tabId: number;
      windowId?: number;
    };

export interface BrowserBridgeDeps {
  logger: Logger;
  /** 实时读取访问令牌（token 热更新后新连接立即生效） */
  getToken: () => string;
  /** 当前内置 Chrome 启动标记；命中 hello.builtinTag 时实例标记为 builtin */
  getBuiltinTag: () => string | null;
  onInstanceConnected: (info: BrowserInstanceInfo) => void;
  onInstanceDisconnected: (instanceId: string) => void;
  onEvent: (payload: BridgeEventPayload) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class BrowserBridgeServer {
  private readonly deps: BrowserBridgeDeps;
  private readonly instances = new Map<string, BridgeInstance>();
  private server: Server<BridgeSocketData> | null = null;
  private actualPort: number | null = null;
  private lastError: string | null = null;

  constructor(deps: BrowserBridgeDeps) {
    this.deps = deps;
  }

  get running(): boolean {
    return this.server !== null;
  }

  get port(): number | null {
    return this.actualPort;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** 在配置端口起的 10 个端口内寻找空闲端口并启动 */
  start(preferredPort: number): void {
    if (this.server) return;
    this.lastError = null;
    const startPort = Math.max(1024, Math.min(65535, Math.trunc(preferredPort) || 7799));
    for (let offset = 0; offset < PORT_SCAN_COUNT; offset += 1) {
      const port = startPort + offset;
      if (port > 65535) break;
      try {
        this.server = Bun.serve<BridgeSocketData>({
          hostname: '127.0.0.1',
          port,
          fetch: (req, srv) => this.handleFetch(req, srv),
          websocket: {
            idleTimeout: 120,
            maxPayloadLength: 64 * 1024 * 1024,
            open: (ws) => this.handleOpen(ws),
            message: (ws, message) => this.handleMessage(ws, message),
            close: (ws) => this.handleClose(ws),
          },
        });
        this.actualPort = port;
        this.deps.logger.info(`[browser] 桥接服务已启动: ws://127.0.0.1:${port}/browser`);
        return;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    this.deps.logger.warn(`[browser] 桥接服务启动失败: ${this.lastError ?? '无可用端口'}`);
  }

  stop(): void {
    for (const instance of this.instances.values()) {
      clearInterval(instance.pingTimer);
      this.rejectAll(instance, new Error('桥接服务已停止'));
      try {
        instance.socket.close();
      } catch {
        // ignore
      }
    }
    this.instances.clear();
    if (this.server) {
      try {
        this.server.stop(true);
      } catch {
        // ignore
      }
      this.server = null;
      this.actualPort = null;
    }
  }

  getInstance(instanceId: string): BrowserInstanceInfo | null {
    return this.instances.get(instanceId)?.info ?? null;
  }

  listInstances(): BrowserInstanceInfo[] {
    return Array.from(this.instances.values())
      .map((item) => item.info)
      .sort((a, b) => b.connectedAt - a.connectedAt);
  }

  /** 向扩展发送命令并等待回复 */
  async send(instanceId: string, method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error('浏览器实例已断开');
    const id = ++instance.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        instance.pending.delete(id);
        reject(new Error(`浏览器命令超时：${method}`));
      }, timeoutMs);
      instance.pending.set(id, { resolve, reject, timer });
      try {
        instance.socket.send(JSON.stringify({ type: 'cmd', id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        instance.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleFetch(req: Request, srv: Server<BridgeSocketData>): Response | undefined {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/blank') {
      // 扩展建页时的本地空白着陆页：保证 chrome.debugger 在 attach 时拥有 host 权限
      return new Response('<!doctype html><html><head><meta charset="utf-8"><title>MOSS</title></head><body></body></html>', {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }
    if (url.pathname !== '/browser') {
      return new Response('Not Found', { status: 404 });
    }
    const origin = req.headers.get('origin') ?? '';
    if (!origin.startsWith('chrome-extension://')) {
      return new Response('Forbidden', { status: 403 });
    }
    const ok = srv.upgrade(req, {
      data: { connectionId: crypto.randomUUID(), instanceId: null },
    });
    if (ok) return undefined;
    return new Response('Upgrade failed', { status: 400 });
  }

  private handleOpen(ws: ServerWebSocket<BridgeSocketData>): void {
    const timer = setTimeout(() => {
      if (!ws.data.instanceId) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }, HELLO_TIMEOUT_MS);
    ws.data = { ...ws.data, instanceId: ws.data.instanceId ?? null };
    // hello 超时计时器挂在闭包中，连接成功后清理
    this.helloTimers.set(ws.data.connectionId, timer);
  }

  private readonly helloTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private handleMessage(ws: ServerWebSocket<BridgeSocketData>, raw: string | Buffer): void {
    let message: unknown;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return;
    }
    if (!isObject(message) || typeof message.type !== 'string') return;

    if (message.type === 'hello') {
      this.handleHello(ws, message as unknown as BridgeHello);
      return;
    }

    const instanceId = ws.data.instanceId;
    if (!instanceId) return;
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    if (message.type === 'reply') {
      const id = typeof message.id === 'number' ? message.id : -1;
      const pending = instance.pending.get(id);
      if (!pending) return;
      instance.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.ok === false) {
        const error = isObject(message.error) && typeof message.error.message === 'string'
          ? message.error.message
          : '浏览器命令执行失败';
        pending.reject(new Error(error));
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }

    if (message.type === 'event') {
      if (message.event === 'tab.created' || message.event === 'tab.updated') {
        const tab = this.parseTabPayload(message.tab);
        if (tab) {
          this.deps.onEvent({ instanceId, event: message.event, tab });
        }
        return;
      }
      if (message.event === 'tab.removed') {
        const tabId = typeof message.tabId === 'number' ? message.tabId : -1;
        if (tabId < 0) return;
        this.deps.onEvent({
          instanceId,
          event: 'tab.removed',
          tabId,
          ...(typeof message.windowId === 'number' ? { windowId: message.windowId } : {}),
        });
        return;
      }
      const tabId = typeof message.tabId === 'number' ? message.tabId : -1;
      if (tabId < 0) return;
      if (message.event === 'debugger') {
        if (typeof message.method !== 'string') return;
        this.deps.onEvent({
          instanceId,
          tabId,
          event: 'debugger',
          method: message.method,
          params: message.params,
        });
      } else if (message.event === 'debugger.detached') {
        this.deps.onEvent({
          instanceId,
          tabId,
          event: 'debugger.detached',
          ...(typeof message.reason === 'string' ? { reason: message.reason } : {}),
        });
      }
      return;
    }
    // pong 等心跳帧：忽略
  }

  /** 扩展 tab 事件 → NativeTabInfo（字段缺失时使用安全默认值） */
  private parseTabPayload(raw: unknown): NativeTabInfo | null {
    if (!isObject(raw)) return null;
    const tabId = typeof raw.tabId === 'number' ? raw.tabId : -1;
    if (tabId < 0) return null;
    return {
      tabId,
      windowId: typeof raw.windowId === 'number' ? raw.windowId : -1,
      ...(typeof raw.openerTabId === 'number' ? { openerTabId: raw.openerTabId } : {}),
      groupId: typeof raw.groupId === 'number' ? raw.groupId : -1,
      url: typeof raw.url === 'string' ? raw.url : '',
      title: typeof raw.title === 'string' ? raw.title : '',
      active: raw.active === true,
      status: typeof raw.status === 'string' ? raw.status : '',
      pinned: raw.pinned === true,
    };
  }

  private handleHello(ws: ServerWebSocket<BridgeSocketData>, hello: BridgeHello): void {
    const connectionId = ws.data.connectionId;
    const timer = this.helloTimers.get(connectionId);
    if (timer) {
      clearTimeout(timer);
      this.helloTimers.delete(connectionId);
    }
    if (ws.data.instanceId) {
      // 重复 hello：忽略
      return;
    }
    const reject = (reason: string): void => {
      try {
        ws.send(JSON.stringify({ type: 'rejected', reason }));
      } catch {
        // ignore
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
    if (hello.protocol !== PROTOCOL_VERSION) {
      reject(`protocol mismatch: ${String(hello.protocol)}`);
      return;
    }
    if (this.deps.getToken() && String(hello.token ?? '') !== this.deps.getToken()) {
      reject('unauthorized');
      return;
    }
    if (typeof hello.extensionId !== 'string' || !hello.extensionId) {
      reject('missing extensionId');
      return;
    }

    const instanceId = crypto.randomUUID();
    const tag = this.deps.getBuiltinTag();
    const builtinTag = typeof hello.builtinTag === 'string' ? hello.builtinTag : '';
    const kind: BrowserInstanceKind = tag && builtinTag && builtinTag === tag ? 'builtin' : 'external';
    const browser = hello.browser ?? {};
    const info: BrowserInstanceInfo = {
      id: instanceId,
      kind,
      browserName: typeof browser.name === 'string' && browser.name ? browser.name : 'Chromium',
      browserVersion: typeof browser.version === 'string' ? browser.version : '',
      extensionId: hello.extensionId,
      extensionVersion: typeof hello.extensionVersion === 'string' ? hello.extensionVersion : '',
      ...(builtinTag ? { builtinTag } : {}),
      connectedAt: Date.now(),
      tabCount: 0,
    };
    const instance: BridgeInstance = {
      id: instanceId,
      kind,
      info,
      socket: ws,
      pending: new Map(),
      seq: 0,
      pingTimer: setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // 发送失败由 close 清理
        }
      }, SERVER_PING_MS),
    };
    this.instances.set(instanceId, instance);
    ws.data = { ...ws.data, instanceId };
    try {
      ws.send(
        JSON.stringify({
          type: 'welcome',
          protocol: PROTOCOL_VERSION,
          instanceId,
          keepaliveSec: SERVER_PING_MS / 1000,
        }),
      );
    } catch {
      // ignore
    }
    this.deps.logger.info(`[browser] 扩展已连接: ${info.browserName} ${info.browserVersion} (${kind})`);
    this.deps.onInstanceConnected(info);
  }

  private handleClose(ws: ServerWebSocket<BridgeSocketData>): void {
    const connectionId = ws.data.connectionId;
    const timer = this.helloTimers.get(connectionId);
    if (timer) {
      clearTimeout(timer);
      this.helloTimers.delete(connectionId);
    }
    const instanceId = ws.data.instanceId;
    if (!instanceId) return;
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    clearInterval(instance.pingTimer);
    this.rejectAll(instance, new Error('浏览器实例已断开'));
    this.instances.delete(instanceId);
    this.deps.logger.info(`[browser] 扩展已断开: ${instance.info.browserName}`);
    this.deps.onInstanceDisconnected(instanceId);
  }

  private rejectAll(instance: BridgeInstance, error: Error): void {
    for (const [, pending] of instance.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    instance.pending.clear();
  }
}
