// UI/src/hooks/useAgents.ts
// Agent 管理 hook：挂载时拉取 agents 列表 + 默认 id 写入 store；
// 提供 create/update/delete/setDefault CRUD。

import { useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { api } from '../api/http';
import type { AgentItem, AgentDetail } from '../types/api';
import { toast } from 'sonner';
import { withRetry } from '../lib/retry';
import { runWhenIdle } from '../lib/idle';

export function useAgents() {
  const setAgents = useStore((s) => s.setAgents);
  const setCurrentAgent = useStore((s) => s.setCurrentAgent);

  const load = useCallback(async () => {
    try {
      // 首屏不等待后端就绪：启动窗口 503 退避重试
      const { agents, default: defaultId } = await withRetry(() => api.listAgents());
      setAgents(agents);
      if (defaultId) setCurrentAgent(defaultId);
    } catch (err) {
      console.warn('useAgents load failed:', err);
    }
  }, [setAgents, setCurrentAgent]);

  useEffect(() => {
    // 首屏非关键：/@ 菜单数据空闲时再拉
    runWhenIdle(() => void load());
  }, [load]);

  const createAgent = useCallback(
    async (data: { name: string; systemPrompt?: string; model?: string; tools?: string[] }) => {
      try {
        const agent = await api.createAgent(data);
        await load(); // 重新拉取列表
        return agent;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const updateAgent = useCallback(
    async (id: string, patch: Partial<AgentDetail>) => {
      try {
        const agent = await api.updateAgent(id, patch);
        await load();
        return agent;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const deleteAgent = useCallback(
    async (id: string) => {
      try {
        await api.deleteAgent(id);
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const setDefaultAgent = useCallback(
    async (id: string) => {
      try {
        await api.setDefaultAgent(id);
        setCurrentAgent(id);
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load, setCurrentAgent],
  );

  return {
    agents: useStore((s) => s.agents),
    currentAgent: useStore((s) => s.currentAgent),
    reload: load,
    createAgent,
    updateAgent,
    deleteAgent,
    setDefaultAgent,
  };
}

/** Agent 图标映射（前端 LucideIcon），后端只存 icon 字符串标识 */
export function mapAgentIcon(icon: string | undefined): AgentItem['icon'] {
  return icon;
}
