// UI/src/hooks/useCommands.ts
// 自定义斜杠命令 hook：挂载时拉取 commands 列表写入 store；订阅 resources:changed 自动刷新；
// 封装 create/update/remove/toggle CRUD（成功后 reload）。
// App 根组件挂载一次即可（/ 菜单与设置页共享 store 数据）。

import { useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { api } from '../api/http';
import { wsClient } from '../api/ws';
import type { CommandUpsertBody } from '../types/api';
import { withRetry } from '../lib/retry';

export function useCommands() {
  const setCommands = useStore((s) => s.setCommands);

  const load = useCallback(async () => {
    try {
      // 首屏不等待后端就绪：启动窗口 503 退避重试
      const { commands } = await withRetry(() => api.listCommands());
      setCommands(commands);
    } catch (err) {
      console.warn('useCommands load failed:', err);
    }
  }, [setCommands]);

  useEffect(() => {
    void load();
    // 订阅后端资源热重载，自动刷新
    const unsub = wsClient.onMessage((msg) => {
      if (msg.type === 'resources.changed') {
        void load();
      }
    });
    return unsub;
  }, [load]);

  const createCommand = useCallback(
    async (data: CommandUpsertBody) => {
      const resp = await api.createCommand(data);
      await load();
      return resp;
    },
    [load],
  );

  const updateCommand = useCallback(
    async (name: string, data: CommandUpsertBody) => {
      const resp = await api.updateCommand(name, data);
      await load();
      return resp;
    },
    [load],
  );

  const removeCommand = useCallback(
    async (name: string) => {
      const resp = await api.deleteCommand(name);
      await load();
      return resp;
    },
    [load],
  );

  const toggleCommand = useCallback(
    async (name: string, enabled: boolean) => {
      // 乐观更新，失败回滚
      const prev = useStore.getState().commands;
      setCommands(prev.map((c) => (c.name === name ? { ...c, enabled } : c)));
      try {
        await api.toggleCommand(name, enabled);
      } catch (err) {
        setCommands(prev);
        console.warn('toggleCommand failed:', err);
        throw err;
      }
    },
    [setCommands],
  );

  return {
    commands: useStore((s) => s.commands),
    reload: load,
    createCommand,
    updateCommand,
    removeCommand,
    toggleCommand,
  };
}
