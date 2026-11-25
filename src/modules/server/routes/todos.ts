// src/modules/server/routes/todos.ts
// GET /api/todos/:sessionId  —— 列出某 session 的 todos（会话级存储）
// PUT /api/todos/:sessionId  —— 整体替换某 session 的 todos

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { Environment } from '../../../core/types';
import {
  getSessionTodoPath,
  readSessionTodoStore,
  writeSessionTodoStore,
  bumpNextId,
  type TodoItem,
  type TodoStatus,
  type TodoPriority,
} from '../../tools/todo/shared/store';
import { ErrorCode } from '../../../core/error-codes';

/** 入参可能缺 id/createdAt/updatedAt，由后端补齐。兼容旧字段 content。 */
interface TodoInput {
  id?: string;
  text: string;
  /** 步骤详细描述（可选，原样透传） */
  describe?: string;
  status: TodoStatus;
  priority: TodoPriority;
  createdAt?: string;
  updatedAt?: string;
}

export function createListTodosHandler(env: Environment): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.sessionId;
    if (!sessionId) {
      return { status: 400, body: { error: ErrorCode.TODOS_SESSION_ID_REQUIRED } };
    }
    const store = readSessionTodoStore(getSessionTodoPath(env, sessionId));
    return { status: 200, body: { sessionId, todos: store.items } };
  };
}

export function createReplaceTodosHandler(env: Environment): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.sessionId;
    if (!sessionId) {
      return { status: 400, body: { error: ErrorCode.TODOS_SESSION_ID_REQUIRED } };
    }
    const body = (req.body ?? {}) as { todos?: TodoInput[] };
    if (!Array.isArray(body.todos)) {
      return { status: 400, body: { error: ErrorCode.TODOS_MUST_BE_ARRAY } };
    }

    const storePath = getSessionTodoPath(env, sessionId);
    const store = readSessionTodoStore(storePath);

    // 整体替换该会话的 todos，补齐 id/时间戳
    const now = new Date().toISOString();
    const newItems: TodoItem[] = body.todos.map((t, idx) => {
      const describe = typeof t.describe === 'string' ? t.describe.trim() : '';
      return {
        id: t.id ?? String(store.nextId + idx),
        text: t.text,
        ...(describe ? { describe } : {}),
        status: t.status,
        priority: t.priority,
        createdAt: t.createdAt ?? now,
        updatedAt: t.updatedAt ?? now,
      };
    });

    store.items = newItems;
    bumpNextId(store);
    writeSessionTodoStore(storePath, store);

    return { status: 200, body: { sessionId, todos: newItems } };
  };
}
