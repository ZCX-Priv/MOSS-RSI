// webui/src/lib/terminal-scope.ts
// 终端作用域哨兵：空白页（无 Task，taskId === ''）用该哨兵作为终端会话键，
// 使「无任务」时也能新建/使用终端；非空 taskId 时终端仍按任务隔离。

export const TERMINAL_SCRATCH_SCOPE = '__scratch__';

/** 由任务键解析终端作用域（空白页 → 哨兵；否则 → 任务 id 本身） */
export function terminalScopeOf(taskId: string | null | undefined): string {
  return taskId ? taskId : TERMINAL_SCRATCH_SCOPE;
}