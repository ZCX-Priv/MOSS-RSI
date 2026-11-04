// src/modules/server/types.ts
// Server 插件类型定义。

import type { Server } from 'node:http';
import type { AgentEvent } from '../contracts';

/** HTTP 请求上下文（Bun.serve fetch handler 内构造） */
export interface HttpRequest {
  method: string;
  url: string;
  /** URL 解析后的 pathname */
  path: string;
  /** URL 查询参数（已解析为对象） */
  query: Record<string, string>;
  /** 请求头 */
  headers: Record<string, string>;
  /** 请求体（已 parse，若 content-type 是 JSON） */
  body: unknown;
  /** 原始 body 文本 */
  rawBody: string;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** 路由处理器（params 为路径参数 :id 等） */
export type RouteHandler = (
  req: HttpRequest,
  params?: Record<string, string>,
) => Promise<HttpResponse> | HttpResponse;

/** 已注册路由 */
export interface Route {
  method: string;
  /** 路径模式，支持 :param 占位符 */
  pattern: string;
  handler: RouteHandler;
  /** 是否需要鉴权 */
  auth: boolean;
}

/** Server 插件注册到服务注册表的服务实例 */
export interface ServerInstance {
  /** Bun.serve 返回的实例 */
  readonly raw: Server | unknown;
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  /** 注册额外路由（供其他插件扩展） */
  addRoute(route: Route): void;
  /** 广播 WS 消息到所有连接 */
  broadcastWS(message: unknown): void;
  /** 给指定 session 的 WS 连接发送消息 */
  sendToSession(sessionId: string, message: unknown): void;
  /** 外部 run（MCP 派发 / 自动化）转发 agent 事件到 session 订阅者（高频类型自动合帧） */
  sendAgentEvent(sessionId: string, event: AgentEvent): void;
  /** 注册外部发起的活跃 run（automation 等不经 task.stream 的运行）：
   *  session.subscribe/task.switch 的 running 判定包含该 session；task.abort 可中断 */
  registerExternalRun(sessionId: string, controller: AbortController): void;
  /** 注销外部活跃 run（仅当注册的 controller 仍是当前活跃 run 时移除，防误删用户新 run） */
  unregisterExternalRun(sessionId: string, controller: AbortController): void;
  /**
   * 该会话是否仍有任务在跑（权威运行态：含 task.stream 与外部注册的 run）。
   * 供任务列表 / 会话状态快照给出「刷新后不丢」的运行态。
   */
  isSessionRunning(sessionId: string): boolean;
  /** 注册 WS 消息处理器 */
  onWSMessage(handler: WSMessageHandler): void;
  /** 注入请求门卫（remote 模块用：远程访问开启时拦截非本机请求；server 在 fetch 最前调用） */
  setRequestGuard(guard: RequestGuard): void;
  /**
   * 热重绑：停止当前 HTTP/WS 服务并以相同端口按新 hostname 重新监听。
   * router/wsHandler 等实例全部复用；运行中 agent 任务不受影响（与连接解耦），
   * 前端断连后自动重连。失败时按原 hostname 回滚并抛错。
   */
  rebind(hostname: string): Promise<void>;
  /** 停止服务器 */
  stop(): Promise<void>;
}

/** WS 消息处理器 */
export type WSMessageHandler = (msg: WSMessage) => void | Promise<void>;

/** WS 消息统一格式 */
export interface WSMessage {
  type: string;
  sessionId?: string;
  payload: unknown;
}

// ============================================================================
// 请求门卫（remote 模块注入：远程访问开启时拦截非本机请求）
// ============================================================================

/** 门卫可见的请求上下文（fetch 回调构造，headers 键已小写） */
export interface GuardRequestContext {
  method: string;
  /** 完整 URL（含 query） */
  url: string;
  headers: Record<string, string>;
  /** 客户端 IP（server.requestIP 解析；IPv6-mapped 格式如 ::ffff:127.0.0.1） */
  clientIp: string;
}

/** 门卫直接返回的响应 */
export interface GuardResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 门卫判定结果 */
export type GuardVerdict =
  /** 放行（本机信任 / 远程未启用 / 局域网免密） */
  | { action: 'pass' }
  /** 放行并注入 Authorization 头（远程会话已认证 → API 鉴权层认可，"两者结合"） */
  | { action: 'pass-authenticated'; authorization: string }
  /** 直接返回响应（登录页 / 401 / 403 / 429） */
  | { action: 'respond'; response: GuardResponse }
  /** 登录提交：server 读取 body 后回调 RequestGuard.handleLogin */
  | { action: 'login' };

/** 请求门卫接口（由 remote 模块实现，server 在 fetch 最前调用） */
export interface RequestGuard {
  /** 每个请求（含 WS upgrade）的预检。 */
  precheck(ctx: GuardRequestContext): GuardVerdict;
  /** 处理 POST /remote/login 表单提交（校验密码、种 cookie）。 */
  handleLogin(ctx: GuardRequestContext, body: string): GuardResponse;
  /** WS upgrade 额外校验（返回 false 时 server 拒绝握手）。 */
  checkWS(ctx: GuardRequestContext): boolean;
}

/** WS 连接信息 */
export interface WSConnection {
  id: string;
  sessionId?: string;
  /**
   * 发送消息。返回 Bun 的发送结果：正数 = 字节数；-1 = 已入队但有背压；
   * 0/undefined = 被丢弃或连接不可用（调用方据此做慢客户端保护）。
   */
  send(message: unknown): number | void;
  close(): void;
}
