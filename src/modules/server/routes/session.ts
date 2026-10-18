// src/modules/server/routes/session.ts
// 会话管理路由：GET /api/session（列出）、GET /api/session/:id（历史，支持分页）、
//                GET /api/session/:id/state（状态快照）、DELETE /api/session/:id

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import type { AgentEngine } from '../../contracts';
import type { AskQuestion } from '../../tools/types';
import { ErrorCode } from '../../../core/error-codes';

/** 引擎扩展面（可选能力；未实现时安全降级） */
type AgentEngineExt = AgentEngine & {
  getHistory?: (id: string) => unknown[];
  getHistoryPage?: (
    id: string,
    opts?: { limit?: number; before?: number; after?: number },
  ) => {
    messages: unknown[];
    total: number;
    oldestIndex: number;
    newestIndex: number;
    hasMoreBefore: boolean;
  };
  getLiveDraft?: (id: string) => unknown;
  getActiveSkill?: (id: string) => { name: string; mode: 'system' | 'message'; content: string } | undefined;
  getPermissionMode?: (id: string) => 'ask' | 'auto' | 'skip' | undefined;
  getLastRunStats?: (id: string) => unknown;
  getPendingAsks?: (id: string) => Array<{
    toolCallId: string;
    sessionId: string;
    payload: { questions: AskQuestion[] };
  }>;
  getPendingConfirms?: (id: string) => Array<{
    toolCallId: string;
    sessionId: string;
    question: string;
    ruleSuggestion?: string;
  }>;
};

/** 解析非负整数字符串（非法/缺省返回 undefined） */
function toIndex(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

export function createListSessionsHandler(services: ServiceRegistry): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const agent = services.tryResolve<AgentEngine & { listSessions?: () => unknown[] }>('agent.engine');
    if (!agent?.listSessions) {
      // 503 语义：agent 模块晚于 server 初始化，启动窗口内引擎可能尚未注册。
      // 返回可重试错误而非 200 空列表，避免前端把「未就绪」当成「无会话」而不再重试。
      return { status: 503, body: { error: ErrorCode.AGENT_ENGINE_UNAVAILABLE } };
    }
    return { status: 200, body: { sessions: agent.listSessions() } };
  };
}

export function createDeleteSessionHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.id ?? (req.body as { sessionId?: string } | null)?.sessionId;
    if (!sessionId) {
      return { status: 400, body: { error: ErrorCode.SESSION_ID_REQUIRED } };
    }
    const agent = services.tryResolve<AgentEngine & { deleteSession?: (id: string) => void }>('agent.engine');
    agent?.deleteSession?.(sessionId);
    // 联动清理该会话的持久终端（终端本体在后端进程内存，避免删除会话后残留）
    try {
      const terminals = services.tryResolve<{ disposeSession?: (sid: string) => void }>(ServiceNames.TERMINAL);
      terminals?.disposeSession?.(sessionId);
    } catch {
      // 终端服务未注册：忽略
    }
    return { status: 200, body: { deleted: true, sessionId } };
  };
}

/**
 * 会话历史。
 * - 无分页参数：全量返回（保持旧调用方零改动）
 * - limit：最新 limit 条（首屏）
 * - limit + before：index < before 的区间（上滑加载更早）
 * - limit + after：index > after 的区间（断线/完成后的尾部补齐）
 * 分页时每条消息附带绝对 index，并返回 page 元数据（total / 区间 / 是否还有更早）。
 */
export function createSessionHistoryHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.id;
    if (!sessionId) {
      return { status: 400, body: { error: ErrorCode.SESSION_ID_REQUIRED } };
    }
    const agent = services.tryResolve<AgentEngineExt>('agent.engine');
    if (!agent?.getHistory) {
      // 503 语义：引擎未就绪（启动窗口）→ 可重试错误，避免前端误判为「该会话没有消息」
      return { status: 503, body: { error: ErrorCode.AGENT_ENGINE_UNAVAILABLE } };
    }

    const limit = toIndex(req.query?.limit);
    const before = toIndex(req.query?.before);
    const after = toIndex(req.query?.after);
    const paged = limit !== undefined || before !== undefined || after !== undefined;

    let messages: unknown[];
    let page: unknown;
    if (paged && agent.getHistoryPage) {
      const result = agent.getHistoryPage(sessionId, {
        ...(limit !== undefined ? { limit: limit === 0 ? 1 : limit } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      });
      messages = result.messages;
      page = {
        total: result.total,
        oldestIndex: result.oldestIndex,
        newestIndex: result.newestIndex,
        hasMoreBefore: result.hasMoreBefore,
      };
    } else {
      messages = agent.getHistory(sessionId);
    }

    // 当前激活的 skill 模式（前端刷新后恢复 Badge）
    const activeSkill = agent.getActiveSkill?.(sessionId) ?? undefined;
    // 会话级权限模式（前端刷新后恢复 PermissionModeSelector 徽章）
    const permissionMode = agent.getPermissionMode?.(sessionId) ?? undefined;
    // 最近一次 run 统计（前端刷新后恢复中控台指标栏）
    const lastRunStats = agent.getLastRunStats?.(sessionId) ?? undefined;
    return {
      status: 200,
      body: {
        sessionId,
        messages,
        ...(page ? { page } : {}),
        ...(activeSkill ? { activeSkill } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(lastRunStats ? { lastRunStats } : {}),
      },
    };
  };
}

/**
 * 会话状态快照：刷新 / 重连后一次请求把「不丢状态」所需的信息全部取回。
 * running 为后端权威运行态（含 automation / MCP 等外部注册的 run），
 * liveDraft 为进行中的半截流式回复（含 messageId 与长度，前端据此续接 offset）。
 * 与 WS `session.subscribed` 的 payload 同构，两条恢复路径语义一致。
 */
export function createSessionStateHandler(services: ServiceRegistry): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.id;
    if (!sessionId) {
      return { status: 400, body: { error: ErrorCode.SESSION_ID_REQUIRED } };
    }
    const agent = services.tryResolve<AgentEngineExt>('agent.engine');
    if (!agent) {
      // 503 语义：引擎未就绪（启动窗口）→ 可重试错误。
      // 若返回 200 空快照，前端会把「未就绪」当成「无消息/无运行态」并置 loaded=true，不再重试。
      return { status: 503, body: { error: ErrorCode.AGENT_ENGINE_UNAVAILABLE } };
    }

    let running = false;
    try {
      const server = services.tryResolve<{ isSessionRunning?: (sid: string) => boolean }>(
        ServiceNames.SERVER_INSTANCE,
      );
      running = server?.isSessionRunning?.(sessionId) ?? false;
    } catch {
      running = false;
    }

    let totalMessages = 0;
    let newestIndex = -1;
    try {
      const page = agent?.getHistoryPage?.(sessionId, { limit: 1 });
      totalMessages = page?.total ?? 0;
      newestIndex = page?.newestIndex ?? -1;
    } catch {
      // 会话不存在：空态
    }

    let liveDraft: unknown = null;
    try {
      liveDraft = agent?.getLiveDraft?.(sessionId) ?? null;
    } catch {
      liveDraft = null;
    }

    const pendingAsks = (agent?.getPendingAsks?.(sessionId) ?? []).map((a) => ({
      toolCallId: a.toolCallId,
      sessionId: a.sessionId,
      questions: a.payload.questions,
    }));
    const pendingConfirms = (agent?.getPendingConfirms?.(sessionId) ?? []).map((c) => ({
      toolCallId: c.toolCallId,
      sessionId: c.sessionId,
      question: c.question,
      ruleSuggestion: c.ruleSuggestion,
    }));

    const permissionMode = agent?.getPermissionMode?.(sessionId) ?? undefined;
    const lastRunStats = agent?.getLastRunStats?.(sessionId) ?? undefined;

    return {
      status: 200,
      body: {
        sessionId,
        running,
        totalMessages,
        newestIndex,
        liveDraft,
        pendingAsks,
        pendingConfirms,
        ...(permissionMode ? { permissionMode } : {}),
        ...(lastRunStats ? { lastRunStats } : {}),
      },
    };
  };
}