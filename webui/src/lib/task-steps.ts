// webui/src/lib/task-steps.ts
// 对话流渲染块分组（纯函数，无 React 依赖）。
//
// 渲染单元：
// - body：助手可见正文，永远完整显示，不参与过程折叠；
// - run：连续的「思考 / 工具」片段，跨消息合并；正文或新的 todo 头出现即断开；
// - todo：待办步骤头（静态状态行，不折叠）；
// - round：简洁挡的一轮回复折叠节点（用户消息之间）；
// - message：用户消息 / 系统卡 / 错误卡 / 中断卡。
//
// 统计只读 toolCalls[].name，不解析参数 JSON（长会话流式期间保持 O(n) 轻量）。

import type { TaskMessage, TodoItem } from '../types/api';
import type { StepDisplayLevel } from '../store';
import { stripInjectBlock } from './inject-block';
import { computeReplyEnds, isEmptyAssistantPlaceholder } from './reply-end';

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

/** 待办步骤内的内容块：正文或连续过程段 */
export type TodoBlock =
  | { kind: 'body'; key: string; message: TaskMessage }
  | { kind: 'run'; key: string; run: ProcessRun }
  | { kind: 'todoCard'; key: string; todos: TodoItem[] };

/**
 * 待办步骤（可折叠容器）：
 * 从该 todo 进入执行状态开始，到它完成/阻塞（或被下一个 todo / 用户消息打断）为止，
 * 其间所有内容（正文 + 过程段）都收在 blocks 里；完成时整段折叠进折叠行。
 */
export interface TodoStep {
  /** `todo:<todoId>`（虚拟列表稳定 key） */
  key: string;
  todoId: string;
  title: string;
  status: StepStatus;
  blocks: TodoBlock[];
}

/** 一段连续过程里的一个片段：同一条消息的「思考部分」或「工具部分」 */
export interface ProcessPart {
  message: TaskMessage;
  part: 'thinking' | 'tools';
}

/** 连续过程段：跨消息合并的 think / tool 序列 */
export interface ProcessRun {
  /** `run:<稳定 foldId>`（由 FoldKeyStore 分配，跨 prepend/append 不变） */
  key: string;
  parts: ProcessPart[];
  stats: StepOpStats;
  hasThinking: boolean;
  /** 段内仍有进行中的思考片段或未返回结果的工具调用（正文是否仍在流式不影响） */
  running: boolean;
}

/** 简洁挡一轮内的渲染块（消息 / todo 进度卡） */
export type CompactBlock =
  | { kind: 'message'; key: string; message: TaskMessage }
  | { kind: 'todoCard'; key: string; todos: TodoItem[] };

/**
 * 简洁挡的折叠单位：一轮回复（相邻用户消息之间）。
 * 收起时只显示「灰色摘要行 + 该轮真正的最终正文」，展开时按时间顺序显示整轮。
 */
export interface CompactRound {
  /** `round:<稳定 foldId>`（跨 prepend/append 不变） */
  key: string;
  /** 触发本轮的第一条 assistant 消息 id */
  anchorId: string;
  /** 该轮参与展示的 assistant 消息（跳过空占位 / 仅 todo 调用的消息） */
  messages: TaskMessage[];
  /** 该轮按顺序渲染的块（消息 + todo 进度卡） */
  blocks: CompactBlock[];
  /** 真正的最终正文：仅当该轮最后一条消息有正文且无工具时才有 */
  finalBodyId?: string;
  /** 整轮工具统计（含最终正文消息自身的工具） */
  stats: StepOpStats;
  /** 整轮是否存在思考 */
  hasThinking: boolean;
  /** 是否存在被折叠进摘要行的内容（决定是否渲染摘要行） */
  hasFold: boolean;
  /** 是否仍在生成中 */
  running: boolean;
}

export type ChatListItem =
  | { kind: 'message'; key: string; message: TaskMessage }
  | { kind: 'todo'; key: string; todo: TodoStep }
  | { kind: 'todoCard'; key: string; todos: TodoItem[] }
  | { kind: 'body'; key: string; message: TaskMessage }
  | { kind: 'run'; key: string; run: ProcessRun }
  | { kind: 'round'; key: string; round: CompactRound }
  /** 一段回复的结尾操作栏：永远排在整段回复的所有折叠行之后 */
  | { kind: 'replyFooter'; key: string; message: TaskMessage };

/**
 * 折叠行稳定身份注册表（可跨 rebuild 复用，按会话持有）。
 *
 * 为什么需要：折叠行的 key 原先取「段内首条消息 id」。上滑 prepend 更早一页时，
 * 新的工具消息可能被向后吸收进已加载的首个 run/round → 首条消息 id 变化 → 虚拟列表
 * 换 key 重挂载，usePersistentState 按新 key 查不到旧的展开状态 → 用户展开的行被收起。
 *
 * 规则：片段身份 → foldId。一个折叠单元只要包含任一已登记片段，就沿用它的 foldId；
 * 全新单元才分配新的 `f<n>`。片段只登记一次，因此向前/向后合并都不会改变身份。
 */
export interface FoldKeyStore {
  /** 片段身份（`m:<messageId>:thinking|tools` / `r:<messageId>`）→ foldId */
  parts: Map<string, string>;
  seq: number;
}

export function createFoldKeyStore(): FoldKeyStore {
  return { parts: new Map(), seq: 0 };
}

/** 片段身份：同一消息的思考/工具是两个可独立存在的片段 */
function runPartKey(messageId: string, part: 'thinking' | 'tools'): string {
  return `m:${messageId}:${part}`;
}

/** 解析折叠单元的稳定 id：沿用任一已登记片段的 id，否则新建并把本单元片段全部登记 */
function resolveFoldId(store: FoldKeyStore, partKeys: readonly string[]): string {
  let foldId: string | null = null;
  for (const key of partKeys) {
    const existing = store.parts.get(key);
    if (existing) {
      foldId = existing;
      break;
    }
  }
  if (!foldId) foldId = `f${store.seq++}`;
  for (const key of partKeys) {
    if (!store.parts.has(key)) store.parts.set(key, foldId);
  }
  return foldId;
}

/** 统计是否包含任何条目 */
export function hasStats(stats: StepOpStats): boolean {
  return Object.values(stats).some((value) => value > 0);
}

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

/** 是否有思考内容 */
function hasThinkingContent(message: TaskMessage): boolean {
  return (message.thinking ?? '').trim().length > 0;
}

/** 是否存在需要展示的工具调用（todo 由折叠行 / 进度卡代表，不计入过程段） */
function hasNonTodoTools(message: TaskMessage): boolean {
  return message.toolCalls?.some((call) => call.name !== 'todo') ?? false;
}

/** 系统卡片 / 错误卡：不属于任何步骤，独立渲染 */
function isStandaloneCard(message: TaskMessage): boolean {
  return !!(
    message.isError ||
    message.compaction ||
    message.maxTurnsNotice ||
    message.outputLimitNotice ||
    message.interrupted
  );
}

/** 统计一条消息内的工具调用（todo 由步骤头代表，不计入） */
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

/**
 * 一组消息是否仍有进行中的动作（整轮维度）：
 * 用于简洁挡 round 摘要行——它代表「这一轮回复是否仍在生成」，正文流式也算进行中。
 */
function isMessagesRunning(messages: readonly TaskMessage[]): boolean {
  return messages.some((message) => {
    if (message.streaming || message.thinkingStreaming) return true;
    const resultIds = new Set((message.toolResults ?? []).map((entry) => entry.toolCallId));
    return (message.toolCalls ?? []).some(
      (call) =>
        (call.status === 'generating' || call.status === 'executing') && !resultIds.has(call.id),
    );
  });
}

/**
 * 单个过程片段是否仍在进行（片段维度）：
 * - thinking：只看 thinkingStreaming（思考结束即完成，与正文是否仍在流式无关）；
 * - tools：只看是否存在「无结果且状态为 generating/executing」的工具调用。
 * 不能用 message.streaming —— 正文继续流式时消息仍是 streaming，但工具/思考片段已完成，
 * 否则折叠行会一直转圈到整条消息定稿（下一轮 assistant 消息创建时才发生）。
 */
function isPartRunning(part: ProcessPart): boolean {
  const message = part.message;
  if (part.part === 'thinking') return message.thinkingStreaming === true;
  const resultIds = new Set((message.toolResults ?? []).map((entry) => entry.toolCallId));
  return (message.toolCalls ?? []).some(
    (call) =>
      (call.status === 'generating' || call.status === 'executing') && !resultIds.has(call.id),
  );
}

/**
 * 一轮回复 → 简洁挡折叠数据。
 * 最终正文只认「该轮最后一条消息」：它必须有可见正文且没有非 todo 工具调用，
 * 否则视为过程尚未结束（如 think+tool+content+tool+think），收起态只显示折叠行。
 */
function summarizeRound(
  blocks: readonly CompactBlock[],
  anchorId: string,
  foldKeys: FoldKeyStore,
): CompactRound {
  const messages = blocks
    .filter((block): block is Extract<CompactBlock, { kind: 'message' }> => block.kind === 'message')
    .map((block) => block.message);
  // 折叠身份取任一已登记消息（prepend 扩展本轮时沿用旧 id，避免展开状态丢失）；
  // 极端情况（本轮只有 todo 进度卡、没有消息）用 anchorId 兜底。
  const partKeys = messages.length > 0
    ? messages.map((message) => `r:${message.id}`)
    : [`r:${anchorId}`];
  const foldId = resolveFoldId(foldKeys, partKeys);
  const stats = emptyStats();
  let hasThinking = false;
  for (const message of messages) {
    countToolCalls(stats, message);
    if (hasThinkingContent(message)) hasThinking = true;
  }
  const last = messages[messages.length - 1];
  const finalBodyId =
    last && hasVisibleContent(last) && !hasNonTodoTools(last) ? last.id : undefined;
  // 最终正文之外的任何消息、最终正文自身的思考/工具、todo 进度卡都属于「被折叠的内容」
  const hasFold =
    hasStats(stats) ||
    hasThinking ||
    blocks.some((block) => block.kind === 'todoCard') ||
    messages.some((message) => message.id !== finalBodyId);
  return {
    key: `round:${foldId}`,
    anchorId,
    messages: [...messages],
    blocks: [...blocks],
    ...(finalBodyId ? { finalBodyId } : {}),
    stats,
    hasThinking,
    hasFold,
    running: isMessagesRunning(messages),
  };
}

/**
 * 简洁挡：按「用户消息之间的一轮回复」聚合为单个折叠节点。
 * 系统卡 / 错误卡 / 中断卡保持独立条目。
 */
function buildCompactItems(
  messages: readonly TaskMessage[],
  replyEndIds: ReadonlySet<string>,
  foldKeys: FoldKeyStore,
): ChatListItem[] {
  const items: ChatListItem[] = [];
  let roundBlocks: CompactBlock[] = [];
  let anchorId = '';
  /** 本轮内出现的回复结尾（可能是仅 todo 调用、不产生渲染块的消息） */
  let roundReplyEnd: TaskMessage | null = null;

  const flush = (): void => {
    const replyEnd = roundReplyEnd;
    roundReplyEnd = null;
    if (roundBlocks.length > 0) {
      const round = summarizeRound(roundBlocks, anchorId, foldKeys);
      items.push({ kind: 'round', key: round.key, round });
    }
    // 操作栏属于「整段回复的末尾」：压在本轮折叠行之后，收起/展开都不会被折进去。
    // 纯 todo 调用的回复没有渲染块，也仍然保留操作栏。
    if (replyEnd && !replyEnd.isError) {
      items.push({
        kind: 'replyFooter',
        key: `reply-footer:${replyEnd.id}`,
        message: replyEnd,
      });
    }
    roundBlocks = [];
    anchorId = '';
  };

  for (const message of messages) {
    if (message.role === 'user' || message.role !== 'assistant' || isStandaloneCard(message)) {
      flush();
      if (message.role === 'tool') continue; // 适配层已合并，防御
      items.push({ kind: 'message', key: message.id, message });
      // 中断卡等独立 assistant 卡也可能是回复结尾（错误卡自带操作栏，跳过）
      if (message.role === 'assistant' && !message.isError && replyEndIds.has(message.id)) {
        items.push({
          kind: 'replyFooter',
          key: `reply-footer:${message.id}`,
          message,
        });
      }
      continue;
    }

    // 空 assistant 占位（无正文/思考/工具）：跳过，不产生空条目
    if (isEmptyAssistantPlaceholder(message)) continue;

    // 回复结尾先记录：即使该消息只有 todo 调用（不产生渲染块），操作栏也必须出现
    if (replyEndIds.has(message.id) && !message.isError) roundReplyEnd = message;

    if (!anchorId) anchorId = message.id;

    // 所有挡位都显示 todo 进度卡：简洁挡放进本轮折叠内
    if (message.todoSnapshot && message.todoSnapshot.length > 0) {
      roundBlocks.push({
        kind: 'todoCard',
        key: `todo-card:${message.id}`,
        todos: message.todoSnapshot,
      });
    }

    const hasContent = hasVisibleContent(message);
    const hasThinking = hasThinkingContent(message);
    const hasTools = hasNonTodoTools(message);
    // 只有 todo 调用的边界消息没有可渲染内容（todo 由进度卡代表）
    if (!hasContent && !hasThinking && !hasTools) continue;

    roundBlocks.push({ kind: 'message', key: message.id, message });
  }
  flush();
  return items;
}

/**
 * 标准 / 详细：块流（todo 容器 / 正文 / 连续过程段 / 独立消息）。
 * - todo 容器从 todo 进入执行状态开始，到它完成/阻塞（或被新 todo / 用户消息打断）为止，
 *   其间所有正文与过程段都收进容器；完成时整段折叠进折叠行；
 * - 过程段跨消息合并，正文或 todo 边界才断开，因此不会出现摘要行上下残留工具卡/思考行；
 * - 原始内容挡：不生成 todo 容器，todo 工具调用按普通工具卡显示。
 */
function buildBlockItems(
  messages: readonly TaskMessage[],
  level: StepDisplayLevel,
  replyEndIds: ReadonlySet<string>,
  foldKeys: FoldKeyStore,
): ChatListItem[] {
  const raw = level === 'raw';
  // 详细挡与原始内容一样不生成 todo 折叠行（只差文案：详细用显示名称）
  const noTodoFold = raw || level === 'detailed';
  const items: ChatListItem[] = [];
  let todo: TodoStep | null = null;
  let run: ProcessRun | null = null;
  /** 上一份 todo 快照（用于识别「本次同时完成多项」） */
  let prevSnapshot: readonly TodoItem[] | null = null;
  /** 待压入的操作栏：延迟到 todo 容器收口之后，保证它排在所有折叠行后面 */
  let pendingFooter: TaskMessage | null = null;
  /** 本次构建已占用的 run 身份：拆分出的后续段必须换新 id（防同 key 冲突） */
  const usedRunFoldIds = new Set<string>();

  const flushFooter = (): void => {
    const message = pendingFooter;
    pendingFooter = null;
    if (!message || message.isError) return;
    items.push({
      kind: 'replyFooter',
      key: `reply-footer:${message.id}`,
      message,
    });
  };

  const flushRun = (): void => {
    if (!run) return;
    // 片段级判定：工具/思考各自完成即完成，不等待整条消息停止流式
    run.running = run.parts.some(isPartRunning);
    // 稳定身份：沿用任一已登记片段的 foldId，prepend 向后合并不会换 key
    const partKeys = run.parts.map((part) => runPartKey(part.message.id, part.part));
    let foldId = resolveFoldId(foldKeys, partKeys);
    if (usedRunFoldIds.has(foldId)) {
      // 同一次构建内同一 run 被正文拆成两段（如先 thinking+tools，后补正文）：
      // 后一段必须换新身份，否则两个折叠行共用 key（React 冲突 + 展开状态串台）。
      foldId = `f${foldKeys.seq++}`;
      for (const key of partKeys) foldKeys.parts.set(key, foldId);
    }
    usedRunFoldIds.add(foldId);
    run.key = `run:${foldId}`;
    const block: TodoBlock = { kind: 'run', key: run.key, run };
    if (todo) todo.blocks.push(block);
    else items.push(block);
    run = null;
  };

  const pushBody = (message: TaskMessage): void => {
    const block: TodoBlock = { kind: 'body', key: `body:${message.id}`, message };
    if (todo) todo.blocks.push(block);
    else items.push(block);
  };

  const closeTodo = (): void => {
    flushRun();
    if (!todo) return;
    items.push({ kind: 'todo', key: todo.key, todo });
    todo = null;
  };

  const appendPart = (message: TaskMessage, part: 'thinking' | 'tools'): void => {
    if (!run) {
      run = {
        // key 在 flushRun 时按稳定 foldId 赋最终值（需看到完整 parts 才能确定身份）
        key: '',
        parts: [],
        stats: emptyStats(),
        hasThinking: false,
        running: false,
      };
    }
    run.parts.push({ message, part });
    if (part === 'thinking') run.hasThinking = true;
    else countToolCalls(run.stats, message);
  };

  for (const message of messages) {
    // 本消息完成后需要收口的 todo（先放进度卡再收口，保证卡片也被折进容器）
    let pendingClose = false;

    // 用户消息 / 系统卡 / 错误卡：结束当前 todo 与过程段，独立渲染
    if (message.role === 'user' || message.role !== 'assistant' || isStandaloneCard(message)) {
      closeTodo();
      // 操作栏压在下一条消息之前、所有折叠行之后
      flushFooter();
      if (message.role === 'tool') continue; // 适配层已合并，防御
      items.push({ kind: 'message', key: message.id, message });
      // 中断卡等独立 assistant 卡也可能是回复结尾（错误卡自带操作栏，跳过）
      if (message.role === 'assistant' && !message.isError && replyEndIds.has(message.id)) {
        items.push({
          kind: 'replyFooter',
          key: `reply-footer:${message.id}`,
          message,
        });
      }
      continue;
    }

    // 空 assistant 占位（无正文/思考/工具）：跳过，不产生空条目
    if (isEmptyAssistantPlaceholder(message)) continue;

    // todo 容器：出现新的 in_progress 待办时开容器；完成/阻塞时延迟到本消息处理完再收口
    if (!noTodoFold && message.todoSnapshot !== undefined) {
      const snapshot = message.todoSnapshot;
      const active = inProgress(snapshot);
      const currentTodoId: string | null = todo ? todo.todoId : null;
      // 本次快照中从非 completed 变为 completed 的待办
      const previous = prevSnapshot;
      prevSnapshot = snapshot;
      const completedNow = previous
        ? snapshot.filter((item) => {
            if (item.status !== 'completed') return false;
            const before = previous.find((p) => p.id === item.id);
            return before !== undefined && before.status !== 'completed';
          })
        : [];
      if (todo) {
        const latest = snapshot.find((item) => item.id === currentTodoId);
        if (latest) {
          todo.title = latest.text;
          todo.status = latest.status;
        } else if (!active && todo.status === 'in_progress') {
          // 已从清单移除且没有新的进行中待办：视为完成
          todo.status = 'completed';
        }
        // 多项待办同时完成：折叠行标题显示 todo1&todo2
        if (completedNow.length > 1 && completedNow.some((item) => item.id === currentTodoId)) {
          todo.title = completedNow.map((item) => item.text).join('&');
        }
      }
      if (active && active.id !== currentTodoId) {
        if (todo && todo.status === 'in_progress') todo.status = 'completed';
        closeTodo();
        todo = {
          key: `todo:${active.id}`,
          todoId: active.id,
          title: active.text,
          status: active.status,
          blocks: [],
        };
      } else if (!active && todo && (todo.status === 'completed' || todo.status === 'blocked')) {
        // 当前 todo 已完成/阻塞：等卡片与工具片段入容器后再收口
        pendingClose = true;
      }
    }

    // 消息拆分顺序：思考 → 正文 → todo 进度卡 → 工具（与模型单轮产出顺序一致）
    if (hasThinkingContent(message)) appendPart(message, 'thinking');
    if (hasVisibleContent(message)) {
      // 正文打断过程段：正文之前的过程归上一段，正文独立成块
      flushRun();
      pushBody(message);
    }
    // todo 进度卡：所有挡位都显示；有 todo 容器时放进折叠内，否则作为顶层项
    if (message.todoSnapshot && message.todoSnapshot.length > 0) {
      flushRun();
      const card: TodoBlock = {
        kind: 'todoCard',
        key: `todo-card:${message.id}`,
        todos: message.todoSnapshot,
      };
      if (todo) todo.blocks.push(card);
      else items.push(card);
    }
    if (hasNonTodoTools(message)) appendPart(message, 'tools');

    if (pendingClose) closeTodo();

    // 回复结尾：先把本消息的工具片段收进当前段，操作栏延迟到 todo 容器收口后再压入
    if (!message.isError && replyEndIds.has(message.id)) {
      flushRun();
      pendingFooter = message;
    }
  }

  closeTodo();
  flushFooter();
  return items;
}

export interface BuildChatItemsOptions {
  /** 回复结尾消息 id 集合；缺省内部调用 computeReplyEnds */
  replyEndIds?: ReadonlySet<string>;
  /** 跨 rebuild 的稳定折叠身份；不传则本次构建内部新建（key 只在本次构建内有效） */
  foldKeys?: FoldKeyStore;
}

/**
 * 消息列表 → 虚拟列表项。
 * 分组只依赖消息顺序与 todoSnapshot，流式期间可反复调用。
 * 简洁挡按「一轮回复」聚合（CompactRound），其余挡位按块流分组。
 *
 * 每个回复结尾都会额外产生一个 `replyFooter` 项，保证操作栏永远排在整段回复
 * 的所有折叠行之后（纯工具 / 纯思考回复同样有操作栏）。
 */
export function buildChatItems(
  messages: readonly TaskMessage[],
  level: StepDisplayLevel = 'standard',
  options?: BuildChatItemsOptions,
): ChatListItem[] {
  const foldKeys = options?.foldKeys ?? createFoldKeyStore();
  const replyEndIds =
    options?.replyEndIds ?? computeReplyEnds([...messages]).replyEndIds;
  if (level === 'compact') return buildCompactItems(messages, replyEndIds, foldKeys);
  return buildBlockItems(messages, level, replyEndIds, foldKeys);
}
