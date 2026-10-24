// src/modules/browser/cdp.ts
// 浏览器级 CDP 连接：直连内置 Chrome 的 DevTools WebSocket，使用 flat session 操作页面。

export type CdpEventHandler = (method: string, params: unknown, sessionId?: string) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string; code?: number };
}

export class CdpConnection {
  private readonly ws: WebSocket;
  private readonly pending = new Map<number, PendingCall>();
  private readonly handlers = new Set<CdpEventHandler>();
  private seq = 0;
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.onmessage = (event: MessageEvent) => this.handleMessage(event);
    this.ws.onclose = () => this.failAll(new Error('CDP 连接已关闭'));
    this.ws.onerror = () => {
      // onclose 会触发统一清理
    };
  }

  /** 连接浏览器级 WebSocket（ws://127.0.0.1:<port>/devtools/browser/<id>） */
  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error('CDP 连接超时'));
      }, timeoutMs);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('CDP 连接失败'));
      };
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onEvent(handler: CdpEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed) throw new Error('CDP 连接已关闭');
    const id = ++this.seq;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** attach 到 target 并返回 flat sessionId */
  async attach(targetId: string, timeoutMs = 30_000): Promise<string> {
    const result = await this.send<{ sessionId?: string }>(
      'Target.attachToTarget',
      { targetId, flatten: true },
      undefined,
      timeoutMs,
    );
    if (!result || typeof result.sessionId !== 'string') {
      throw new Error('Target.attachToTarget 未返回 sessionId');
    }
    return result.sessionId;
  }

  async detach(sessionId: string): Promise<void> {
    try {
      await this.send('Target.detachFromTarget', { sessionId });
    } catch {
      // 页面已关闭时 detach 会失败，忽略
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('CDP 连接已关闭'));
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }

  private handleMessage(event: MessageEvent): void {
    const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
    let message: CdpMessage;
    try {
      message = JSON.parse(text) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const call = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) {
        call.reject(new Error(message.error.message ?? `CDP 错误 ${message.error.code ?? ''}`.trim()));
      } else {
        call.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === 'string') {
      for (const handler of this.handlers) {
        try {
          handler(message.method, message.params ?? {}, message.sessionId);
        } catch {
          // 单个事件处理器异常不影响连接
        }
      }
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }
}
