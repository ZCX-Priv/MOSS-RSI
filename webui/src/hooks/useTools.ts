// webui/src/hooks/useTools.ts
// 工具管理 hook：挂载时拉取 /api/tools 完整列表写入 store，并派生 toolIconMap
// 供工具调用卡片渲染图标；提供 toggleTool 启停工具。
// 订阅 WS resources.changed 自动刷新（工具热重载时同步）。

import { useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { api } from '../api/http';
import { wsClient } from '../api/ws';
import { toast } from 'sonner';
import { withRetry } from '../lib/retry';
import { runWhenIdle } from '../lib/idle';

export function useTools() {
  const setTools = useStore((s) => s.setTools);
  const setToolIconMap = useStore((s) => s.setToolIconMap);
  const updateTool = useStore((s) => s.updateTool);

  const load = useCallback(async () => {
    try {
      // 首屏不等待后端就绪：启动窗口 503 退避重试
      const { tools } = await withRetry(() => api.listTools());
      setTools(tools);
      // 派生 iconMap（兼容工具调用卡片图标渲染）
      const map: Record<string, string> = {};
      for (const t of tools) if (t.icon) map[t.name] = t.icon;
      setToolIconMap(map);
    } catch (err) {
      console.warn('useTools load failed:', err);
    }
  }, [setTools, setToolIconMap]);

  useEffect(() => {
    // 首屏非关键：工具图标映射只在渲染工具卡片时需要，空闲时再拉
    runWhenIdle(() => void load());
    // 订阅资源热重载自动刷新（热重载本身已避让首屏，立即刷新即可）
    const unsub = wsClient.onMessage((msg) => {
      if (msg.type === 'resources.changed') {
        void load();
      }
    });
    return unsub;
  }, [load]);

  const toggleTool = useCallback(
    async (name: string, enabled: boolean) => {
      try {
        await api.updateTool(name, { enabled });
        updateTool(name, { enabled });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [updateTool],
  );

  /** 保存工具编辑对话框的整表配置（enabled + requireConfirmation + 专属参数） */
  const saveToolConfig = useCallback(
    async (name: string, config: Record<string, unknown>) => {
      try {
        const res = await api.updateTool(name, { config });
        // 本地刷新（不依赖 WS 推送）：生效值用后端返回的合并结果，enabled 单独同步
        updateTool(name, {
          configValues: res.config,
          ...(typeof config.enabled === 'boolean' ? { enabled: config.enabled } : {}),
        });
        return res;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [updateTool],
  );

  return {
    tools: useStore((s) => s.tools),
    reload: load,
    toggleTool,
    saveToolConfig,
  };
}
