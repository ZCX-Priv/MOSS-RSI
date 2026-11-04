// UI/src/hooks/useConfig.ts
// 配置 hook：挂载时拉取 appConfig + apiConfig 写入 store；
// 提供 updateAppConfig / updateApiConfig；
// 订阅 config.changed WS 事件自动重拉配置。

import { useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { api } from '../api/http';
import { wsClient } from '../api/ws';
import type { AppConfig, ApiConfig } from '../types/api';
import { toast } from 'sonner';
import { withRetry } from '../lib/retry';

export function useConfig() {
  const setAppConfig = useStore((s) => s.setAppConfig);
  const setApiConfig = useStore((s) => s.setApiConfig);
  const setCurrentModel = useStore((s) => s.setCurrentModel);

  const loadConfig = useCallback(async () => {
    try {
      // 首屏不等待后端就绪：启动窗口 503 退避重试（后端监听后配置即就绪）
      const [app, apiCfg] = await withRetry(() =>
        Promise.all([api.getAppConfig(), api.getApiConfig()]),
      );
      setAppConfig(app);
      setApiConfig(apiCfg);
      // 从 appConfig 同步默认模型到 store
      if (app.agent?.defaultModel) {
        setCurrentModel(app.agent.defaultModel);
      }
      // 同步后端工作目录（终端运行目录）为默认 workingDirectory
      if (app.agent?.workingDirectory && !useStore.getState().workingDirectory) {
        useStore.getState().setWorkingDirectory(app.agent.workingDirectory);
      }
    } catch (err) {
      // 后端未启动时静默（WS 会持续重连）
      console.warn('loadConfig failed:', err);
    }
  }, [setAppConfig, setApiConfig, setCurrentModel]);

  useEffect(() => {
    void loadConfig();
    // 订阅 config.changed WS 事件自动重拉
    const unsub = wsClient.onMessage((msg) => {
      if (msg.type === 'config.changed') {
        void loadConfig();
      }
    });
    return unsub;
  }, [loadConfig]);

  const updateAppConfig = useCallback(
    async (patch: Partial<AppConfig>) => {
      try {
        const updated = await api.updateAppConfig(patch);
        setAppConfig(updated);
        if (updated.agent?.defaultModel) {
          setCurrentModel(updated.agent.defaultModel);
        }
        return updated;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [setAppConfig, setCurrentModel],
  );

  const updateApiConfig = useCallback(
    async (patch: Partial<ApiConfig>) => {
      try {
        const updated = await api.updateApiConfig(patch);
        setApiConfig(updated);
        return updated;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [setApiConfig],
  );

  return { appConfig: useStore((s) => s.appConfig), apiConfig: useStore((s) => s.apiConfig), updateAppConfig, updateApiConfig, reload: loadConfig };
}
