// tools/todo/shared/store.ts
// Todo 会话级持久化层：读写 ~/.moss/todo/<sessionId>.json（每会话一文件）。
// 原子写（atomicWriteFile）保证中断不损坏；旧全局 todos.json 不迁移不读取。
// 被 tools/todo/index.ts（工具执行）、server 路由（todos.ts / tasks.ts）、
// agent 引擎（notifyToolSideEffects）三方复用。

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Environment } from '../../../../core/types';
import { atomicWriteFile } from '../../../../utils/fs-atomic';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type TodoPriority = 'low' | 'medium' | 'high';

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  priority: TodoPriority;
  createdAt: string;
  updatedAt: string;
}

export interface TodoStore {
  nextId: number;
  items: TodoItem[];
}

const DEFAULT_STORE: TodoStore = { nextId: 1, items: [] };

/** todo 存储根目录（~/.moss/todo/） */
export function getTodoDir(env: Environment): string {
  return join(env.dataDir, 'todo');
}

/** 按数据目录拼会话 todo 路径（IM 等无 Environment 的调用方复用同一清洗规则）。 */
export function getSessionTodoPathFromDir(dataDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
  return join(dataDir, 'todo', `${safe}.json`);
}

/** 某会话的 todo 文件路径（~/.moss/todo/<sessionId>.json）。sessionId 做路径安全清洗。 */
export function getSessionTodoPath(env: Environment, sessionId: string): string {
  return getSessionTodoPathFromDir(env.dataDir, sessionId);
}

/**
 * 读取某会话的 todo 存储。文件不存在或损坏时返回空状态。
 * 兼容旧数据：content 字段映射为 text；sessionId 字段忽略（文件名即会话）。
 */
export function readSessionTodoStore(path: string): TodoStore {
  try {
    if (!existsSync(path)) return { ...DEFAULT_STORE, items: [] };
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TodoStore> & { items?: Array<Record<string, unknown>> };
    if (typeof parsed.nextId !== 'number' || !Array.isArray(parsed.items)) {
      return { ...DEFAULT_STORE, items: [] };
    }
    const items = (parsed.items as Array<Record<string, unknown>>).map((it) => {
      if (it.text === undefined && typeof it.content === 'string') {
        it.text = it.content;
        delete it.content;
      }
      delete it.sessionId;
      return it as unknown as TodoItem;
    });
    return { nextId: parsed.nextId, items };
  } catch {
    return { ...DEFAULT_STORE, items: [] };
  }
}

/** 原子写入某会话的 todo 存储（tmp + fsync + rename，中断不损坏）。 */
export function writeSessionTodoStore(path: string, store: TodoStore): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, JSON.stringify(store, null, 2), { fsync: true });
}

/**
 * 重算 nextId：取 items 中最大数字 id + 1（至少不低于当前 nextId）。
 * 消除 PUT 整体替换后 nextId 不前进导致的 id 复用隐患。
 */
export function bumpNextId(store: TodoStore): void {
  let max = store.nextId - 1;
  for (const it of store.items) {
    const n = parseInt(it.id, 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  store.nextId = max + 1;
}
