// src/modules/agenteam/orchestrator.ts
// TeamOrchestrator：agenteam 编排服务（核心）。
// 职责：团队生命周期（创建/审批/暂停/恢复/删除）、成员任务创建、
// DAG 调度派发（复用 AgentEngine.run + 持久成员会话）、质量门禁循环、
// 事件广播（agenteam:team-changed / agenteam:member-event）。

import type { EventBus, Environment, Logger } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AgentEngine } from '../contracts';
import type { AgentEvent } from '../contracts';
import type { PermissionMode } from '../safety/types';
import type { ServerInstance } from '../server/types';
import { TeamStore, safeTeamId } from './store';
import { TeamProfileStore } from './profiles';
import {
  buildTaskTicket,
  newAttemptId,
  nextReadyTask,
  ownedOpenTask,
  allTasksTerminal,
} from './scheduler';
import {
  evaluateQualityCompletion,
  planQualityFollowUp,
  validateCreateTask,
} from './quality-gates';
import type {
  MemberSpec,
  TaskSpec,
  TeamMessage,
  TeamState,
  TeamSummary,
  TeamProfileConfig,
  TeamTask,
} from './types';
import { TERMINAL_TASK_STATUSES } from './types';

/** 普通任务（work/implementation 等非质量门禁类）失败自动重试上限 */
const MAX_TASK_RETRY_ATTEMPTS = 2;

/** subagent 隐藏分组固定 id（dir=subagent，平坦存放每次 subagent 会话） */
const SUBAGENT_GROUP_ID = 'subagent';

/** 创建团队输入 */
export interface CreateTeamInput {
  name: string;
  description?: string;
  cwd: string;
  permissionMode?: PermissionMode;
  captainSessionId: string;
  members: MemberSpec[];
  tasks: TaskSpec[];
  /** true=staged 计划审批；false=直接 running */
  approval: boolean;
  /** 从团队模板创建时记录快照 */
  profile?: TeamState['profile'];
  reviewPolicy?: TeamState['reviewPolicy'];
}

/** 计划修订输入（action=edit） */
export interface EditPlanInput {
  /** 替换团队描述 */
  description?: string;
  addMembers?: MemberSpec[];
  removeMembers?: string[];
  addTasks?: TaskSpec[];
  removeTasks?: string[];
}

/** 调用方身份解析结果（成员会话 → 成员；否则主会话=队长） */
export interface TeamActor {
  teamId: string;
  /** 成员名；主会话为 undefined（即队长） */
  memberName?: string;
}

/** 临时 subagent 运行输入 */
export interface SubagentRunInput {
  /** 模板 agent id（或注册表任意 agent id） */
  template: string;
  task: string;
  cwd: string;
  permissionMode?: PermissionMode;
}

export interface SubagentRunOutput {
  sessionId: string;
  taskId: string;
  finishReason: string;
  result: string;
}

export class TeamOrchestrator {
  private readonly engine: AgentEngine;
  private readonly store: TeamStore;
  private readonly profiles: TeamProfileStore;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly env: Environment;
  /** 进行中的成员 run：memberSessionId → AbortController（halt 用） */
  private readonly activeMemberRuns = new Map<string, AbortController>();
  /** 进行中的队长 run：captainSessionId → AbortController（halt 用） */
  private readonly activeCaptainRuns = new Map<string, AbortController>();
  /** 队长决策队列：teamId → 串行 Promise 链（同 session 并发 run 规避） */
  private readonly captainRuns = new Map<string, Promise<void>>();
  /** 最终汇报中标记（防 checkTeamCompletion 重复入队） */
  private readonly summarizing = new Set<string>();
  /** 团队调度互斥（防重入） */
  private readonly kicking = new Set<string>();
  /** 兜底轮询定时器 */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 服务注册表（externalRun 注册用） */
  private readonly services: import('../../core/types').ServiceRegistry;

  constructor(deps: {
    engine: AgentEngine;
    store: TeamStore;
    profiles: TeamProfileStore;
    eventBus: EventBus;
    logger: Logger;
    env: Environment;
    services: import('../../core/types').ServiceRegistry;
  }) {
    this.engine = deps.engine;
    this.store = deps.store;
    this.profiles = deps.profiles;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;
    this.env = deps.env;
    this.services = deps.services;
    this.startPolling();
  }

  /** 注册外部活跃 run（前端任务页 running 判定 / task.abort 可中断） */
  private registerExternalRun(sessionId: string, controller: AbortController): void {
    const server = this.services.tryResolve<ServerInstance>(ServiceNames.SERVER_INSTANCE);
    server?.registerExternalRun(sessionId, controller);
  }

  private unregisterExternalRun(sessionId: string, controller: AbortController): void {
    const server = this.services.tryResolve<ServerInstance>(ServiceNames.SERVER_INSTANCE);
    server?.unregisterExternalRun(sessionId, controller);
  }

  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const controller of this.activeMemberRuns.values()) {
      controller.abort();
    }
    this.activeMemberRuns.clear();
    for (const controller of this.activeCaptainRuns.values()) {
      controller.abort();
    }
    this.activeCaptainRuns.clear();
    this.captainRuns.clear();
    this.summarizing.clear();
  }

  // ========================================================================
  // 团队生命周期
  // ========================================================================

  list(): TeamState[] {
    return this.store.list();
  }

  summaries(): TeamSummary[] {
    return this.store.summaries();
  }

  get(teamId: string): TeamState | null {
    return this.store.get(teamId);
  }

  /** 保存外部获取并修改的团队引用（工具 edit 等） */
  saveTeam(team: TeamState): void {
    this.store.save(team);
    this.notifyChanged(team.id);
  }

  getMessages(teamId: string, since?: number): TeamMessage[] {
    return this.store.listMessages(teamId, since);
  }

  /**
   * 解析调用方身份：sessionId 是某个团队的成员会话 → 返回该团队与该成员名；
   * 否则视为队长（创建团队的主会话），返回其创建的团队（若有）。
   * 用于工具层统一“成员 vs 队长”的身份判定与 teamId 缺省。
   */
  resolveActor(sessionId: string): TeamActor | null {
    if (!sessionId) return null;
    for (const team of this.store.list()) {
      const member = team.members.find((m) => m.sessionId === sessionId && m.status !== 'removed');
      if (member) return { teamId: team.id, memberName: member.name };
    }
    const asCaptain = this.store.list().find((t) => t.captainSessionId === sessionId);
    return asCaptain ? { teamId: asCaptain.id } : null;
  }

  createTeam(input: CreateTeamInput): TeamState {
    if (!input.name?.trim()) throw new Error('team name required');
    if (input.members.length === 0) throw new Error('team requires at least one member');
    const now = Date.now();
    const id = safeTeamId(this.store.nextTeamId());

    const team: TeamState = {
      id,
      name: input.name.trim(),
      description: input.description,
      profile: input.profile,
      captainSessionId: input.captainSessionId,
      cwd: input.cwd,
      permissionMode: input.permissionMode ?? 'auto',
      createdAt: now,
      members: input.members.map((m, i) => ({
        id: `m${i + 1}`,
        name: m.name,
        role: m.role,
        agentId: m.agentId,
        inlinePrompt: m.inlinePrompt,
        sessionId: '', // 派发时创建任务后回填
        executionPrompt: m.executionPrompt,
        joinedAt: now,
        status: 'idle' as const,
      })),
      tasks: input.tasks.map((t, i) => ({
        id: `t${i + 1}`,
        subject: t.subject,
        description: t.description,
        status: 'pending' as const,
        assignee: t.assignee,
        dependencies: t.dependencies ?? [],
        kind: t.kind,
        reviewedTaskId: t.reviewedTaskId,
        sourceTaskId: t.sourceTaskId,
        createdAt: now,
        updatedAt: now,
      })),
      taskSeq: input.tasks.length,
      phase: input.approval ? 'staged' : 'running',
      planReviewState: input.approval ? 'awaiting_review' : undefined,
      reviewPolicy: input.reviewPolicy,
    };

    // 创建时校验质量门禁任务
    for (const task of team.tasks) {
      const validation = validateCreateTask(task, team);
      if (!validation.ok) throw new Error(validation.reason ?? 'invalid task');
    }

    this.store.save(team);
    this.notifyChanged(team.id);
    if (team.phase === 'running') {
      void this.kick(team.id);
    }
    this.logger.info('agenteam: team created', { teamId: id, name: team.name });
    return team;
  }

  /** 审批通过：staged → running，立即调度 + 通知队长就位 */
  approvePlan(teamId: string): TeamState {
    const team = this.mustGet(teamId);
    if (team.phase !== 'staged') throw new Error(`team phase is ${team.phase}, not staged`);
    team.phase = 'running';
    team.planReviewState = undefined;
    team.approvedAt = Date.now();
    this.store.save(team);
    this.notifyChanged(teamId);
    // 通知队长团队已批准开始（captain 会话获得团队背景起点）
    this.enqueueCaptainRun(
      team,
      [
        `[Agenteam] 你领导的团队「${team.name}」计划已获用户批准，开始执行。`,
        team.description ? `团队目标: ${team.description}` : '',
        `成员: ${team.members.filter((m) => m.status !== 'removed').map((m) => `${m.name}(${m.role ?? m.agentId ?? 'custom'})`).join(', ')}`,
        `任务: ${team.tasks.length} 个（${team.tasks.map((t) => t.id).join(', ')}）`,
        '',
        '调度器会自动派发任务；成员完成/失败后你会收到报告并决策。现在请简短确认你已就位。',
      ].filter(Boolean).join('\n'),
    );
    void this.kick(teamId);
    return team;
  }

  /** 驳回：标记 awaiting_feedback（captain 会话继续可编辑） */
  discardPlan(teamId: string): TeamState {
    const team = this.mustGet(teamId);
    if (team.phase !== 'staged') throw new Error(`team phase is ${team.phase}, not staged`);
    team.planReviewState = 'awaiting_feedback';
    this.store.save(team);
    this.notifyChanged(teamId);
    return team;
  }

  /** 暂停：中止进行中成员 run，未完成任务取消 */
  halt(teamId: string): TeamState {
    const team = this.mustGet(teamId);
    if (team.phase === 'staged' || team.phase === 'halted') return team;
    team.phase = 'halted';
    team.halted = true;
    team.haltedAt = Date.now();
    const now = Date.now();
    for (const task of team.tasks) {
      if (!TERMINAL_TASK_STATUSES.includes(task.status)) {
        task.status = 'cancelled';
        task.updatedAt = now;
      }
    }
    for (const member of team.members) {
      const controller = this.activeMemberRuns.get(member.sessionId);
      if (controller) controller.abort();
      if (member.status === 'working') member.status = 'idle';
    }
    // 中止进行中的队长 run（staged 之外的队长决策 turn）
    if (team.captainSessionId) {
      this.activeCaptainRuns.get(team.captainSessionId)?.abort();
    }
    this.store.save(team);
    this.notifyChanged(teamId);
    return team;
  }

  /** 恢复：cancelled 任务回 pending，重新调度 */
  resume(teamId: string): TeamState {
    const team = this.mustGet(teamId);
    if (team.phase !== 'halted') return team;
    team.phase = 'running';
    team.halted = false;
    const now = Date.now();
    for (const task of team.tasks) {
      if (task.status === 'cancelled') {
        task.status = 'pending';
        task.updatedAt = now;
      }
    }
    this.store.save(team);
    this.notifyChanged(teamId);
    void this.kick(teamId);
    return team;
  }

  deleteTeam(teamId: string): boolean {
    const team = this.store.get(teamId);
    if (!team) return false;
    // 中止进行中的成员 run
    for (const member of team.members) {
      const controller = this.activeMemberRuns.get(member.sessionId);
      if (controller) controller.abort();
    }
    // 中止进行中的队长 run + 清理队列
    if (team.captainSessionId) {
      this.activeCaptainRuns.get(team.captainSessionId)?.abort();
    }
    this.captainRuns.delete(teamId);
    this.summarizing.delete(teamId);
    const ok = this.store.delete(teamId);
    if (ok) {
      // 清理团队专属隐藏分组：成员/自动队长会话文件与 tasks/agenteam/<teamId>/ 一并删除。
      // 未跑过的团队无分组（deleteTaskGroup 返回 false，无副作用）；工具建队的 captain 属用户会话，不在该组内
      try {
        this.engine.deleteTaskGroup(teamId, { deleteTasks: true });
      } catch (err) {
        this.logger.warn('agenteam: delete task group failed', {
          teamId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.notifyChanged(teamId);
      this.logger.info('agenteam: team deleted', { teamId });
    }
    return ok;
  }

  // ========================================================================
  // 团队模板
  // ========================================================================

  listProfiles(): TeamProfileConfig[] {
    return this.profiles.list();
  }

  saveProfile(profile: TeamProfileConfig): boolean {
    return this.profiles.upsert(profile);
  }

  deleteProfile(name: string): boolean {
    return this.profiles.remove(name);
  }

  // ========================================================================
  // 调度
  // ========================================================================

  /** 手动/事件驱动触发调度（幂等；每成员同时只持一个任务） */
  async kick(teamId: string): Promise<void> {
    if (this.kicking.has(teamId)) return;
    this.kicking.add(teamId);
    try {
      const team = this.store.get(teamId);
      if (!team || team.phase !== 'running' || team.halted) return;

      // 就绪任务派发给空闲成员
      for (const member of team.members) {
        if (member.status === 'removed') continue;
        if (member.status === 'working') continue;
        const owned = ownedOpenTask(team.tasks, member.name);
        if (owned) {
          // 重启恢复：成员 idle 但仍持有 open 任务（run 已随进程终止）→ 重新派发
          this.dispatchMember(team, member.name, owned.id);
          continue;
        }
        const task = nextReadyTask(team.tasks, member.name);
        if (task) {
          this.dispatchMember(team, member.name, task.id);
          continue;
        }
        // 无就绪任务但有未读消息 → 消息处理 run（投递消息，成员可回复/按消息行事）
        if ((member.pendingMessages?.length ?? 0) > 0 && member.sessionId) {
          this.deliverMemberMessages(team, member);
        }
      }

      // 检查团队是否整体完成
      this.checkTeamCompletion(teamId);
    } catch (err) {
      this.logger.error('agenteam: kick failed', {
        teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.kicking.delete(teamId);
    }
  }

  /** 派发任务给成员（并行：启动 run 后立即返回，完成回调内联处理） */
  private dispatchMember(team: TeamState, memberName: string, taskId: string): void {
    const member = team.members.find((m) => m.name === memberName && m.status !== 'removed');
    if (!member) return;
    const task = team.tasks.find((t) => t.id === taskId);
    if (!task || TERMINAL_TASK_STATUSES.includes(task.status)) return;

    // 成员侧边栏任务按需创建（幂等；内部同步）
    this.ensureMemberTask(team, member);

    const now = Date.now();
    const attempt = (task.attempt ?? 0) + 1;
    const attemptId = newAttemptId();
    task.attempt = attempt;
    task.attemptId = attemptId;
    task.status = 'in_progress';
    task.assignee = member.name;
    task.updatedAt = now;
    member.status = 'working';
    // 附带投递未读团队消息（消费 pendingMessages）
    const pendingToDeliver = member.pendingMessages ?? [];
    member.pendingMessages = [];
    this.store.save(team);
    this.notifyChanged(team.id);

    const ticket = buildTaskTicket(team, member, task, attemptId, pendingToDeliver);
    const controller = new AbortController();
    this.activeMemberRuns.set(member.sessionId, controller);
    this.registerExternalRun(member.sessionId, controller);

    // 动态成员（无 agentId）：票据前置注入角色提示
    const userMessage = member.agentId
      ? ticket
      : [
          `你在此团队中的角色设定：${member.name}${member.role ? `（${member.role}）` : ''}`,
          member.inlinePrompt ?? '',
          '',
          ticket,
        ]
          .filter(Boolean)
          .join('\n');

    this.logger.info('agenteam: dispatch task', {
      teamId: team.id,
      member: member.name,
      taskId: task.id,
      attempt,
    });

    void this.engine
      .run({
        sessionId: member.sessionId,
        agentId: member.agentId,
        userMessage,
        permissionMode: team.permissionMode ?? 'auto',
        cwd: team.cwd,
        onEvent: (event: AgentEvent) => {
          // 成员事件广播（server 转发 WS agenteam.member.event）
          void this.eventBus.broadcast('agenteam:member-event', {
            teamId: team.id,
            memberName: member.name,
            taskId: task.id,
            event,
          });
        },
        signal: controller.signal,
      })
      .then((result) => {
        // 完成处理（旧 attempt 的迟到结果丢弃）
        const fresh = this.store.get(team.id);
        if (!fresh) return;
        const freshTask = fresh.tasks.find((t) => t.id === task.id);
        const freshMember = fresh.members.find((m) => m.name === member.name);
        if (!freshTask || !freshMember) return;

        // 成员已在 run 中通过 agent(mode=agenteam, action=task) 自我报告（任务已终态且产出已写）：
        // 只重置成员状态并推进调度，不重复处理/重复报告
        if (TERMINAL_TASK_STATUSES.includes(freshTask.status) && freshTask.output !== undefined) {
          if (freshMember.status === 'working') {
            freshMember.status = 'idle';
            this.store.save(fresh);
          }
          void this.kick(team.id);
          return;
        }
        if (freshTask.attemptId !== attemptId) return; // 已被重派/中止，丢弃

        const success = result.finishReason === 'stop' && result.finalText.trim() !== '';
        const outputText = result.finalText.trim() || '(no output)';
        const completeTime = Date.now();
        let reportStatus: 'completed' | 'failed' | 'pending' = 'completed';

        if (success) {
          freshTask.output = outputText;
          freshTask.status = 'completed';
          freshTask.updatedAt = completeTime;
          freshMember.status = 'idle';

          // 质量门禁：审查类任务未 pass 时打回重做
          const evaluation = evaluateQualityCompletion(freshTask);
          if (!evaluation.ok) {
            freshTask.status = 'pending';
            freshTask.updatedAt = completeTime;
            reportStatus = 'pending';
            const gateMsg = `质量门禁未通过：${evaluation.reason}。请继续完善（可在完成时调用 agent(mode=agenteam, action=task, patch={...}) 补充 verdict/acceptanceResults）。`;
            this.appendMessage(fresh, {
              from: 'captain',
              to: member.name,
              content: gateMsg,
            });
            // 打回消息入成员待收队列（下次派发 ticket 附带）
            freshMember.pendingMessages = [...(freshMember.pendingMessages ?? []), `captain: ${gateMsg}`];
          } else {
            const followUp = planQualityFollowUp(fresh, freshTask);
            if (followUp) {
              this.addFollowUpTask(fresh, followUp.task, followUp.reason, followUp.escalate);
            }
          }
        } else {
          freshTask.output = outputText;
          freshTask.status = 'failed';
          freshTask.updatedAt = completeTime;
          freshMember.status = 'idle';
          reportStatus = 'failed';

          // 失败 → 质量门禁类走 follow-up（repair 循环）；
          // 普通 work/implementation 类且 attempt 未达上限 → 自动重试
          const followUp = planQualityFollowUp(fresh, freshTask);
          if (followUp) {
            this.addFollowUpTask(fresh, followUp.task, followUp.reason, followUp.escalate);
          } else if ((freshTask.attempt ?? 1) < MAX_TASK_RETRY_ATTEMPTS) {
            freshTask.status = 'pending';
            freshTask.updatedAt = completeTime;
            reportStatus = 'pending';
          }
        }

        this.store.save(fresh);
        this.notifyChanged(team.id);

        // 消息流记录（前端展示）
        this.appendMessage(fresh, {
          from: member.name,
          to: 'captain',
          content: `任务 ${task.id}「${task.subject}」${reportStatus === 'completed' ? '完成' : reportStatus === 'pending' ? '被打回重做' : '失败'}。产出：\n${truncate(outputText, 600)}`,
        });

        // 唤醒队长决策（报告注入 captain 会话新 turn）
        const completedCount = fresh.tasks.filter((t) => t.status === 'completed').length;
        const failedCount = fresh.tasks.filter((t) => t.status === 'failed').length;
        this.enqueueCaptainRun(
          fresh,
          [
            `[Agenteam] 成员 ${member.name} 报告：`,
            `任务 ${task.id}「${task.subject}」${reportStatus === 'completed' ? '已完成' : reportStatus === 'pending' ? '被打回重做' : '失败'}。产出：`,
            truncate(outputText, 800),
            '',
            `当前团队进度：${completedCount}/${fresh.tasks.length} 完成，${failedCount} 失败。`,
            '作为队长请决策下一步：无需行动则简短确认；需要时可调用 agent（mode=agenteam）调整任务/重派/发消息。',
          ].join('\n'),
        );

        // 链式推进：任务完成后继续调度
        void this.kick(team.id);
      })
      .catch((err: unknown) => {
        // run 抛错（含 abort）：任务 failed（abort 视为 cancelled）
        const fresh = this.store.get(team.id);
        if (fresh) {
          const freshTask = fresh.tasks.find((t) => t.id === task.id);
          const freshMember = fresh.members.find((m) => m.name === member.name);
          const aborted = controller.signal.aborted;
          if (freshTask && freshMember && freshTask.attemptId === attemptId) {
            freshTask.status = aborted ? 'cancelled' : 'failed';
            freshTask.output = aborted ? '(halted)' : `error: ${err instanceof Error ? err.message : String(err)}`;
            freshTask.updatedAt = Date.now();
            freshMember.status = 'idle';
            this.store.save(fresh);
            this.notifyChanged(team.id);
            if (!aborted) {
              this.enqueueCaptainRun(
                fresh,
                [
                  `[Agenteam] 成员 ${member.name} 执行异常：`,
                  `任务 ${task.id}「${task.subject}」run 抛错：${err instanceof Error ? err.message : String(err)}`,
                  '作为队长请决策（重派/换人/调整方案）。',
                ].join('\n'),
              );
            }
          }
        }
      })
      .finally(() => {
        this.activeMemberRuns.delete(member.sessionId);
        this.unregisterExternalRun(member.sessionId, controller);
      });
  }

  /** follow-up 任务入队（质量门禁循环） */
  private addFollowUpTask(
    team: TeamState,
    spec: Omit<TeamTask, 'id' | 'createdAt' | 'updatedAt'>,
    reason: string,
    escalate: boolean,
  ): void {
    const now = Date.now();
    team.taskSeq += 1;
    const task: TeamTask = {
      ...spec,
      id: `t${team.taskSeq}`,
      createdAt: now,
      updatedAt: now,
    };
    team.tasks.push(task);
    if (escalate) {
      team.escalated = true;
      this.appendMessage(team, {
        from: 'captain',
        to: 'user',
        content: `质量循环触顶（${reason}），已生成 follow-up 任务 ${task.id} 并标记 escalated，请人工介入。`,
      });
    } else {
      this.appendMessage(team, {
        from: 'captain',
        to: 'user',
        content: `质量门禁 follow-up：${reason} → 新任务 ${task.id}「${task.subject}」。`,
      });
    }
  }

  /** 成员会话任务幂等创建（团队专属隐藏分组；sessionId=taskId；不出现在侧边栏） */
  private ensureMemberTask(team: TeamState, member: TeamState['members'][number]): void {
    if (member.sessionId && member.taskId) return;
    const group = this.ensureTeamGroup(team);
    const task = this.engine.createTask(`${team.name} / ${member.name}`, group.id);
    member.sessionId = task.id;
    member.taskId = task.id;
    const fresh = this.store.get(team.id);
    if (fresh) {
      const m = fresh.members.find((x) => x.name === member.name);
      if (m) {
        m.sessionId = task.id;
        m.taskId = task.id;
      }
      this.store.save(fresh);
    }
  }

  /** 团队整体完成检查：全部任务终态 → 队长最终汇报（兜底自动汇总） */
  private checkTeamCompletion(teamId: string): void {
    const team = this.store.get(teamId);
    if (!team || team.phase !== 'running') return;
    if (!allTasksTerminal(team.tasks)) return;
    if (this.summarizing.has(teamId)) return;
    this.summarizing.add(teamId);

    const completed = team.tasks.filter((t) => t.status === 'completed');
    const failed = team.tasks.filter((t) => t.status === 'failed');
    const cancelled = team.tasks.filter((t) => t.status === 'cancelled');

    // 无队长会话（历史脏数据/异常建队）→ 自动拼 summary 并置终态
    if (!team.captainSessionId) {
      this.finalizeTeam(team, completed, failed, cancelled, this.buildFallbackSummary(team, completed));
      return;
    }

    // 队长最终汇报（captain 输出面向用户的总结）
    this.enqueueCaptainRun(
      team,
      [
        `[Agenteam] 团队「${team.name}」所有任务已到达终态（${completed.length} 完成 / ${failed.length} 失败 / ${cancelled.length} 取消）。`,
        '请调用 agent(mode=agenteam, action=status) 查看全部任务与产出，然后输出面向用户的最终总结报告：',
        '- 各任务成果摘要（引用关键产出）',
        '- 失败任务的失败原因与影响',
        '- 后续建议（如有）',
        '你的最终回复将被保存为团队总结。',
      ].join('\n'),
      { isFinalReport: true },
    );
  }

  /** 置团队终态（captain 汇报完成或兜底路径调用） */
  private finalizeTeam(
    team: TeamState,
    completed: TeamTask[],
    failed: TeamTask[],
    _cancelled: TeamTask[],
    summary: string,
  ): void {
    team.phase = failed.length > 0 && completed.length === 0 ? 'failed' : 'completed';
    team.summary = summary;
    this.store.save(team);
    this.appendMessage(team, {
      from: 'captain',
      to: 'user',
      content: summary,
    });
    this.summarizing.delete(team.id);
    this.notifyChanged(team.id);
  }

  /** 兜底自动汇总（无队长或队长汇报失败时） */
  private buildFallbackSummary(team: TeamState, completed: TeamTask[]): string {
    return [
      `团队「${team.name}」执行结束。`,
      `任务总数 ${team.tasks.length}：完成 ${completed.length}，失败 ${team.tasks.filter((t) => t.status === 'failed').length}，取消 ${team.tasks.filter((t) => t.status === 'cancelled').length}。`,
      ...(completed.length > 0
        ? [
            '各任务产出：',
            ...completed.map(
              (t) => `- [${t.id}] ${t.subject}（${t.assignee ?? 'unassigned'}）：\n  ${truncate(t.output ?? '(no output)', 300)}`,
            ),
          ]
        : []),
    ].join('\n');
  }

  // ========================================================================
  // 临时 Subagent
  // ========================================================================

  /** 一次性 subagent：模板 agentId + 专属 session，同步返回结果（落盘 tasks/subagent/） */
  async runSubagent(input: SubagentRunInput): Promise<SubagentRunOutput> {
    if (!input.template?.trim()) throw new Error('template required');
    if (!input.task?.trim()) throw new Error('task required');

    const group = this.ensureSubagentGroup();
    const task = this.engine.createTask(`Subagent · ${input.template}`, group.id);

    this.logger.info('agenteam: subagent run', {
      template: input.template,
      taskId: task.id,
    });

    const controller = new AbortController();
    this.activeMemberRuns.set(task.id, controller);
    this.registerExternalRun(task.id, controller);
    try {
      const result = await this.engine.run({
        sessionId: task.id,
        agentId: input.template,
        userMessage: input.task,
        permissionMode: input.permissionMode ?? 'auto',
        cwd: input.cwd,
        onEvent: (event: AgentEvent) => {
          void this.eventBus.broadcast('agenteam:member-event', {
            teamId: null,
            memberName: input.template,
            taskId: task.id,
            event,
          });
        },
        signal: controller.signal,
      });
      return {
        sessionId: task.id,
        taskId: task.id,
        finishReason: result.finishReason,
        result: result.finalText,
      };
    } finally {
      this.activeMemberRuns.delete(task.id);
      this.unregisterExternalRun(task.id, controller);
    }
  }

  // ========================================================================
  // 工具支持（captain 工具的操作入口）
  // ========================================================================

  /** 运行期添加成员 */
  addMember(teamId: string, spec: MemberSpec): TeamState {
    const team = this.mustGet(teamId);
    if (team.members.some((m) => m.name === spec.name)) {
      throw new Error(`member name "${spec.name}" already exists`);
    }
    team.members.push({
      id: `m${team.members.length + 1}`,
      name: spec.name,
      role: spec.role,
      agentId: spec.agentId,
      inlinePrompt: spec.inlinePrompt,
      sessionId: '',
      executionPrompt: spec.executionPrompt,
      joinedAt: Date.now(),
      status: 'idle',
    });
    this.store.save(team);
    this.notifyChanged(teamId);
    void this.kick(teamId);
    return team;
  }

  /** 运行期移除成员（进行中任务置回 pending） */
  removeMember(teamId: string, memberName: string): TeamState {
    const team = this.mustGet(teamId);
    const member = team.members.find((m) => m.name === memberName);
    if (!member) throw new Error(`member "${memberName}" not found`);
    member.status = 'removed';
    const controller = this.activeMemberRuns.get(member.sessionId);
    if (controller) controller.abort();
    const now = Date.now();
    for (const task of team.tasks) {
      if (task.assignee === memberName && !TERMINAL_TASK_STATUSES.includes(task.status)) {
        task.status = 'pending';
        task.assignee = undefined;
        task.reassigning = false;
        task.updatedAt = now;
      }
    }
    this.store.save(team);
    this.notifyChanged(teamId);
    void this.kick(teamId);
    return team;
  }

  /** 运行期创建任务（队长/成员工具） */
  createTask(
    teamId: string,
    spec: TaskSpec & { dependencies?: string[] },
  ): TeamState {
    const team = this.mustGet(teamId);
    const now = Date.now();
    team.taskSeq += 1;
    const task: TeamTask = {
      id: `t${team.taskSeq}`,
      subject: spec.subject,
      description: spec.description,
      status: 'pending',
      assignee: spec.assignee,
      dependencies: spec.dependencies ?? [],
      kind: spec.kind,
      reviewedTaskId: spec.reviewedTaskId,
      sourceTaskId: spec.sourceTaskId,
      createdAt: now,
      updatedAt: now,
    };
    const validation = validateCreateTask(task, team);
    if (!validation.ok) throw new Error(validation.reason ?? 'invalid task');
    team.tasks.push(task);
    this.store.save(team);
    this.notifyChanged(teamId);
    void this.kick(teamId);
    return team;
  }

  /**
   * 计划修订（action=edit）：在一个事务内增删成员与任务。
   * staged / running 阶段可用；终态（completed/failed/halted）拒绝。
   */
  editTeam(teamId: string, plan: EditPlanInput): TeamState {
    const team = this.mustGet(teamId);
    if (team.phase !== 'staged' && team.phase !== 'running') {
      throw new Error(`team phase is ${team.phase}, plan cannot be edited`);
    }
    const now = Date.now();

    if (plan.description !== undefined) team.description = plan.description;

    for (const name of plan.removeMembers ?? []) {
      const member = team.members.find((m) => m.name === name && m.status !== 'removed');
      if (!member) continue;
      member.status = 'removed';
      const controller = this.activeMemberRuns.get(member.sessionId);
      if (controller) controller.abort();
      for (const task of team.tasks) {
        if (task.assignee === name && !TERMINAL_TASK_STATUSES.includes(task.status)) {
          task.status = 'pending';
          task.assignee = undefined;
          task.reassigning = false;
          task.updatedAt = now;
        }
      }
    }

    for (const spec of plan.addMembers ?? []) {
      if (team.members.some((m) => m.name === spec.name && m.status !== 'removed')) {
        throw new Error(`member name "${spec.name}" already exists`);
      }
      team.members.push({
        id: `m${team.members.length + 1}`,
        name: spec.name,
        role: spec.role,
        agentId: spec.agentId,
        inlinePrompt: spec.inlinePrompt,
        sessionId: '',
        executionPrompt: spec.executionPrompt,
        joinedAt: now,
        status: 'idle',
      });
    }

    for (const id of plan.removeTasks ?? []) {
      const task = team.tasks.find((t) => t.id === id);
      if (!task) continue;
      const controller = task.assignee
        ? this.activeMemberRuns.get(team.members.find((m) => m.name === task.assignee)?.sessionId ?? '')
        : undefined;
      if (controller) controller.abort();
      team.tasks = team.tasks.filter((t) => t.id !== id);
    }

    for (const spec of plan.addTasks ?? []) {
      team.taskSeq += 1;
      const task: TeamTask = {
        id: `t${team.taskSeq}`,
        subject: spec.subject,
        description: spec.description,
        status: 'pending',
        assignee: spec.assignee,
        dependencies: spec.dependencies ?? [],
        kind: spec.kind,
        reviewedTaskId: spec.reviewedTaskId,
        sourceTaskId: spec.sourceTaskId,
        createdAt: now,
        updatedAt: now,
      };
      const validation = validateCreateTask(task, team);
      if (!validation.ok) throw new Error(validation.reason ?? 'invalid task');
      team.tasks.push(task);
    }

    this.store.save(team);
    this.notifyChanged(teamId);
    void this.kick(teamId);
    return team;
  }

  /** 认领 pending 任务（等价置 in_progress，交由调度器按指派/认领规则接管） */
  claimTask(teamId: string, taskId: string): TeamState {
    const team = this.mustGet(teamId);
    const task = team.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`task "${taskId}" not found`);
    if (task.status !== 'pending') throw new Error(`task status is ${task.status}, not pending`);
    return this.updateTask(teamId, taskId, { status: 'in_progress' });
  }

  /** 任务更新（captain 工具；需 attemptId 防旧报告） */
  updateTask(
    teamId: string,
    taskId: string,
    patch: Partial<Pick<TeamTask, 'status' | 'output' | 'verdict' | 'findings' | 'acceptanceResults' | 'commandsRun'>>,
    attemptId?: string,
  ): TeamState {
    const team = this.mustGet(teamId);
    const task = team.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`task "${taskId}" not found`);

    if (task.attemptId && attemptId && task.attemptId !== attemptId) {
      throw new Error('stale attemptId: task has been reassigned or retried');
    }
    Object.assign(task, patch);
    task.updatedAt = Date.now();

    // 完成时走质量门禁
    if (task.status === 'completed') {
      const evaluation = evaluateQualityCompletion(task);
      if (!evaluation.ok) {
        task.status = 'pending';
        this.store.save(team);
        this.notifyChanged(teamId);
        throw new Error(evaluation.reason ?? 'quality gate failed');
      }
    }
    this.store.save(team);
    this.notifyChanged(teamId);
    if (!TERMINAL_TASK_STATUSES.includes(task.status)) {
      void this.kick(teamId);
    } else {
      this.checkTeamCompletion(teamId);
    }
    return team;
  }

  /** 任务重派（换人/重试） */
  reassignTask(teamId: string, taskId: string, assignee?: string): TeamState {
    const team = this.mustGet(teamId);
    const task = team.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`task "${taskId}" not found`);
    task.assignee = assignee;
    task.status = 'pending';
    task.reassigning = false;
    task.handoffId = undefined;
    task.updatedAt = Date.now();
    this.store.save(team);
    this.notifyChanged(teamId);
    void this.kick(teamId);
    return team;
  }

  /**
   * 发送团队消息（真投递）：
   * - to=成员名：消息入该成员 pendingMessages，kick 时投递（派发 ticket 附带或消息处理 run）
   * - to=captain：消息注入队长决策队列（唤醒队长）
   */
  sendMessage(teamId: string, from: string, to: string, content: string): TeamState {
    const team = this.mustGet(teamId);
    this.appendMessage(team, { from, to, content });

    if (to === 'captain') {
      // 队长自我消息无意义（工具层已阻止，防御）
      if (from !== 'captain') {
        this.enqueueCaptainRun(
          team,
          [
            `[Agenteam] ${from} 消息：`,
            content,
            '',
            '作为队长请决策下一步：无需行动则简短确认；需要时用 agent（mode=agenteam）行动。',
          ].join('\n'),
        );
      }
    } else {
      const member = team.members.find((m) => m.name === to && m.status !== 'removed');
      if (member) {
        member.pendingMessages = [...(member.pendingMessages ?? []), `${from}: ${content}`];
        this.store.save(team);
        // 空闲成员立即触发投递
        if (member.status === 'idle' && member.sessionId) {
          void this.kick(teamId);
        }
      }
    }
    this.notifyChanged(teamId);
    return team;
  }

  // ========================================================================
  // 内部
  // ========================================================================

  // ========================================================================
  // Captain 机制（MOSS 等价物：串行决策队列）
  // ========================================================================

  /**
   * 获取/创建团队专属隐藏分组（id=teamId，dir=agenteam/<teamId>，hidden）。
   * 成员与自动队长会话均落于 tasks/agenteam/<teamId>/；分组不出现在侧边栏。
   */
  private ensureTeamGroup(team: TeamState): { id: string } {
    const groups = this.engine.listTaskGroups();
    const existing = groups.find((g) => g.id === team.id);
    if (existing) return existing;
    return this.engine.createTaskGroup(`Agenteam · ${team.name}`, 'manual', {
      id: team.id,
      dir: `agenteam/${team.id}`,
      hidden: true,
    });
  }

  /** 获取/创建 subagent 隐藏分组（id='subagent'，dir=subagent，hidden；平坦存放每次会话） */
  private ensureSubagentGroup(): { id: string } {
    const groups = this.engine.listTaskGroups();
    const existing = groups.find((g) => g.id === SUBAGENT_GROUP_ID);
    if (existing) return existing;
    return this.engine.createTaskGroup('Subagent', 'manual', {
      id: SUBAGENT_GROUP_ID,
      dir: 'subagent',
      hidden: true,
    });
  }

  /**
   * 队长会话 id：队长恒为“创建团队的主会话”（主 agent 自身），不另建队长会话。
   * 无队长会话（历史脏数据）时返回 null，调用方走兜底汇总。
   */
  private ensureCaptainTask(team: TeamState): string | null {
    return team.captainSessionId || null;
  }

  /**
   * 队长决策入队：把内容作为新 turn 注入队长（主）会话（串行队列防同 session 并发 run）。
   */
  private enqueueCaptainRun(team: TeamState, content: string, opts?: { isFinalReport?: boolean }): void {
    if (!this.ensureCaptainTask(team)) return;
    const teamId = team.id;
    const previous = this.captainRuns.get(teamId) ?? Promise.resolve();
    const next = previous
      .then(() => this.runCaptainTurn(teamId, content, opts?.isFinalReport === true))
      .catch((err: unknown) => {
        this.logger.warn('agenteam: captain run failed', {
          teamId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (this.captainRuns.get(teamId) === next) this.captainRuns.delete(teamId);
      });
    this.captainRuns.set(teamId, next);
  }

  /** 执行一次队长决策 turn（引擎调用 + 事件广播 + 最终汇报落盘） */
  private async runCaptainTurn(teamId: string, content: string, isFinalReport: boolean): Promise<void> {
    const team = this.store.get(teamId);
    if (!team) return;
    // 暂停/未批准/已删除的团队不打扰队长
    if (team.phase === 'halted' || team.phase === 'staged') return;
    const captainSessionId = this.ensureCaptainTask(team);
    if (!captainSessionId) return;

    const controller = new AbortController();
    this.activeCaptainRuns.set(captainSessionId, controller);
    this.registerExternalRun(captainSessionId, controller);
    this.logger.info('agenteam: captain turn', { teamId, isFinalReport });
    try {
      const result = await this.engine.run({
        sessionId: captainSessionId,
        // 队长即主会话本身：沿用其既有 agent 配置（不传 agentId）
        agentId: undefined,
        userMessage: content,
        permissionMode: team.permissionMode ?? 'auto',
        cwd: team.cwd,
        onEvent: (event: AgentEvent) => {
          void this.eventBus.broadcast('agenteam:member-event', {
            teamId,
            memberName: 'captain',
            taskId: null,
            event,
          });
        },
        signal: controller.signal,
      });

      // 最终汇报：captain 的最终回复存为团队总结并置终态
      if (isFinalReport) {
        const fresh = this.store.get(teamId);
        if (!fresh) return;
        const completed = fresh.tasks.filter((t) => t.status === 'completed');
        const failed = fresh.tasks.filter((t) => t.status === 'failed');
        const cancelled = fresh.tasks.filter((t) => t.status === 'cancelled');
        const summaryText = result.finalText.trim();
        if (summaryText) {
          this.finalizeTeam(fresh, completed, failed, cancelled, summaryText);
        } else {
          // 队长空回复 → 兜底自动汇总
          this.finalizeTeam(fresh, completed, failed, cancelled, this.buildFallbackSummary(fresh, completed));
        }
      }
    } catch (err) {
      // 队长 run 失败（含 abort）：最终汇报走兜底自动汇总；普通决策失败仅记日志
      if (isFinalReport && !controller.signal.aborted) {
        const fresh = this.store.get(teamId);
        if (fresh) {
          const completed = fresh.tasks.filter((t) => t.status === 'completed');
          const failed = fresh.tasks.filter((t) => t.status === 'failed');
          const cancelled = fresh.tasks.filter((t) => t.status === 'cancelled');
          this.finalizeTeam(fresh, completed, failed, cancelled, this.buildFallbackSummary(fresh, completed));
        }
      }
      if (!controller.signal.aborted) {
        this.logger.warn('agenteam: captain turn error', {
          teamId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.activeCaptainRuns.delete(captainSessionId);
      this.unregisterExternalRun(captainSessionId, controller);
    }
  }

  /**
   * 消息处理 run（MOSS 等价物）：
   * 把成员的未读消息作为新 turn 投递给空闲成员，成员阅读并按消息行事/回复。
   */
  private deliverMemberMessages(team: TeamState, member: TeamState['members'][number]): void {
    const messages = member.pendingMessages ?? [];
    if (messages.length === 0) return;
    this.ensureMemberTask(team, member);
    if (!member.sessionId) return;

    // 消费未读消息
    member.pendingMessages = [];
    this.store.save(team);
    this.notifyChanged(team.id);

    const content = [
      '[Agenteam] 你收到团队消息：',
      ...messages.map((m) => `- ${m}`),
      '',
      '请阅读并按消息内容行事（若需要回复，可用 agent(mode=agenteam, action=message)，to=captain 或队友名；若无实际行动需要，简短确认即可）。',
    ].join('\n');

    const controller = new AbortController();
    this.activeMemberRuns.set(member.sessionId, controller);
    this.registerExternalRun(member.sessionId, controller);
    this.logger.info('agenteam: deliver messages to member', {
      teamId: team.id,
      member: member.name,
      count: messages.length,
    });

    const userMessage = member.agentId
      ? content
      : [
          `你在此团队中的角色设定：${member.name}${member.role ? `（${member.role}）` : ''}`,
          member.inlinePrompt ?? '',
          '',
          content,
        ]
          .filter(Boolean)
          .join('\n');

    void this.engine
      .run({
        sessionId: member.sessionId,
        agentId: member.agentId,
        userMessage,
        permissionMode: team.permissionMode ?? 'auto',
        cwd: team.cwd,
        onEvent: (event: AgentEvent) => {
          void this.eventBus.broadcast('agenteam:member-event', {
            teamId: team.id,
            memberName: member.name,
            taskId: null,
            event,
          });
        },
        signal: controller.signal,
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          this.logger.warn('agenteam: member message run failed', {
            teamId: team.id,
            member: member.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .finally(() => {
        this.activeMemberRuns.delete(member.sessionId);
        this.unregisterExternalRun(member.sessionId, controller);
      });
  }

  private mustGet(teamId: string): TeamState {
    const team = this.store.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    return team;
  }

  private appendMessage(team: TeamState, message: Omit<TeamMessage, 'id' | 'ts'>): void {
    const msg: TeamMessage = {
      id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      ...message,
    };
    this.store.appendMessage(team.id, msg);
  }

  private notifyChanged(teamId: string): void {
    void this.eventBus.broadcast('agenteam:team-changed', { teamId });
  }

  /** 兜底轮询：每 5s 对 running 团队触发调度（事件遗漏/重启恢复） */
  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      for (const team of this.store.list()) {
        if (team.phase === 'running' && !team.halted) {
          void this.kick(team.id);
        }
      }
    }, 5000);
  }
}

/** 文本截断 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} [truncated]`;
}
