// src/modules/server/routes/truncate.ts
// 消息撤回（截断）路由：
// GET  /api/sessions/:id/truncate-preview?messageTimestamp=xxx  —— 预览将删除的消息与将回滚的文件变更
// POST /api/sessions/:id/truncate        —— 执行撤回（body: { messageTimestamp, content }）
// POST /api/sessions/:id/truncate-restore —— 恢复最近一次撤回（redo）

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ServiceRegistry } from '../../../core/types';
import type { AgentEngine } from '../../contracts';
import { ErrorCode } from '../../../core/error-codes';

type AgentEngineWithTruncate = AgentEngine & {
  previewTruncate?: (sessionId: string, messageTimestamp: string, content: string) => unknown;
  truncateFrom?: (
    sessionId: string,
    messageTimestamp: string,
    content: string,
    options?: { rollbackFiles?: boolean },
  ) => Promise<unknown>;
  restoreTruncate?: (sessionId: string) => Promise<unknown>;
  /** 「重新生成」重跑起点：最后一条真实用户消息（服务端在完整历史上定位） */
  getLastUserMessage?: (
    sessionId: string,
  ) => { timestamp: string; content: string; attachments?: string[] } | null;
};

function resolveEngine(services: ServiceRegistry): AgentEngineWithTruncate | null {
  return services.tryResolve<AgentEngineWithTruncate>('agent.engine');
}

/** GET /api/sessions/:id/truncate-preview?messageTimestamp=xxx&content=yyy */
export function createTruncatePreviewHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.id;
    if (!sessionId) {
      return { status: 400, body: { error: ErrorCode.SESSION_ID_REQUIRED } };
    }
    const engine = resolveEngine(services);
    if (!engine?.previewTruncate) {
      return { status: 503, body: { error: ErrorCode.AGENT_ENGINE_UNAVAILABLE } };
    }
    // 注意：HttpRequest.url 仅含 pathname（router 构造时 query string 已剥离），
    // 查询参数必须从框架解析好的 req.query 读取（同 filesystem.ts createReadFileHandler 模式）
    const messageTimestamp = (req.query.messageTimestamp ?? '').trim();
    const content = (req.query.content ?? '').trim();
    if (!messageTimestamp && !content) {
      return { status: 400, body: { error: 'messageTimestamp or content is required' } };
    }
    const preview = engine.previewTruncate(sessionId, messageTimestamp, content);
    if (!preview) {
      return { status: 404, body: { error: 'target message not found' } };
    }
    return { status: 200, body: { sessionId, ...preview as object } };
  };
}

/** POST /api/sessions/:id/truncate body: { messageTimestamp, content } */
export function createTruncateHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.id;
    if (!sessionId) {
      return { status: 400, body: { error: ErrorCode.SESSION_ID_REQUIRED } };
    }
    const engine = resolveEngine(services);
    if (!engine?.truncateFrom) {
      return { status: 503, body: { error: ErrorCode.AGENT_ENGINE_UNAVAILABLE } };
    }
    const body = (req.body ?? {}) as { messageTimestamp?: string; content?: string; rollbackFiles?: boolean };
    if (!body.messageTimestamp || typeof body.content !== 'string') {
      return { status: 400, body: { error: 'messageTimestamp and content are required' } };
    }
    const result = await engine.truncateFrom(sessionId, body.messageTimestamp, body.content, {
      // 默认 true（保持既有行为）；前端「重新生成」显式传 false 以跳过文件回滚
      rollbackFiles: body.rollbackFiles !== false,
    });
    if (!result) {
      return { status: 404, body: { error: 'target message not found' } };
    }
    return { status: 200, body: { sessionId, ...result as object } };
  };
}

/** POST /api/sessions/:id/truncate-restore */
export function createTruncateRestoreHandler(services: ServiceRegistry): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.id;
    if (!sessionId) {
      return { status: 400, body: { error: ErrorCode.SESSION_ID_REQUIRED } };
    }
    const engine = resolveEngine(services);
    if (!engine?.restoreTruncate) {
      return { status: 503, body: { error: ErrorCode.AGENT_ENGINE_UNAVAILABLE } };
    }
    const result = await engine.restoreTruncate(sessionId);
    if (!result) {
      return { status: 404, body: { error: 'no truncation to restore' } };
    }
    return { status: 200, body: { sessionId, ...result as object } };
  };
}

/**
 * POST /api/sessions/:id/regenerate-target
 * 「重新生成」的重跑起点：返回**最后一条真实用户消息**（服务端在完整历史上定位）。
 * 前端点「重新生成」时先取此结果，再走既有 truncate → 重发流程——
 * 避免前端只加载最后一页（HISTORY_PAGE_SIZE=30）时在本地找不到 user 消息而静默失败。
 */
export function createRegenerateTargetHandler(services: ServiceRegistry): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.id;
    if (!sessionId) {
      return { status: 400, body: { error: ErrorCode.SESSION_ID_REQUIRED } };
    }
    const engine = resolveEngine(services);
    if (!engine?.getLastUserMessage) {
      return { status: 503, body: { error: ErrorCode.AGENT_ENGINE_UNAVAILABLE } };
    }
    const userMessage = engine.getLastUserMessage(sessionId);
    if (!userMessage) {
      return { status: 404, body: { error: 'no user message to regenerate' } };
    }
    return { status: 200, body: { sessionId, userMessage } };
  };
}
