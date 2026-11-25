// webui/src/components/shared/TaskStepNode.tsx
// 对话流任务步骤节点：todo 节点（标题 + 描述预览 + 展开操作）或
// 无 todo 时的操作汇总节点（标题 = 操作统计）。
//
// 折叠语义：
// - 收起只隐藏「思考 + 工具操作」；todo 节点内的模型正文始终渲染（contentOnly 模式），
//   标准/详细/原始挡位因此满足「折叠节点但正文不折叠」；
// - 简洁挡位的正文由 FoldableContent 再折成预览行；
// - 详细/原始挡位默认展开节点与内部工具卡。

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { ChevronRight, Circle, CircleCheck, CircleX, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePersistentState } from '../../lib/ui-state';
import { hasVisibleContent, type StepOpStats, type TaskStep } from '../../lib/task-steps';
import type { StepDisplayLevel } from '../../store';
import type { TaskMessage } from '../../types/api';

/** 统计是否有任何条目（用于决定 todo 节点收起时是否回退展示操作汇总） */
function hasStats(stats: StepOpStats): boolean {
  return Object.values(stats).some((value) => value > 0);
}

/**
 * 操作汇总文案（无 todo 节点标题 / todo 节点无 describe 时的预览）。
 * 顺序与参考视觉一致：创建 → 编辑 → 读取 → 搜索 → 命令 → 提问 → 子智能体 → 浏览器/电脑/…
 */
export function buildStepSummary(t: TFunction, step: TaskStep): string {
  const { stats } = step;
  const parts: string[] = [];
  if (stats.created > 0) parts.push(t('task.stepOps.created', { count: stats.created }));
  if (stats.edited > 0) parts.push(t('task.stepOps.edited', { count: stats.edited }));
  if (stats.read > 0) parts.push(t('task.stepOps.read', { count: stats.read }));
  if (stats.searched > 0) parts.push(t('task.stepOps.searched', { count: stats.searched }));
  if (stats.commands > 0) parts.push(t('task.stepOps.commands', { count: stats.commands }));
  if (stats.asked > 0) parts.push(t('task.stepOps.asked'));
  if (stats.subagents > 0) parts.push(t('task.stepOps.subagents', { count: stats.subagents }));
  if (stats.browser > 0) parts.push(t('task.stepOps.browser', { count: stats.browser }));
  if (stats.computer > 0) parts.push(t('task.stepOps.computer', { count: stats.computer }));
  if (stats.mcp > 0) parts.push(t('task.stepOps.mcp', { count: stats.mcp }));
  if (stats.code > 0) parts.push(t('task.stepOps.code', { count: stats.code }));
  if (stats.docs > 0) parts.push(t('task.stepOps.docs', { count: stats.docs }));
  if (stats.other > 0) parts.push(t('task.stepOps.other', { count: stats.other }));
  if (parts.length > 0) return parts.join(t('task.stepOps.separator'));
  return step.hasThinking ? t('task.step.thinking') : t('task.step.process');
}

function StepStatusIcon({ step }: { step: TaskStep }) {
  const { t } = useTranslation();
  if (step.kind === 'ops') {
    return step.status === 'in_progress' ? (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
    ) : (
      <CircleCheck className="size-3.5 shrink-0 text-muted-foreground/70" />
    );
  }
  switch (step.status) {
    case 'completed':
      return (
        <CircleCheck
          className="size-3.5 shrink-0 text-success"
          aria-label={t('task.step.statusCompleted')}
        />
      );
    case 'blocked':
      return (
        <CircleX
          className="size-3.5 shrink-0 text-danger"
          aria-label={t('task.step.statusBlocked')}
        />
      );
    case 'pending':
      return (
        <Circle
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-label={t('task.step.statusPending')}
        />
      );
    default:
      return (
        <Loader2
          className="size-3.5 shrink-0 animate-spin text-primary-strong"
          aria-label={t('task.step.statusRunning')}
        />
      );
  }
}

export interface TaskStepNodeProps {
  step: TaskStep;
  sessionId: string;
  level: StepDisplayLevel;
  /** 子消息渲染器：contentOnly=true 时不渲染思考/工具（收起态正文专用） */
  renderChild: (message: TaskMessage, contentOnly: boolean) => ReactNode;
  className?: string;
}

export function TaskStepNode({
  step,
  sessionId,
  level,
  renderChild,
  className,
}: TaskStepNodeProps) {
  const { t } = useTranslation();
  const defaultOpen = level === 'detailed' || level === 'raw';
  // key 带挡位：切换挡位时按新默认值重置；同挡位内手动开合可跨虚拟列表卸载保持
  const [expanded, setExpanded] = usePersistentState(
    `${sessionId}:${step.key}:${level}`,
    defaultOpen,
  );

  const summary = buildStepSummary(t, step);
  const preview =
    step.kind === 'todo'
      ? step.describe ?? (hasStats(step.stats) ? summary : '')
      : '';
  const title = step.kind === 'todo' ? step.title : summary;

  // 收起态：todo 节点仍需显示模型正文（contentOnly），操作型子消息隐藏；
  // 展开态：按原顺序渲染全部子消息。
  const visibleChildren = expanded
    ? step.children
    : step.children.filter((child) => hasVisibleContent(child));

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <button
        type="button"
        aria-expanded={expanded}
        title={expanded ? t('task.step.collapse') : t('task.step.expand')}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full min-w-0 cursor-pointer items-start gap-1.5 py-1 text-left"
      >
        <ChevronRight
          className={cn(
            'mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <span className="mt-0.5">
          <StepStatusIcon step={step} />
        </span>
        {step.kind === 'todo' ? (
          <span
            className={cn(
              'min-w-0 flex-1 break-words text-xs font-semibold',
              step.status === 'completed' || step.status === 'blocked'
                ? 'text-foreground/70'
                : 'text-foreground',
              step.status === 'blocked' && 'line-through',
            )}
          >
            {title}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={title}>
            {title}
          </span>
        )}
      </button>

      {/* 收起预览：describe 优先；无 describe 时回退操作汇总（仅 todo 节点） */}
      {!expanded && preview && (
        <button
          type="button"
          className="line-clamp-2 w-full min-w-0 cursor-pointer pl-8 text-left text-[11px] leading-relaxed text-muted-foreground/80"
          title={preview}
          onClick={() => setExpanded(true)}
        >
          {preview}
        </button>
      )}

      {expanded && (step.describe || visibleChildren.length > 0) && (
        <div className="mt-0.5 flex min-w-0 flex-col gap-1 border-l border-border/60 pl-3 ml-[7px]">
          {step.describe && (
            <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
              {step.describe}
            </div>
          )}
          {visibleChildren.map((child) => (
            <div key={child.id} className="min-w-0">
              {renderChild(child, false)}
            </div>
          ))}
        </div>
      )}

      {/* 收起态正文：仍渲染 todo 节点内的模型回复（操作型子消息已过滤） */}
      {!expanded && visibleChildren.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1 pl-8">
          {visibleChildren.map((child) => (
            <div key={child.id} className="min-w-0">
              {renderChild(child, true)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
