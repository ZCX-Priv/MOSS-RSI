// webui/src/components/agenteam/TaskListView.tsx
// 专家团任务列表：状态图标 + kind 徽章 + 依赖链 + assignee 头像 + 展开详情。

import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDashed, CircleX, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fallbackAvatarSeed } from '../../lib/agenteam-avatars';
import { HumationAvatar } from './HumationAvatar';
import type { TeamMember, TeamTask } from '../../types/api';

interface TaskListViewProps {
  tasks: TeamTask[];
  members: TeamMember[];
  /** 成员名 → 团队级唯一头像 seed（避免同 agentId 成员重复头像） */
  avatarSeeds?: ReadonlyMap<string, string>;
}

function TaskStatusIcon({ status }: { status: TeamTask['status'] }) {
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

function TaskRow({
  task,
  members,
  avatarSeeds,
}: {
  task: TeamTask;
  members: TeamMember[];
  avatarSeeds?: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const assignee = members.find((m) => m.name === task.assignee && m.status !== 'removed');
  const hasDetail = Boolean(task.description || task.output || task.findings?.length || task.acceptanceResults?.length);
  const kind = task.kind && task.kind !== 'work' ? task.kind : null;

  return (
    <div className="rounded-md border border-border/60">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        onClick={() => hasDetail && setExpanded((v) => !v)}
      >
        {hasDetail ? (
          expanded ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <TaskStatusIcon status={task.status} />
        <span className="shrink-0 text-[10px] font-mono text-muted-foreground">{task.id}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{task.subject}</span>
        {kind && (
          <span className="shrink-0 rounded bg-primary/10 px-1 py-px text-[10px] text-primary">
            {t(`agenteam.taskKind.${kind}`)}
          </span>
        )}
        {task.round !== undefined && task.round > 1 && (
          <span className="shrink-0 text-[10px] text-muted-foreground">R{task.round}</span>
        )}
        {task.verdict && (
          <span
            className={cn(
              'shrink-0 text-[10px]',
              task.verdict === 'pass' ? 'text-emerald-500' : 'text-amber-500',
            )}
          >
            {task.verdict}
          </span>
        )}
        {assignee && (
          <HumationAvatar
            seed={avatarSeeds?.get(assignee.name) ?? fallbackAvatarSeed(assignee.agentId, assignee.name)}
            size={18}
          />
        )}
      </button>
      {expanded && hasDetail && (
        <div className="space-y-1.5 border-t border-border/60 px-2 py-1.5 text-[11px] leading-relaxed">
          {task.description && (
            <div className="whitespace-pre-wrap break-words text-muted-foreground">{task.description}</div>
          )}
          {task.dependencies.length > 0 && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <span className="shrink-0">{t('agenteam.dependencies')}:</span>
              <span className="font-mono">{task.dependencies.join(', ')}</span>
            </div>
          )}
          {task.findings && task.findings.length > 0 && (
            <div className="space-y-1">
              {task.findings.map((f) => (
                <div key={f.id} className="rounded border border-border/60 px-1.5 py-1">
                  <span
                    className={cn(
                      'mr-1 font-mono text-[10px]',
                      f.severity === 'blocker'
                        ? 'text-red-500'
                        : f.severity === 'high'
                          ? 'text-orange-500'
                          : f.severity === 'medium'
                            ? 'text-amber-500'
                            : 'text-muted-foreground',
                    )}
                  >
                    [{f.severity}]
                  </span>
                  <span className="font-mono text-[10px]">{f.id}</span>
                  <span className="ml-1">{f.problem}</span>
                  {f.requiredFix && (
                    <div className="mt-0.5 pl-2 text-muted-foreground">→ {f.requiredFix}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {task.output && (
            <div className="whitespace-pre-wrap break-words rounded bg-muted/50 px-1.5 py-1 text-foreground">
              {task.output}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const TaskListView = memo(function TaskListView({ tasks, members, avatarSeeds }: TaskListViewProps) {
  const { t } = useTranslation();
  if (tasks.length === 0) {
    return <div className="px-2 py-3 text-center text-xs text-muted-foreground">{t('agenteam.empty')}</div>;
  }
  return (
    <div className="space-y-1">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} members={members} avatarSeeds={avatarSeeds} />
      ))}
    </div>
  );
});
