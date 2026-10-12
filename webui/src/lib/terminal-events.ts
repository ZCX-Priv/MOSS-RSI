// webui/src/lib/terminal-events.ts
// 终端相关 WS 消息处理：元数据进 store（创建/关闭/退出/列表），
// 高频输出走 terminal-bus 直投 xterm。返回 true 表示已消费该消息。

import type { TerminalInfo, WSMessage } from '../types/api';
import { useStore } from '../store';
import { emitTerminalOutput } from './terminal-bus';
import { terminalScopeOf } from './terminal-scope';

interface TerminalListPayload {
  sessionId?: string;
  terminals?: TerminalInfo[];
}
interface TerminalCreatedPayload {
  terminal?: TerminalInfo;
}
interface TerminalDataPayload {
  terminalId?: string;
  data?: string;
}
interface TerminalExitPayload {
  terminalId?: string;
  exitCode?: number;
}

/** 当前展示的任务键（任务页为 taskId；空白页为空串） */
function displayedTaskKey(s: ReturnType<typeof useStore.getState>): string {
  return s.activeSessionId ?? s.activeTaskId ?? '';
}

/** 处理终端类 WS 消息；非终端消息返回 false */
export function handleTerminalMessage(msg: WSMessage): boolean {
  const s = useStore.getState();
  switch (msg.type) {
    case 'terminal.list': {
      const p = (msg.payload ?? {}) as TerminalListPayload;
      const sessionId = p.sessionId ?? msg.sessionId ?? s.activeSessionId ?? '';
      if (sessionId) s.setTerminalList(sessionId, p.terminals ?? []);
      return true;
    }
    case 'terminal.created': {
      const p = (msg.payload ?? {}) as TerminalCreatedPayload;
      const term = p.terminal;
      // 仅登记元数据（含 AI 新建终端）：**绝不自动展开右侧面板 / 切换标签**。
      // 终端面板一律由用户手动打开（右侧「+」菜单 / 「开始」面板），尊重用户操作。
      if (term) s.addTerminal(term);
      return true;
    }
    case 'terminal.focus': {
      // 服务端广播「正在使用的终端」：仅记录应展示的终端 id，不打开面板、不切换标签。
      // 用户手动打开终端页时，展示的就是这里记录的最新活跃终端。
      const p = (msg.payload ?? {}) as { terminalId?: string; sessionId?: string };
      if (!p.terminalId) return true;
      const displayedTask = displayedTaskKey(s);
      const scope = terminalScopeOf(displayedTask);
      // 非当前展示会话的终端不抢占活跃项
      if (p.sessionId && p.sessionId !== scope) return true;
      s.setActiveTerminal(scope, p.terminalId);
      return true;
    }
    case 'terminal.closed': {
      const terminalId = (msg.payload as TerminalDataPayload | undefined)?.terminalId;
      if (terminalId) s.removeTerminal(terminalId);
      return true;
    }
    case 'terminal.exit': {
      const p = (msg.payload ?? {}) as TerminalExitPayload;
      if (p.terminalId) {
        s.updateTerminal(p.terminalId, { running: false, exitCode: p.exitCode ?? null });
      }
      return true;
    }
    case 'terminal.data': {
      const p = (msg.payload ?? {}) as TerminalDataPayload;
      if (p.terminalId && typeof p.data === 'string') {
        emitTerminalOutput(p.terminalId, p.data, 'append');
      }
      return true;
    }
    case 'terminal.snapshot': {
      const p = (msg.payload ?? {}) as TerminalDataPayload;
      if (p.terminalId && typeof p.data === 'string') {
        emitTerminalOutput(p.terminalId, p.data, 'replace');
      }
      return true;
    }
    default:
      return false;
  }
}