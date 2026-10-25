// src/modules/agenteam/tools.ts
// 单一 agent 工具：mode 区分 subagent（一次性子代理）与 agenteam（专家团编排），
// action 区分 agenteam 的具体操作。注册到 ToolRegistry（agenteam 模块 initialize 时），
// 随系统提示词暴露给主会话模型。
// 语义：主 agent（当前会话）就是队长，团队成员是队友；成员之间可互相发消息。

import { ServiceNames } from '../../core/types';
import type { ServiceRegistry, Logger, Environment } from '../../core/types';
import type { Tool, ToolResult, ToolContext } from '../tools/types';
import { textResult, errorResult } from '../tools/types';
import type { ToolRegistry } from '../contracts';
import { loadPromptFileOrNull } from '../context/prompt-loader';
import type { AgentRegistry } from './index';
import type { TeamOrchestrator, EditPlanInput } from './orchestrator';
import type { MemberSpec, TaskSpec, TeamTask, TaskKind } from './types';
import { TASK_KINDS } from './types';

/** agenteam 模式的操作枚举（7 个，覆盖全部编排能力） */
const AGENTEAM_ACTIONS = ['create', 'approve', 'edit', 'task', 'message', 'status', 'control'] as const;

type AgenteamAction = (typeof AGENTEAM_ACTIONS)[number];

// ============================================================================
// 参数结构（扁平：mode + action 分派；同类参数收进 plan/patch）
// ============================================================================

interface MemberSpecInput {
  name?: string;
  role?: string;
  agentId?: string;
  inlinePrompt?: string;
  executionPrompt?: string;
}

interface TaskSpecInput {
  subject?: string;
  description?: string;
  kind?: string;
  dependencies?: string[];
  assignee?: string;
  /** kind=review 必填：被审查的任务 id */
  reviewedTaskId?: string;
  /** kind=repair 必填：修复来源任务 id */
  sourceTaskId?: string;
}

interface AgentToolParams {
  mode?: 'subagent' | 'agenteam';
  action?: string;

  // --- subagent ---
  /** 注册表 agent id（如 agent_explorer） */
  template?: string;
  /** 完整自包含的任务描述（子代理只看得到它） */
  task?: string;

  cwd?: string;

  // --- agenteam：定位 ---
  teamId?: string;

  // --- create ---
  name?: string;
  description?: string;
  members?: MemberSpecInput[];
  tasks?: TaskSpecInput[];
  approval?: boolean;

  // --- edit ---
  plan?: {
    description?: string;
    addMembers?: MemberSpecInput[];
    removeMembers?: string[];
    addTasks?: TaskSpecInput[];
    removeTasks?: string[];
  };

  // --- task ---
  taskId?: string;
  attemptId?: string;
  patch?: {
    status?: string;
    output?: string;
    verdict?: string;
    findings?: Array<{ id?: string; severity?: string; file?: string; line?: number; problem?: string; requiredFix?: string }>;
    acceptanceResults?: Array<{ criterion?: string; status?: string; evidence?: string }>;
    commandsRun?: Array<{ command?: string; status?: string; exitCode?: number; evidence?: string }>;
  };
  /** 重派：成员名（空字符串=取消指派） */
  assignee?: string;
  /** 认领：仅 pending 任务可认领 */
  claim?: boolean;

  // --- message ---
  to?: string;
  content?: string;

  // --- control ---
  op?: 'resume' | 'delete';
}

// ============================================================================
// 工具实现辅助
// ============================================================================

function resolveRegistry(services: ServiceRegistry): AgentRegistry | null {
  return services.tryResolve<AgentRegistry>('agenteam.registry');
}

/** 校验成员规格（agentId 存在性 + inlinePrompt 兜底） */
function normalizeMembers(raw: MemberSpecInput[] | undefined, registry: AgentRegistry | null): MemberSpec[] {
  if (!raw || raw.length === 0) throw new Error('members：至少需要一个成员');
  return raw.map((m, i) => {
    const name = (m.name ?? '').trim();
    if (!name) throw new Error(`members[${i}].name 为必填项`);
    if (!m.agentId && !m.inlinePrompt) {
      throw new Error(`成员 "${name}"：agentId 或 inlinePrompt 为必填项`);
    }
    if (m.agentId && registry && !registry.get(m.agentId)) {
      throw new Error(`成员 "${name}"：注册表中未找到 agentId "${m.agentId}"`);
    }
    return {
      name,
      role: m.role,
      agentId: m.agentId,
      inlinePrompt: m.inlinePrompt,
      executionPrompt: m.executionPrompt,
    };
  });
}

function normalizeKind(kind: string | undefined): TaskKind | undefined {
  return kind && (TASK_KINDS as readonly string[]).includes(kind) ? (kind as TaskKind) : undefined;
}

/** 任务规格规范化（含 review/repair 的必填指向字段） */
function normalizeTaskSpec(t: TaskSpecInput, index: number): TaskSpec & { reviewedTaskId?: string; sourceTaskId?: string } {
  const subject = (t.subject ?? '').trim();
  if (!subject) throw new Error(`tasks[${index}].subject 为必填项`);
  const kind = normalizeKind(t.kind);
  if (kind === 'review' && !t.reviewedTaskId?.trim()) {
    throw new Error(`任务 "${subject}"：kind=review 时必须提供 reviewedTaskId（被审查的任务 id）`);
  }
  if (kind === 'repair' && !t.sourceTaskId?.trim()) {
    throw new Error(`任务 "${subject}"：kind=repair 时必须提供 sourceTaskId（修复来源任务 id）`);
  }
  return {
    subject,
    description: t.description,
    kind,
    dependencies: t.dependencies ?? [],
    assignee: t.assignee,
    reviewedTaskId: t.reviewedTaskId,
    sourceTaskId: t.sourceTaskId,
  };
}

function normalizeTasks(raw: TaskSpecInput[] | undefined): Array<TaskSpec & { reviewedTaskId?: string; sourceTaskId?: string }> {
  if (!raw || raw.length === 0) throw new Error('tasks：至少需要一个任务');
  return raw.map((t, i) => normalizeTaskSpec(t, i));
}

/** updateTask patch 规范化（枚举字符串 → 具体类型；无效值丢弃） */
function normalizeTaskPatch(patch: AgentToolParams['patch']): Partial<
  Pick<TeamTask, 'status' | 'output' | 'verdict' | 'findings' | 'acceptanceResults' | 'commandsRun'>
> {
  if (!patch) return {};
  const out: Partial<Pick<TeamTask, 'status' | 'output' | 'verdict' | 'findings' | 'acceptanceResults' | 'commandsRun'>> = {};
  const STATUSES = ['pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'];
  const VERDICTS = ['pass', 'needs_revision', 'reject'];
  const SEVERITIES = ['low', 'medium', 'high', 'blocker'];
  if (patch.status && STATUSES.includes(patch.status)) {
    out.status = patch.status as TeamTask['status'];
  }
  if (typeof patch.output === 'string') out.output = patch.output;
  if (patch.verdict && VERDICTS.includes(patch.verdict)) {
    out.verdict = patch.verdict as TeamTask['verdict'];
  }
  if (Array.isArray(patch.findings)) {
    out.findings = patch.findings
      .filter((f) => f?.id && f.problem && f.requiredFix && f.severity && SEVERITIES.includes(f.severity))
      .map((f) => ({
        id: f.id as string,
        severity: f.severity as 'low' | 'medium' | 'high' | 'blocker',
        file: f.file,
        line: f.line,
        problem: f.problem as string,
        requiredFix: f.requiredFix as string,
      }));
  }
  if (Array.isArray(patch.acceptanceResults)) {
    out.acceptanceResults = patch.acceptanceResults
      .filter((r) => r?.criterion && (r.status === 'passed' || r.status === 'failed'))
      .map((r) => ({ criterion: r.criterion as string, status: r.status as 'passed' | 'failed', evidence: r.evidence }));
  }
  if (Array.isArray(patch.commandsRun)) {
    out.commandsRun = patch.commandsRun
      .filter((c) => c?.command && (c.status === 'passed' || c.status === 'failed'))
      .map((c) => ({ command: c.command as string, status: c.status as 'passed' | 'failed', exitCode: c.exitCode, evidence: c.evidence }));
  }
  return out;
}

function formatTeamStatus(team: {
  id: string; name: string; phase: string; tasks: TeamTask[]; members: Array<{ name: string; status: string; role?: string }>; summary?: string;
}): string {
  const lines: string[] = [];
  lines.push(`团队 ${team.id}「${team.name}」phase=${team.phase}`);
  const members = team.members
    .map((m) => `  - ${m.name}${m.role ? ` (${m.role})` : ''}: ${m.status}`)
    .join('\n');
  lines.push(`成员：\n${members}`);
  const tasks = team.tasks
    .map(
      (t) =>
        `  - [${t.id}] ${t.subject} status=${t.status}${t.assignee ? ` assignee=${t.assignee}` : ''}${t.dependencies.length > 0 ? ` deps=[${t.dependencies.join(',')}]` : ''}${t.kind && t.kind !== 'work' ? ` kind=${t.kind}` : ''}`,
    )
    .join('\n');
  lines.push(`任务：\n${tasks}`);
  if (team.summary) lines.push(`总结：\n${team.summary}`);
  return lines.join('\n');
}

// ============================================================================
// 分支实现
// ============================================================================

/** mode=subagent：一次性子代理（模板 agentId + 专属 session，同步返回结果） */
async function runSubagentMode(
  orch: TeamOrchestrator,
  p: AgentToolParams,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const template = (p.template ?? '').trim();
    const task = (p.task ?? '').trim();
    if (!template || !task) return errorResult('subagent 模式：template 与 task 为必填项');
    const registry = resolveRegistry(ctx.services);
    if (registry && !registry.get(template)) {
      return errorResult(`注册表中未找到模板 "${template}"`);
    }
    const output = await orch.runSubagent({
      template,
      task,
      cwd: p.cwd || ctx.cwd,
      parentToolCallId: ctx.toolCallId,
      parentSessionId: ctx.sessionId,
      signal: ctx.signal,
    });
    return textResult(
      `子代理已完成 (finishReason=${output.finishReason}, session=${output.sessionId}):\n\n${output.result}`,
      output.finishReason === 'error',
    );
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

/** mode=agenteam：按 action 分派 */
async function runAgenteamMode(
  orch: TeamOrchestrator,
  p: AgentToolParams,
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = p.action as AgenteamAction | undefined;
  if (!action || !(AGENTEAM_ACTIONS as readonly string[]).includes(action)) {
    return errorResult(`agenteam 模式：action 必须为以下之一：${AGENTEAM_ACTIONS.join(', ')}`);
  }
  // 调用方身份：成员会话 → 成员名；否则为主会话（队长）
  const actor = orch.resolveActor(ctx.sessionId);
  /** 成员调用时 teamId 可省略（自动定位到自己的团队） */
  const teamId = p.teamId ?? actor?.teamId;

  try {
    switch (action) {
      case 'create': {
        if (!p.name?.trim()) return errorResult('create：name 为必填项');
        const registry = resolveRegistry(ctx.services);
        const team = orch.createTeam({
          name: p.name,
          description: p.description,
          cwd: p.cwd || ctx.cwd,
          captainSessionId: ctx.sessionId,
          members: normalizeMembers(p.members, registry),
          tasks: normalizeTasks(p.tasks),
          approval: p.approval !== false,
        });
        return textResult(
          `团队已创建：id=${team.id} phase=${team.phase}。${
            team.phase === 'staged'
              ? '计划正在专家团面板等待用户批准，请提示用户前往审核并批准。'
              : '团队已开始运行，调度器会自动派发任务。'
          }`,
        );
      }

      case 'approve': {
        if (!teamId) return errorResult('approve：teamId 为必填项');
        const team = orch.approvePlan(teamId);
        return textResult(`团队已批准并开始运行。phase=${team.phase}`);
      }

      case 'edit': {
        if (!teamId) return errorResult('edit：teamId 为必填项');
        if (!p.plan) return errorResult('edit：plan 为必填项');
        const registry = resolveRegistry(ctx.services);
        const plan: EditPlanInput = {
          description: p.plan.description,
          removeMembers: p.plan.removeMembers,
          removeTasks: p.plan.removeTasks,
        };
        if (p.plan.addMembers?.length) plan.addMembers = normalizeMembers(p.plan.addMembers, registry);
        if (p.plan.addTasks?.length) plan.addTasks = p.plan.addTasks.map((t, i) => normalizeTaskSpec(t, i));
        const team = orch.editTeam(teamId, plan);
        return textResult(
          `计划已更新。成员：${team.members.filter((m) => m.status !== 'removed').map((m) => m.name).join(', ') || '(无)'}；任务：${team.tasks.map((t) => t.id).join(', ') || '(无)'}`,
        );
      }

      case 'task': {
        if (!teamId || !p.taskId) return errorResult('task：teamId 与 taskId 为必填项');
        if (p.claim === true) {
          const team = orch.claimTask(teamId, p.taskId);
          return textResult(`任务已认领。phase=${team.phase}`);
        }
        if (p.assignee !== undefined) {
          orch.reassignTask(teamId, p.taskId, p.assignee.trim() || undefined);
          return textResult(`任务 ${p.taskId} 已${p.assignee.trim() ? `重新指派给 ${p.assignee.trim()}` : '取消指派'}。`);
        }
        if (p.patch) {
          const team = orch.updateTask(teamId, p.taskId, normalizeTaskPatch(p.patch), p.attemptId);
          return textResult(`任务已更新。团队 phase=${team.phase}`);
        }
        return errorResult('task：需要 patch（上报产出）、assignee（重派）或 claim=true（认领）之一');
      }

      case 'message': {
        if (!p.to || !p.content) return errorResult('message：to 与 content 为必填项');
        if (!teamId) return errorResult('message：teamId 为必填项（主会话调用时必填）');
        const from = actor?.memberName ?? 'captain';
        orch.sendMessage(teamId, from, p.to, p.content);
        return textResult(`消息已发送给 ${p.to}。`);
      }

      case 'status': {
        if (!teamId) {
          const summaries = orch.summaries();
          if (summaries.length === 0) return textResult('暂无团队。');
          return textResult(summaries.map((s) => `团队 ${s.id}「${s.name}」phase=${s.phase} 任务=${s.taskCompleted}/${s.taskTotal}`).join('\n'));
        }
        const team = orch.get(teamId);
        if (!team) return errorResult(`未找到团队 "${teamId}"`);
        return textResult(formatTeamStatus(team));
      }

      case 'control': {
        if (!teamId) return errorResult('control：teamId 为必填项');
        if (p.op === 'resume') {
          const team = orch.resume(teamId);
          return textResult(`团队已恢复运行。phase=${team.phase}`);
        }
        if (p.op === 'delete') {
          const ok = orch.deleteTeam(teamId);
          return ok ? textResult('团队已删除。') : errorResult('未找到该团队');
        }
        return errorResult("control：op 必须为 'resume' 或 'delete'");
      }
    }
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============================================================================
// 工具定义
// ============================================================================

/** 任务项 schema（create.tasks 与 edit.plan.addTasks 复用） */
const TASK_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: '任务标题', description_en: 'Task title' },
    description: { type: 'string', description: '需要完成的内容', description_en: 'What needs to be done' },
    kind: {
      type: 'string',
      description: `质量门禁类型（${TASK_KINDS.join('/')}）；review 必须带 reviewedTaskId，repair 必须带 sourceTaskId`,
      description_en: `Quality-gate kind (${TASK_KINDS.join('/')}); review requires reviewedTaskId, repair requires sourceTaskId`,
      enum: [...TASK_KINDS],
    },
    dependencies: {
      type: 'array',
      items: { type: 'string' },
      description: '必须先完成的任务 id（t1、t2……）',
      description_en: 'Task ids that must complete first (t1, t2...)',
    },
    assignee: { type: 'string', description: '成员名；省略表示任意成员可认领', description_en: 'Member name; omit for any-member claim' },
    reviewedTaskId: { type: 'string', description: 'kind=review 必填：被审查的任务 id', description_en: 'Required when kind=review: the task id being reviewed' },
    sourceTaskId: { type: 'string', description: 'kind=repair 必填：修复来源任务 id', description_en: 'Required when kind=repair: the source task id' },
  },
  required: ['subject'],
};

const MEMBER_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '团队内唯一的成员名', description_en: 'Unique member name in team' },
    role: { type: 'string', description: '角色，如 researcher/engineer/reviewer', description_en: 'Role, e.g. researcher/engineer/reviewer' },
    agentId: { type: 'string', description: '注册表 agent id（优先使用）', description_en: 'Registry agent id (preferred)' },
    inlinePrompt: { type: 'string', description: '动态成员的内联 system prompt（无注册表条目时使用）', description_en: 'Inline system prompt for dynamic member (no registry entry)' },
    executionPrompt: { type: 'string', description: '附加到该成员任务票据上的额外提示词', description_en: 'Extra prompt appended to this member task tickets' },
  },
  required: ['name'],
};

function createAgentTool(orch: TeamOrchestrator, env: Environment): Tool {
  // 协议文案从 agent/prompts/agenteam/usage-zh.md 加载；缺失时为空串降级
  const usageZh = loadPromptFileOrNull(env, 'agenteam/usage-zh.md') ?? '';
  return {
    name: 'agent',
    icon: 'bot',
    description: `统一 agent 工具。mode="subagent" 运行一次性子代理（template + task）；mode="agenteam" 编排持久多智能体团队（action 选择具体操作）。${usageZh}`,
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['subagent', 'agenteam'], description: '执行模式："subagent"（一次性委派运行）或 "agenteam"（持久多智能体团队编排）', description_en: 'Execution mode: "subagent" (one-off delegated run) or "agenteam" (persistent team orchestration)' },
        action: { type: 'string', enum: [...AGENTEAM_ACTIONS], description: `agenteam 操作（mode="agenteam" 时必填）：${AGENTEAM_ACTIONS.join(' | ')}`, description_en: `agenteam operation (required when mode="agenteam"): ${AGENTEAM_ACTIONS.join(' | ')}` },

        // subagent
        template: { type: 'string', description: 'subagent 模式：注册表 agent id，如 agent_explorer / agent_planner / agent_coder / agent_reviewer', description_en: 'subagent mode: registry agent id, e.g. agent_explorer / agent_planner / agent_coder / agent_reviewer' },
        task: { type: 'string', description: 'subagent 模式：完整自包含的任务描述（子代理只能看到这段内容）', description_en: 'subagent mode: complete self-contained task description (the subagent sees only this)' },

        // 通用定位
        teamId: { type: 'string', description: 'agenteam：目标团队 id（成员会话调用可省略，自动定位到自己的团队）', description_en: 'agenteam: target team id (member sessions may omit it)' },
        cwd: { type: 'string', description: '工作目录（默认当前会话 cwd）', description_en: 'Working directory (defaults to current session cwd)' },

        // create
        name: { type: 'string', description: 'create：团队名称', description_en: 'create: team name' },
        description: { type: 'string', description: 'create：团队目标/用途', description_en: 'create: team goal/purpose' },
        members: { type: 'array', description: 'create：团队成员', description_en: 'create: team members', items: MEMBER_ITEM_SCHEMA },
        tasks: { type: 'array', description: 'create：任务 DAG（id 即数组顺序 1..N，如 t1、t2……）', description_en: 'create: task DAG (ids are the array order 1..N, i.e. t1, t2, ...)', items: TASK_ITEM_SCHEMA },
        approval: { type: 'boolean', description: 'create：true（默认）= 计划暂存并等待用户在专家团面板批准；false = 立即开始', description_en: 'create: true (default) = staged plan awaiting user approval; false = start immediately' },

        // edit
        plan: {
          type: 'object',
          description: 'edit：要施加的修订（可同时增删成员与任务）',
          description_en: 'edit: revisions to apply (members and tasks may be changed together)',
          properties: {
            description: { type: 'string', description: '替换团队描述', description_en: 'Replace team description' },
            addMembers: { type: 'array', items: MEMBER_ITEM_SCHEMA, description: '要添加的成员', description_en: 'Members to add' },
            removeMembers: { type: 'array', items: { type: 'string' }, description: '要移除的成员名', description_en: 'Member names to remove' },
            addTasks: { type: 'array', items: TASK_ITEM_SCHEMA, description: '要添加的任务', description_en: 'Tasks to add' },
            removeTasks: { type: 'array', items: { type: 'string' }, description: '要移除的任务 id', description_en: 'Task ids to remove' },
          },
        },

        // task
        taskId: { type: 'string', description: 'task：任务 id（t1、t2……）', description_en: 'task: task id (t1, t2...)' },
        attemptId: { type: 'string', description: 'task：派发票据中的 attempt id（用于拒绝过期上报）', description_en: 'task: the attempt id from the dispatch ticket (rejects stale reports)' },
        patch: {
          type: 'object',
          description: 'task：上报任务产出/状态（成员自报必用）',
          description_en: 'task: report task output/status (members must use this)',
          properties: {
            status: { type: 'string', enum: ['pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'] },
            output: { type: 'string' },
            verdict: { type: 'string', enum: ['pass', 'needs_revision', 'reject'] },
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  severity: { type: 'string', enum: ['low', 'medium', 'high', 'blocker'] },
                  file: { type: 'string' },
                  line: { type: 'number' },
                  problem: { type: 'string' },
                  requiredFix: { type: 'string' },
                },
                required: ['id', 'severity', 'problem', 'requiredFix'],
              },
            },
            acceptanceResults: {
              type: 'array',
              items: {
                type: 'object',
                properties: { criterion: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed'] }, evidence: { type: 'string' } },
                required: ['criterion', 'status'],
              },
            },
            commandsRun: {
              type: 'array',
              items: {
                type: 'object',
                properties: { command: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed'] }, exitCode: { type: 'number' }, evidence: { type: 'string' } },
                required: ['command', 'status'],
              },
            },
          },
        },
        assignee: { type: 'string', description: 'task：重派给该成员名（空字符串 = 取消指派）', description_en: 'task: reassign to this member (empty string = unassign)' },
        claim: { type: 'boolean', description: 'task：true = 认领该 pending 任务', description_en: 'task: true = claim this pending task' },

        // message
        to: { type: 'string', description: 'message：收件人（成员名或 captain）', description_en: 'message: recipient (member name or captain)' },
        content: { type: 'string', description: 'message：消息正文', description_en: 'message: message body' },

        // control
        op: { type: 'string', enum: ['resume', 'delete'], description: 'control：resume（恢复）或 delete（删除）', description_en: 'control: resume or delete' },
      },
      required: ['mode'],
    },
    annotations: { readOnlyHint: false },
    async execute(params, ctx: ToolContext): Promise<ToolResult> {
      const p = params as AgentToolParams;
      if (p.mode === 'subagent') return runSubagentMode(orch, p, ctx);
      if (p.mode === 'agenteam') return runAgenteamMode(orch, p, ctx);
      return errorResult('mode 必须为 "subagent" 或 "agenteam"');
    },
  };
}

// ============================================================================
// 注册入口
// ============================================================================

/**
 * 注册单一 agent 工具到 ToolRegistry。
 * 由 agenteam 模块 initialize 调用（此时 agent 引擎已就绪）。
 */
export function registerAgentTools(
  services: ServiceRegistry,
  orchestrator: TeamOrchestrator,
  logger: Logger,
  env: Environment,
): void {
  const registry = services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
  if (!registry) {
    logger.warn('agenteam: tool registry unavailable, agent tool not registered');
    return;
  }
  try {
    registry.register(createAgentTool(orchestrator, env));
  } catch (err) {
    logger.warn('agenteam: tool register failed', {
      tool: 'agent',
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  logger.info('agenteam: agent tool registered');
}
