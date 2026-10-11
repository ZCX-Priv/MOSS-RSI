// webui/src/lib/terminal-bus.ts
// 终端高频输出总线：xterm 数据流不经 zustand（避免全局重渲染），
// 由 WS 事件投递、TerminalPanel 逐终端订阅。

export type TerminalOutputMode = 'append' | 'replace';
export type TerminalOutputHandler = (data: string, mode: TerminalOutputMode) => void;

const handlers = new Map<string, Set<TerminalOutputHandler>>();

/** 订阅某终端的输出（返回取消订阅函数） */
export function onTerminalOutput(terminalId: string, cb: TerminalOutputHandler): () => void {
  let set = handlers.get(terminalId);
  if (!set) {
    set = new Set();
    handlers.set(terminalId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) handlers.delete(terminalId);
  };
}

/** 投递某终端的输出（replace = 快照，面板先清屏再写入） */
export function emitTerminalOutput(terminalId: string, data: string, mode: TerminalOutputMode = 'append'): void {
  const set = handlers.get(terminalId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(data, mode);
    } catch {
      // 单个订阅者异常不影响其他订阅者
    }
  }
}