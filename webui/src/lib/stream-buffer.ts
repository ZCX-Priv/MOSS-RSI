// webui/src/lib/stream-buffer.ts
// 流式分片缓冲 + offset 续传（「刷新/断线重连后半截回复能接着长」的核心）。
//
// 为什么需要 offset：
//   后端为每条流式消息分配稳定 messageId（`<sessionId>#<turn>`），并给每个分片附带
//   该分片在所属字段中的起始下标 offset。前端据此可以：
//     ① 去重 —— 分片被重复投递（重连重放 / 多路径送达）时整体丢弃；
//     ② 续接 —— 刷新后先用服务端草稿把内容补齐，后续分片自动从草稿长度处接上，无空档无重复；
//     ③ 缺口自检 —— offset 跳变时标记需要重新对齐（触发一次尾部增量拉取）。
//   仅靠「前端自己数长度」无法做到：批处理、重连、多标签页都会破坏本地长度假设。
//
// 性能：分片先进入本模块的缓冲，由 requestAnimationFrame 合并后一次性写入 store
// （原先每条分片触发一次 store.set 的做法会饿死渲染）。合并仅在「严格连续」时进行，
// 非连续分片立即冲刷，避免把不同区间的内容拼在一起造成错位。

import { useStore } from '../store';
import { pendingAssistant } from './pending-assistant';
import { diag, diagAlways, diagCount } from './diag';
import type { TaskMessage } from '../types/api';

/** 纯函数：依据服务端 offset 计算「本次应追加的片段」 */
export function nextChunkSlice(
  currentLength: number,
  offset: number | undefined,
  text: string,
): { slice: string; resync: boolean } {
  if (!text) return { slice: '', resync: false };
  // 无 offset（旧后端 / 非流式来源）：退化为尾部追加
  if (offset === undefined || !Number.isFinite(offset)) {
    return { slice: text, resync: false };
  }
  const start = Math.max(0, Math.floor(offset));
  const end = start + text.length;
  if (end <= currentLength) return { slice: '', resync: false }; // 重复分片
  if (start > currentLength) return { slice: '', resync: true }; // 缺口
  return { slice: text.slice(currentLength - start), resync: false };
}

/** 待冲刷的文本分片（同一 (sessionId, messageId, field) 连续区间合并） */
interface PendingText {
  sessionId: string;
  messageId: string;
  field: 'content' | 'thinking';
  offset: number | undefined;
  text: string;
  /** 下一次追加的起始下标（用于判断连续性） */
  nextOffset: number;
  thinkingStreaming: boolean;
}

/** 待冲刷的工具参数分片 */
interface PendingToolArgs {
  sessionId: string;
  messageId: string;
  toolCallId: string;
  offset: number | undefined;
  text: string;
  nextOffset: number;
}

const pendingTextMap = new Map<string, PendingText>();
const pendingToolArgsMap = new Map<string, PendingToolArgs>();
let rafId: number | null = null;
/** 超时兜底冲刷定时器（后台标签页/节流环境下 rAF 可能长时间不触发） */
let flushTimerId: ReturnType<typeof setTimeout> | null = null;

/** 各流式字段的已知长度缓存（key = sessionId|messageId|field）：让每次分片的 offset 校验为 O(1) */
const lengthCache = new Map<string, number>();
/** resync 请求回调（由会话编排 hook 注册：触发一次尾部增量拉取） */
type ResyncHandler = (sessionId: string) => void;
const resyncHandlers = new Set<ResyncHandler>();
/** 已请求过 resync 的会话（attachLiveDraft 完成对齐后清除，同一 run 内允许再次触发） */
const resyncRequested = new Set<string>();
/**
 * 缺口分片暂存（key 同 lengthKey）：gap 触发 resync 时把分片存起来，
 * 对齐完成（attachLiveDraft 全量覆盖 + 重播种长度）后重放——按新长度自然去重，
 * 修复「二次缺口永久静默丢弃 → 回复终止」。
 */
const pendingAfterResync = new Map<string, PendingText>();
/** 缺口重放的每字段重试计数（防止草稿持续滞后时无限循环） */
const resyncReplayRetries = new Map<string, number>();
/** 重放次数上限：超过即放弃该分片（服务端正式消息会在 done 后整体覆盖对齐） */
const MAX_REPLAY_RETRIES = 3;

export function onStreamResyncNeeded(handler: ResyncHandler): () => void {
  resyncHandlers.add(handler);
  return () => resyncHandlers.delete(handler);
}

function requestResync(sessionId: string): void {
  const key = `${sessionId}|${pendingAssistant.get(sessionId)?.serverMessageId ?? ''}`;
  if (resyncRequested.has(key)) return;
  resyncRequested.add(key);
  diagCount('gap-resync-requested', { sessionId });
  for (const h of resyncHandlers) {
    try {
      h(sessionId);
    } catch {
      // 单个处理器异常不影响其他
    }
  }
}

/**
 * resync 完成对齐后调用（由 attachLiveDraft 触发）：清除「已请求」标记，
 * 使同一 run 内后续缺口仍能再次触发对齐——否则一次性标记会让第二次缺口
 * 起的所有分片被永久按重复丢弃（回复终止的根因之一）。
 */
export function clearResyncMark(sessionId: string): void {
  for (const key of Array.from(resyncRequested.keys())) {
    if (key.startsWith(`${sessionId}|`)) resyncRequested.delete(key);
  }
}

/**
 * 重放暂存的缺口分片：在 attachLiveDraft 全量覆盖消息并重播种长度之后调用。
 * 按新长度走 nextChunkSlice 天然去重（快照已含的部分被丢弃，超出部分正常追加）。
 * 若分片仍超前于新长度（再次 gap）会重新暂存并再次请求 resync，重试计数上限保护。
 */
export function replayPendingAfterResync(sessionId: string): void {
  const keys: string[] = [];
  for (const key of pendingAfterResync.keys()) {
    if (key.startsWith(`${sessionId}|`)) keys.push(key);
  }
  if (keys.length === 0) return;
  const ops: PendingText[] = [];
  for (const key of keys) {
    const op = pendingAfterResync.get(key);
    if (op) ops.push(op);
    pendingAfterResync.delete(key);
  }
  for (const op of ops) {
    const retryKey = lengthKey(op.sessionId, op.messageId, op.field);
    const retries = (resyncReplayRetries.get(retryKey) ?? 0) + 1;
    if (retries > MAX_REPLAY_RETRIES) {
      diag('resync-replay-giveup', { sessionId, messageId: op.messageId, field: op.field });
      continue;
    }
    resyncReplayRetries.set(retryKey, retries);
    applyText(op);
  }
}

function lengthKey(sessionId: string, messageId: string, field: string): string {
  return `${sessionId}|${messageId}|${field}`;
}

/** 会话切换 / 历史重载时清空缓存（避免跨会话/跨轮脏读） */
export function resetStreamBuffer(sessionId?: string): void {
  if (sessionId) {
    // 活跃 run 保护：会话仍在生成时，缓冲/长度缓存属于「当前轮」，
    // 不能被一次迟到的 reset（典型来源：上一轮 onStreamSettled 的异步续体，
    // 其 catchUpTail 含网络往返）清掉 —— 否则新一轮已入缓冲的分片被丢弃 = 零输出。
    // 状态取自 store 权威运行态（随终态事件清除），天然不会泄漏。
    if (useStore.getState().generatingBySession[sessionId] === true) {
      diagAlways('reset-stream-buffer-skip-active', { sessionId });
      return;
    }
    for (const key of Array.from(lengthCache.keys())) {
      if (key.startsWith(`${sessionId}|`)) lengthCache.delete(key);
    }
    for (const key of Array.from(pendingTextMap.keys())) {
      if (key.startsWith(`${sessionId}|`)) pendingTextMap.delete(key);
    }
    for (const key of Array.from(pendingToolArgsMap.keys())) {
      if (key.startsWith(`${sessionId}|`)) pendingToolArgsMap.delete(key);
    }
    for (const key of Array.from(resyncRequested)) {
      if (key.startsWith(`${sessionId}|`)) resyncRequested.delete(key);
    }
    for (const key of Array.from(pendingAfterResync.keys())) {
      if (key.startsWith(`${sessionId}|`)) pendingAfterResync.delete(key);
    }
    for (const key of Array.from(resyncReplayRetries.keys())) {
      if (key.startsWith(`${sessionId}|`)) resyncReplayRetries.delete(key);
    }
    return;
  }
  lengthCache.clear();
  pendingTextMap.clear();
  pendingToolArgsMap.clear();
  resyncRequested.clear();
  pendingAfterResync.clear();
  resyncReplayRetries.clear();
}

/** 用服务端草稿/历史恢复出的长度回填缓存（刷新恢复后接流的关键一步） */
export function seedStreamLength(
  sessionId: string,
  messageId: string,
  field: 'content' | 'thinking' | 'toolArgs',
  length: number,
): void {
  lengthCache.set(lengthKey(sessionId, messageId, field), Math.max(0, length));
}

/**
 * 取得（或创建）本轮流式消息：以服务端 messageId 作为本地消息 id
 * —— 刷新后恢复的草稿与后续分片天然指向同一条消息，无需任何启发式匹配。
 */
function adoptOrCreateStreamingMessage(sessionId: string, messageId: string): TaskMessage | null {
  const st = useStore.getState();
  const list = st.messagesBySession[sessionId] ?? [];

  const pending = pendingAssistant.get(sessionId);
  if (pending && pending.serverMessageId !== messageId) {
    // 上一轮已结束（新的 messageId）：把旧消息定稿，避免 spinner 常转
    diagCount('adopt-finalize-prev', { sessionId, prev: pending.id, next: messageId });
    st.updateMessage(sessionId, pending.id, { streaming: false, thinkingStreaming: false });
    pendingAssistant.delete(sessionId);
  }

  const existing = list.find((m) => m.id === messageId);
  if (existing) {
    if (!existing.streaming) st.updateMessage(sessionId, messageId, { streaming: true });
    pendingAssistant.set(sessionId, { ...existing, streaming: true });
    return existing;
  }

  diagCount('adopt-create', { sessionId, messageId });
  const msg: TaskMessage = {
    id: messageId,
    serverMessageId: messageId,
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    streaming: true,
    thinkingStreaming: false,
  };
  st.addMessage(sessionId, msg);
  pendingAssistant.set(sessionId, msg);
  return msg;
}

/**
 * 读取某字段当前长度（缓存优先，未命中则从 store 读取并回填）。
 * 找不到该消息时返回 null —— 调用方据此判断「这是新消息（offset 应≈0）」还是
 * 「已有消息的续写」，从而在补重复分片 / 缺口时不必先创建空消息。
 */
function currentLength(
  sessionId: string,
  messageId: string,
  field: 'content' | 'thinking',
): number | null {
  const key = lengthKey(sessionId, messageId, field);
  const cached = lengthCache.get(key);
  if (cached !== undefined) return cached;
  const msg = (useStore.getState().messagesBySession[sessionId] ?? []).find((m) => m.id === messageId);
  if (!msg) return null;
  const len = field === 'content' ? msg.content.length : (msg.thinking ?? '').length;
  lengthCache.set(key, len);
  return len;
}

// ============================================================================
// 入队（高频热路径：只做缓冲与合并，不触碰 store）
// ============================================================================

export function enqueueTextChunk(opts: {
  sessionId: string;
  messageId: string;
  field: 'content' | 'thinking';
  offset: number | undefined;
  text: string;
}): void {
  if (!opts.text) return;
  const key = `${opts.sessionId}|${opts.messageId}|${opts.field}`;
  const existing = pendingTextMap.get(key);
  if (existing && existing.nextOffset === opts.offset) {
    existing.text += opts.text;
    existing.nextOffset = (opts.offset ?? 0) + existing.text.length;
    existing.thinkingStreaming = opts.field === 'thinking';
    scheduleFlush();
    return;
  }
  // 首片或与前一片不连续：先把旧片冲刷（保证顺序与区间正确）
  if (existing) flushPending();
  const start = opts.offset ?? currentLength(opts.sessionId, opts.messageId, opts.field) ?? 0;
  pendingTextMap.set(key, {
    sessionId: opts.sessionId,
    messageId: opts.messageId,
    field: opts.field,
    offset: opts.offset,
    text: opts.text,
    nextOffset: start + opts.text.length,
    thinkingStreaming: opts.field === 'thinking',
  });
  scheduleFlush();
}

export function enqueueToolArgsChunk(opts: {
  sessionId: string;
  messageId: string;
  toolCallId: string;
  offset: number | undefined;
  argumentsDelta: string;
}): void {
  if (!opts.argumentsDelta) return;
  const key = `${opts.sessionId}|${opts.messageId}|${opts.toolCallId}`;
  const existing = pendingToolArgsMap.get(key);
  if (existing && existing.nextOffset === opts.offset) {
    existing.text += opts.argumentsDelta;
    existing.nextOffset = (opts.offset ?? 0) + existing.text.length;
    scheduleFlush();
    return;
  }
  if (existing) flushPending();
  const start = opts.offset ?? 0;
  pendingToolArgsMap.set(key, {
    sessionId: opts.sessionId,
    messageId: opts.messageId,
    toolCallId: opts.toolCallId,
    offset: opts.offset,
    text: opts.argumentsDelta,
    nextOffset: start + opts.argumentsDelta.length,
  });
  scheduleFlush();
}

function scheduleFlush(): void {
  if (rafId === null) {
    rafId = requestAnimationFrame(() => {
      rafId = null;
      flushPending();
    });
  }
  // 超时兜底：后台标签页 / rAF 节流环境下，rAF 可能长时间（甚至到下一个非批处理事件）
  // 才触发，导致流式内容滞留在缓冲里（用户症状「响应中很久才有内容」）。
  // 100ms 内必冲刷一次，两路 whichever first，flushPending 幂等。
  if (flushTimerId === null) {
    flushTimerId = setTimeout(() => {
      flushTimerId = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      flushPending();
    }, 100);
  }
}

/** 冲刷全部缓冲（低频事件到达前调用，保证「文本先于工具事件写入」的顺序） */
export function flushPending(): void {
  // 取消尚未触发的两路调度，避免冲刷后又触发一次空冲刷
  if (flushTimerId !== null) {
    clearTimeout(flushTimerId);
    flushTimerId = null;
  }
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (pendingTextMap.size > 0) {
    const entries = Array.from(pendingTextMap.values());
    pendingTextMap.clear();
    for (const op of entries) {
      applyText(op);
    }
  }
  if (pendingToolArgsMap.size > 0) {
    const entries = Array.from(pendingToolArgsMap.values());
    pendingToolArgsMap.clear();
    for (const op of entries) {
      applyToolArgs(op);
    }
  }
}

function applyText(op: PendingText): void {
  const st = useStore.getState();
  // 先按「已知长度」判定重复/缺口，再决定是否创建消息：
  // 完全重复的分片（重放）不会平白创建一条空消息。
  const known = currentLength(op.sessionId, op.messageId, op.field);
  const { slice, resync } = nextChunkSlice(known ?? 0, op.offset, op.text);
  if (resync) {
    resetLengthCacheForMessage(op.sessionId, op.messageId);
    // 暂存缺口分片：对齐完成后重放（按新长度自然去重），不再永久静默丢弃
    pendingAfterResync.set(lengthKey(op.sessionId, op.messageId, op.field), op);
    requestResync(op.sessionId);
    return;
  }
  if (!slice) {
    diagCount('apply-text-duplicate-drop', { messageId: op.messageId, field: op.field });
    return;
  }
  const msg = adoptOrCreateStreamingMessage(op.sessionId, op.messageId);
  if (!msg) return;
  st.appendTextAndMarkThinking(op.sessionId, op.messageId, op.field, slice, op.thinkingStreaming);
  lengthCache.set(lengthKey(op.sessionId, op.messageId, op.field), (known ?? 0) + slice.length);
  const pending = pendingAssistant.get(op.sessionId);
  if (pending && pending.id === op.messageId) {
    pendingAssistant.set(op.sessionId, {
      ...pending,
      [op.field]: (pending[op.field] ?? '') + slice,
      thinkingStreaming: op.field === 'thinking' ? op.thinkingStreaming : false,
    });
  }
}

function applyToolArgs(op: PendingToolArgs): void {
  const st = useStore.getState();
  const msg = adoptOrCreateStreamingMessage(op.sessionId, op.messageId);
  if (!msg) return;
  const pending = pendingAssistant.get(op.sessionId);
  const toolCalls = (pending?.id === op.messageId ? pending.toolCalls : msg.toolCalls) ?? [];
  const target = toolCalls.find((tc) => tc.id === op.toolCallId);
  // 目标缺失（tool-call-start 事件尚未处理 / 刷新后丢失）：补占位条目而不是丢弃参数，
  // 后续 tool-call-start 会按同 id 更新名称，参数不会丢。
  const cur = target?.arguments.length ?? 0;
  const { slice, resync } = nextChunkSlice(cur, op.offset, op.text);
  if (resync) {
    requestResync(op.sessionId);
    return;
  }
  if (!slice) return;
  const updated = target
    ? toolCalls.map((tc) => (tc.id === op.toolCallId ? { ...tc, arguments: tc.arguments + slice } : tc))
    : [...toolCalls, { id: op.toolCallId, name: '', arguments: slice, status: 'generating' as const }];
  st.updateMessage(op.sessionId, op.messageId, { toolCalls: updated });
  if (pending && pending.id === op.messageId) {
    pendingAssistant.set(op.sessionId, { ...pending, toolCalls: updated });
  }
}

function resetLengthCacheForMessage(sessionId: string, messageId: string): void {
  for (const key of Array.from(lengthCache.keys())) {
    if (key.startsWith(`${sessionId}|${messageId}|`)) lengthCache.delete(key);
  }
}