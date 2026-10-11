// webui/src/hooks/useTerminals.ts
// 持久终端 WS 交互封装：列表刷新 / 新建 / 输入 / 尺寸 / 订阅 / 关闭。
// 元数据在 store（terminalsBySession），高频输出走 terminal-bus（见 lib/terminal-events）。

import { useCallback } from 'react';
import { wsClient } from '../api/ws';
import { useStore } from '../store';
import type { InterpreterKind, TerminalInfo } from '../types/api';

/** 稳定空数组（避免 zustand 选择器返回新引用触发 useSyncExternalStore 死循环） */
const EMPTY: TerminalInfo[] = [];

export interface CreateTerminalInput {
  cols?: number;
  rows?: number;
  cwd?: string;
  interpreter?: InterpreterKind;
}

export function useTerminals(sessionId: string) {
  const list = useStore((s) => s.terminalsBySession[sessionId]?.list ?? EMPTY);
  const activeId = useStore((s) => s.terminalsBySession[sessionId]?.activeId);

  /** 拉取本会话终端列表 */
  const refresh = useCallback(() => {
    wsClient.send({ type: 'terminal.list', sessionId });
  }, [sessionId]);

  /** 新建终端 */
  const create = useCallback(
    (input: CreateTerminalInput = {}) => {
      wsClient.send({
        type: 'terminal.create',
        sessionId,
        payload: { sessionId, cols: input.cols, rows: input.rows, cwd: input.cwd, interpreter: input.interpreter },
      });
    },
    [sessionId],
  );

  /** 写入原始输入 */
  const write = useCallback((terminalId: string, data: string) => {
    wsClient.send({ type: 'terminal.input', payload: { terminalId, data } });
  }, []);

  /** 调整尺寸 */
  const resize = useCallback((terminalId: string, cols: number, rows: number) => {
    wsClient.send({ type: 'terminal.resize', payload: { terminalId, cols, rows } });
  }, []);

  /** 订阅（回送当前缓冲快照，用于刷新/重连后复原） */
  const subscribe = useCallback((terminalId: string) => {
    wsClient.send({ type: 'terminal.subscribe', payload: { terminalId } });
  }, []);

  /** 关闭终端 */
  const close = useCallback((terminalId: string) => {
    wsClient.send({ type: 'terminal.close', payload: { terminalId } });
  }, []);

  return { list, activeId, refresh, create, write, resize, subscribe, close };
}