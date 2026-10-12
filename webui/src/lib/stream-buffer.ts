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
import { diagAlways, diagCount } from './diag';
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
/**
 * 已请求 resync 的时刻（key = sessionId|messageId）：**冷却**语义而非一次性。
 * 旧实现用「一次性标记 + 仅在 attachLiveDraft 时清除」，一旦那次对齐没能走到 attachLiveDraft
 * （/state 无草稿、请求异常、会话已切换），标记永不释放 → 该消息之后每个分片都被暂存丢弃
 * （整轮不可见、内容最后整块出现的根因之一）。改为时间戳冷却后，后续缺口仍能再次发起对齐。
 */
const resyncRequestedAt = new Map<string, number>();
/** 同一消息的 resync 冷却时长：窗口内不重复请求（避免风暴），窗口外允许再次对齐 */
const RESYNC_COOLDOWN_MS = 1000;
/**
 * 缺口分片暂存（key 同 lengthKey）：gap 触发 resync 时把分片存起来，
 * 对齐完成（attachLiveDraft 全量覆盖 + 重播种长度）后重放——按新长度自然去重，
 * 修复「二次缺口永久静默丢弃 → 回复终止」。
 */
const pendingAfterResync = new Map<string, PendingText>();
/** 缺口重放的每字段重试计数（防止草稿持续滞后时无限循环） */
const resyncReplayRetries = new Map<string, number>();
/** 重放次数上限：超过即改为「强制追加」兜底（见 applyText），绝不再静默丢弃整轮 */
const MAX_REPLAY_RETRIES = 3;

// ============================================================================
// 分片账本（异常取证）：区分「没收到」与「收到但被丢」，并给出丢弃原因计数。
// 每次一轮结束（终态事件）时由 dumpStreamAccounting 输出一行并从零开始。
// ============================================================================
interface StreamAccount {
  /** 前端 WS 实际收到的流式分片数（在 ws-events 入口计数，含后续被丢弃的） */
  received: number;
  /** 真正写入 store 的片段数 */
  applied: number;
  /** 因「重复分片」丢弃 */
  droppedDuplicate: number;
  /** 因「缺口」暂存（待对齐后重放） */
  droppedGap: number;
  /** 缺口重试耗尽后强制追加（保命路径，正常应为 0） */
  gapForcedAppend: number;
  /** 因 runId 不匹配被过滤丢弃（在 ws-events 计数） */
  droppedRunId: number;
}
const accounts = new Map<string, StreamAccount>();
function accountOf(sessionId: string): StreamAccount {
  let a = accounts.get(sessionId);
  if (!a) {
    a = { received: 0, applied: 0, droppedDuplicate: 0, droppedGap: 0, gapForcedAppend: 0, droppedRunId: 0 };
    accounts.set(sessionId, a);
  }
  return a;
}

/** 记录「收到一个流式分片」（ws-events 入口调用） */
export function noteStreamReceived(sessionId: string, n = 1): void {
  accountOf(sessionId).received += n;
}

/** 记录「因 runId 不匹配被过滤丢弃」（ws-events 入口调用） */
export function noteStreamRunIdDrop(sessionId: string): void {
  accountOf(sessionId).droppedRunId++;
}

/**
 * 一轮结束时输出账本（生产也输出：仅在异常/对账时触发，低频）。
 * 判定口径：received==0 → 后端没发/WS 没到；received>0 且 applied==0 → 前端丢流（看 dropped* 归因）。
 */
export function dumpStreamAccounting(sessionId: string): void {
  const a = accounts.get(sessionId);
  if (!a) return;
  accounts.delete(sessionId);
  if (a.received === 0 && a.droppedRunId === 0) return; // 无流式事件（纯工具/错误轮）：不产生噪音
  diagAlways('stream-account', { sessionId, ...a });
}

export function onStreamResyncNeeded(handler: ResyncHandler): () => void {
  resyncHandlers.add(handler);
  return () => resyncHandlers.delete(handler);
}

function requestResync(sessionId: string): void {
  const key = `${sessionId}|${pendingAssistant.get(sessionId)?.serverMessageId ?? ''}`;
  const last = resyncRequestedAt.get(key) ?? 0;
  if (Date.now() - last < RESYNC_COOLDOWN_MS) return; // 冷却期内不重复请求
  resyncRequestedAt.set(key, Date.now());
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
 * 一次对齐动作结束（成功 / 无草稿 / 异常）时调用：清冷却标记，使后续缺口仍能再次对齐。
 * 由 attachLiveDraft（有草稿）与 reconcileFromState 的 finally（无草稿/异常）共同调用，
 * 保证「对齐失败」也不会让该消息的后续分片被永久丢弃。
 */
export function finishResync(sessionId: string): void {
  for (const key of Array.from(resyncRequestedAt.keys())) {
    if (key.startsWith(`${sessionId}|`)) resyncRequestedAt.delete(key);
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
    resyncReplayRetries.set(retryKey, retries);
    // 超过上限不再丢弃：由 applyText 内部走「强制追加」保命路径（宁可顺序风险也不丢整轮）
    applyText(op);
  }
}

function lengthKey(sessionId: string, messageId: string, field: string): string {
  return `${sessionId}|${messageId}|${field}`;
}

/**
 * 会话切换 / 历史重载 / 一轮结束时清空缓存（避免跨会话/跨轮脏读）。
 *
 * @param opts.preserveMessageIds 需要**保留**其键的 messageId 列表。
 *   缺省时自动保留「当前仍在 streaming 的消息」——这样上一轮 onStreamSettled 的迟到 reset
 *   （其 catchUpTail 含网络往返）不会清掉新一轮已入缓冲的分片；
 *   而刚结束那一轮的消息此时已 streaming=false，仍会被正确清掉（语义不变）。
 */
export function resetStreamBuffer(sessionId?: string, opts?: { preserveMessageIds?: string[] }): void {
  if (sessionId) {
    // 活跃 run 保护：会话仍在生成时，缓冲/长度缓存属于「当前轮」，整体跳过（最保守）
    if (useStore.getState().generatingBySession[sessionId] === true) {
      diagAlways('reset-stream-buffer-skip-active', { sessionId });
      return;
    }
    const preserve = new Set(
      opts?.preserveMessageIds ??
        (useStore.getState().messagesBySession[sessionId] ?? [])
          .filter((m) => m.streaming)
          .map((m) => m.id),
    );
    const isPreserved = (key: string): boolean => {
      if (preserve.size === 0) return false;
      const rest = key.slice(sessionId.length + 1);
      const mid = rest.slice(0, rest.indexOf('|'));
      return preserve.has(mid);
    };
    for (const key of Array.from(lengthCache.keys())) {
      if (key.startsWith(`${sessionId}|`) && !isPreserved(key)) lengthCache.delete(key);
    }
    for (const key of Array.from(pendingTextMap.keys())) {
      if (key.startsWith(`${sessionId}|`) && !isPreserved(key)) pendingTextMap.delete(key);
    }
    for (const key of Array.from(pendingToolArgsMap.keys())) {
      if (key.startsWith(`${sessionId}|`) && !isPreserved(key)) pendingToolArgsMap.delete(key);
    }
    // resync 冷却 / 缺口暂存 / 重试计数：仅当没有需要保留的消息时才整体清理
    // （否则会丢掉新一轮正在等待对齐的暂存分片）
    if (preserve.size === 0) {
      for (const key of Array.from(resyncRequestedAt.keys())) {
        if (key.startsWith(`${sessionId}|`)) resyncRequestedAt.delete(key);
      }
      for (const key of Array.from(pendingAfterResync.keys())) {
        if (key.startsWith(`${sessionId}|`)) pendingAfterResync.delete(key);
      }
      for (const key of Array.from(resyncReplayRetries.keys())) {
        if (key.startsWith(`${sessionId}|`)) resyncReplayRetries.delete(key);
      }
    }
    return;
  }
  lengthCache.clear();
  pendingTextMap.clear();
  pendingToolArgsMap.clear();
  resyncRequestedAt.clear();
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
  const rk = lengthKey(op.sessionId, op.messageId, op.field);
  const { slice, resync } = nextChunkSlice(known ?? 0, op.offset, op.text);
  if (resync) {
    // 保命兜底：多次对齐后仍缺口 → 不再丢弃，信任 store 当前长度直接追加。
    // 宁可极端情况下顺序略有风险，也不让整轮内容对用户不可见（有 stream-account 账本可观测）。
    const tried = resyncReplayRetries.get(rk) ?? 0;
    if (tried >= MAX_REPLAY_RETRIES) {
      accountOf(op.sessionId).gapForcedAppend++;
      diagAlways('stream-gap-forced-append', {
        sessionId: op.sessionId,
        messageId: op.messageId,
        field: op.field,
        known,
        offset: op.offset,
      });
      const forced = adoptOrCreateStreamingMessage(op.sessionId, op.messageId);
      if (!forced) return;
      st.appendTextAndMarkThinking(op.sessionId, op.messageId, op.field, op.text, op.thinkingStreaming);
      lengthCache.set(rk, (known ?? 0) + op.text.length);
      accountOf(op.sessionId).applied++;
      const pendingForced = pendingAssistant.get(op.sessionId);
      if (pendingForced && pendingForced.id === op.messageId) {
        pendingAssistant.set(op.sessionId, {
          ...pendingForced,
          [op.field]: (pendingForced[op.field] ?? '') + op.text,
          thinkingStreaming: op.field === 'thinking' ? op.thinkingStreaming : false,
        });
      }
      return;
    }
    resetLengthCacheForMessage(op.sessionId, op.messageId);
    // 暂存缺口分片：对齐完成后重放（按新长度自然去重），不再永久静默丢弃
    pendingAfterResync.set(rk, op);
    accountOf(op.sessionId).droppedGap++;
    requestResync(op.sessionId);
    return;
  }
  if (!slice) {
    accountOf(op.sessionId).droppedDuplicate++;
    diagCount('apply-text-duplicate-drop', { messageId: op.messageId, field: op.field });
    return;
  }
  const msg = adoptOrCreateStreamingMessage(op.sessionId, op.messageId);
  if (!msg) return;
  st.appendTextAndMarkThinking(op.sessionId, op.messageId, op.field, slice, op.thinkingStreaming);
  lengthCache.set(rk, (known ?? 0) + slice.length);
  accountOf(op.sessionId).applied++;
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
  accountOf(op.sessionId).applied++;
  if (pending && pending.id === op.messageId) {
    pendingAssistant.set(op.sessionId, { ...pending, toolCalls: updated });
  }
}

function resetLengthCacheForMessage(sessionId: string, messageId: string): void {
  for (const key of Array.from(lengthCache.keys())) {
    if (key.startsWith(`${sessionId}|${messageId}|`)) lengthCache.delete(key);
  }
}