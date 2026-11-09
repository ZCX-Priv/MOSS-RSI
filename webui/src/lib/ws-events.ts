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
import { pendingAssistant, pendingGuideRunIds, pendingRunId } from './pending-assistant';
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
  requestStreamResync,
  seedStreamLength,
} from './stream-buffer';
import { diag, diagAlways } from './diag';
import { emitInsightEvent } from './insight-bus';
import { bindSubagentSession } from './subagent-sessions';
import { applyAgentBusMember, applyAgentBusMessage } from './agent-bus';
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
  CodeRunLiveCall,
  RunStats,
  CompactionRecord,
  ContextStats,
  LiveDraftPayload,
  SessionSubscribedPayload,
  InsightEvent,
  AskQuestion,
  AgentBusMember,
  AgentBusMessage,
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
  'run-code-progress',
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
  'run-code-progress',
  'ask', 'ask-timeout', 'confirm-required', 'review-start', 'review-end',
  'stats-updated', 'error', 'done',
]);

/** 读取事件的 runId（agent 事件 payload 顶层） */
function eventRunIdOf(msg: WSMessage): string | undefined {
  const v = (msg.payload as { runId?: unknown } | undefined)?.runId;
  return typeof v === 'string' ? v : undefined;
}

/**
 * 本地 run 被服务端权威 runId 替换的宽限期（ms）。
 * 覆盖「前端已 beginRun、task.stream 尚未被后端处理」的竞态：此窗口内到达的旧快照
 * 不得把刚点亮的本地 runId 覆盖掉。
 */
const RUN_ADOPT_GRACE_MS = 5_000;

/**
 * 无身份 `task.updated { running:false }` 的宽松期（ms）。
 * 与 store 里「任务列表 running」的宽限口径一致：刚发起的本地 run 在这段时间内
 * 绝不能被一条无法指名 run 的空闲广播熄灭/终止（否则新 run 会被列入终止集合）。
 */
const RUN_IDLE_GRACE_MS = 60_000;

/**
 * 以服务端权威 runId 对齐本地 activeRun。
 *
 * 为什么必须对齐：前端 runId 过滤（AGENT_STREAM_EVENT_TYPES）只放行与本地 activeRun
 * 相同的分片。重连 / 多客户端（WebUI + CLI）切换 / 终态丢失后，本地 activeRun 可能是旧
 * runId；若不对齐，新 run 的全部流式事件（含 tool-call-start / stats-updated）都会被丢弃，
 * 前端永久停在「响应中」，只有刷新（activeRun 清空）后才恢复。
 */
export function adoptAuthoritativeRunId(sessionId: string, runId: string | undefined): void {
  if (!sessionId || !runId) return;
  const st = useStore.getState();
  const active = st.activeRunBySession[sessionId];
  if (active?.runId === runId) return;
  // 本地刚发起的新 run 还在「后端尚未注册」的窗口：保留本地 runId，不做覆盖
  if (active && Date.now() - active.startedAt < RUN_ADOPT_GRACE_MS) return;
  diagAlways('runid-adopt-authoritative', {
    sessionId,
    runId,
    prevRunId: active?.runId,
  });
  pendingRunId.set(sessionId, runId);
  st.beginRun(sessionId, runId);
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
  const activeRunId = st.activeRunBySession[sessionId]?.runId;
  const msg: TaskMessage = {
    id: draft.messageId,
    serverMessageId: draft.messageId,
    role: 'assistant',
    ...(activeRunId ? { runId: activeRunId } : {}),
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
      // 服务端草稿代表「新一轮仍在进行」：清除上一次本地定稿留下的屏障
      streamEndedAt: undefined,
      ...(activeRunId ? { runId: activeRunId } : {}),
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

  // runId 过滤：丢弃旧 run 的分片，防止「打断发送/停止」时旧流污染新流状态。
  // 停止语义的关键：abort 不再删除当前 runId，而是把 runId 记入 terminated 集合；
  // 该 run 的任何事件（含终态）在本地都已无意义，入口直接丢弃 —— 否则会出现
  // 「停止后内容继续增长 / 已停止又跳回运行中」。
  const eventRunId = eventRunIdOf(msg);
  if (sessionId && s.isRunTerminated(sessionId, eventRunId)) {
    // 唯一例外：引导续跑交接。后端已消费引导并在同一 while 中启动了 nextRunId；
    // 若因「本轮刚被本地停止」而丢掉这条 task.done，新 run 的所有事件都会被旧簿记
    // 过滤掉（nextRunId 只在这里送达），表现为永久「响应中」且无自愈路径。
    const nextRunId = (msg.payload as { nextRunId?: unknown } | undefined)?.nextRunId;
    if (msg.type === 'task.done' && typeof nextRunId === 'string' && nextRunId) {
      diagAlways('runid-handoff-adopt', { sessionId, eventRunId, nextRunId });
      pendingRunId.set(sessionId, nextRunId);
      // 只消费本次交接的一条；后端队列里剩余引导仍会按 FIFO 继续交接
      pendingGuideRunIds.shift(sessionId);
      useStore.getState().beginRun(sessionId, nextRunId);
      return;
    }
    noteStreamRunIdDrop(sessionId);
    diagAlways('stream-terminated-drop', { type: msg.type, eventRunId, sessionId });
    return;
  }
  if (sessionId && AGENT_STREAM_EVENT_TYPES.has(msg.type)) {
    const currentRunId = s.activeRunBySession[sessionId]?.runId ?? pendingRunId.get(sessionId);
    if (eventRunId && currentRunId && eventRunId !== currentRunId) {
      noteStreamRunIdDrop(sessionId);
      diagAlways('stream-runid-drop', { type: msg.type, eventRunId, currentRunId, sessionId });
      // 不静默等死：一次权威对账就能用 /state 的 liveDraft 把内容接回来
      //（requestStreamResync 自带 1s 冷却，不会形成请求风暴）。
      requestStreamResync(sessionId);
      return;
    }
    // 账本：先记「收到」（后续是否被 store 应用/丢弃由 stream-buffer 归因）
    if (STREAM_CHUNK_TYPES.has(msg.type)) noteStreamReceived(sessionId);
  }
  const terminalRunIdMismatch =
    sessionId !== '' &&
    AGENT_TERMINAL_EVENT_TYPES.has(msg.type) &&
    (() => {
      const currentRunId = s.activeRunBySession[sessionId]?.runId ?? pendingRunId.get(sessionId);
      return Boolean(eventRunId && currentRunId && eventRunId !== currentRunId);
    })();
  if (terminalRunIdMismatch) {
    diagAlways('terminal-runid-mismatch', {
      type: msg.type,
      eventRunId: eventRunIdOf(msg),
      currentRunId: pendingRunId.get(sessionId),
      sessionId,
    });
    // 终态与本地 run 认知不一致：不能静默吞掉（否则本地永久停在旧 run）。
    // 交给编排层做一次权威对账（/state 的 running + runId），按后端真实状态对齐或收敛。
    if (sessionId) requestStreamResync(sessionId);
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
      // 无身份分片不再用 genId 造「游离消息」（会产生多条同时 streaming 的消息，
      // 让 finalize 与状态判定全部失真）；丢弃并请求一次 /state 对齐。
      const messageId = event.messageId ?? pendingAssistant.get(sessionId)?.id;
      if (!messageId) {
        requestStreamResync(sessionId);
        break;
      }
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
      const messageId = event.messageId ?? pendingAssistant.get(sessionId)?.id;
      if (!messageId) {
        requestStreamResync(sessionId);
        break;
      }
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
      // 引擎严格按轮次串行：新工具调用开始时，其它消息里的工具不可能仍在执行。
      // 收敛掉它们，避免 done 事件丢失后旧卡片永久转圈。
      s.finalizeToolCallsExcept(sessionId, pending.id);
      const newToolCall: ToolCall = {
        id: event.toolCallId,
        name: event.toolName,
        arguments: '',
        status: 'generating',
      };
      const existing = pending.toolCalls ?? [];
      // 幂等：同 id 已存在（重连重放 / 草稿已含该调用）时不重复追加。
      // 状态单向：done 不回退；executing 也不回退为 generating（状态回跳会让已开始的工具看起来重新生成）。
      const merged = existing.some((tc) => tc.id === event.toolCallId)
        ? existing.map((tc) =>
            tc.id === event.toolCallId
              ? {
                  ...tc,
                  name: event.toolName,
                  status:
                    tc.status === 'done' || tc.status === 'executing'
                      ? tc.status
                      : ('generating' as const),
                }
              : tc,
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
      const target = resolveToolCallTarget(
        sessionId,
        event.toolCallId,
        pendingAssistant.get(sessionId)?.id ?? event.messageId,
      );
      if (!target?.toolCalls) break;
      const updatedToolCalls = target.toolCalls.map((tc) =>
        tc.id === event.toolCallId && tc.status !== 'done'
          ? { ...tc, status: 'executing' as const }
          : tc,
      );
      s.updateMessage(sessionId, target.id, { toolCalls: updatedToolCalls });
      const pending = pendingAssistant.get(sessionId);
      if (pending && pending.id === target.id) {
        pendingAssistant.set(sessionId, { ...pending, toolCalls: updatedToolCalls });
      }
      break;
    }
    case 'tool-call-end': {
      flushPending(); // 保证参数分片先写入，避免 end 后还有残余 delta
      const event = msg.payload as Extract<AgentEvent, { type: 'tool-call-end' }> & { messageId?: string };
      if (!sessionId) break;
      // 同一 PTC 调用的缓冲进度必须先落地，再写最终结果（否则会被迟到进度覆盖状态）
      flushRunCodeProgress(sessionId, event.toolCallId);
      const target = resolveToolCallTarget(
        sessionId,
        event.toolCallId,
        pendingAssistant.get(sessionId)?.id ?? event.messageId,
      );
      if (target?.toolCalls) {
        const updatedToolCalls = target.toolCalls.map((tc) =>
          tc.id === event.toolCallId
            ? { ...tc, name: event.toolName, status: 'done' as const }
            : tc,
        );
        // 结果按 toolCallId 去重覆盖：重复投递/重连重放时不会出现重复结果条目
        const prevResults = target.toolResults ?? [];
        const resultMap = new Map(prevResults.map((tr) => [tr.toolCallId, tr]));
        resultMap.set(event.toolCallId, { toolCallId: event.toolCallId, result: event.result });
        const updatedToolResults = Array.from(resultMap.values());
        s.updateMessage(sessionId, target.id, {
          toolCalls: updatedToolCalls,
          toolResults: updatedToolResults,
        });
        const pending = pendingAssistant.get(sessionId);
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
    case 'run-code-progress': {
      // 高频进度（日志/并行调用）先进 100ms 合并队列：一条消息只写一次 store，
      // 避免几十次嵌套调用产生上百次整条消息替换与整卡重渲染。
      flushPending();
      const event = msg.payload as {
        toolCallId?: string;
        messageId?: string;
        payload?: {
          phase?: 'started' | 'log' | 'call-start' | 'call-end';
          startedAtMs?: number;
          log?: string;
          call?: CodeRunLiveCall;
        };
      };
      if (!sessionId || !event.toolCallId || !event.payload) break;
      queueRunCodeProgress(sessionId, event.toolCallId, event.payload);
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
        ruleSuggestion: event.ruleSuggestion,
        source: event.source,
        createdAt: Date.now(),
      });
      break;
    }
    case 'review-start': {
      const event = msg.payload as Extract<AgentEvent, { type: 'review-start' }>;
      const owner = event.parentSessionId ?? event.sessionId ?? sessionId;
      if (owner) s.addReviewing(owner);
      break;
    }
    case 'review-end': {
      const event = msg.payload as Extract<AgentEvent, { type: 'review-end' }>;
      const owner = event.parentSessionId ?? event.sessionId ?? sessionId;
      if (owner) s.removeReviewing(owner);
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
      // 协议级错误（如「该确认已失效」）不带 sessionId：只提示，不进入会话错误态。
      // 否则会用 activeSessionId 兜底，把当前会话里仍在运行的任务误标记为失败并停止「正在回复」。
      if (!msg.sessionId) {
        const protocolMessage = ((msg.payload ?? {}) as { message?: string }).message ?? '';
        const localizedProtocolMessage = i18n.exists(`errors.${protocolMessage}`)
          ? i18n.t(`errors.${protocolMessage}`)
          : (protocolMessage || i18n.t('errors.UNKNOWN'));
        if (!opts?.silent) toast.error(localizedProtocolMessage);
        break;
      }
      if (terminalRunIdMismatch) break; // 旧 run 的终态：只观测，不改当前状态
      const event = (msg.payload ?? {}) as { message?: string; providerError?: string; messageId?: string };
      const errorCode = event.message ?? '';
      const localizedMessage = i18n.exists(`errors.${errorCode}`)
        ? i18n.t(`errors.${errorCode}`)
        : (errorCode || i18n.t('errors.UNKNOWN'));
      // 原始 provider 错误文本（用于错误卡片正文 + 「诊断」弹窗输入；与刷新后历史恢复字段一致）
      const errorDetail = event.providerError ?? localizedMessage;
      if (sessionId) {
        // 失败终止：未生效的引导不会被执行（后端 run 已结束）
        pendingGuideRunIds.clear(sessionId);
        s.finalizeStreamingMessages(sessionId, eventRunId);
        s.finalizeToolCalls(sessionId, eventRunId);
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
        s.terminateRun(sessionId, eventRunId);
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
      const doneEvent = (msg.payload ?? {}) as Extract<AgentEvent, { type: 'done' }> & {
        nextRunId?: string;
      };
      if (sessionId) {
        // 只定稿本轮消息：引导交接时新 run 可能已开始流式，不能把它的消息一并定稿
        flushRunCodeProgress(sessionId);
        s.finalizeStreamingMessages(sessionId, doneEvent.runId ?? eventRunId);
        s.finalizeToolCalls(sessionId, doneEvent.runId ?? eventRunId);
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
        // 统一收敛点：记入终止集合 + 定稿本轮消息 + 熄灭生成态（不再裸写 generating）
        s.terminateRun(sessionId, doneEvent.runId ?? eventRunId);
        // 引导续跑：后端在旧 run 收尾的同一时刻已挂起新 run（nextRunId），
        // 立即以其点亮本地状态，保证新 run 的分片不被旧 run 过滤丢弃。
        if (doneEvent.nextRunId) {
          pendingGuideRunIds.shift(sessionId); // 消费已生效的引导条目
          pendingRunId.set(sessionId, doneEvent.nextRunId);
          useStore.getState().beginRun(sessionId, doneEvent.nextRunId);
        } else {
          pendingGuideRunIds.clear(sessionId); // 正常结束：未生效的引导一并作废
        }
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
      const taskDoneEvent = (msg.payload ?? {}) as { runId?: string; nextRunId?: string };
      if (sessionId) {
        // 只定稿本轮消息（同 done：交接瞬间不得定稿下一轮已在流式的消息）
        flushRunCodeProgress(sessionId);
        s.finalizeStreamingMessages(sessionId, eventRunId);
        s.finalizeToolCalls(sessionId, taskDoneEvent.runId ?? eventRunId);
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
        s.terminateRun(sessionId, eventRunId);
        // 引导续跑承接（与 done 分支同语义）
        if (taskDoneEvent.nextRunId) {
          pendingGuideRunIds.shift(sessionId);
          pendingRunId.set(sessionId, taskDoneEvent.nextRunId);
          useStore.getState().beginRun(sessionId, taskDoneEvent.nextRunId);
        } else {
          pendingGuideRunIds.clear(sessionId);
        }
        emitSettled(sessionId, 'done');
      }
      break;
    }
    case 'task.aborted': {
      flushPending();
      if (terminalRunIdMismatch) break; // 旧 run 的终态：只观测，不改当前状态
      // 用户主动中断：后端 run 已结束，这里才是「彻底停下」的权威收敛点
      if (sessionId) {
        // 未生效的引导随停止一并作废（后端已中止，不会再续跑）
        pendingGuideRunIds.clear(sessionId);
        flushRunCodeProgress(sessionId);
        s.finalizeStreamingMessages(sessionId, eventRunId);
        s.finalizeToolCalls(sessionId, eventRunId);
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
        s.terminateRun(sessionId, eventRunId);
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
        // 权威 runId 对齐：本地 activeRun 若是旧 run，必须切到后端当前 runId，
        // 否则该 run 的流式分片会被 runId 过滤全部丢弃（「响应中」永挂、刷新才恢复的根因）。
        adoptAuthoritativeRunId(sessionId, payload.runId);
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
    case 'terminal.interrupt.ack': {
      // 停止命令结果：ok=false 时前端立即复位按钮并提示（命令已结束/无中断句柄）
      const payload = (msg.payload ?? {}) as {
        toolCallId?: string;
        ok?: boolean;
        terminalId?: string;
        reason?: string;
      };
      if (!payload.toolCallId) break;
      useStore.getState().setTerminalInterruptAck(payload.toolCallId, {
        ok: payload.ok === true,
        ...(payload.terminalId ? { terminalId: payload.terminalId } : {}),
        ...(payload.reason ? { reason: payload.reason } : {}),
      });
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
      const payload = (msg.payload ?? {}) as {
        task?: TaskItem;
        taskId?: string;
        running?: boolean;
        /** 该广播所描述的那一轮 run 身份（后端新增；旧后端缺省） */
        runId?: string;
      };
      const st = useStore.getState();
      if (typeof payload.running === 'boolean') {
        const sid = payload.taskId ?? payload.task?.sessionId ?? payload.task?.id;
        if (sid) {
          const localRunId = st.activeRunBySession[sid]?.runId ?? pendingRunId.get(sid);
          if (payload.running) {
            if (!st.activeRunBySession[sid]) st.setGenerating(sid, true);
            // 权威 runId 对齐：其它标签页 / 自动化发起的 run 也要能被本端正确接收
            adoptAuthoritativeRunId(sid, payload.runId);
          } else if (payload.runId !== undefined) {
            if (localRunId && localRunId !== payload.runId) {
              // 这条 false 属于已被顶替的旧 run（典型：停止后立刻中断发送、排队自动续发、
              // 旧 run 收尾广播晚于新 run 发起）。绝不能终止「当前 run」——那会把新 runId
              // 记入终止集合，使它的全部事件（含终态）在入口被永久丢弃，永远停在「响应中」。
              diagAlways('runid-terminate-skip', {
                sessionId: sid,
                eventRunId: payload.runId,
                localRunId,
              });
              requestStreamResync(sid);
            } else {
              st.terminateRun(sid, payload.runId);
            }
          } else {
            // 旧后端（无身份空闲广播）：本地 run 在宽松期内不降级，只做权威对账。
            const startedAt = st.activeRunBySession[sid]?.startedAt;
            if (startedAt !== undefined && Date.now() - startedAt < RUN_IDLE_GRACE_MS) {
              requestStreamResync(sid);
            } else {
              st.terminateRun(sid);
            }
          }
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
    case 'subagent.todo': {
      // 子代理自己的 todo（与主会话完全隔离）：只写入 agentSessionId 对应的子代理会话，
      // 绝不触碰主会话的 todos。数据源仍是该子代理 sessionId 的独立落盘文件。
      const payload = (msg.payload ?? {}) as {
        agentSessionId?: string;
        todos?: TodoItem[];
        toolCallId?: string;
      };
      const agentSessionId = payload.agentSessionId;
      if (!agentSessionId || !Array.isArray(payload.todos)) break;
      useStore.getState().setTodos(agentSessionId, payload.todos);
      if (payload.toolCallId) {
        const msgs = useStore.getState().messagesBySession[agentSessionId] ?? [];
        const target = msgs.find((m) => m.toolCalls?.some((tc) => tc.id === payload.toolCallId));
        if (target && target.todoSnapshot === undefined) {
          useStore
            .getState()
            .updateMessage(agentSessionId, target.id, { todoSnapshot: payload.todos });
        }
      }
      break;
    }
    case 'agent-bus.event': {
      const payload = (msg.payload ?? {}) as {
        type?: string;
        member?: AgentBusMember;
        message?: AgentBusMessage;
      };
      if (payload.type === 'member' && payload.member) {
        applyAgentBusMember(payload.member);
      } else if (payload.type === 'message' && payload.message) {
        applyAgentBusMessage(payload.message);
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
 * 定位 toolCall 真正所属的消息。
 * 旧实现只「先按 pending 找，找不到再用全局」，当 pending 存在但该消息不含此 toolCallId 时
 * 事件会被静默丢弃（大量并行调用后状态错乱的根因）。这里优先命中真正包含该 id 的消息。
 */
function resolveToolCallTarget(
  sessionId: string,
  toolCallId: string,
  preferredId?: string,
): TaskMessage | null {
  const msgs = useStore.getState().messagesBySession[sessionId] ?? [];
  if (preferredId) {
    const preferred = msgs.find((m) => m.id === preferredId);
    if (preferred?.toolCalls?.some((tc) => tc.id === toolCallId)) return preferred;
  }
  return findMessageByToolCallId(sessionId, toolCallId);
}

// ============================================================================
// run_code 实时进度：100ms 合并队列
// ============================================================================

interface PendingRunCodeProgress {
  sessionId: string;
  toolCallId: string;
  startedAtMs?: number;
  /** 尚未落库的日志（按到达顺序拼接） */
  logs: string[];
  /** 尚未落库的嵌套调用状态（按 id 覆盖合并） */
  calls: Map<string, CodeRunLiveCall>;
}

const pendingRunCode = new Map<string, PendingRunCodeProgress>();
let runCodeFlushTimer: ReturnType<typeof setTimeout> | null = null;

function queueRunCodeProgress(
  sessionId: string,
  toolCallId: string,
  progress: {
    phase?: 'started' | 'log' | 'call-start' | 'call-end';
    startedAtMs?: number;
    log?: string;
    call?: CodeRunLiveCall;
  },
): void {
  const key = `${sessionId}:${toolCallId}`;
  let entry = pendingRunCode.get(key);
  if (!entry) {
    entry = { sessionId, toolCallId, logs: [], calls: new Map() };
    pendingRunCode.set(key, entry);
  }
  if (progress.phase === 'started') {
    if (progress.startedAtMs) entry.startedAtMs = progress.startedAtMs;
  } else if (progress.phase === 'log') {
    const log = progress.log ?? '';
    if (log) {
      entry.logs.push(log);
      if (entry.logs.length > 200) entry.logs.splice(0, entry.logs.length - 200);
    }
  } else if ((progress.phase === 'call-start' || progress.phase === 'call-end') && progress.call) {
    const call = progress.call;
    const prev = entry.calls.get(call.id);
    entry.calls.set(call.id, prev ? { ...prev, ...call } : call);
  }
  if (runCodeFlushTimer === null) {
    runCodeFlushTimer = setTimeout(() => {
      runCodeFlushTimer = null;
      flushRunCodeProgress();
    }, 100);
  }
}

/** 按 seq 排序（并行完成顺序 ≠ 调用顺序；旧数据无 seq 时保持原相对顺序） */
function sortLiveCalls(calls: CodeRunLiveCall[]): CodeRunLiveCall[] {
  return calls
    .map((call, index) => ({ call, index }))
    .sort((a, b) => {
      const sa = a.call.seq;
      const sb = b.call.seq;
      if (sa !== undefined && sb !== undefined && sa !== sb) return sa - sb;
      if (sa !== undefined && sb === undefined) return -1;
      if (sa === undefined && sb !== undefined) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.call);
}

/**
 * 落地缓冲进度。可按 session/toolCallId 过滤。
 * 已完成（done）的工具一律忽略：PTC 结束后迟到的 log/call-end 不得把状态打回执行中。
 */
function flushRunCodeProgress(sessionId?: string, toolCallId?: string): void {
  if (pendingRunCode.size === 0) return;
  const entries: PendingRunCodeProgress[] = [];
  for (const entry of pendingRunCode.values()) {
    if (sessionId && entry.sessionId !== sessionId) continue;
    if (toolCallId && entry.toolCallId !== toolCallId) continue;
    entries.push(entry);
    pendingRunCode.delete(`${entry.sessionId}:${entry.toolCallId}`);
  }
  if (entries.length === 0) return;

  // 同一目标消息的多个条目合并为一次 updateMessage
  const perMessage = new Map<string, { sessionId: string; toolCalls: ToolCall[] }>();
  for (const entry of entries) {
    const target = resolveToolCallTarget(entry.sessionId, entry.toolCallId);
    if (!target?.toolCalls) continue;
    const baseToolCalls = perMessage.get(target.id)?.toolCalls ?? target.toolCalls;
    const updated = baseToolCalls.map((tc): ToolCall => {
      if (tc.id !== entry.toolCallId || tc.status === 'done') return tc;
      const live = tc.live ?? { calls: [], logs: [] };
      const logs =
        entry.logs.length > 0
          ? [...live.logs, ...entry.logs].slice(-200)
          : live.logs;
      const callMap = new Map(live.calls.map((call) => [call.id, call]));
      for (const call of entry.calls.values()) {
        const prev = callMap.get(call.id);
        callMap.set(call.id, prev ? { ...prev, ...call } : call);
      }
      return {
        ...tc,
        status: 'executing',
        live: {
          ...live,
          ...(entry.startedAtMs ? { startedAtMs: entry.startedAtMs } : {}),
          logs,
          calls: sortLiveCalls([...callMap.values()]),
        },
      };
    });
    perMessage.set(target.id, { sessionId: entry.sessionId, toolCalls: updated });
  }

  for (const [messageId, data] of perMessage) {
    const st = useStore.getState();
    st.updateMessage(data.sessionId, messageId, { toolCalls: data.toolCalls });
    const pending = pendingAssistant.get(data.sessionId);
    if (pending && pending.id === messageId) {
      pendingAssistant.set(data.sessionId, { ...pending, toolCalls: data.toolCalls });
    }
  }
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
      // 已定稿消息不再复活（停止后的迟到 tool 事件不得让它重新进入流式态）
      if (found.streamEndedAt) return null;
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
 * 尾部增量补齐（分页循环拉取 after 之后的消息）。
 * 用途：一轮结束 / WS 重连后的「本地流式草稿 → 服务端正式消息」对齐。
 * 循环上限兜底，避免异常游标导致死循环。
 *
 * 性能约束（首屏卡顿根因修复）：
 * - 游标缺失（after < 0）时**不再把全部历史当成增量**：改为只取末页 pageSize 条。
 *   旧行为在「WS 快照先于 HTTP 首屏返回」时会请求 limit=200&after=-1，
 *   把三千万级字符的长会话（实测 2.29MB / 92 条）一次性拉回，直接拖垮启动。
 * - 页大小 200 → 50、最多 4 页（200 条）：断线补齐仍够用，单次解析量可控。
 */
export async function fetchTailPages(
  sessionId: string,
  after: number,
  pageSize = 50,
): Promise<{ messages: TaskMessage[]; newestIndex: number; total: number } | null> {
  const collected: TaskMessage[] = [];
  let cursor = after;
  let total = Math.max(0, after + 1);
  for (let guard = 0; guard < 4; guard++) {
    let resp: Awaited<ReturnType<typeof api.getSessionHistory>>;
    try {
      // 游标缺失：只拉末页（首屏历史由 useSessionHistory 负责，不在这里全量重拉）
      resp =
        cursor >= 0
          ? await api.getSessionHistory(sessionId, { limit: pageSize, after: cursor })
          : await api.getSessionHistory(sessionId, { limit: pageSize });
    } catch {
      return collected.length > 0 ? { messages: collected, newestIndex: cursor, total } : null;
    }
    collected.push(...resp.messages);
    if (!resp.page) {
      return { messages: collected, newestIndex: Math.max(cursor, after), total };
    }
    total = resp.page.total;
    const next = resp.page.newestIndex;
    if (next <= cursor || resp.messages.length < pageSize) {
      return { messages: collected, newestIndex: next, total };
    }
    cursor = next;
  }
  return { messages: collected, newestIndex: cursor, total };
}