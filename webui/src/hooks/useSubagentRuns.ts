// webui/src/hooks/useSubagentRuns.ts
// 专家团面板「子代理」分节数据：列出隐藏分组 subagent 下的全部运行记录（永久落盘）。
// 刷新：挂载拉取 + WS 事件节流刷新 + 有运行中记录时 4s 轮询兜底。

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/http';
import { wsClient } from '../api/ws';
import type { TaskItem } from '../types/api';

/** subagent 隐藏分组固定 id（与后端 orchestrator 的 SUBAGENT_GROUP_ID 一致） */
const SUBAGENT_GROUP_ID = 'subagent';
/** 面板展示条数（完整历史从任务页访问） */
const LIMIT = 30;
const REFRESH_THROTTLE_MS = 1000;
const POLL_INTERVAL_MS = 4000;

export function useSubagentRuns() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const aliveRef = useRef(true);
  const tasksRef = useRef<TaskItem[]>([]);
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listTasksInGroup(SUBAGENT_GROUP_ID, { limit: LIMIT });
      if (!aliveRef.current) return;
      const list = res.tasks ?? [];
      tasksRef.current = list;
      setTasks(list);
    } catch {
      // 拉取失败保留旧列表（面板不闪空）
    }
  }, []);

  const schedule = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void refresh();
    }, REFRESH_THROTTLE_MS);
  }, [refresh]);

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    void refresh().finally(() => {
      if (aliveRef.current) setLoading(false);
    });

    const unsub = wsClient.onMessage((msg) => {
      // 子代理事件 / 任务运行态变化 → 节流刷新
      if (msg.type === 'agenteam.member.event' || msg.type === 'task.updated') schedule();
    });
    const poll = window.setInterval(() => {
      if (tasksRef.current.some((tk) => tk.running)) void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      aliveRef.current = false;
      unsub();
      clearInterval(poll);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [refresh, schedule]);

  return { tasks, loading, refresh };
}
