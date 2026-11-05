// webui/src/lib/pending-assistant.ts
// 跨 hook 共享的流式 assistant 消息管理器。
// useWebSocket 和 useTask 都需要访问 pending 状态，提取为模块级变量避免 useRef 跨 hook 不可达。

import type { TaskMessage } from '../types/api';

// 当前流式 assistant 消息（按 sessionId 索引）
const pendingMap: Record<string, TaskMessage> = {};
// 当前运行的 runId（按 sessionId 索引）
const runIdMap: Record<string, string> = {};
// 已发送、等待后端消费的引导 run（按 sessionId FIFO）：
// 引导消息在后端「当前工具调用完成」后才生效，期间前端必须继续显示旧 run 的流，
// 因此不能提前把本地 activeRun 切到引导 runId（否则旧 run 事件会被 runId 过滤全部丢弃）。
const guideRunIdsMap: Record<string, string[]> = {};

export const pendingAssistant = {
  get(sessionId: string): TaskMessage | undefined {
    return pendingMap[sessionId];
  },
  set(sessionId: string, msg: TaskMessage): void {
    pendingMap[sessionId] = msg;
  },
  delete(sessionId: string): void {
    delete pendingMap[sessionId];
  },
};

export const pendingRunId = {
  get(sessionId: string): string | undefined {
    return runIdMap[sessionId];
  },
  set(sessionId: string, runId: string): void {
    runIdMap[sessionId] = runId;
  },
  delete(sessionId: string): void {
    delete runIdMap[sessionId];
  },
};

/** 待生效的引导 run 队列（前端生成的 runId，后端续跑时按 FIFO 取用） */
export const pendingGuideRunIds = {
  enqueue(sessionId: string, runId: string): void {
    const list = guideRunIdsMap[sessionId] ?? [];
    if (!list.includes(runId)) list.push(runId);
    guideRunIdsMap[sessionId] = list;
  },
  /** 取出最早的一条（后端 task.done 携带 nextRunId 时用于本地承接） */
  shift(sessionId: string): string | undefined {
    const list = guideRunIdsMap[sessionId];
    if (!list || list.length === 0) return undefined;
    const head = list.shift();
    if (list.length === 0) delete guideRunIdsMap[sessionId];
    return head;
  },
  clear(sessionId: string): void {
    delete guideRunIdsMap[sessionId];
  },
};
