// webui/src/lib/insight-bus.ts
// AI 诊断事件总线：ws-events 收到 insight.diagnose.event 后投递到订阅者（不落 store）。
// 与 ws-events 内的 settleHandlers 同构：单个回调异常不影响其他订阅者。

import type { InsightEvent } from '@/types/api';

const handlers = new Set<(e: InsightEvent) => void>();

/** 订阅诊断流式事件；返回取消订阅函数 */
export function onInsightEvent(handler: (e: InsightEvent) => void): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** 投递诊断流式事件（仅 ws-events 调用） */
export function emitInsightEvent(e: InsightEvent): void {
  for (const h of handlers) {
    try {
      h(e);
    } catch {
      // 单个回调异常不影响其他
    }
  }
}
