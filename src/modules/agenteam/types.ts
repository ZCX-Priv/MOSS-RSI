// src/modules/agenteam/types.ts
// agenteam 编排类型定义。
// 团队持久化于 ~/.moss/agenteam/<teamId>/，成员执行复用 AgentEngine 的
// agentId + 持久 session 机制。

import type { PermissionMode } from '../safety/types';

// ============================================================================
// 任务
// ============================================================================

/** 任务生命周期状态（流转顺序） */
export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 终态：不可再认领/执行 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];

/** 结构化质量门禁类型；缺省视为 work */
export type TaskKind =
  | 'requirements'
  | 'implementation'
  | 'verification'
  | 'review'
  | 'repair'
  | 'integration'
  | 'work';

export const TASK_KINDS: readonly TaskKind[] = [
  'requirements',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
  'work',
];

/** 审查/需求结论；只有 pass 可使该类任务完成 */
export type ReviewVerdict = 'pass' | 'needs_revision' | 'reject';

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['pass', 'needs_revision', 'reject'];

/** 审查发现严重级别 */
export type FindingSeverity = 'low' | 'medium' | 'high' | 'blocker';

export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['low', 'medium', 'high', 'blocker'];

/** 单条结构化审查发现 */
export interface ReviewFinding {
  /** 稳定 id，如 SEC-001 */
  id: string;
  severity: FindingSeverity;
  file?: string;
  line?: number;
  problem: string;
  requiredFix: string;
  resolved?: boolean;
}

/** 完成时记录的验收标准结果 */
export interface AcceptanceResult {
  criterion: string;
  status: 'passed' | 'failed';
  evidence?: string;
}

/** 完成时记录的验证命令结果 */
export interface CommandResult {
  command: string;
  status: 'passed' | 'failed';
  exitCode?: number;
  evidence?: string;
}

/** 审查循环上限策略 */
export interface ReviewPolicy {
  requirementsMinRounds?: number;
  requirementsMaxRounds?: number;
  codeMaxRounds?: number;
  maxRepairAttempts?: number;
  requiredReviewers?: string[];
}

/** 团队任务（任务 DAG 节点） */
export interface TeamTask {
  /** 团队内稳定任务 id（t1、t2…） */
  id: string;
  /** 来自团队模板的种子任务 id（ad-hoc 任务缺省） */
  profileSeedId?: string;
  /** 任务简短标题 */
  subject: string;
  /** 任务详情 */
  description?: string;
  status: TaskStatus;
  /** 指派成员名（或 captain）；未指派任务等待认领 */
  assignee?: string;
  /** 依赖任务 id 列表（全部 completed 后才可认领） */
  dependencies: string[];
  /** 工作产出（完成/失败时写入） */
  output?: string;
  /** 单调递增执行代数；重派/重试使旧 attempt 失效 */
  attempt?: number;
  /** 当前持有方执行票据 id；成员更新任务时必须出示 */
  attemptId?: string;
  /** 交接未开始的代数（调度器暂不派发） */
  handoffId?: string;
  /** 正在向新持有方静默交接，调度器暂不派发 */
  reassigning?: boolean;
  /** 质量门禁类型；缺省视为 work */
  kind?: TaskKind;
  /** 审查/需求/修复循环轮次（1-based） */
  round?: number;
  verdict?: ReviewVerdict;
  findings?: ReviewFinding[];
  objective?: string;
  inScope?: string[];
  outOfScope?: string[];
  acceptance?: string[];
  verify?: string[];
  deliverables?: string[];
  nonGoals?: string[];
  changedPaths?: string[];
  acceptanceResults?: AcceptanceResult[];
  commandsRun?: CommandResult[];
  reviewedTaskId?: string;
  reviewedAttempt?: number;
  /** 修复来源任务（implementation/上一次成功产物） */
  sourceTaskId?: string;
  sourceFindingIds?: string[];
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// 成员与消息
// ============================================================================

/** 成员生命周期状态 */
export type MemberStatus = 'idle' | 'working' | 'removed';

/** 团队成员：编排记录 + 专属持久会话 */
export interface TeamMember {
  /** 成员 id（memberId） */
  id: string;
  /** 团队内唯一显示名 */
  name: string;
  /** 角色描述（researcher/engineer/reviewer…） */
  role?: string;
  /** 注册表 agent id（内置模板/用户自建）；动态成员缺省 */
  agentId?: string;
  /** 动态成员的内联 systemPrompt（不入注册表） */
  inlinePrompt?: string;
  /** 专属持久会话 id（=侧边栏任务 id；用户可点进任务页查看完整对话） */
  sessionId: string;
  /** 对应侧边栏任务 id（与 sessionId 同值，冗余便于读取） */
  taskId?: string;
  /** 该成员执行轮次的附加提示词 */
  executionPrompt?: string;
  /** 待投递消息（captain/队友发来；下次派发 ticket 附带或 idle 时消息处理 run 消费） */
  pendingMessages?: string[];
  joinedAt: number;
  status: MemberStatus;
}

/** 一条团队消息 */
export interface TeamMessage {
  id: string;
  /** captain 或成员名 */
  from: string;
  /** captain 或成员名 */
  to: string;
  content: string;
  ts: number;
}

// ============================================================================
// 团队
// ============================================================================

/** 团队阶段 */
export type TeamPhase = 'staged' | 'running' | 'completed' | 'failed' | 'halted';

/** 创建团队时的成员规格 */
export interface MemberSpec {
  name: string;
  role?: string;
  /** 注册表 agent id */
  agentId?: string;
  /** 动态成员内联提示词（与 agentId 二选一） */
  inlinePrompt?: string;
  executionPrompt?: string;
}

/** 创建团队时的任务规格 */
export interface TaskSpec {
  subject: string;
  description?: string;
  kind?: TaskKind;
  dependencies?: string[];
  assignee?: string;
  /** kind=review 必填：被审查的任务 id */
  reviewedTaskId?: string;
  /** kind=repair 必填：修复来源任务 id */
  sourceTaskId?: string;
}

/** 团队模板快照 */
export interface TeamProfileSnapshot {
  name: string;
  description?: string;
  protocol?: string;
  executionPrompt?: string;
  /** 冻结的规划模式：captain 规划 DAG；seed 保留模板任务 */
  taskPlanning?: 'captain' | 'seed';
  reviewPolicy?: ReviewPolicy;
}

/** 团队完整持久记录 */
export interface TeamState {
  /** 团队名 */
  name: string;
  /** 清洗后的目录 id（团队稳定身份） */
  id: string;
  /** 团队目标 */
  description?: string;
  /** 命名团队模板快照（从模板创建时） */
  profile?: TeamProfileSnapshot;
  /** 队长（= 创建团队的主会话）session id；成员仅队友 */
  captainSessionId: string;
  /** 工作目录 */
  cwd: string;
  /** 团队级权限模式（缺省 auto） */
  permissionMode?: PermissionMode;
  createdAt: number;
  /** 仅队友；captain 隐式（即所属会话） */
  members: TeamMember[];
  tasks: TeamTask[];
  /** 任务 id 单调计数器 */
  taskSeq: number;
  /** staged=计划待审批；running=执行中；completed/failed/halted=终态/暂停 */
  phase: TeamPhase;
  /** staged 阶段的人审子状态 */
  planReviewState?: 'awaiting_review' | 'awaiting_feedback';
  /** 计划被显式批准后的时间戳 */
  approvedAt?: number;
  /** 人工暂停标记 */
  halted?: boolean;
  haltedAt?: number;
  /** 从创建模板复制的审查策略 */
  reviewPolicy?: ReviewPolicy;
  /** 审查/修复循环触顶升级标记 */
  escalated?: boolean;
  /** 团队最终汇总报告 */
  summary?: string;
}

/** 团队列表摘要（列表页用，不含任务/成员详情） */
export interface TeamSummary {
  id: string;
  name: string;
  description?: string;
  phase: TeamPhase;
  planReviewState?: TeamState['planReviewState'];
  memberCount: number;
  taskTotal: number;
  taskCompleted: number;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// 团队模板（Profiles）
// ============================================================================

/** 团队模板成员定义 */
export interface TeamProfileMember {
  name: string;
  role?: string;
  /** 注册表 agent id（内置模板/用户自建） */
  agentId?: string;
  /** 动态成员内联提示词（与 agentId 二选一） */
  inlinePrompt?: string;
  executionPrompt?: string;
}

/** 团队模板种子任务定义 */
export interface TeamProfileTask {
  /** 模板内稳定 id（如 explore/plan/code/review） */
  seedId: string;
  subject: string;
  description?: string;
  kind?: TaskKind;
  dependencies?: string[];
  assignee?: string;
}

/** 团队模板配置（持久化于 ~/.moss/agenteam-profiles.json） */
export interface TeamProfileConfig {
  name: string;
  description?: string;
  /** 成员协作协议（注入 captain 编排指南与成员提示） */
  protocol?: string;
  executionPrompt?: string;
  members: TeamProfileMember[];
  tasks: TeamProfileTask[];
  /** captain=队长规划 DAG；seed=直接保留模板任务 */
  taskPlanning: 'captain' | 'seed';
  reviewPolicy?: ReviewPolicy;
  builtIn?: boolean;
}
