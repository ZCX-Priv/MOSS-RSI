// UI/src/hooks/useMcp.ts
// MCP 管理 hook：拉取服务器列表 + 工具列表；CRUD / 连接 / 断开 / 启停。

import { useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { api } from '../api/http';
import { wsClient } from '../api/ws';
import { applyPluginOrder, loadPluginOrder, MCP_ORDER_KEY } from '../lib/plugin-order';

export function useMcp() {
  const setMcpServers = useStore((s) => s.setMcpServers);
  const setMcpTools = useStore((s) => s.setMcpTools);

  const load = useCallback(async () => {
    try {
      const [{ servers }, { tools }, order] = await Promise.all([
        api.listMcpServers(),
        api.listMcpTools(),
        loadPluginOrder(MCP_ORDER_KEY),
      ]);
      // 应用浏览器本地保存的自定义顺序（IndexedDB）
      setMcpServers(applyPluginOrder(servers, order));
      setMcpTools(tools);
    } catch (err) {
      console.warn('useMcp load failed:', err);
    }
  }, [setMcpServers, setMcpTools]);

  useEffect(() => {
    void load();
    const unsub = wsClient.onMessage((msg) => {
      // 配置变更（CRUD 写 config.mcpServers）后刷新
      if (msg.type === 'config.changed' || msg.type === 'resources.changed') {
        void load();
      }
      // MCP 连接状态变化（启动后台连接完成/断开/失败）后刷新
      if (msg.type === 'mcp.status') {
        void load();
      }
    });
    return unsub;
  }, [load]);

  const connect = useCallback(
    async (server: string) => {
      try {
        await api.connectMcpServer(server);
      } finally {
        void load();
      }
    },
    [load],
  );

  const disconnect = useCallback(
    async (server: string) => {
      try {
        await api.disconnectMcpServer(server);
      } finally {
        void load();
      }
    },
    [load],
  );

  const remove = useCallback(
    async (server: string) => {
      await api.deleteMcpServer(server);
      void load();
    },
    [load],
  );

  const setEnabled = useCallback(
    async (server: string, enabled: boolean) => {
      // 先乐观更新，失败回滚刷新
      const prev = useStore.getState().mcpServers;
      setMcpServers(prev.map((s) => (s.name === server ? { ...s, enabled } : s)));
      try {
        await api.updateMcpServer(server, { enabled });
      } catch {
        setMcpServers(prev);
        throw new Error('update failed');
      }
    },
    [setMcpServers],
  );

  return {
    servers: useStore((s) => s.mcpServers),
    tools: useStore((s) => s.mcpTools),
    reload: load,
    connect,
    disconnect,
    remove,
    setEnabled,
  };
}
