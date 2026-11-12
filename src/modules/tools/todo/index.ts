// tools/todo/index.ts
// todo 工具 execute 逻辑：会话级待办管理（create[append/replace]/update/list/reorder/batch_update），
// 持久化到 ~/.moss/todo/<sessionId>.json（每会话一文件）。
// create 双模式：mode=append（默认）新建一条；mode=replace 用 items 全量覆盖清单（至少 1 条）。
// 工厂模式：需要 env 以定位持久化路径。
// 持久化函数位于 ./shared/store.ts，被 server 路由和 agent 引擎复用。
// 元数据见同目录 tool.json。

import { t } from '../../../core/i18n';
import type { Environment } from '../../../core/types';
import type { ToolContext, ToolResult } from '../types';
import {
  readSessionTodoStore,
  writeSessionTodoStore,
  getSessionTodoPath,
  bumpNextId,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from './shared/store';

interface TodoUpdatePatch {
  id: string;
  text?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
}

/** create mode=replace 的单条入参：id 可选（保留原条目身份），其余可选字段由后端补齐 */
interface TodoReplaceInput {
  id?: string;
  text: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * 清单摘要：每次变更后回传完整清单与当前/下一个待办。
 * 目的：让模型始终看见自己的进度，强化「一次只推进一项」。
 */
function formatTodoSummary(items: TodoItem[]): string {
  const mark: Record<TodoStatus, string> = {
    completed: '[x]',
    in_progress: '[>]',
    pending: '[ ]',
    blocked: '[!]',
  };
  const lines = items.map((it) => `${mark[it.status]} #${it.id} ${it.text}`);
  const current = items.find((it) => it.status === 'in_progress');
  const next = items.find((it) => it.status === 'pending');
  return [
    ...lines,
    current ? `当前进行中：#${current.id} ${current.text}` : '当前没有 in_progress 项',
    next ? `下一个待办：#${next.id} ${next.text}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export default function createExecute(env: Environment) {
  return {
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const p = params as {
        action: 'create' | 'update' | 'list' | 'reorder' | 'batch_update';
        mode?: 'append' | 'replace';
        text?: string;
        priority?: TodoPriority;
        id?: string;
        status?: TodoStatus;
        items?: TodoReplaceInput[];
        orderedIds?: string[];
        updates?: TodoUpdatePatch[];
      };

      if (!ctx.sessionId) {
        return { content: [{ type: 'text', text: `Error: ${t('tools.todoSessionIdRequired')}` }], isError: true };
      }
      const storePath = getSessionTodoPath(env, ctx.sessionId);
      const store = readSessionTodoStore(storePath);

      const persist = (): void => {
        bumpNextId(store);
        writeSessionTodoStore(storePath, store);
      };

      switch (p.action) {
        case 'create': {
          const mode = p.mode ?? 'append';

          // 覆盖模式：items 全量替换现有清单（禁止空数组）
          if (mode === 'replace') {
            if (!Array.isArray(p.items) || p.items.length === 0) {
              return { content: [{ type: 'text', text: `Error: ${t('tools.todoReplaceItemsRequired')}` }], isError: true };
            }
            const invalid = p.items
              .map((it, idx) => ({ idx, it }))
              .filter(({ it }) => typeof it?.text !== 'string' || it.text.trim() === '')
              .map(({ idx }) => idx);
            if (invalid.length > 0) {
              return { content: [{ type: 'text', text: `Error: ${t('tools.todoItemsMissingText', { indexes: invalid.join(', ') })}` }], isError: true };
            }
            const now = new Date().toISOString();
            // id 分配：保留传入 id；无 id 项从 nextId 起跳过已占用 id 递增分配（防撞号）
            const usedIds = new Set(p.items.filter(it => it.id).map(it => it.id as string));
            let next = store.nextId;
            const newItems: TodoItem[] = p.items.map((it) => {
              let id = it.id;
              if (!id) {
                while (usedIds.has(String(next))) next += 1;
                id = String(next);
                usedIds.add(id);
                next += 1;
              }
              return {
                id,
                text: it.text,
                status: it.status ?? 'pending',
                priority: it.priority ?? 'medium',
                createdAt: it.createdAt ?? now,
                updatedAt: it.updatedAt ?? now,
              };
            });
            store.items = newItems;
            persist();
            return {
              content: [{
                type: 'text',
                text: `${t('tools.todoReplaced', { count: newItems.length })}:\n${JSON.stringify(newItems, null, 2)}\n\n${formatTodoSummary(newItems)}`,
              }],
              metadata: { action: 'create', mode: 'replace', count: newItems.length },
            };
          }

          // 新建模式（默认）：追加一条
          if (!p.text || typeof p.text !== 'string' || p.text.trim() === '') {
            return { content: [{ type: 'text', text: `Error: ${t('tools.todoTextRequired')}` }], isError: true };
          }
          const now = new Date().toISOString();
          const item: TodoItem = {
            id: String(store.nextId),
            text: p.text,
            status: 'pending',
            priority: p.priority ?? 'medium',
            createdAt: now,
            updatedAt: now,
          };
          store.items.push(item);
          store.nextId += 1;
          persist();
          return {
            content: [{
              type: 'text',
              text: `${t('tools.todoCreated', { id: item.id })}:\n${JSON.stringify(item, null, 2)}\n\n${formatTodoSummary(store.items)}`,
            }],
            metadata: { action: 'create', mode: 'append', id: item.id },
          };
        }

        case 'update': {
          if (!p.id) {
            return { content: [{ type: 'text', text: `Error: ${t('tools.todoIdRequired')}` }], isError: true };
          }
          const item = store.items.find(it => it.id === p.id);
          if (!item) {
            return { content: [{ type: 'text', text: `Error: ${t('tools.todoNotFound', { id: p.id })}` }], isError: true };
          }
          if (p.text !== undefined) item.text = p.text;
          if (p.status !== undefined) item.status = p.status;
          if (p.priority !== undefined) item.priority = p.priority;
          item.updatedAt = new Date().toISOString();
          persist();
          return {
            content: [{
              type: 'text',
              text: `${t('tools.todoUpdated', { id: item.id })}:\n${JSON.stringify(item, null, 2)}\n\n${formatTodoSummary(store.items)}`,
            }],
            metadata: { action: 'update', id: item.id },
          };
        }

        case 'list': {
          const todos = store.items.map(it => ({ id: it.id, text: it.text, status: it.status, priority: it.priority }));
          return {
            content: [{ type: 'text', text: todos.length === 0 ? t('tools.todoEmpty') : `${t('tools.todoListHeader', { count: todos.length })}:\n${JSON.stringify(todos, null, 2)}` }],
            metadata: { action: 'list', count: todos.length },
          };
        }

        case 'reorder': {
          if (!Array.isArray(p.orderedIds) || p.orderedIds.length === 0) {
            return { content: [{ type: 'text', text: `Error: ${t('tools.todoOrderedIdsRequired')}` }], isError: true };
          }
          const currentIds = new Set(store.items.map(it => it.id));
          const incoming = new Set(p.orderedIds);
          if (p.orderedIds.length !== store.items.length || p.orderedIds.some(id => !currentIds.has(id)) || [...currentIds].some(id => !incoming.has(id))) {
            return { content: [{ type: 'text', text: `Error: ${t('tools.todoOrderedIdsMismatch', { ids: [...currentIds].join(', ') })}` }], isError: true };
          }
          const byId = new Map(store.items.map(it => [it.id, it]));
          store.items = p.orderedIds.map(id => byId.get(id)!);
          persist();
          return {
            content: [{ type: 'text', text: t('tools.todoReordered', { order: store.items.map(it => `${it.id}(${it.text})`).join(' -> ') }) }],
            metadata: { action: 'reorder', count: store.items.length },
          };
        }

        case 'batch_update': {
          const updates = p.updates;
          if (!Array.isArray(updates) || updates.length === 0) {
            return { content: [{ type: 'text', text: `Error: ${t('tools.todoUpdatesRequired')}` }], isError: true };
          }
          // 预校验全通过才写入（原子语义）：任一 id 不存在则整体报错
          const missing = updates.filter(u => !u.id || !store.items.some(it => it.id === u.id));
          if (missing.length > 0) {
            return { content: [{ type: 'text', text: `Error: ${t('tools.todoBatchNotFound', { ids: missing.map(u => u.id).join(', ') })}` }], isError: true };
          }
          const now = new Date().toISOString();
          const updateIds = new Set(updates.map(u => u.id));
          for (const u of updates) {
            const item = store.items.find(it => it.id === u.id)!;
            if (u.text !== undefined) item.text = u.text;
            if (u.status !== undefined) item.status = u.status;
            if (u.priority !== undefined) item.priority = u.priority;
            item.updatedAt = now;
          }
          persist();
          return {
            content: [{
              type: 'text',
              text: `${t('tools.todoBatchUpdated', { count: updates.length })}:\n${JSON.stringify(store.items.filter(it => updateIds.has(it.id)), null, 2)}\n\n${formatTodoSummary(store.items)}`,
            }],
            metadata: { action: 'batch_update', count: updates.length },
          };
        }

        default:
          return { content: [{ type: 'text', text: `Error: ${t('tools.todoUnknownAction', { action: String(p.action) })}` }], isError: true };
      }
    },
  };
}
