// webui/src/hooks/useMcpInstallTask.ts
// MCP 市场安装任务：写盘后由 WS 真实阶段驱动进度，连接成功/失败后收尾。
// 市场列表页与「市场 MCP 详情页」共用，避免两套安装状态机。

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { api } from '../api/http';
import { wsClient } from '../api/ws';
import type {
  McpInstallPhase,
  McpInstallProgressEvent,
  McpMarketDetail,
  McpMarketSource,
  McpServer,
} from '../types/api';

/** 安装阶段顺序（只允许前进；error 直接覆盖） */
export const INSTALL_PHASE_RANK: Record<McpInstallPhase, number> = {
  prepare: 0,
  start: 1,
  download: 2,
  install: 3,
  connect: 4,
  done: 5,
  error: 99,
};

const INSTALL_LOG_FLUSH_MS = 150;
const MAX_LOG_LINES = 200;

export interface InstallTask {
  /** `${source}:${id}` */
  key: string;
  source: McpMarketSource;
  id: string;
  /** 写盘成功后返回的本地服务器名 */
  name?: string;
  marketName: string;
  phase: McpInstallPhase;
  detail?: string;
  log: string[];
  downloaded: number;
  startedAt: number;
  /** 重新配置：旧连接可能仍是 connected，需确认新连接已开始/完成 */
  reconfiguring: boolean;
}

/** 安装提交参数（自动配置 / 手动配置共用） */
export interface InstallPayload {
  source: McpMarketSource;
  id: string;
  optionIndex?: number;
  env?: Record<string, string>;
  name?: string;
  /** 重新配置已安装的同源服务器 */
  reconfiguring?: boolean;
  manual?: {
    transport: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
}

export interface InstallFinishedInfo {
  ok: boolean;
  task: InstallTask;
}

/**
 * @param servers 当前 MCP 服务器列表（用于判断连接结果）
 * @param reload  重新拉取服务器列表
 * @param onFinished 任务结束回调（成功/失败各一次）
 */
export function useMcpInstallTask({
  servers,
  reload,
  onFinished,
}: {
  servers: McpServer[];
  reload: () => void | Promise<void>;
  onFinished?: (info: InstallFinishedInfo) => void;
}): {
  installTask: InstallTask | null;
  startInstall: (payload: InstallPayload, detail: McpMarketDetail) => Promise<void>;
} {
  const { t } = useTranslation();
  const [installTask, setInstallTask] = useState<InstallTask | null>(null);
  /** 已结束任务（避免 connected/error 重复 toast） */
  const handledTaskRef = useRef(new Set<string>());
  /** 重新配置时旧状态可能仍是 connected：必须观察到 connecting/disconnected 才接受新结果 */
  const sawNonConnectedRef = useRef(false);
  const pendingLogsRef = useRef<string[]>([]);
  const pendingLogKeyRef = useRef('');
  const logFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 批量把缓冲日志追加到匹配的安装任务 */
  const flushPendingLogs = useCallback((): void => {
    logFlushTimerRef.current = null;
    const lines = pendingLogsRef.current.splice(0);
    if (lines.length === 0) return;
    const logKey = pendingLogKeyRef.current;
    setInstallTask((prev) => {
      if (!prev) return prev;
      const matches =
        (prev.name !== undefined && logKey === `server:${prev.name}`) ||
        logKey === `${prev.source}:${prev.id}`;
      if (!matches) return prev;
      return { ...prev, log: [...prev.log, ...lines].slice(-MAX_LOG_LINES) };
    });
  }, []);

  const scheduleLogFlush = useCallback((): void => {
    if (logFlushTimerRef.current) return;
    logFlushTimerRef.current = setTimeout(flushPendingLogs, INSTALL_LOG_FLUSH_MS);
  }, [flushPendingLogs]);

  useEffect(
    () => () => {
      if (logFlushTimerRef.current) clearTimeout(logFlushTimerRef.current);
    },
    [],
  );

  // 安装进度事件（后端真实阶段 + npm/uv 日志）
  useEffect(() => {
    const unsub = wsClient.onMessage((msg) => {
      if (msg.type !== 'mcp.install-progress') return;
      const payload = msg.payload as Partial<McpInstallProgressEvent> | undefined;
      if (!payload || typeof payload.phase !== 'string') return;
      const phase = payload.phase as McpInstallPhase;
      if (!(phase in INSTALL_PHASE_RANK)) return;

      setInstallTask((prev) => {
        if (!prev) return prev;
        const matches =
          (typeof payload.server === 'string' && prev.name === payload.server) ||
          (payload.source === prev.source && payload.id === prev.id);
        if (!matches) return prev;
        const nextPhase =
          phase === 'error' || INSTALL_PHASE_RANK[phase] >= INSTALL_PHASE_RANK[prev.phase]
            ? phase
            : prev.phase;
        return {
          ...prev,
          phase: nextPhase,
          ...(typeof payload.detail === 'string' && payload.detail
            ? { detail: payload.detail }
            : {}),
          ...(typeof payload.downloaded === 'number'
            ? { downloaded: payload.downloaded }
            : {}),
        };
      });

      if (typeof payload.log === 'string' && payload.log) {
        // 用 source/id 匹配：API 返回前任务还没有本地服务器名，但 source/id 一开始就有
        pendingLogKeyRef.current = `${payload.source ?? ''}:${payload.id ?? ''}`;
        pendingLogsRef.current.push(...payload.log.split(/\r?\n/));
        if (pendingLogsRef.current.length > MAX_LOG_LINES) {
          pendingLogsRef.current = pendingLogsRef.current.slice(-MAX_LOG_LINES);
        }
        scheduleLogFlush();
      }
    });
    return unsub;
  }, [scheduleLogFlush]);

  // 连接成功/失败：清理任务并通知调用方（失败时配置已写入，管理页可重试）
  useEffect(() => {
    const task = installTask;
    if (!task?.name) return;
    const server = servers.find((item) => item.name === task.name);
    if (!server) return;
    if (server.status === 'connecting' || server.status === 'disconnected') {
      sawNonConnectedRef.current = true;
      return;
    }
    // 重新配置时旧状态可能仍是 connected/error：需新连接已开始/完成，或超过 3s 兜底
    const newConnectionStarted =
      sawNonConnectedRef.current || task.phase === 'done' || Date.now() - task.startedAt > 3000;
    if (server.status === 'connected') {
      if (task.reconfiguring && !newConnectionStarted) return;
      if (handledTaskRef.current.has(task.key)) return;
      handledTaskRef.current.add(task.key);
      toast.success(t('plugins.mcpInstallSuccess', { name: task.name }));
      setInstallTask(null);
      onFinished?.({ ok: true, task });
      return;
    }
    const newConnectionFailed =
      task.phase === 'error' ||
      sawNonConnectedRef.current ||
      Date.now() - task.startedAt > 3000;
    if (server.status === 'error' && server.lastError && newConnectionFailed) {
      if (handledTaskRef.current.has(task.key)) return;
      handledTaskRef.current.add(task.key);
      toast.warning(
        t('plugins.mcpInstallConnectFailed', { error: server.lastError }),
        { duration: 8000 },
      );
      setInstallTask(null);
      onFinished?.({ ok: false, task });
    }
  }, [servers, installTask, t, onFinished]);

  /** 发起安装：写盘后立即返回；后续下载/安装/连接进度由 WS 驱动 */
  const startInstall = useCallback(
    async (payload: InstallPayload, marketDetail: McpMarketDetail): Promise<void> => {
      const key = `${payload.source}:${payload.id}`;
      pendingLogsRef.current = [];
      pendingLogKeyRef.current = key;
      handledTaskRef.current.clear();
      sawNonConnectedRef.current = false;
      setInstallTask({
        key,
        source: payload.source,
        id: payload.id,
        marketName: marketDetail.name,
        phase: 'prepare',
        log: [],
        downloaded: 0,
        startedAt: Date.now(),
        reconfiguring: payload.reconfiguring === true,
      });
      try {
        const result = await api.marketMcpInstall(payload);
        setInstallTask((prev) =>
          prev && prev.key === key ? { ...prev, name: result.name } : prev,
        );
        await reload();
      } catch (err) {
        setInstallTask(null);
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`${t('plugins.mcpInstallFailed')}${message ? `: ${message}` : ''}`);
        throw err;
      }
    },
    [reload, t],
  );

  return { installTask, startInstall };
}
