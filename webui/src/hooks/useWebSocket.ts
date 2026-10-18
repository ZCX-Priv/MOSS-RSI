// webui/src/hooks/useWebSocket.ts
// WS 连接生命周期 + 事件分发入口（单例，只应在 App.tsx 调用一次）。
//
// 职责（保持精简；事件处理与流式缓冲已抽出，见 lib/ws-events 与 lib/stream-buffer）：
// 1. 挂载时建立 wsClient 连接，卸载时断开。
// 2. 连接状态 → store（含重连次数 / 下次重试时间 / 是否刚刚恢复，驱动连接状态条）。
// 3. WS 消息 → applyWsMessage（单一入口）。
// 4. 排队模式：一轮任务正常结束后自动续发队列中的下一条。

import { useEffect } from 'react';
import { useStore } from '../store';
import { wsClient } from '../api/ws';
import { api } from '../api/http';
import { applyWsMessage, onStreamSettled } from '../lib/ws-events';
import { pendingRunId } from '../lib/pending-assistant';

/**
 * 排队模式：任务完成后自动发送队列中的下一条消息。
 * 仅在「一轮正常结束」（done / task.done）时触发；出错或中断不自动续发，保留人工介入。
 */
function processQueueIfPending(sessionId: string): void {
  const st = useStore.getState();
  if (st.followUpBehavior !== 'queue') return;
  const queue = st.messageQueueBySession[sessionId] ?? [];
  if (queue.length === 0) return;
  const next = queue[0];
  st.removeFromMessageQueue(sessionId, next.id);

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pendingRunId.set(sessionId, runId);

  // 复用入队时生成的 id 作为 clientMessageId（本地乐观消息与服务端副本同身份）
  const clientMessageId = next.id;
  st.addMessage(sessionId, {
    id: clientMessageId,
    clientMessageId,
    role: 'user',
    content: next.content,
    ...(next.attachments ? { attachments: next.attachments } : {}),
    timestamp: new Date().toISOString(),
  });
  st.setGenerating(sessionId, true);

  wsClient.send({
    type: 'task.stream',
    sessionId,
    payload: {
      message: next.content,
      clientMessageId,
      attachments: next.attachments,
      model: st.currentModel || undefined,
      agentId: st.currentAgent || undefined,
      cwd: st.workingDirectory || undefined,
      runId,
      permissionMode: st.permissionModeBySession[sessionId] ?? st.permissionMode,
    },
  });
}

export function useWebSocket(): void {
  useEffect(() => {
    // 1. 建立连接
    wsClient.connect();
    const unsubStatus = wsClient.onStatus((info) => {
      const st = useStore.getState();
      st.setWsConnection({
        status: info.status,
        attempt: info.attempt,
        nextRetryAt: info.nextRetryAt,
      });
      // 断开后重新连上：记录一次「已恢复」（状态条短暂提示，随后自动淡出）
      if (info.status === 'open' && info.restored) {
        st.bumpWsRestored();
        // 断连期间错过的任务增删/运行态广播不可重放（WS 无送达保证），
        // 重连成功即全量重拉一次任务列表，恢复「实时广播 + 最终一致」的模型。
        // applyFullTaskSnapshot 内置 running 置位逻辑，MCP/自动化/其它端触发的运行态一并恢复。
        void api
          .listTasks()
          .then(({ groups, tasks }) => {
            const s = useStore.getState();
            s.setTaskGroups(groups);
            // 无参 GET /api/tasks 返回全量 → 走全量快照（物化全部 + 各分组标记已加载）
            s.applyFullTaskSnapshot(tasks);
          })
          .catch(() => {
            // 列表拉取失败不影响连接状态
          });
      }
    });

    // 2. 消息分发（单一入口；异常不打断后续消息处理）
    const unsubMessage = wsClient.onMessage((msg) => {
      try {
        applyWsMessage(msg);
      } catch (err) {
        console.error('WS message handler error:', err);
      }
    });

    // 3. 排队续发（由「一轮正常结束」信号驱动）
    const unsubSettled = onStreamSettled((sessionId, reason) => {
      if (reason !== 'done') return;
      setTimeout(() => processQueueIfPending(sessionId), 300);
    });

    return () => {
      unsubStatus();
      unsubMessage();
      unsubSettled();
      wsClient.disconnect();
    };
  }, []);
}