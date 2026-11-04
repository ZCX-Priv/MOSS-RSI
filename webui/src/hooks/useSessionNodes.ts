// webui/src/hooks/useSessionNodes.ts
// 对话节点列表（右侧导航刻度）：独立于消息分页，进入会话即拉全量用户提问。
//
// 为什么不用 messages 推导：分页只加载末页，早期节点会缺失（用户看到的「节点显示不全」）。
// 缓存按 sessionId 复用；用户新发消息（末条变 user）时自动刷新。
// 失败降级为空数组，导航隐藏好过阻塞页面。

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/http';
import { useStore } from '../store';
import { withRetry } from '../lib/retry';
import type { ConversationNode } from '../types/api';

const cache = new Map<string, ConversationNode[]>();

/** 会话尾部是用户消息时的 id 签名；流式 assistant 增长期间不变，避免每 token 触发刷新 */
function selectTailUserId(state: ReturnType<typeof useStore.getState>, taskId: string): string {
  const list = state.messagesBySession[taskId];
  const last = list?.[list.length - 1];
  return last?.role === 'user' ? last.id : '';
}

export interface UseSessionNodesResult {
  nodes: ConversationNode[];
  /** 手动刷新（撤回 / 重新生成等游标变化后调用） */
  refresh: () => void;
}

export function useSessionNodes(taskId: string): UseSessionNodesResult {
  const [nodes, setNodes] = useState<ConversationNode[]>(() => cache.get(taskId) ?? []);
  const requestSeqRef = useRef(0);
  /** 末条用户消息 id：新发消息 / 撤回后变化 → 刷新节点 */
  const tailUserId = useStore((s) => selectTailUserId(s, taskId));

  const load = useCallback(async (): Promise<void> => {
    if (!taskId) {
      setNodes([]);
      return;
    }
    const seq = ++requestSeqRef.current;
    try {
      // 内核启动窗口内该路由返回 503：退避重试后自愈，不阻塞页面
      const resp = await withRetry(() => api.getSessionNodes(taskId));
      if (seq !== requestSeqRef.current) return;
      cache.set(taskId, resp.nodes);
      setNodes(resp.nodes);
    } catch {
      if (seq !== requestSeqRef.current) return;
      // 失败：保留缓存（可能为空），导航自动隐藏，绝不影响消息区
      setNodes(cache.get(taskId) ?? []);
    }
  }, [taskId]);

  useEffect(() => {
    // 会话切换：先同步出缓存（切换无等待），再后台刷新
    setNodes(cache.get(taskId) ?? []);
    void load();
  }, [taskId, load]);

  useEffect(() => {
    if (!tailUserId) return;
    void load();
  }, [tailUserId, load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { nodes, refresh };
}
