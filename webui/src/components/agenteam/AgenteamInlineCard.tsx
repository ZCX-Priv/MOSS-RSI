// webui/src/components/agenteam/AgenteamInlineCard.tsx
// 对话流内专家团卡片：
// 容器卡 = 头部（机器人图标 Bot + 团队名 + 任务数 + 进度点阵 + 阶段徽章）
//        + 任务行（成员头像 + 成员名 + 序号 + 树形任务描述 + 状态图标）。
// 数据：工具参数静态计划立即渲染；result 解析出 teamId 后经 useTeamLive 实时刷新。

import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronRight, CircleCheck, CircleDashed, CircleX, Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buildMemberAvatarSeeds, fallbackAvatarSeed } from '../../lib/agenteam-avatars';
import { HumationAvatar } from './HumationAvatar';
import { AgentTaskFlow } from './AgentTaskFlow';
import { useTeamLive } from '../../hooks/useTeamLive';
import type { TeamPhase, TeamTaskStatus } from '../../types/api';

/** 从 agent（mode=agenteam, action=create）工具参数解析出的静态计划 */
export interface InlineTeamPlan {
  name: string;
  members: Array<{ name: string; role?: string; agentId?: string }>;
  tasks: Array<{ subject: string; assignee?: string }>;
}

/** 渲染归一后的任务行（静态计划任务无 status 视为 pending） */
interface InlineTaskRow {
  id?: string;
  subject: string;
  assignee?: string;
  status: TeamTaskStatus;
}

interface AgenteamInlineCardProps {
  plan: InlineTeamPlan | null;
  /** 从工具结果解析的团队 id（非空时拉取实时状态） */
  teamId: string | null;
}

/** 阶段徽章配色（文案复用 agenteam.phase.*） */
const PHASE_BADGE: Record<TeamPhase, string> = {
  staged: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-500',
  running: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-500',
  failed: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-500',
  halted: 'border-border bg-muted text-muted-foreground',
};

/** 进度点阵配色（按任务状态） */
const DOT_CLASS: Record<TeamTaskStatus, string> = {
  completed: 'bg-emerald-500',
  in_progress: 'bg-blue-500 animate-pulse',
  claimed: 'bg-blue-500 animate-pulse',
  failed: 'bg-red-500',
  cancelled: 'bg-muted-foreground/40',
  pending: 'bg-muted-foreground/30',
};

/** 任务行右侧状态图标（与面板 TaskListView 语义一致） */
function TaskStatusIcon({ status }: { status: TeamTaskStatus }) {
  switch (status) {
    case 'completed':
      return <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />;
    case 'failed':
      return <CircleX className="size-3.5 shrink-0 text-red-500" />;
    case 'cancelled':
      return <CircleX className="size-3.5 shrink-0 text-muted-foreground/50" />;
    case 'in_progress':
    case 'claimed':
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-500" />;
    default:
      return <CircleDashed className="size-3.5 shrink-0 text-muted-foreground/60" />;
  }
}

export const AgenteamInlineCard = memo(function AgenteamInlineCard({
  plan,
  teamId,
}: AgenteamInlineCardProps) {
  const { t } = useTranslation();
  const live = useTeamLive(teamId);
  /** 展开的任务行 key（同一时刻只展开一行，避免卡片过长） */
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  // 缺参兜底：plan/teamId 皆无时也渲染占位卡（名称回落 agenteam.title），保证工具调用处不丢卡

  const name = live?.name ?? plan?.name ?? '';
  const members = live?.members.filter((m) => m.status !== 'removed') ?? plan?.members ?? [];
  const rows: InlineTaskRow[] = live
    ? live.tasks.map((task) => ({
        id: task.id,
        subject: task.subject,
        assignee: task.assignee,
        status: task.status,
      }))
    : (plan?.tasks ?? []).map((task, i) => ({
        id: undefined,
        subject: task.subject,
        assignee: task.assignee,
        status: 'pending' as TeamTaskStatus,
      }));
  const phase = live?.phase;
  const memberByName = new Map(members.map((m) => [m.name, m]));
  // 成员头像唯一分配（模板固定 seed；自定义成员避开四模板且互不重复）
  const avatarSeeds = useMemo(
    () => buildMemberAvatarSeeds(members, live?.id ?? plan?.name ?? 'plan'),
    [members, live?.id, plan?.name],
  );

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
      {/* 头部：图标 + 团队名 + 任务数 + 进度点阵 + 阶段徽章 */}
      <div className="flex min-w-0 items-center gap-1.5">
        <Bot className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium text-foreground" title={name}>
          {name || t('agenteam.title')}
        </span>
        <span className="shrink-0 text-border">|</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('agenteam.card.taskCount', { count: rows.length })}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* 进度点阵：每任务一点，最多 24 点 */}
          {rows.length > 0 && (
            <div className="hidden items-center gap-1 sm:flex" aria-hidden>
              {rows.slice(0, 24).map((task, i) => (
                <span
                  key={task.id ?? i}
                  className={cn('size-1.5 rounded-full', DOT_CLASS[task.status])}
                />
              ))}
            </div>
          )}
          {phase ? (
            <span
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                PHASE_BADGE[phase],
              )}
            >
              {phase === 'running' && <Loader2 className="size-2.5 animate-spin" />}
              {t(`agenteam.phase.${phase}`)}
            </span>
          ) : (
            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      {/* 任务行列表（每行可展开该成员自己的微缩任务流） */}
      <div className="flex flex-col gap-1.5">
        {rows.map((task, i) => {
          const member = task.assignee ? memberByName.get(task.assignee) : undefined;
          const seed = member
            ? (avatarSeeds.get(member.name) ?? fallbackAvatarSeed(member.agentId, member.name))
            : (task.id || `t${i + 1}`);
          const memberLabel = task.assignee || t('agenteam.card.unassigned');
          const rowKey = task.id ?? `plan-${i}`;
          const isOpen = expandedRow === rowKey;
          return (
            <div key={rowKey} className="rounded-lg bg-muted/50 px-2.5 py-2">
              <button
                type="button"
                onClick={() => setExpandedRow((v) => (v === rowKey ? null : rowKey))}
                aria-expanded={isOpen}
                className="flex w-full min-w-0 items-center gap-2 text-left"
              >
                <HumationAvatar seed={seed} size={24} />
                <span className="min-w-0 truncate text-xs font-medium text-foreground">
                  {memberLabel}
                </span>
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <ChevronRight
                  className={cn(
                    'size-3 shrink-0 text-muted-foreground transition-transform',
                    isOpen && 'rotate-90',
                  )}
                />
              </button>
              <div className="mt-1 flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 select-none text-muted-foreground/50">└</span>
                <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={task.subject}>
                  {task.subject}
                </span>
                <TaskStatusIcon status={task.status} />
              </div>
              {isOpen && (
                <div className="mt-2">
                  <AgentTaskFlow
                    sessionId={
                      (task.assignee
                        ? live?.members.find((m) => m.name === task.assignee)?.sessionId
                        : undefined) ?? null
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* staged 待审批提示 */}
      {phase === 'staged' && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-500">
          <TriangleAlert className="size-3 shrink-0" />
          <span>{t('agenteam.card.awaitingApprovalHint')}</span>
        </div>
      )}
    </div>
  );
});