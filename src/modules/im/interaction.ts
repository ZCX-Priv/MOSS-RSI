// src/modules/im/interaction.ts
// IM 交互协议：把 Agent 的权限询问 / ask 提问 / 工具确认 / Todo 清单渲染成可读消息，
// 并解析用户回复的数字序号（1/2/3…）。纯逻辑，便于单测。

import { t } from '../../core/i18n';
import type { AskAnswer, AskQuestion } from '../tools/types';
import type { TodoItem, TodoStatus } from '../tools/todo/shared/store';
import type { ImInboundMessage } from './types';

/** 待应答交互（按 botId:conversationKey 排队，保证同一聊天的提问串行） */
export type PendingInteraction =
  | { kind: 'permission'; task: ImInboundMessage }
  | {
      kind: 'ask';
      sessionId: string;
      toolCallId: string;
      questions: AskQuestion[];
      index: number;
      answers: AskAnswer[];
    }
  | { kind: 'confirm'; sessionId: string; toolCallId: string };

export class InteractionManager {
  private readonly queues = new Map<string, PendingInteraction[]>();

  enqueue(key: string, item: PendingInteraction): void {
    const queue = this.queues.get(key) ?? [];
    if (item.kind === 'permission') {
      // 未选择权限时又发来新任务：只保留最新任务，避免堆积
      this.queues.set(key, [...queue.filter(entry => entry.kind !== 'permission'), item]);
      return;
    }
    const toolCallId = 'toolCallId' in item ? item.toolCallId : '';
    const existing = queue.findIndex(
      entry => (entry.kind === 'ask' || entry.kind === 'confirm') && entry.toolCallId === toolCallId,
    );
    if (existing >= 0) queue.splice(existing, 1, item);
    else queue.push(item);
    this.queues.set(key, queue);
  }

  peek(key: string): PendingInteraction | null {
    return this.queues.get(key)?.[0] ?? null;
  }

  shift(key: string): void {
    const queue = this.queues.get(key);
    if (!queue) return;
    queue.shift();
    if (queue.length === 0) this.queues.delete(key);
  }

  /** 按 toolCallId 移除（超时/取消时清理） */
  removeByToolCall(key: string, toolCallId: string): PendingInteraction | null {
    const queue = this.queues.get(key);
    if (!queue) return null;
    const index = queue.findIndex(
      entry => (entry.kind === 'ask' || entry.kind === 'confirm') && entry.toolCallId === toolCallId,
    );
    if (index < 0) return null;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(key);
    return removed ?? null;
  }

  clear(key: string): void {
    this.queues.delete(key);
  }
}

/**
 * 数字选择解析：支持 `4` 与 `[4]` 两种写法（多选可 `[1],[3]` 或 `1,3`）。
 * 返回选项序号（从 1 开始）、'cancel' 或 null（含非序号内容/越界 → 交给「其他」逻辑）。
 */
export function parseChoice(
  text: string,
  count: number,
  mode: 'single' | 'multi',
): number[] | 'cancel' | null {
  const source = text.trim();
  if (!source) return null;
  if (/^(0|取消|取消提问|cancel)$/i.test(source)) return 'cancel';
  const tokens = source.split(/[,，、\s]+/).filter(Boolean);
  const numbers: number[] = [];
  for (const token of tokens) {
    // 只接受「纯数字」或「[数字]」；夹带其他文字时整条消息不是选项选择
    const match = /^\[?\s*(\d+)\s*\]?$/.exec(token);
    if (!match) return null;
    const value = Number(match[1]);
    if (value < 1 || value > count) return null;
    numbers.push(value);
  }
  if (numbers.length === 0) return null;
  if (mode === 'single') return [numbers[0]!];
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** 表单回答解析：每行 `字段=值`；无法解析返回 null */
export function parseFormAnswer(text: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const index = line.indexOf('=');
    if (index <= 0) return null;
    const key = line.slice(0, index).trim();
    if (!key) return null;
    result[key] = line.slice(index + 1).trim();
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** 首次权限选择菜单 */
export function renderPermissionMenu(): string {
  return t('im.interaction.permissionMenu');
}

/** 选择题目标题 + 选项 + 回复提示 */
export function renderAskQuestion(question: AskQuestion, index: number, total: number): string {
  const head = t('im.interaction.askHead', { index: index + 1, total, question: question.question });
  const type = question.answerType ?? 'text';
  if (type === 'text') return `${head}\n${t('im.interaction.askTextHint')}`;
  if (type === 'form') return `${head}\n${t('im.interaction.askFormHint')}`;

  if (type === 'boolean') {
    return [
      head,
      `[1] ${t('im.interaction.yes')}`,
      `[2] ${t('im.interaction.no')}`,
      t('im.interaction.askSingleHint'),
    ].join('\n');
  }

  const options = question.options ?? [];
  const lines = options.map((option, i) => {
    const suffix = option.description ? `（${option.description}）` : '';
    return `[${i + 1}] ${option.label}${suffix}`;
  });
  const hint = type === 'multi' ? t('im.interaction.askMultiHint') : t('im.interaction.askSingleHint');
  // 「其他」不占序号：用户直接发送文字即作为 otherText
  return [head, ...lines, t('im.interaction.askOtherOption'), hint].join('\n');
}

/** 工具执行确认 */
export function renderConfirm(toolName: string, question: string): string {
  return [
    t('im.interaction.confirmHead', { tool: toolName, question }),
    `[1] ${t('im.interaction.confirmAllow')}`,
    `[2] ${t('im.interaction.confirmDeny')}`,
    `[3] ${t('im.interaction.confirmAlways')}`,
  ].join('\n');
}

const TODO_STATUS_LABEL: Record<TodoStatus, string> = {
  pending: 'im.interaction.todoPending',
  in_progress: 'im.interaction.todoInProgress',
  completed: 'im.interaction.todoCompleted',
};

/** Todo 清单（空清单返回空串） */
export function renderTodoList(items: readonly TodoItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map(
    (item, index) => `${index + 1}. [${t(TODO_STATUS_LABEL[item.status])}] ${item.text}`,
  );
  return [`📋 ${t('im.interaction.todoTitle')}`, ...lines].join('\n');
}

/** Todo 去重签名（id:status 序列） */
export function todoSignature(items: readonly TodoItem[]): string {
  return items.map(item => `${item.id}:${item.status}`).join('|');
}
