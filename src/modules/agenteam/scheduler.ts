// src/modules/agenteam/scheduler.ts
// DAG 调度器（纯函数集）：依赖输出收集、就绪任务选择、成员执行票据合成。

import type { TeamMember, TeamState, TeamTask } from './types';
import { TERMINAL_TASK_STATUSES } from './types';

/** 一个已完成依赖（展示给被派发成员） */
export interface DependencyOutput {
  readonly id: string;
  readonly subject: string;
  readonly output?: string;
}

/** 递归收集 taskId 的已完成祖先依赖输出（拓扑序：依赖在前） */
export function collectCompletedDependencyOutputs(
  tasks: readonly TeamTask[],
  taskId: string,
  warn?: (message: string) => void,
): DependencyOutput[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: TeamTask[] = [];

  const walk = (id: string): void => {
    if (visiting.has(id)) {
      warn?.(`agenteam: dependency cycle involving "${id}" while collecting outputs`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const task = byId.get(id);
    if (task !== undefined) {
      for (const dependency of task.dependencies) walk(dependency);
      if (id !== taskId) ordered.push(task);
    }
    visiting.delete(id);
    visited.add(id);
  };

  walk(taskId);
  return ordered
    .filter((task) => task.status === 'completed')
    .map((task) => ({
      id: task.id,
      subject: task.subject,
      output: task.output,
    }));
}

/** 成员是否持有未完成任务（claimed / in_progress） */
export function ownedOpenTask(
  tasks: readonly TeamTask[],
  memberName: string,
): TeamTask | undefined {
  return tasks.find(
    (task) =>
      task.assignee === memberName && (task.status === 'claimed' || task.status === 'in_progress'),
  );
}

/** 选择成员的下一个就绪任务（pending + 依赖全部完成 + 非 reassigning + 已指派或可认领） */
export function nextReadyTask(
  tasks: readonly TeamTask[],
  memberName: string,
): TeamTask | undefined {
  return tasks.find((task) => {
    if (task.status !== 'pending' || task.reassigning) return false;
    const depsOk = task.dependencies.every((dep) => {
      const depTask = tasks.find((t) => t.id === dep);
      return depTask?.status === 'completed';
    });
    if (!depsOk) return false;
    // 已指派给该成员，或未指派（可认领）
    return task.assignee === undefined || task.assignee === memberName;
  });
}

/** 团队是否所有任务都处于终态 */
export function allTasksTerminal(tasks: readonly TeamTask[]): boolean {
  return tasks.every((task) => TERMINAL_TASK_STATUSES.includes(task.status));
}

/** 团队进度统计 */
export function teamProgress(tasks: readonly TeamTask[]): {
  total: number;
  completed: number;
  failed: number;
  active: number;
  pending: number;
} {
  let completed = 0;
  let failed = 0;
  let active = 0;
  let pending = 0;
  for (const task of tasks) {
    if (task.status === 'completed') completed++;
    else if (task.status === 'failed') failed++;
    else if (task.status === 'pending' || task.status === 'cancelled') pending++;
    else active++;
  }
  return { total: tasks.length, completed, failed, active, pending };
}

/** 依赖输出格式化（含截断） */
export function formatDependencyOutputs(items: readonly DependencyOutput[]): string {
  if (items.length === 0) return '(none)';
  const DEP_MAX = 4000;
  const TOTAL_MAX = 12000;
  const formatted = items.map((item) => {
    const raw = item.output === undefined || item.output === '' ? '(no output recorded)' : item.output;
    const truncated = raw.length > DEP_MAX;
    const body = truncated ? `${raw.slice(0, DEP_MAX)} [truncated]` : raw;
    return `- ${item.id} ${item.subject}:\n  ${body}`;
  });
  let selected = formatted;
  while (selected.length > 1 && selected.join('\n').length > TOTAL_MAX) {
    selected = selected.slice(1);
  }
  const last = selected[0];
  if (selected.length === 1 && last !== undefined && last.length > TOTAL_MAX) {
    selected = [`${last.slice(0, TOTAL_MAX)} [truncated]`];
  }
  return selected.join('\n');
}

/** 生成执行票据 id（attemptId） */
export function newAttemptId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 派发票据（成员执行提示词的输入） */
export interface DispatchTicket {
  readonly taskId: string;
  readonly memberName: string;
  readonly attempt: number;
  readonly attemptId: string;
  readonly subject: string;
  readonly description?: string;
  readonly teamDescription?: string;
  readonly profileProtocol?: string;
  readonly dependencyOutputs: readonly DependencyOutput[];
  readonly kind?: string;
  readonly round?: number;
  readonly acceptance?: readonly string[];
  readonly verify?: readonly string[];
}

/** 合成成员执行提示词（任务票据；pendingMessages 为本次附带投递的未读团队消息） */
export function buildTaskTicket(
  team: TeamState,
  member: TeamMember,
  task: TeamTask,
  attemptId: string,
  pendingMessages?: string[],
): string {
  const deps = collectCompletedDependencyOutputs(team.tasks, task.id);
  const lines: string[] = [];

  lines.push('=== 团队任务派发 ===');
  lines.push(`团队: ${team.name}`);
  if (team.description) lines.push(`团队目标: ${team.description}`);
  lines.push(`执行角色: ${member.name}${member.role ? ` (${member.role})` : ''}`);
  if (team.profile?.protocol) lines.push(`协作协议: ${team.profile.protocol}`);
  lines.push('');

  lines.push('=== 你的任务 ===');
  lines.push(`任务 ID: ${task.id}`);
  lines.push(`标题: ${task.subject}`);
  if (task.description) lines.push(`说明: ${task.description}`);
  if (task.kind && task.kind !== 'work') {
    lines.push(`任务类型: ${task.kind}`);
    if (task.round !== undefined) lines.push(`轮次: ${task.round}`);
  }
  if (task.objective) lines.push(`目标: ${task.objective}`);
  if (task.acceptance?.length) {
    lines.push('验收标准:');
    for (const a of task.acceptance) lines.push(`- ${a}`);
  }
  if (task.verify?.length) {
    lines.push('验证命令:');
    for (const v of task.verify) lines.push(`- ${v}`);
  }
  if (task.reviewedTaskId) lines.push(`审查对象: ${task.reviewedTaskId}`);
  if (task.sourceTaskId) lines.push(`修复来源: ${task.sourceTaskId}`);
  lines.push('');

  lines.push('=== 前置依赖产出 ===');
  lines.push(formatDependencyOutputs(deps));
  lines.push('');

  // 未读团队消息（captain/队友发来）
  if (pendingMessages && pendingMessages.length > 0) {
    lines.push('=== 你收到的团队消息 ===');
    for (const m of pendingMessages) lines.push(`- ${m}`);
    lines.push('');
  }

  lines.push('=== 成员工作规则 ===');
  lines.push(`attempt_id: ${attemptId}（更新任务时必须出示）`);
  lines.push('1. 完成任务时：你的最终回复将被记录为任务产出，请以完整、自包含的工作报告形式给出。');
  lines.push('2. 若无法完成：如实说明原因与已尝试的路径，系统将标记 failed。');
  lines.push('3. 你收到的团队消息（上方「你收到的团队消息」段）是重要指导，按其行事。');
  lines.push('4. 完成/自报产出时调用 agent(mode=agenteam, action=task, patch={...}) 上报（带 attempt_id）；需要向队长或队友沟通时调用 agent(mode=agenteam, action=message)（to=captain 或队友名）。');
  lines.push('5. 审查类任务（review/requirements）完成时 verdict 必须为 pass，否则会被打回重做。');
  lines.push('6. 你是团队成员，专注于当前任务；不要干预其他成员的任务。');
  if (member.executionPrompt) {
    lines.push('');
    lines.push('=== 角色附加指引 ===');
    lines.push(member.executionPrompt);
  }
  return lines.join('\n');
}
