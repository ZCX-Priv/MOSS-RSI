// webui/src/lib/task-steps.ts
// 任务步骤分组（纯函数，无 React 依赖）。
//
// 两类节点：
// - todo：某个待办成为 in_progress 后，到它完成/阻塞/被替换/切换待办/遇到用户消息为止；
//   节点内含该步的思考、工具调用与模型正文（正文在标准/详细挡位始终可见）。
// - ops：无 todo 时，连续「无正文」的 assistant 消息（只有思考/工具）折叠成一个操作节点；
//   一旦出现正文，结束当前节点，正文独立显示，后续重新开始新节点。
//
// 统计只读 toolCalls[].name，不解析参数 JSON（长会话流式期间保持 O(n) 轻量）。

import type { TaskMessage, TodoItem } from '../types/api';
import { stripInjectBlock } from './inject-block';
import { isEmptyAssistantPlaceholder } from './reply-end';

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface StepOpStats {
  created: number;
  edited: number;
  read: number;
  searched: number;
  commands: number;
  asked: number;
  subagents: number;
  browser: number;
  computer: number;
  mcp: number;
  code: number;
  docs: number;
  other: number;
}

export interface TaskStep {
  /** `step:<首条消息 id>`（虚拟列表稳定 key） */
  key: string;
  kind: 'todo' | 'ops';
  /** todo 节点 = 待办文本；ops 节点为空（标题由统计在渲染层生成） */
  title: string;
  describe?: string;
  status: StepStatus;
  todoId?: string;
  /** 节点内最新的 todo 快照（用于展开时展示状态） */
  snapshot: TodoItem[];
  children: TaskMessage[];
  stats: StepOpStats;
  /** 是否存在思考内容（ops 节点无工具时标题回退「思考过程」） */
  hasThinking: boolean;
  /** 触发本节点的消息 id */
  anchorId: string;
}

export type ChatListItem =
  | { kind: 'message'; key: string; message: TaskMessage }
  | { kind: 'step'; key: string; step: TaskStep };

function emptyStats(): StepOpStats {
  return {
    created: 0,
    edited: 0,
    read: 0,
    searched: 0,
    commands: 0,
    asked: 0,
    subagents: 0,
    browser: 0,
    computer: 0,
    mcp: 0,
    code: 0,
    docs: 0,
    other: 0,
  };
}

/** 正文可见性缓存：流式期间只有尾部消息对象变化，旧消息不重复执行 stripInjectBlock */
const visibleContentCache = new WeakMap<TaskMessage, boolean>();

/** 助手消息是否有可见正文（剥离 LLM 可见/UI 不可见的注入块） */
export function hasVisibleContent(message: TaskMessage): boolean {
  if (message.role !== 'assistant') return false;
  const cached = visibleContentCache.get(message);
  if (cached !== undefined) return cached;
  const value = stripInjectBlock(message.content ?? '').trim().length > 0;
  visibleContentCache.set(message, value);
  return value;
}

/** 系统卡片 / 错误卡：不属于任何步骤节点，独立渲染 */
function isStandaloneCard(message: TaskMessage): boolean {
  return !!(
    message.isError ||
    message.compaction ||
    message.maxTurnsNotice ||
    message.outputLimitNotice ||
    message.interrupted
  );
}

/** 统计一条消息内的工具调用（todo 由节点自身代表，不计入） */
function countToolCalls(stats: StepOpStats, message: TaskMessage): void {
  for (const call of message.toolCalls ?? []) {
    const name = call.name;
    if (name === 'todo') continue;
    switch (name) {
      case 'write':
        stats.created += 1;
        break;
      case 'edit':
        stats.edited += 1;
        break;
      case 'read':
        stats.read += 1;
        break;
      case 'grep':
      case 'glob':
        stats.searched += 1;
        break;
      case 'terminal':
        stats.commands += 1;
        break;
      case 'ask':
        stats.asked += 1;
        break;
      case 'agent':
        stats.subagents += 1;
        break;
      case 'browser':
        stats.browser += 1;
        break;
      case 'computer':
        stats.computer += 1;
        break;
      case 'run_code':
        stats.code += 1;
        break;
      case 'documents':
        stats.docs += 1;
        break;
      default:
        if (name === 'mcp' || name.startsWith('mcp__')) stats.mcp += 1;
        else stats.other += 1;
        break;
    }
  }
}

/** 当前 todo 快照中的 in_progress 项 */
function inProgress(snapshot: TodoItem[]): TodoItem | null {
  return snapshot.find((item) => item.status === 'in_progress') ?? null;
}

/** 节点内是否仍有进行中的动作（流式正文/思考或未拿到结果的工具调用） */
function isStepRunning(step: TaskStep): boolean {
  return step.children.some((message) => {
    if (message.streaming || message.thinkingStreaming) return true;
    const resultIds = new Set((message.toolResults ?? []).map((entry) => entry.toolCallId));
    return (message.toolCalls ?? []).some(
      (call) =>
        (call.status === 'generating' || call.status === 'executing') && !resultIds.has(call.id),
    );
  });
}

/**
 * 消息列表 → 虚拟列表项（消息 / 步骤节点）。
 * 分组只依赖消息顺序与 todoSnapshot，可在流式期间反复调用。
 */
export function buildChatItems(messages: readonly TaskMessage[]): ChatListItem[] {
  const items: ChatListItem[] = [];
  let snapshot: TodoItem[] = [];
  let activeTodo: TodoItem | null = null;
  let current: TaskStep | null = null;

  const closeStep = (boundary = false): void => {
    if (!current) return;
    // todo 节点允许没有子消息（仅标题 + describe）；ops 节点必须有内容才有意义
    if (current.kind === 'todo' || current.children.length > 0) {
      if (current.kind === 'ops') {
        // 边界关闭（出现正文/用户消息/系统卡）视为该段结束；列表末尾则按真实工具状态判断转圈
        current.status = boundary || !isStepRunning(current) ? 'completed' : 'in_progress';
      }
      items.push({ kind: 'step', key: current.key, step: current });
    }
    current = null;
  };

  const openStep = (message: TaskMessage, kind: 'todo' | 'ops', todo: TodoItem | null): TaskStep => {
    const step: TaskStep = {
      key: `step:${message.id}`,
      kind,
      title: todo?.text ?? '',
      ...(todo?.describe ? { describe: todo.describe } : {}),
      status: todo?.status ?? 'in_progress',
      ...(todo ? { todoId: todo.id } : {}),
      snapshot,
      children: [],
      stats: emptyStats(),
      hasThinking: false,
      anchorId: message.id,
    };
    return step;
  };

  const append = (step: TaskStep, message: TaskMessage): void => {
    step.children.push(message);
    if ((message.thinking ?? '').trim().length > 0) step.hasThinking = true;
    countToolCalls(step.stats, message);
  };

  for (const message of messages) {
    // 用户消息：结束节点并重置 todo 归属（清单本身仍持久化）
    if (message.role === 'user') {
      closeStep(true);
      snapshot = [];
      activeTodo = null;
      items.push({ kind: 'message', key: message.id, message });
      continue;
    }

    // 系统卡片 / 错误卡 / 中断占位：结束节点，独立渲染
    if (message.role !== 'assistant' || isStandaloneCard(message)) {
      if (message.role === 'tool') continue; // 适配层已合并，防御
      closeStep(true);
      items.push({ kind: 'message', key: message.id, message });
      continue;
    }

    // 空 assistant 占位（无正文/思考/工具）：跳过，不产生空节点
    if (isEmptyAssistantPlaceholder(message)) continue;

    const hasContent = hasVisibleContent(message);
    const hasThinking = (message.thinking ?? '').trim().length > 0;
    const hasOtherTools =
      message.toolCalls?.some((call) => call.name !== 'todo') ?? false;

    // 1) todo 快照变化：关闭已完成/被替换的节点，必要时开启新的 todo 节点。
    // 快照也可能来自 run_code 内嵌套的 todo（外挂在外层消息上），因此不要求存在直接 todo 调用。
    if (message.todoSnapshot !== undefined) {
      snapshot = message.todoSnapshot;
      const nextActive = inProgress(snapshot);
      if (current && current.kind === 'todo') {
        // 先用最新快照刷新旧节点的最终状态（完成/阻塞），再决定是否关闭
        const step = current;
        const previous = step.todoId
          ? snapshot.find((item) => item.id === step.todoId)
          : undefined;
        if (previous) {
          step.title = previous.text;
          if (previous.describe) step.describe = previous.describe;
          else delete step.describe;
          step.status = previous.status;
        }
        step.snapshot = snapshot;
        if (step.todoId !== nextActive?.id) closeStep(true);
      } else if (current && current.kind === 'ops' && nextActive) {
        // 当前是纯操作节点，待办开始：先结束操作节点，让新的 todo 节点接管
        closeStep(true);
      }
      activeTodo = nextActive;
      if (activeTodo) {
        if (!current) current = openStep(message, 'todo', activeTodo);
        else if (current.kind === 'todo') {
          current.title = activeTodo.text;
          if (activeTodo.describe) current.describe = activeTodo.describe;
          else delete current.describe;
          current.status = activeTodo.status;
          current.snapshot = snapshot;
        }
      }
    }

    // 2) 归属当前节点
    if (current) {
      // 只有 todo 调用的边界消息没有可渲染内容（工具行不显示 todo），不入子列表
      if (!hasContent && !hasThinking && !hasOtherTools) continue;
      if (current.kind === 'ops' && hasContent) {
        // 出现正文：结束折叠节点，正文独立显示（后续重新开始节点）
        closeStep(true);
        items.push({ kind: 'message', key: message.id, message });
        continue;
      }
      append(current, message);
      continue;
    }

    // 3) 无当前节点：正文独立显示；只有思考/工具则开启 ops 节点
    if (hasContent) {
      items.push({ kind: 'message', key: message.id, message });
      continue;
    }
    if (!hasThinking && !hasOtherTools) continue; // 纯空消息（含仅 todo 调用且无 in_progress）
    current = openStep(message, 'ops', null);
    append(current, message);
  }

  closeStep();
  return items;
}
