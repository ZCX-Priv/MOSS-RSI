// webui/src/lib/ws-events.ts
// WS 事件分发单一入口（从 useWebSocket 抽出，避免 hook 内积压成 700+ 行的巨型 switch）。
//
// 职责分层：
// - stream-buffer：高频流式分片的批处理与 offset 续传（本模块只负责把事件投递进去）
// - 本模块：把 WS 事件落到 store（消息 / 会话 / 列表 / 自动化 / 子代理）
// - useSessionHistory：会话级编排（快照对齐、分页、尾部补齐）——通过下方注册的回调感知时机
//
// 关键约定（「刷新后不丢状态」的核心）：
// - 运行态只由权威信号写入：状态快照 / session.subscribed / 完成类事件 / 本地发送与中断
// - 任何历史拉取都不得把 running 置 false

import { toast } from 'sonner';
import { useStore } from '../store';
import { api } from '../api/http';
import { pendingAssistant, pendingRunId } from './pending-assistant';
import { handleTerminalMessage } from './terminal-events';
import {
  dumpStreamAccounting,
  enqueueTextChunk,
  enqueueToolArgsChunk,
  finishResync,
  flushPending,
  noteStreamReceived,
  noteStreamRunIdDrop,
  replayPendingAfterResync,
  seedStreamLength,
} from './stream-buffer';
import { diag, diagAlways } from './diag';
import { emitInsightEvent } from './insight-bus';
import { bindSubagentSession } from './subagent-sessions';
import i18n from '../i18n';
import type {
  AgentEvent,
  TaskMessage,
  TaskItem,
  TaskGroup,
  TodoItem,
  ContextFile,
  AutomationRun,
  WSMessage,
  ToolCall,
  RunStats,
  CompactionRecord,
  ContextStats,
  LiveDraftPayload,
  SessionSubscribedPayload,
  InsightEvent,
  AskQuestion,
} from '../types/api';

function genId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 参与 runId 过滤的「流式」事件类型。
 * 终态事件（done / task.done / task.aborted / error）刻意不在其中：
 * 它们是运行态状态机的唯一收敛点（generatingBySession 只在这里置 false）。
 * 若终态信号因 runId 不一致被丢弃，前端将永久停在「响应中」且无自愈路径 —
 * 故终态事件必须无条件处理（见 applyWsMessage 顶部注释）。
 */
const AGENT_STREAM_EVENT_TYPES = new Set([
  'assistant-text', 'assistant-thinking',
  'tool-call-start', 'tool-call-delta', 'tool-call-executing', 'tool-call-end',
  'ask', 'stats-updated',
]);

/** 终态事件：不参与 runId 过滤（收敛点不可丢） */
const AGENT_TERMINAL_EVENT_TYPES = new Set([
  'done', 'task.done', 'task.aborted', 'error',
]);

/** 高频流式分片类型：仅这些计入前端分片账本的 received 计数 */
const STREAM_CHUNK_TYPES = new Set([
  'assistant-text', 'assistant-thinking', 'tool-call-delta',
]);

/**
 * subagent.event 内层 agent 事件的白名单：
 * 子代理事件复用主 agent 的 reducer 落到 messagesBySession[子代理会话id]，
 * 这里只放行可渲染的事件类型，避免未知类型进入 switch 的 default / 误触终端分支。
 */
const SUBAGENT_DISPLAY_EVENT_TYPES = new Set([
  'assistant-text', 'assistant-thinking',
  'tool-call-start', 'tool-call-delta', 'tool-call-executing', 'tool-call-end',
  'ask', 'ask-timeout', 'confirm-required', 'stats-updated', 'error', 'done',
]);

/** 读取事件的 runId（agent 事件 payload 顶层） */
function eventRunIdOf(msg: WSMessage): string | undefined {
  const v = (msg.payload as { runId?: unknown } | undefined)?.runId;
  return typeof v === 'string' ? v : undefined;
}

// ============================================================================
// 会话编排回调（由 useSessionHistory 注册）：本模块只负责「通知时机」，
// 不承担分页/补拉逻辑，避免两个模块各自实现一遍造成竞态。
// ============================================================================

export type StreamSettleReason = 'done' | 'aborted' | 'error';

type SnapshotHandler = (sessionId: string, payload: SessionSubscribedPayload) => void;
type SettleHandler = (sessionId: string, reason: StreamSettleReason) => void;

const snapshotHandlers = new Set<SnapshotHandler>();
const settleHandlers = new Set<SettleHandler>();
const invalidatedHandlers = new Set<(sessionId: string) => void>();

/**
 * 订阅：会话消息数组被服务端改动（撤回 / 恢复）→ 分页游标失效，需按末页重新加载。
 * 与「快照」区分：此时不能按游标做增量（下标已变化），必须整体重载末页。
 */
export function onHistoryInvalidated(handler: (sessionId: string) => void): () => void {
  invalidatedHandlers.add(handler);
  return () => invalidatedHandlers.delete(handler);
}

function emitHistoryInvalidated(sessionId: string): void {
  for (const h of invalidatedHandlers) {
    try {
      h(sessionId);
    } catch {
      // 单个回调异常不影响其他
    }
  }
}

const truncatedHandlers = new Set<(sessionId: string) => void>();

/**
 * 订阅：本会话「撤回/截断」事件已处理完毕（本地消息已按截断点删除）。
 * 「重新生成」据此等待删除落地后再重发，避免乐观新消息被同一次删除误删（竞态）。
 */
export function onSessionTruncated(handler: (sessionId: string) => void): () => void {
  truncatedHandlers.add(handler);
  return () => truncatedHandlers.delete(handler);
}

function emitSessionTruncated(sessionId: string): void {
  for (const h of truncatedHandlers) {
    try {
      h(sessionId);
    } catch {
      // 单个回调异常不影响其他
    }
  }
}

/** 订阅：收到 session.subscribed 快照（后端权威状态）时回调 */
export function onSessionSnapshot(handler: SnapshotHandler): () => void {
  snapshotHandlers.add(handler);
  return () => snapshotHandlers.delete(handler);
}

/** 订阅：一轮流结束（done/aborted/error）时回调——用于尾部增量补齐 */
export function onStreamSettled(handler: SettleHandler): () => void {
  settleHandlers.add(handler);
  return () => settleHandlers.delete(handler);
}

function emitSnapshot(sessionId: string, payload: SessionSubscribedPayload): void {
  for (const h of snapshotHandlers) {
    try {
      h(sessionId, payload);
    } catch {
      // 单个回调异常不影响其他
    }
  }
}

function emitSettled(sessionId: string, reason: StreamSettleReason): void {
  for (const h of settleHandlers) {
    try {
      h(sessionId, reason);
    } catch {
      // 单个回调异常不影响其他
    }
  }
}

/**
 * 把服务端流式草稿落成一条本地消息（刷新/重连后恢复半截回复，并让后续分片接得上）。
 * - 以草稿 messageId 作为本地消息 id → 后续分片按同一 id 精确续接
 * - 同时把已知长度写入续传缓冲（后续 offset 校验无需读 store）
 */
export function attachLiveDraft(draft: LiveDraftPayload): void {
  const sessionId = draft.sessionId;
  const st = useStore.getState();
  // 新一轮开始后，上一条「上次中断的未完成回复」失去意义（其内容不会被服务端续用）→ 移除
  const stale = (st.messagesBySession[sessionId] ?? []).filter(
    (m) => m.interrupted && m.id !== draft.messageId,
  );
  if (!draft.stale && stale.length > 0) {
    const staleIds = new Set(stale.map((m) => m.id));
    st.setMessages(
      sessionId,
      (st.messagesBySession[sessionId] ?? []).filter((m) => !staleIds.has(m.id)),
    );
  }
  const existing = (st.messagesBySession[sessionId] ?? []).find((m) => m.id === draft.messageId);
  const streaming = !draft.stale;
  const msg: TaskMessage = {
    id: draft.messageId,
    serverMessageId: draft.messageId,
    role: 'assistant',
    content: draft.content,
    thinking: draft.thinking,
    ...(draft.toolCalls.length > 0
      ? {
          toolCalls: draft.toolCalls.map<ToolCall>((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            status: tc.status ?? 'generating',
          })),
        }
      : {}),
    timestamp: draft.startedAt,
    streaming,
    thinkingStreaming: false,
    // 思考起始时刻（草稿落盘）：刷新/重连恢复后据此续算思考已用时
    ...(draft.thinkingStartedAt ? { thinkingStartedAt: draft.thinkingStartedAt } : {}),
    ...(draft.stale ? { interrupted: true } : {}),
  };

  if (existing) {
    // 已有同 id 消息（重连二次恢复 / 分片先行创建）：以服务端内容为准整体覆盖
    diag('live-draft-overwrite', { sessionId, messageId: draft.messageId, existed: true });
    st.updateMessage(sessionId, draft.messageId, {
      content: draft.content,
      thinking: draft.thinking,
      toolCalls: msg.toolCalls,
      streaming,
      thinkingStreaming: false,
      ...(draft.thinkingStartedAt ? { thinkingStartedAt: draft.thinkingStartedAt } : {}),
      ...(draft.stale ? { interrupted: true } : {}),
    });
  } else {
    diag('live-draft-attach', { sessionId, messageId: draft.messageId, contentLen: draft.content.length });
    st.addMessage(sessionId, msg);
  }

  seedStreamLength(sessionId, draft.messageId, 'content', draft.contentLength);
  seedStreamLength(sessionId, draft.messageId, 'thinking', draft.thinkingLength);
  // 对齐完成：释放 resync 冷却标记（后续缺口可再次触发对齐），
  // 并重放暂存的缺口分片（按新长度自然去重，超出部分正常续接）
  finishResync(sessionId);
  replayPendingAfterResync(sessionId);
  if (streaming) pendingAssistant.set(sessionId, { ...msg, streaming: true });
}

// ============================================================================

export function applyWsMessage(msg: WSMessage, opts?: { silent?: boolean }): void {
  const s = useStore.getState();

  // 终端类消息：元数据进 store / 高频输出走 terminal-bus，直接消费不进入下方 agent 事件流
  if (handleTerminalMessage(msg)) return;

  const sessionId = msg.sessionId ?? s.activeSessionId ?? '';

  // runId 过滤（仅流式事件）：丢弃旧 run 的分片，防止「打断发送」时旧流污染新流状态。
  // 终态事件不丢弃（收敛点不可丢），但若确属已被顶替的旧 run（runId 不一致），
  // 则只打点观测、不做状态变更（否则会把新 run 的 pending 清掉）；
  // 真正的兜底收敛由生成态看门狗按后端权威态完成（useGenerationWatchdog）。
  if (sessionId && AGENT_STREAM_EVENT_TYPES.has(msg.type)) {
    const eventRunId = eventRunIdOf(msg);
    const currentRunId = pendingRunId.get(sessionId);
    if (eventRunId && currentRunId && eventRunId !== currentRunId) {
      noteStreamRunIdDrop(sessionId);
      diagAlways('stream-runid-drop', { type: msg.type, eventRunId, currentRunId, sessionId });
      return;
    }
    // 账本：先记「收到」（后续是否被 store 应用/丢弃由 stream-buffer 归因）
    if (STREAM_CHUNK_TYPES.has(msg.type)) noteStreamReceived(sessionId);
  }
  const terminalRunIdMismatch =
    sessionId !== '' &&
    AGENT_TERMINAL_EVENT_TYPES.has(msg.type) &&
    (() => {
      const eventRunId = eventRunIdOf(msg);
      const currentRunId = pendingRunId.get(sessionId);
      return Boolean(eventRunId && currentRunId && eventRunId !== currentRunId);
    })();
  if (terminalRunIdMismatch) {
    diagAlways('terminal-runid-mismatch', {
      type: msg.type,
      eventRunId: eventRunIdOf(msg),
      currentRunId: pendingRunId.get(sessionId),
      sessionId,
    });
  }

  switch (msg.type) {
    // ======================================================================
    // Agent 事件流（payload 为完整 AgentEvent）
    // ======================================================================
    case 'user-message': {
      // 先冲刷上一轮残余流式文本，保证用户消息按时间顺序出现
      flushPending();
      const sid = msg.sessionId ?? sessionId;
      if (!sid) break;
      const event = (msg.payload ?? {}) as {
        content?: string;
        timestamp?: string;
        attachments?: string[];
        clientMessageId?: string;
      };
      const content = event.content ?? '';
      if (!content.trim()) break;
      const clientMessageId = event.clientMessageId;
      // 稳定身份：优先 clientMessageId（与历史副本同 id）；缺失时退化为时间戳 id
      const id = clientMessageId ?? `user_${event.timestamp ?? Date.now()}`;
      const st = useStore.getState();
      const list = st.messagesBySession[sid] ?? [];
      // 幂等：WebUI 自己发送时本地乐观副本已在 store；多标签页 / 重复投递同样安全
      const exists = list.some(
        (m) => m.id === id || (clientMessageId !== undefined && m.clientMessageId === clientMessageId),
      );
      if (exists) break;
      st.addMessage(sid, {
        id,
        ...(clientMessageId ? { clientMessageId } : {}),
        role: 'user',
        content,
        ...(event.attachments && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
        timestamp: event.timestamp ?? new Date().toISOString(),
      });
      break;
    }
    case 'assistant-text': {
      if (!sessionId) return;
      const event = msg.payload as Extract<AgentEvent, { type: 'assistant-text' }> & {
        messageId?: string;
        offset?: number;
      };
      const messageId = event.messageId ?? pendingAssistant.get(sessionId)?.id ?? genId();
      enqueueTextChunk({
        sessionId,
        messageId,
        field: 'content',
        offset: event.offset,
        text: event.text,
      });
      break;
    }
    case 'assistant-thinking': {
      if (!sessionId) return;
      const event = msg.payload as Extract<AgentEvent, { type: 'assistant-thinking' }> & {
        messageId?: string;
        offset?: number;
      };
      const messageId = event.messageId ?? pendingAssistant.get(sessionId)?.id ?? genId();
      enqueueTextChunk({
        sessionId,
        messageId,
        field: 'thinking',
        offset: event.offset,
        text: event.text,
      });
      break;
    }
    case 'tool-call-start': {
      flushPending(); // 保证之前的文本分片先写入（保持事件顺序）
      const event = msg.payload as Extract<AgentEvent, { type: 'tool-call-start' }> & { messageId?: string };
      if (!sessionId) break;
      const pending = ensureStreamingMessage(sessionId, event.messageId);
      if (!pending) break;
      const newToolCall: ToolCall = {
        id: event.toolCallId,
        name: event.toolName,
        arguments: '',
        status: 'generating',
      };
      const existing = pending.toolCalls ?? [];
      // 幂等：同 id 已存在（重连重放 / 草稿已含该调用）时不重复追加
      const merged = existing.some((tc) => tc.id === event.toolCallId)
        ? existing.map((tc) =>
            tc.id === event.toolCallId ? { ...tc, name: event.toolName, status: 'generating' as const } : tc,
          )
        : [...existing, newToolCall];
      s.updateMessage(sessionId, pending.id, { toolCalls: merged, thinkingStreaming: false });
      pendingAssistant.set(sessionId, { ...pending, toolCalls: merged });
      break;
    }
    case 'tool-call-delta': {
      const event = msg.payload as Extract<AgentEvent, { type: 'tool-call-delta' }> & {
        messageId?: string;
        offset?: number;
      };
      if (!sessionId) break;
      const messageId = event.messageId ?? pendingAssistant.get(sessionId)?.id;
      if (!messageId) break;
      enqueueToolArgsChunk({
        sessionId,
        messageId,
        toolCallId: event.toolCallId,
        offset: event.offset,
        argumentsDelta: event.argumentsDelta,
      });
      break;
    }
    case 'tool-call-executing': {
      flushPending(); // 保证参数分片先写入
      const event = msg.payload as Extract<AgentEvent, { type: 'tool-call-executing' }> & { messageId?: string };
      if (!sessionId) break;
      const pending = pendingAssistant.get(sessionId);
      const targetId = pending?.id ?? event.messageId;
      if (targetId) {
        const msgs = useStore.getState().messagesBySession[sessionId] ?? [];
        const target = msgs.find((m) => m.id === targetId) ?? findMessageByToolCallId(sessionId, event.toolCallId);
        if (target?.toolCalls) {
          const updatedToolCalls = target.toolCalls.map((tc) =>
            tc.id === event.toolCallId ? { ...tc, status: 'executing' as const } : tc,
          );
          s.updateMessage(sessionId, target.id, { toolCalls: updatedToolCalls });
          if (pending && pending.id === target.id) {
            pendingAssistant.set(sessionId, { ...pending, toolCalls: updatedToolCalls });
          }
          break;
        }
      }
      // 回退：无 pending 且历史里也没有该 toolCallId 的消息（刷新丢态）→ 定位含此 id 的消息
      const fallback = findMessageByToolCallId(sessionId, event.toolCallId);
      if (fallback?.toolCalls) {
        s.updateMessage(sessionId, fallback.id, {
          toolCalls: fallback.toolCalls.map((tc) =>
            tc.id === event.toolCallId ? { ...tc, status: 'executing' as const } : tc,
          ),
        });
      }
      break;
    }
    case 'tool-call-end': {
      flushPending(); // 保证参数分片先写入，避免 end 后还有残余 delta
      const event = msg.payload as Extract<AgentEvent, { type: 'tool-call-end' }> & { messageId?: string };
      if (!sessionId) break;
      const pending = pendingAssistant.get(sessionId);
      const targetId = pending?.id ?? event.messageId;
      const msgs = useStore.getState().messagesBySession[sessionId] ?? [];
      const target =
        (targetId ? msgs.find((m) => m.id === targetId) : undefined) ??
        findMessageByToolCallId(sessionId, event.toolCallId);
      if (target?.toolCalls) {
        const updatedToolCalls = target.toolCalls.map((tc) =>
          tc.id === event.toolCallId
            ? { ...tc, name: event.toolName, status: 'done' as const }
            : tc,
        );
        const updatedToolResults = [
          ...(target.toolResults ?? []),
          { toolCallId: event.toolCallId, result: event.result },
        ];
        s.updateMessage(sessionId, target.id, {
          toolCalls: updatedToolCalls,
          toolResults: updatedToolResults,
        });
        if (pending && pending.id === target.id) {
          pendingAssistant.set(sessionId, {
            ...pending,
            toolCalls: updatedToolCalls,
            toolResults: updatedToolResults,
          });
        }
      }
      break;
    }
    case 'ask': {
      if (!sessionId) return;
      const event = (msg.payload ?? {}) as Partial<Extract<AgentEvent, { type: 'ask' }>> & {
        // 旧后端兜底：扁平单题字段
        question?: string;
        answerType?: AskQuestion['answerType'];
        options?: AskQuestion['options'];
        defaultAnswer?: string;
        formSchema?: Record<string, unknown>;
      };
      if (!event.toolCallId) break;
      const questions: AskQuestion[] =
        Array.isArray(event.questions) && event.questions.length > 0
          ? event.questions
          : event.question
            ? [
                {
                  id: 'q0',
                  question: event.question,
                  answerType: event.answerType,
                  options: event.options,
                  defaultAnswer: event.defaultAnswer,
                  formSchema: event.formSchema,
                },
              ]
            : [];
      if (questions.length === 0) break;
      s.addPendingAsk({
        toolCallId: event.toolCallId,
        sessionId,
        questions,
        createdAt: Date.now(),
      });
      break;
    }
    case 'ask-timeout': {
      const event = (msg.payload ?? {}) as { toolCallId?: string };
      const sid = msg.sessionId ?? sessionId;
      if (event.toolCallId && sid) useStore.getState().removePendingAsk(sid, event.toolCallId);
      break;
    }
    case 'confirm-required': {
      if (!sessionId) return;
      const event = msg.payload as Extract<AgentEvent, { type: 'confirm-required' }>;
      s.addPendingConfirm({
        toolCallId: event.toolCallId,
        sessionId,
        toolName: event.toolName,
        question: event.question,
        details: event.details,
        ruleSuggestion: (msg.payload as { ruleSuggestion?: string }).ruleSuggestion,
        createdAt: Date.now(),
      });
      break;
    }
    case 'confirm-cancel': {
      const event = (msg.payload ?? {}) as { toolCallId?: string };
      const sid = msg.sessionId ?? sessionId;
      if (event.toolCallId && sid) useStore.getState().removePendingConfirm(sid, event.toolCallId);
      break;
    }
    case 'stats-updated': {
      if (!sessionId) return;
      const event = (msg.payload ?? {}) as { stats?: RunStats };
      if (event.stats) s.setRunStats(sessionId, event.stats);
      break;
    }
    case 'insight.diagnose.event': {
      // AI 诊断流式事件：仅投递到诊断弹窗订阅者（不落 store、不参与会话状态机）
      emitInsightEvent((msg.payload ?? {}) as InsightEvent);
      break;
    }
    case 'error': {
      flushPending(); // 流式文本在终止前全部写入
      if (terminalRunIdMismatch) break; // 旧 run 的终态：只观测，不改当前状态
      const event = (msg.payload ?? {}) as { message?: string; providerError?: string; messageId?: string };
      const errorCode = event.message ?? '';
      const localizedMessage = i18n.exists(`errors.${errorCode}`)
        ? i18n.t(`errors.${errorCode}`)
        : (errorCode || i18n.t('errors.UNKNOWN'));
      // 原始 provider 错误文本（用于错误卡片正文 + 「诊断」弹窗输入；与刷新后历史恢复字段一致）
      const errorDetail = event.providerError ?? localizedMessage;
      if (sessionId) {
        s.finalizeStreamingMessages(sessionId);
        s.addMessage(sessionId, {
          // 稳定身份：与后端持久化 system-error 消息同 id（`<sid>#<turn>#error`）→
          // catchUpTail 合并时原位 patch，实时与刷新后只渲染一条错误卡片。
          id: event.messageId ?? genId(),
          role: 'assistant',
          content: localizedMessage,
          isError: true,
          errorDetail,
          timestamp: new Date().toISOString(),
        });
        s.setGenerating(sessionId, false);
        s.setStopping(sessionId, false);
        s.setTaskError(sessionId, true);
        pendingAssistant.delete(sessionId);
        // 防御：终态同步清理 runId，防残留值误杀未来带 runId 的外部 run 事件
        pendingRunId.delete(sessionId);
        emitSettled(sessionId, 'error');
      }
      // silent：子代理（member 事件）失败已在卡片结果中呈现，不弹全局 toast
      if (!opts?.silent) toast.error(localizedMessage);
      break;
    }
    case 'done': {
      flushPending();
      if (terminalRunIdMismatch) break; // 旧 run 的终态：只观测，不改当前状态
      const doneEvent = (msg.payload ?? {}) as Extract<AgentEvent, { type: 'done' }>;
      if (sessionId) {
        s.finalizeStreamingMessages(sessionId);
        const pending = pendingAssistant.get(sessionId);
        if (pending) {
          const finalizedToolCalls = pending.toolCalls?.map((tc) =>
            tc.status === 'done' ? tc : { ...tc, status: 'done' as const },
          );
          s.updateMessage(sessionId, pending.id, {
            streaming: false,
            thinkingStreaming: false,
            toolCalls: finalizedToolCalls,
          });
          pendingAssistant.delete(sessionId);
        }
        pendingRunId.delete(sessionId);
        s.setGenerating(sessionId, false);
        s.setStopping(sessionId, false);
        useStore.getState().clearPendingAsksBySession(sessionId);
        useStore.getState().clearPendingConfirmsBySession(sessionId);
        // 轮数触顶：插入提示卡（幂等防重）
        if (doneEvent.finishReason === 'max_turns') {
          const st = useStore.getState();
          const maxTurns = st.appConfig?.agent.maxTurns ?? 0;
          const cardMessage: TaskMessage = {
            id: `max_turns_${doneEvent.runId ?? Date.now()}`,
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            maxTurnsNotice: { maxTurns },
          };
          const existing = st.messagesBySession[sessionId] ?? [];
          if (!existing.some((m) => m.id === cardMessage.id)) {
            st.setMessages(sessionId, [...existing, cardMessage]);
          }
        }
        // 输出长度触顶：模型因 max_tokens 上限被截断（思考与回复共用该预算），插入提示卡（幂等防重）
        if (doneEvent.finishReason === 'length') {
          const st = useStore.getState();
          const cardMessage: TaskMessage = {
            id: `output_limit_${doneEvent.runId ?? Date.now()}`,
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            outputLimitNotice: {},
          };
          const existing = st.messagesBySession[sessionId] ?? [];
          if (!existing.some((m) => m.id === cardMessage.id)) {
            st.setMessages(sessionId, [...existing, cardMessage]);
          }
        }
        emitSettled(sessionId, 'done');
      }
      break;
    }
    case 'task.done': {
      flushPending();
      if (terminalRunIdMismatch) break; // 旧 run 的终态：只观测，不改当前状态
      if (sessionId) {
        s.finalizeStreamingMessages(sessionId);
        const pending = pendingAssistant.get(sessionId);
        if (pending) {
          const finalizedToolCalls = pending.toolCalls?.map((tc) =>
            tc.status === 'done' ? tc : { ...tc, status: 'done' as const },
          );
          s.updateMessage(sessionId, pending.id, {
            streaming: false,
            thinkingStreaming: false,
            toolCalls: finalizedToolCalls,
          });
          pendingAssistant.delete(sessionId);
        }
        pendingRunId.delete(sessionId);
        s.setGenerating(sessionId, false);
        s.setStopping(sessionId, false);
        emitSettled(sessionId, 'done');
      }
      break;
    }
    case 'task.aborted': {
      flushPending();
      if (terminalRunIdMismatch) break; // 旧 run 的终态：只观测，不改当前状态
      // 用户主动中断：后端 run 已结束，这里才是「彻底停下」的权威收敛点
      if (sessionId) {
        s.finalizeStreamingMessages(sessionId);
        const pending = pendingAssistant.get(sessionId);
        if (pending) {
          const finalizedToolCalls = pending.toolCalls?.map((tc) =>
            tc.status === 'done' ? tc : { ...tc, status: 'done' as const },
          );
          s.updateMessage(sessionId, pending.id, {
            streaming: false,
            thinkingStreaming: false,
            toolCalls: finalizedToolCalls,
          });
          pendingAssistant.delete(sessionId);
        }
        pendingRunId.delete(sessionId);
        s.setGenerating(sessionId, false);
        s.setStopping(sessionId, false);
        emitSettled(sessionId, 'aborted');
      }
      break;
    }

    // ======================================================================
    // 会话订阅 / 撤回恢复
    // ======================================================================
    case 'session.subscribed': {
      if (!sessionId) break;
      const payload = (msg.payload ?? {}) as SessionSubscribedPayload;
      useStore.getState().setActiveSession(sessionId);
      // 权威运行态：running=true → 一亮到底（刷新后立刻显示运行中）；
      // running=false → 由编排层判断是否需要尾部补齐后再收尾（避免误判「已完成」）
      if (payload.running === true) {
        useStore.getState().setGenerating(sessionId, true);
      }
      if (payload.liveDraft && payload.liveDraft.messageId) {
        attachLiveDraft(payload.liveDraft);
      }
      emitSnapshot(sessionId, payload);
      break;
    }
    case 'session-truncated': {
      // 消息撤回已执行：删除 timestamp >= 截断起点的本地消息（含 1s 容差）
      if (!sessionId) break;
      const payload = (msg.payload ?? {}) as { messageTimestamp?: string };
      if (!payload.messageTimestamp) break;
      const cutoff = Date.parse(payload.messageTimestamp) - 1000;
      const msgs = useStore.getState().messagesBySession[sessionId] ?? [];
      const removed = msgs.filter((m) => Date.parse(m.timestamp) >= cutoff);
      const kept = msgs.filter((m) => Date.parse(m.timestamp) < cutoff);
      if (removed.length > 0) {
        useStore.getState().setMessages(sessionId, kept);
        useStore.getState().setTruncateBackup(sessionId, {
          messageTimestamp: payload.messageTimestamp,
          messages: removed,
        });
      }
      // 服务端消息数组已变化 → 分页游标失效，交由编排层按末页整体重载
      useStore.getState().resetHistory(sessionId);
      emitHistoryInvalidated(sessionId);
      // 通知「重新生成」：本地删除已落地，可以安全重发（消除竞态）
      emitSessionTruncated(sessionId);
      break;
    }
    case 'session-restored': {
      if (!sessionId) break;
      const backup = useStore.getState().truncateBackups[sessionId];
      if (backup) {
        const msgs = useStore.getState().messagesBySession[sessionId] ?? [];
        const cutoff = Date.parse(backup.messageTimestamp);
        const before = msgs.filter((m) => Date.parse(m.timestamp) < cutoff);
        const after = msgs.filter((m) => Date.parse(m.timestamp) >= cutoff);
        useStore.getState().setMessages(sessionId, [...before, ...backup.messages, ...after]);
        useStore.getState().setTruncateBackup(sessionId, undefined);
      }
      useStore.getState().resetHistory(sessionId);
      emitHistoryInvalidated(sessionId);
      break;
    }
    case 'tool.ask.accepted': {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId;
      const sid = msg.sessionId;
      if (toolCallId && sid) useStore.getState().removePendingAsk(sid, toolCallId);
      break;
    }
    case 'tool.confirm.accepted': {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId;
      const sid = msg.sessionId;
      if (toolCallId && sid) useStore.getState().removePendingConfirm(sid, toolCallId);
      break;
    }

    // ======================================================================
    // todo / 上下文 / 文件
    // ======================================================================
    case 'todo-updated': {
      if (!sessionId) break;
      const payload = (msg.payload ?? {}) as { todos?: TodoItem[]; toolCallId?: string };
      if (Array.isArray(payload.todos)) {
        useStore.getState().setTodos(sessionId, payload.todos);
        // 回填快照到发起这次 todo 调用的 message（快照仅首次写入，后续变更不覆盖）
        if (payload.toolCallId) {
          const msgs = useStore.getState().messagesBySession[sessionId] ?? [];
          const target = msgs.find((m) => m.toolCalls?.some((tc) => tc.id === payload.toolCallId));
          if (target && target.todoSnapshot === undefined) {
            useStore.getState().updateMessage(sessionId, target.id, { todoSnapshot: payload.todos });
          }
        }
      }
      break;
    }
    case 'context-updated': {
      if (!sessionId) break;
      const payload = (msg.payload ?? {}) as {
        files?: ContextFile[];
        totalTokens?: number;
        maxTokens?: number;
      };
      useStore.getState().setContext(sessionId, {
        files: payload.files ?? [],
        totalTokens: payload.totalTokens ?? 0,
        maxTokens: payload.maxTokens ?? 0,
      });
      useStore.getState().bumpContextFileReadSeq(sessionId);
      break;
    }
    case 'context-stats-updated': {
      if (!sessionId) break;
      // 字段级合并而非整体覆盖：部分形状 payload 不得破坏 store 中的完整对象
      const payload = msg.payload as Partial<ContextStats> | undefined;
      if (payload && typeof payload === 'object' && payload.breakdown) {
        const cur = useStore.getState().contextStatsBySession[sessionId];
        useStore.getState().setContextStats(sessionId, {
          ...(cur ?? {}),
          ...payload,
          sessionId: payload.sessionId ?? sessionId,
          model: payload.model ?? cur?.model ?? { id: '', name: '' },
          breakdown: payload.breakdown ?? cur?.breakdown,
          windowTokens: payload.windowTokens ?? cur?.windowTokens ?? 0,
          usedPercent: payload.usedPercent ?? cur?.usedPercent ?? 0,
          avgHitRate: payload.avgHitRate ?? cur?.avgHitRate ?? null,
          lastUsage: payload.lastUsage ?? cur?.lastUsage ?? null,
          compaction:
            payload.compaction ??
            cur?.compaction ?? {
              enabled: false,
              compactRatio: 0.8,
              compactedMessages: 0,
              activeSummaryTokens: 0,
            },
          systemSections: payload.systemSections ?? cur?.systemSections ?? [],
          cacheHits: payload.cacheHits ?? cur?.cacheHits ?? [],
        });
      }
      break;
    }
    case 'compaction-started': {
      if (!sessionId) break;
      const payload = (msg.payload ?? {}) as { trigger?: 'auto' | 'manual' };
      toast.info(
        payload.trigger === 'manual'
          ? i18n.t('context.compactionStartedManual')
          : i18n.t('context.compactionStartedAuto'),
      );
      break;
    }
    case 'compaction-completed': {
      if (!sessionId) break;
      const payload = (msg.payload ?? {}) as { compaction?: CompactionRecord };
      const compaction = payload.compaction;
      if (!compaction) break;
      const cardMessage: TaskMessage = {
        id: `compaction_${compaction.id}`,
        role: 'assistant',
        content: compaction.summary,
        timestamp: compaction.at,
        compaction,
      };
      const st = useStore.getState();
      const existing = st.messagesBySession[sessionId] ?? [];
      if (!existing.some((m) => m.id === cardMessage.id)) {
        st.setMessages(sessionId, [...existing, cardMessage]);
      }
      toast.success(
        i18n.t('context.compactionDone', {
          count: compaction.compactedCount,
          before: compaction.beforeTokens,
          after: compaction.afterTokens,
        }),
      );
      // 压缩物理折叠了中段消息：分页游标（绝对下标）整体失效 → 按末页整体重载。
      // 不重载的话，旧 h<index> 会与压缩后新页的 h<index> 撞 id（错位/丢消息）。
      useStore.getState().resetHistory(sessionId);
      emitHistoryInvalidated(sessionId);
      break;
    }
    case 'context-healed': {
      if (!sessionId) break;
      const payload = (msg.payload ?? {}) as {
        toolCallId?: string;
        healLog?: Array<{ kind: string; detail: string }>;
      };
      if (payload.healLog && payload.healLog.length > 0) {
        toast.info(
          i18n.t('context.healed', { details: payload.healLog.map((h) => h.detail).join('; ') }),
        );
      }
      break;
    }
    case 'file-created': {
      const payload = (msg.payload ?? {}) as { path?: string; source?: string };
      // 实时监控捕获的外部变更不弹 toast（可能非常频繁），由「文件变更」面板展示
      if (payload.path && payload.source !== 'watch') toast.success(`已创建文件: ${payload.path}`);
      break;
    }
    case 'file-edited': {
      const payload = (msg.payload ?? {}) as { path?: string; source?: string };
      if (payload.path && payload.source !== 'watch') toast.success(`已编辑文件: ${payload.path}`);
      break;
    }
    case 'file-deleted': {
      const payload = (msg.payload ?? {}) as { path?: string; source?: string };
      if (payload.path && payload.source !== 'watch') toast.info(`已删除文件: ${payload.path}`);
      break;
    }
    case 'file-moved': {
      const payload = (msg.payload ?? {}) as { path?: string; destPath?: string };
      if (payload.path && payload.destPath) {
        toast.success(`已移动: ${payload.path} → ${payload.destPath}`);
      }
      break;
    }
    case 'terminal-changed': {
      const payload = (msg.payload ?? {}) as {
        report?: { created?: string[]; modified?: string[]; deleted?: string[] };
      };
      const r = payload.report;
      if (r) {
        const count = (r.created?.length ?? 0) + (r.modified?.length ?? 0) + (r.deleted?.length ?? 0);
        if (count > 0) toast.info(`终端命令修改了 ${count} 个文件`);
      }
      break;
    }

    // ======================================================================
    // 任务列表实时同步（后端广播：任意客户端的增删改都不需要刷新本端）
    // ======================================================================
    case 'task.created': {
      const payload = (msg.payload ?? {}) as { task?: TaskItem; group?: TaskGroup };
      if (payload.task) {
        const st = useStore.getState();
        const group = payload.group;
        if (group && !st.taskGroups.some((g) => g.id === group.id)) st.addTaskGroup(group);
        // 已存在同 id（本端已乐观插入 / HTTP 响应先到）→ 用服务端条目覆盖合并：
        // 关键是把 groupId 校正为服务端权威分组，并在分组栏中归位，而不是直接丢弃事件。
        if (st.tasks.some((tk) => tk.id === payload.task!.id)) {
          st.updateTask(payload.task.id, payload.task);
        } else {
          st.addTask(payload.task);
        }
      }
      break;
    }
    case 'task.updated': {
      const payload = (msg.payload ?? {}) as { task?: TaskItem; taskId?: string; running?: boolean };
      const st = useStore.getState();
      if (typeof payload.running === 'boolean') {
        const sid = payload.taskId ?? payload.task?.sessionId ?? payload.task?.id;
        // 运行态是权威信号（后端 run 生命周期广播）：可升可降
        if (sid) {
          st.setGenerating(sid, payload.running);
          // 后端确认已非运行 → 结束停止转圈（覆盖 task.stream 与外部 run）
          if (!payload.running) st.setStopping(sid, false);
        }
      }
      if (payload.task) st.updateTask(payload.task.id, payload.task);
      break;
    }
    case 'task.deleted': {
      const payload = (msg.payload ?? {}) as { taskId?: string };
      if (payload.taskId) useStore.getState().removeTask(payload.taskId);
      break;
    }
    case 'tasks.reordered':
    case 'tasks.changed': {
      const payload = (msg.payload ?? {}) as { tasks?: TaskItem[]; groups?: TaskGroup[] };
      const st = useStore.getState();
      // 顺序：先更新分组，再物化全量任务快照（applyFullTaskSnapshot 按最新分组标记各分组加载态）
      if (Array.isArray(payload.groups)) st.setTaskGroups(payload.groups);
      if (Array.isArray(payload.tasks)) st.applyFullTaskSnapshot(payload.tasks);
      break;
    }
    case 'task-groups.changed': {
      const payload = (msg.payload ?? {}) as { groups?: TaskGroup[] };
      if (Array.isArray(payload.groups)) useStore.getState().setTaskGroups(payload.groups);
      break;
    }

    // ======================================================================
    // 自动化 / 子代理
    // ======================================================================
    case 'automation.started': {
      const payload = (msg.payload ?? {}) as {
        automationId?: string;
        runId?: string;
        startedAt?: string;
        taskId?: string;
      };
      if (!payload.automationId || !payload.runId || !payload.startedAt) break;
      const st = useStore.getState();
      st.addAutomationRun(payload.automationId, {
        id: payload.runId,
        automationId: payload.automationId,
        taskId: payload.taskId,
        startedAt: payload.startedAt,
        status: 'running',
      });
      st.updateAutomation(payload.automationId, { lastRunAt: payload.startedAt });
      if (payload.taskId) st.setGenerating(payload.taskId, true);
      break;
    }
    case 'automation.finished': {
      const payload = (msg.payload ?? {}) as {
        automationId?: string;
        runId?: string;
        taskId?: string;
        status?: AutomationRun['status'];
        finishReason?: string;
        finalText?: string;
        error?: string;
        finishedAt?: string;
      };
      if (!payload.automationId || !payload.runId) break;
      const st = useStore.getState();
      st.updateAutomationRun(payload.automationId, payload.runId, {
        finishedAt: payload.finishedAt,
        status: payload.status ?? 'success',
        finishReason: payload.finishReason,
        finalText: payload.finalText,
        error: payload.error,
      });
      if (payload.finishedAt) st.updateAutomation(payload.automationId, { lastRunAt: payload.finishedAt });
      if (payload.taskId) st.setGenerating(payload.taskId, false);
      break;
    }
    case 'subagent.event': {
      const payload = (msg.payload ?? {}) as {
        taskId?: string;
        parentToolCallId?: string;
        event?: AgentEvent;
      };
      if (!payload.taskId) break;
      // 按父工具调用 id 精确绑定子代理会话 id（同模板并发也互不串台；
      // 绑定表见 lib/subagent-sessions.ts）
      if (payload.parentToolCallId) {
        bindSubagentSession(payload.parentToolCallId, payload.taskId);
      }
      // 实时过程：把子代理的内层 agent 事件按「子代理自己的会话 id」复用主 agent reducer，
      // 卡片展开后即可像主 agent 一样看到思考 / 流式正文 / 工具调用状态。
      const ev = payload.event;
      if (ev && ev.sessionId && SUBAGENT_DISPLAY_EVENT_TYPES.has(ev.type)) {
        applyWsMessage(
          { type: ev.type, sessionId: ev.sessionId, payload: ev },
          { silent: true },
        );
      }
      break;
    }
    case 'config.changed': {
      // 具体重拉由 useConfig hook 独立订阅 wsClient.onMessage 触发，此处不重复处理
      break;
    }

    default:
      // 未知消息类型忽略
      break;
  }

  // 一轮结束（终态事件）：输出本轮前端分片账本并清零。
  // 判定口径：received==0 → 后端没发/WS 没到；received>0 且 applied==0 → 前端丢流（看 dropped* 归因）。
  if (sessionId && AGENT_TERMINAL_EVENT_TYPES.has(msg.type) && !terminalRunIdMismatch) {
    dumpStreamAccounting(sessionId);
  }
}

/** pending 丢失（流式中刷新）时回退：定位 store 中最后一条含该 toolCallId 的 assistant 消息 */
function findMessageByToolCallId(sid: string, toolCallId: string): TaskMessage | null {
  const msgs = useStore.getState().messagesBySession[sid] ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === toolCallId)) return m;
  }
  return null;
}

/**
 * 工具类事件的目标消息解析：
 * - 服务端给了 messageId 且本地存在 → 直接命中（刷新恢复后的精确对齐）
 * - 否则回落到当前 pending（同一轮）
 * - 都没有 → 返回 null，由调用方的历史回退逻辑兜底
 */
function ensureStreamingMessage(sessionId: string, messageId?: string): TaskMessage | null {
  const st = useStore.getState();
  const msgs = st.messagesBySession[sessionId] ?? [];
  if (messageId) {
    const found = msgs.find((m) => m.id === messageId);
    if (found) {
      if (!found.streaming) st.updateMessage(sessionId, messageId, { streaming: true });
      const revived: TaskMessage = { ...found, streaming: true };
      pendingAssistant.set(sessionId, revived);
      return revived;
    }
  }
  const pending = pendingAssistant.get(sessionId);
  if (pending) {
    // 服务端消息 id 已推进到新一轮 → 旧 pending 定稿后另建
    if (messageId && pending.serverMessageId !== messageId) {
      st.updateMessage(sessionId, pending.id, { streaming: false, thinkingStreaming: false });
      pendingAssistant.delete(sessionId);
    } else {
      return pending;
    }
  }
  if (!messageId) return null;
  const created: TaskMessage = {
    id: messageId,
    serverMessageId: messageId,
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    streaming: true,
    thinkingStreaming: false,
  };
  st.addMessage(sessionId, created);
  pendingAssistant.set(sessionId, created);
  return created;
}

/**
 * 尾部增量补齐（分页循环拉取 after 之后的全部消息）。
 * 用途：一轮结束 / WS 重连后的「本地流式草稿 → 服务端正式消息」对齐。
 * 循环上限兜底，避免异常游标导致死循环。
 */
export async function fetchTailPages(
  sessionId: string,
  after: number,
  pageSize = 200,
): Promise<{ messages: TaskMessage[]; newestIndex: number; total: number } | null> {
  const collected: TaskMessage[] = [];
  let cursor = after;
  let total = after + 1;
  for (let guard = 0; guard < 50; guard++) {
    let resp: Awaited<ReturnType<typeof api.getSessionHistory>>;
    try {
      resp = await api.getSessionHistory(sessionId, { limit: pageSize, after: cursor });
    } catch {
      return collected.length > 0 ? { messages: collected, newestIndex: cursor, total } : null;
    }
    collected.push(...resp.messages);
    if (!resp.page) return { messages: collected, newestIndex: cursor, total };
    total = resp.page.total;
    const next = resp.page.newestIndex;
    if (next <= cursor || resp.messages.length < pageSize) {
      return { messages: collected, newestIndex: next, total };
    }
    cursor = next;
  }
  return { messages: collected, newestIndex: cursor, total };
}