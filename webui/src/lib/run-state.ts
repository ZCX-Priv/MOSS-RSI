// webui/src/lib/run-state.ts
// run 生命周期公共类型与纯函数。
//
// 目的：把「当前 run / 已终止 run」从 pendingRunId 的删除语义中解耦。
// 停止时不再删除当前 runId（删除会让 runId 过滤条件失效），而是把 runId 记入
// 终止集合：此后该 run 的任何迟到分片/终态事件都被丢弃，直到新一轮 beginRun。

import type { TaskMessage } from '../types/api';

/** 当前活跃 run（按 sessionId 索引，存于 store 以便 UI 订阅） */
export interface ActiveRun {
  runId: string;
  /** 单调递增的 run 序号（同一 session 内用于区分新旧 run） */
  epoch: number;
  /** 本轮开始时刻（ms；用于「发送后宽限期」与「长时间无流」判定） */
  startedAt: number;
}

/** 每个 session 保留的终止 runId 上限（覆盖迟到的旧 run 终态即可） */
export const MAX_TERMINATED_RUN_IDS = 4;

/** 该 run 是否已被本地终止（终止后其所有事件都必须丢弃） */
export function isRunTerminated(
  terminatedBySession: Record<string, string[] | undefined>,
  sessionId: string,
  runId: string | undefined,
): boolean {
  if (!sessionId || !runId) return false;
  const list = terminatedBySession[sessionId];
  return Array.isArray(list) && list.includes(runId);
}

/**
 * 从终止集合中移除指定 runId（无需变更时返回原引用）。
 *
 * 用于「新一轮开始」：一个刚开始运行的 run 不可能合法地已被终止，出现同名记录
 * 只可能是旧 run 的无身份 running:false 广播留下的簿记污染。不清掉它，该 run 的
 * 全部事件（含终态）都会在 ws-events 入口被永久丢弃 —— 表现为永远停在「响应中」。
 */
export function withoutTerminatedRunId(
  list: string[] | undefined,
  runId: string,
): string[] | undefined {
  if (!Array.isArray(list) || !list.includes(runId)) return list;
  const next = list.filter((id) => id !== runId);
  return next.length > 0 ? next : undefined;
}

/** 追加终止 runId（去重 + FIFO 截断）；无需变更时返回原引用 */
export function appendTerminatedRunId(
  list: string[] | undefined,
  runId: string | undefined,
): string[] | undefined {
  if (!runId) return list;
  const cur = list ?? [];
  if (cur.includes(runId)) return list;
  const next = [...cur, runId];
  return next.length > MAX_TERMINATED_RUN_IDS
    ? next.slice(next.length - MAX_TERMINATED_RUN_IDS)
    : next;
}

/**
 * 把某条消息定稿：清流式标记、工具状态收敛到 done，并写入 streamEndedAt。
 * streamEndedAt 是「迟到分片屏障」：一旦写入，stream-buffer 不再向该消息追加，
 * 也不会把它重新标成 streaming（停止后内容继续增长/状态回跳的根因）。
 */
export function finalizeMessage(
  m: TaskMessage,
  endedAt: string,
): TaskMessage {
  if (!m.streaming && !m.thinkingStreaming) return m;
  const finalizedToolCalls = m.toolCalls?.map((tc) =>
    tc.status === 'done' ? tc : { ...tc, status: 'done' as const },
  );
  return {
    ...m,
    streaming: false,
    thinkingStreaming: false,
    toolCalls: finalizedToolCalls,
    streamEndedAt: endedAt,
    ...(m.thinkingStreaming && !m.thinkingEndedAt ? { thinkingEndedAt: endedAt } : {}),
  };
}
