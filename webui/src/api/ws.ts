// UI/src/api/ws.ts
// WebSocket 客户端：自动重连。迁移自 webui/src/api/ws.ts，无业务改动。

import type { WSMessage } from '../types/api';

type MessageHandler = (msg: WSMessage) => void;

/** 连接状态详情（状态条数据源：能显示「正在重连（第 N 次，约 X 秒后重试）」并支持立即重试） */
export interface WsStatusInfo {
  status: 'connecting' | 'open' | 'closed' | 'error';
  /** 已发生的重连尝试次数（0 = 未在重连） */
  attempt: number;
  /** 下一次重连的预计时间戳（ms；null = 无待执行的退避重连） */
  nextRetryAt: number | null;
  /** 是否为「断开后重新连上」（状态条据此短暂提示「连接已恢复」） */
  restored: boolean;
}

type StatusHandler = (info: WsStatusInfo) => void;

/** Page Lifecycle 的 resume 事件（TS DOM 事件表未收录，运行时字符串不变） */
const RESUME_EVENT = 'resume' as keyof DocumentEventMap;

export class WSClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private reconnectDelay = 1000;
  private shouldReconnect = true;
  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private pendingMessages: WSMessage[] = [];
  /**
   * 控制类消息（如 task.abort）：断连时不随业务消息队列无限积压，
   * 按 `type+sessionId` 只保留最后一条；重连后优先补发。
   */
  private controlMessages = new Map<string, WSMessage>();
  /** 当前订阅的 session（重连后自动重订阅，防止 sendToSession 事件丢失） */
  private subscribedSessionId: string | null = null;
  /** 心跳定时器（主线程回退方案；首选 Web Worker，见 heartbeatWorker） */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 心跳 Worker（不受 Chrome 后台标签页 timer 节流影响） */
  private heartbeatWorker: Worker | null = null;
  private lastPong = 0;
  /** 退避重连定时器（retryNow 需要能取消它） */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 下一次重连的预计时间戳（状态条倒计时用） */
  private nextRetryAt: number | null = null;
  /** 是否经历过断连（用于判定「已恢复」提示） */
  private hadDisconnect = false;
  /** 心跳间隔与超时（毫秒） */
  private static readonly HEARTBEAT_INTERVAL = 15_000;
  private static readonly HEARTBEAT_TIMEOUT = 30_000;
  /** 断连期间积压消息上限，超出丢弃最旧 */
  private static readonly MAX_PENDING = 500;

  constructor(url?: string) {
    // 默认使用当前页面同源的 ws:// 或 wss://
    if (url) {
      this.url = url;
    } else {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.url = `${proto}//${window.location.host}/ws`;
    }
    // 页面回前台/窗口聚焦：立即补一次探活与重连（后台时退避 setTimeout 同样被节流，
    // 可能延迟数分钟；回前台主动补连把恢复时间拉回秒级）
    this.onVisibilityChange = this.onVisibilityChange.bind(this);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    document.addEventListener(RESUME_EVENT, this.onVisibilityChange);
    window.addEventListener('focus', this.onVisibilityChange);
  }

  /**
   * 页面可见/聚焦/从冻结恢复：连接存活则刷新探活基准；在等退避重连则立即重试。
   * 切后台期间连接可能已被后端 idleTimeout 关闭，因此不能无条件刷新 lastPong
   * （那会掩盖死链，导致要等下一次 30s 心跳超时才重连）。
   */
  private onVisibilityChange(): void {
    if (document.visibilityState !== 'visible') return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (Date.now() - this.lastPong > WSClient.HEARTBEAT_TIMEOUT) {
        // 僵死连接：立即关闭交给 onclose → 退避重连，不刷新探活基准
        try {
          this.ws.close();
        } catch {
          // 已关闭则忽略
        }
        return;
      }
      this.lastPong = Date.now();
      try {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        // 发送失败由心跳超时路径兜底
      }
      return;
    }
    if (this.shouldReconnect) this.retryNow();
  }

  connect(): void {
    // 每次显式 connect 都重置重连意愿：disconnect() 会将其置 false（React StrictMode
    // dev 双挂载、组件重挂载都会走 disconnect→connect），不重置会导致后续断开永不重连
    this.shouldReconnect = true;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    // 清理旧实例的事件回调：旧连接 close 握手的迟到 onclose 会污染新连接的状态
    // （误报 closed / 误停新连接的心跳）
    if (this.ws) {
      const old = this.ws;
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      if (old.readyState === WebSocket.CONNECTING) {
        // 握手中不能提前 close（Chrome 会报 closed before the connection is established）；
        // 等 open 后立即关闭，回调已清空不会污染新连接状态
        old.onopen = () => {
          try {
            old.close();
          } catch {
            // 已关闭则忽略
          }
        };
      } else {
        try {
          old.close();
        } catch {
          // 已关闭则忽略
        }
      }
    }
    this.notifyStatus('connecting');

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.notifyStatus('error');
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      const restored = this.hadDisconnect;
      this.reconnectAttempts = 0;
      this.hadDisconnect = false;
      this.clearReconnectTimer();
      this.notifyStatus('open', restored);
      this.startHeartbeat();
      // 重连后自动恢复 session 订阅（后端 sendToSession 按连接订阅的 sessionId 投递事件，
      // 新连接不重新订阅会导致 session-truncated/session-restored 等事件静默丢失）
      if (this.subscribedSessionId) {
        this.ws?.send(JSON.stringify({ type: 'session.subscribe', sessionId: this.subscribedSessionId }));
      }
      // 优先补发控制消息（每类只保留最后一条），再发送积压的业务消息
      for (const msg of this.controlMessages.values()) {
        this.ws?.send(JSON.stringify(msg));
      }
      this.controlMessages.clear();
      while (this.pendingMessages.length > 0) {
        const msg = this.pendingMessages.shift()!;
        this.ws?.send(JSON.stringify(msg));
      }
    };

    this.ws.onmessage = (event) => {
      // 任何到达的数据都视为连接存活，重置心跳
      this.lastPong = Date.now();
      try {
        const msg = JSON.parse(event.data) as WSMessage;
        for (const h of this.messageHandlers) {
          try {
            h(msg);
          } catch (err) {
            console.error('WS message handler error:', err);
          }
        }
      } catch {
        // 非 JSON 消息忽略
      }
    };

    this.ws.onerror = () => {
      this.notifyStatus('error');
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.hadDisconnect = true;
      this.notifyStatus('closed');
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    document.removeEventListener(RESUME_EVENT, this.onVisibilityChange);
    window.removeEventListener('focus', this.onVisibilityChange);
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    // 清空回调：握手迟到的 open/close 不得再影响后续连接
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (ws.readyState === WebSocket.CONNECTING) {
      // StrictMode 双挂载会在 CONNECTING 阶段卸载：等握手完成再关闭，
      // 消除控制台 "WebSocket is closed before the connection is established"
      ws.onopen = () => {
        try {
          ws.close();
        } catch {
          // 已关闭则忽略
        }
      };
      return;
    }
    try {
      ws.close();
    } catch {
      // 已关闭则忽略
    }
  }

  /** 立即重试：取消退避等待并马上发起连接（状态条的「立即重试」按钮） */
  retryNow(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.clearReconnectTimer();
    this.notifyStatus('connecting');
    this.connect();
  }

  send(msg: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      if (this.pendingMessages.length >= WSClient.MAX_PENDING) {
        // 丢弃最旧，避免弱网下无限积压
        this.pendingMessages.shift();
      }
      this.pendingMessages.push(msg);
      this.connect();
    }
  }

  /**
   * 发送控制消息（abort 等）：连接已开则立即发送；断连时按类型去重排队，
   * 只保留最后一次（避免弱网下大量过期控制指令排队并被顺序执行）。
   */
  sendControl(msg: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch {
        // 发送失败：转存到控制队列，重连后补发
        this.controlMessages.set(`${msg.type}|${msg.sessionId ?? ''}`, msg);
      }
      return;
    }
    this.controlMessages.set(`${msg.type}|${msg.sessionId ?? ''}`, msg);
    this.connect();
  }

  /**
   * 订阅 session 并记住订阅关系：断线自动重连后由 onopen 自动重发 session.subscribe，
   * 保证后端 sendToSession 投递的 session 级事件（撤回/恢复/流式输出等）不因重连丢失。
   */
  subscribeSession(sessionId: string): void {
    this.subscribedSessionId = sessionId;
    this.send({ type: 'session.subscribe', sessionId });
  }

  /**
   * 发送二进制帧（语音音频 PCM）。仅连接已打开时发送，不排队：
   * 音频是实时流，积压重放没有意义（断线期间丢弃即可）。
   */
  sendBinary(data: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /** 当前是否已连接（可发送数据） */
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** 心跳：首选 Web Worker 定时（主线程 timer 在后台标签页被 Chrome 对齐到 1 分钟一次，
   *  会踩穿后端 idleTimeout；Worker 定时器不参与标签页节流）。单次 tick 的逻辑不变：
   *  周期发 ping，超过超时未收到任何数据则判定连接僵死并主动断开触发重连 */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPong = Date.now();
    try {
      this.heartbeatWorker = new Worker(
        new URL('./heartbeat-worker.ts', import.meta.url),
        { type: 'module' },
      );
      this.heartbeatWorker.onmessage = () => this.heartbeatTick();
      this.heartbeatWorker.postMessage('start');
      return;
    } catch {
      // Worker 创建失败（极老环境）：回退主线程定时
      this.heartbeatWorker = null;
    }
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), WSClient.HEARTBEAT_INTERVAL);
  }

  /** 单次心跳动作（Worker tick 与主线程回退共用） */
  private heartbeatTick(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        // 发送失败视为断开
      }
      if (Date.now() - this.lastPong > WSClient.HEARTBEAT_TIMEOUT) {
        // 僵死连接：主动关闭以触发 onclose → 重连
        this.ws.close();
      }
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatWorker) {
      this.heartbeatWorker.postMessage('stop');
      this.heartbeatWorker.terminate();
      this.heartbeatWorker = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    // 指数退避 + 抖动，封顶 30s；不设固定次数上限，弱网下持续重连
    this.reconnectAttempts++;
    const base = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
    const delay = base + Math.random() * 500;
    this.clearReconnectTimer();
    this.nextRetryAt = Date.now() + delay;
    // 通知一次「重连已排期」：状态条据此显示第 N 次与倒计时
    this.notifyStatus('closed');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextRetryAt = null;
      if (this.shouldReconnect) this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.nextRetryAt = null;
  }

  private notifyStatus(status: 'connecting' | 'open' | 'closed' | 'error', restored = false): void {
    const info: WsStatusInfo = {
      status,
      attempt: this.reconnectAttempts,
      nextRetryAt: this.nextRetryAt,
      restored,
    };
    for (const h of this.statusHandlers) {
      try {
        h(info);
      } catch {
        // 静默
      }
    }
  }
}

export const wsClient = new WSClient();
