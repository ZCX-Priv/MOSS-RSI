// src/modules/agenteam/quality-gates.ts
// 质量门禁：结构化任务（requirements/review/repair 等）的创建校验、
// 完成评估与失败后自动 follow-up（审查/修复循环）。

import type { TeamState, TeamTask } from './types';

/** 创建任务校验结果 */
export interface CreateValidation {
  ok: boolean;
  reason?: string;
}

/** 创建时校验：质量门禁任务需要特定字段 */
export function validateCreateTask(task: TeamTask, team: TeamState): CreateValidation {
  const kind = task.kind ?? 'work';
  if (kind === 'requirements') {
    if (!task.objective) {
      return { ok: false, reason: 'requirements task requires objective' };
    }
  }
  if (kind === 'review') {
    if (!task.reviewedTaskId) {
      return { ok: false, reason: 'review task requires reviewedTaskId' };
    }
    const reviewed = team.tasks.find((t) => t.id === task.reviewedTaskId);
    if (!reviewed) {
      return { ok: false, reason: `reviewedTaskId "${task.reviewedTaskId}" not found` };
    }
  }
  if (kind === 'repair') {
    if (!task.sourceTaskId) {
      return { ok: false, reason: 'repair task requires sourceTaskId' };
    }
    const source = team.tasks.find((t) => t.id === task.sourceTaskId);
    if (!source) {
      return { ok: false, reason: `sourceTaskId "${task.sourceTaskId}" not found` };
    }
  }
  // 依赖存在性校验
  for (const dep of task.dependencies) {
    if (!team.tasks.some((t) => t.id === dep)) {
      return { ok: false, reason: `dependency "${dep}" not found` };
    }
  }
  return { ok: true };
}

/** 完成评估结果 */
export interface CompletionEvaluation {
  /** 是否允许标记 completed */
  ok: boolean;
  /** 不通过原因（ok=false 时） */
  reason?: string;
}

/**
 * 完成时评估：控制质量任务的状态迁移。
 * - review / requirements：必须 verdict=pass 才可 completed
 * - implementation / repair：需给出 acceptanceResults（存在即认为已自评）
 */
export function evaluateQualityCompletion(task: TeamTask): CompletionEvaluation {
  const kind = task.kind ?? 'work';
  if (kind === 'review' || kind === 'requirements') {
    if (task.verdict !== 'pass') {
      return {
        ok: false,
        reason: `${kind} task can only complete with verdict=pass (current: ${task.verdict ?? 'unset'})`,
      };
    }
    return { ok: true };
  }
  if (kind === 'implementation' || kind === 'repair') {
    // 无验收标准时放行（任务契约未要求）
    if (!task.acceptance || task.acceptance.length === 0) return { ok: true };
    const results = task.acceptanceResults ?? [];
    const failed = task.acceptance.filter(
      (criterion) => !results.some((r) => r.criterion === criterion && r.status === 'passed'),
    );
    if (failed.length > 0) {
      return {
        ok: false,
        reason: `acceptance criteria not passed: ${failed.join('; ')}`,
      };
    }
    return { ok: true };
  }
  return { ok: true };
}

/** follow-up 计划（自动生成的下一轮任务） */
export interface QualityFollowUp {
  /** 新任务（未含 id/createdAt/updatedAt/attempt，由调用方补齐） */
  task: Omit<TeamTask, 'id' | 'createdAt' | 'updatedAt'>;
  /** 触发原因说明 */
  reason: string;
  /** 是否触顶升级（不再自动循环） */
  escalate: boolean;
}

/** 审查/修复轮次上限读取（缺省默认值） */
function roundCeiling(team: TeamState, task: TeamTask): number {
  const policy = team.reviewPolicy ?? team.profile?.reviewPolicy;
  if (task.kind === 'repair') return policy?.maxRepairAttempts ?? 2;
  if (task.kind === 'requirements') return policy?.requirementsMaxRounds ?? 3;
  return policy?.codeMaxRounds ?? 2;
}

/**
 * 任务未通过（verdict=needs_revision / reject / 完成评估失败）时的自动 follow-up。
 * - review needs_revision/reject → 生成 repair 任务（指派回实现成员）
 * - requirements needs_revision → 生成下一轮 requirements
 * - repair 失败 → 触顶升级或再修复
 */
export function planQualityFollowUp(team: TeamState, task: TeamTask): QualityFollowUp | null {
  const kind = task.kind ?? 'work';
  const round = task.round ?? 1;
  const ceiling = roundCeiling(team, task);
  const nextRound = round + 1;
  const escalate = nextRound > ceiling;
  const now = Date.now();

  if (kind === 'review') {
    if (task.verdict === 'pass' || !task.verdict) return null;
    // 审查未通过 → 修复任务指派回被审任务的实现者
    const reviewed = team.tasks.find((t) => t.id === task.reviewedTaskId);
    const implementer = reviewed?.assignee;
    const findingIds = (task.findings ?? []).map((f) => f.id);
    return {
      reason: `review of ${task.reviewedTaskId} returned ${task.verdict}`,
      escalate,
      task: {
        subject: `修复 ${task.reviewedTaskId} 的审查发现`,
        description: [
          `审查任务 ${task.id}（verdict=${task.verdict}）发现以下问题，请逐项修复：`,
          ...(task.findings ?? []).map(
            (f) => `- [${f.severity}] ${f.id}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}: ${f.problem} → ${f.requiredFix}`,
          ),
        ].join('\n'),
        status: 'pending',
        assignee: implementer,
        dependencies: [task.id],
        kind: 'repair',
        round: 1,
        sourceTaskId: task.reviewedTaskId,
        sourceFindingIds: findingIds,
        ...(escalate ? {} : {}),
      },
    };
  }

  if (kind === 'requirements') {
    if (task.verdict === 'pass' || !task.verdict) return null;
    return {
      reason: `requirements round ${round} returned ${task.verdict}`,
      escalate,
      task: {
        subject: `修订需求（第 ${nextRound} 轮）`,
        description: `上一轮需求（任务 ${task.id}）未通过，请按反馈修订。`,
        status: 'pending',
        assignee: task.assignee,
        dependencies: [task.id],
        kind: 'requirements',
        round: nextRound,
        objective: task.objective,
        ...(task.inScope ? { inScope: [...task.inScope] } : {}),
        ...(task.outOfScope ? { outOfScope: [...task.outOfScope] } : {}),
      },
    };
  }

  if (kind === 'repair') {
    if (task.status !== 'failed') return null;
    // 修复失败 → 再修复一轮或触顶
    return {
      reason: `repair attempt ${round} failed`,
      escalate,
      task: {
        subject: `重试修复（第 ${nextRound} 轮）：${task.subject}`,
        description: task.description,
        status: 'pending',
        assignee: task.assignee,
        dependencies: [task.id],
        kind: 'repair',
        round: nextRound,
        sourceTaskId: task.sourceTaskId,
        ...(task.sourceFindingIds ? { sourceFindingIds: [...task.sourceFindingIds] } : {}),
      },
    };
  }

  return null;
}
