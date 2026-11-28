// webui/src/components/shared/TaskStepNode.tsx
// 对话流折叠行组件集合（上一版工具栏样式：左箭头 + 图标 + 文本，无卡片容器）：
// - TodoFoldRow：todo 折叠行。todo 执行中即可手动收起；完成/阻塞时自动折叠
//   「从该 todo 开始到结束之间的所有内容」（含正文与过程段）；
// - ProcessFoldRow：连续过程段（think / tool）摘要行；
// - RoundFoldNode：简洁挡「一轮回复」折叠节点。
//
// 折叠语义：
// - 标准：todo 完成即整段收起；过程段恒定折叠为一行摘要，点开才看逐条卡片；
// - 简洁：每轮一行摘要，只有「真正的最终正文」显示在摘要行下方；
// - 详细：todo 行静态、过程不折叠；思考行仍默认收起；
// - 原始内容：无 todo 行（todo 以原始工具卡展示），过程不折叠。

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { ChevronRight, Circle, CircleCheck, CircleX, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePersistentState } from '../../lib/ui-state';
import type {
  CompactRound,
  ProcessRun,
  StepOpStats,
  StepStatus,
  TodoStep,
} from '../../lib/task-steps';
import type { StepDisplayLevel } from '../../store';
import type { TaskMessage } from '../../types/api';
import { TodoProgressCard } from './TodoProgressCard';

/** 子消息渲染模式：all = 完整消息；body = 仅正文；thinking = 仅思考；tools = 仅工具卡 */
export type StepRenderMode = 'all' | 'body' | 'thinking' | 'tools';

/**
 * 操作汇总文案（过程段摘要行）。
 * 顺序与参考视觉一致：创建 → 编辑 → 读取 → 搜索 → 命令 → 提问 → 子智能体 → 浏览器/电脑/…
 */
export function buildStepSummary(t: TFunction, stats: StepOpStats, hasThinking: boolean): string {
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
  return hasThinking ? t('task.step.thinking') : t('task.step.process');
}

function StatusIcon({ status }: { status: StepStatus }) {
  const { t } = useTranslation();
  switch (status) {
    case 'completed':
      return (
        <CircleCheck
          className="size-3.5 shrink-0 text-success"
          aria-label={t('task.step.statusCompleted')}
        />
      );
    case 'blocked':
      return (
        <CircleX className="size-3.5 shrink-0 text-danger" aria-label={t('task.step.statusBlocked')} />
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

export interface TodoFoldRowProps {
  todo: TodoStep;
  sessionId: string;
  level: StepDisplayLevel;
  /** false = 详细挡：静态行、始终展开、内容不折叠 */
  foldable: boolean;
  renderChild: (message: TaskMessage, mode: StepRenderMode) => ReactNode;
  className?: string;
}

/** todo 折叠行：左箭头 + 状态图标 + 加粗标题；展开后按顺序渲染 todo 内的正文与过程段 */
export function TodoFoldRow({
  todo,
  sessionId,
  level,
  foldable,
  renderChild,
  className,
}: TodoFoldRowProps) {
  const { t } = useTranslation();
  const terminal = todo.status === 'completed' || todo.status === 'blocked';
  const [open, setOpen] = usePersistentState(
    `${sessionId}:${todo.key}:${level}`,
    todo.status === 'in_progress',
  );
  // 用户手动操作过本行 → 完成/阻塞时不再自动收起（尊重用户展开意图）。
  // 该标记也要持久化：快速滚动会让折叠行卸载重挂，ref 会丢失。
  const [manualTouched, setManualTouched] = usePersistentState(
    `${sessionId}:${todo.key}:${level}:touched`,
    false,
  );
  const toggleOpen = (): void => {
    setManualTouched(true);
    setOpen(!open);
  };
  // todo 完成/阻塞瞬间自动收起一次（折叠其间的全部内容）；用户手动展开的行保持展开
  const prevTerminalRef = useRef(terminal);
  useEffect(() => {
    if (terminal && !prevTerminalRef.current && !manualTouched) setOpen(false);
    prevTerminalRef.current = terminal;
  }, [terminal, setOpen, manualTouched]);

  const expanded = foldable ? open : true;
  const titleClassName = cn(
    'min-w-0 flex-1 break-words text-xs font-semibold',
    terminal ? 'text-foreground/70' : 'text-foreground',
    todo.status === 'blocked' && 'line-through',
  );

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      {foldable ? (
        <button
          type="button"
          aria-expanded={open}
          title={open ? t('task.step.collapse') : t('task.step.expand')}
          onClick={toggleOpen}
          className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 py-1 text-left"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
          <StatusIcon status={todo.status} />
          <span className={titleClassName}>{todo.title}</span>
        </button>
      ) : (
        <div className="flex w-full min-w-0 items-center gap-1.5 py-1">
          <StatusIcon status={todo.status} />
          <span className={titleClassName}>{todo.title}</span>
        </div>
      )}

      {expanded && todo.blocks.length > 0 && (
        <div className="mt-0.5 ml-[7px] flex min-w-0 flex-col gap-1 border-l border-border/60 pl-3">
          {todo.blocks.map((block) => {
            if (block.kind === 'body') {
              return (
                <div key={block.key} className="min-w-0">
                  {renderChild(block.message, 'body')}
                </div>
              );
            }
            if (block.kind === 'todoCard') {
              return (
                <div key={block.key} className="min-w-0">
                  <TodoProgressCard todos={block.todos} variant="inline" />
                </div>
              );
            }
            return (
              <ProcessFoldRow
                key={block.key}
                run={block.run}
                sessionId={sessionId}
                level={level}
                foldable={foldable}
                renderChild={renderChild}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface ProcessFoldRowProps {
  run: ProcessRun;
  sessionId: string;
  level: StepDisplayLevel;
  /** false = 详细 / 原始内容：不折叠，直接逐条渲染 */
  foldable: boolean;
  renderChild: (message: TaskMessage, mode: StepRenderMode) => ReactNode;
  className?: string;
}

/** 连续过程段：工具栏式摘要行（左箭头 + 图标 + 灰色统计），点开后逐条显示思考/工具 */
export function ProcessFoldRow({
  run,
  sessionId,
  level,
  foldable,
  renderChild,
  className,
}: ProcessFoldRowProps) {
  const { t } = useTranslation();
  const [open, setOpen] = usePersistentState(`${sessionId}:${run.key}:${level}`, false);
  const summary = buildStepSummary(t, run.stats, run.hasThinking);

  // 逐条渲染片段：只在需要显示时构造 React 元素（收起态不为隐藏内容做无效工作）
  const renderParts = (): ReactNode =>
    run.parts.map((part) => (
      <div key={`${part.message.id}:${part.part}`} className="min-w-0">
        {renderChild(part.message, part.part)}
      </div>
    ));

  if (!foldable) {
    return <div className={cn('flex min-w-0 flex-col gap-1', className)}>{renderParts()}</div>;
  }

  return (
    <div className={cn('min-w-0', className)}>
      <button
        type="button"
        aria-expanded={open}
        title={open ? t('task.step.collapse') : t('task.step.expand')}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 py-0.5 text-left"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        {run.running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <CircleCheck className="size-3.5 shrink-0 text-muted-foreground/70" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={summary}>
          {summary}
        </span>
      </button>
      {open && <div className="ml-5 flex flex-col gap-1">{renderParts()}</div>}
    </div>
  );
}

export interface RoundFoldNodeProps {
  round: CompactRound;
  sessionId: string;
  level: StepDisplayLevel;
  renderChild: (message: TaskMessage, mode: StepRenderMode) => ReactNode;
  className?: string;
}

/**
 * 简洁挡：一轮回复折叠为一行工具栏式摘要；
 * - 该轮最后一条消息有正文且无工具 → 收起时仅显示这一条正文；
 * - 否则只显示摘要行（如 think+tool+content+tool+think）；
 * - 点摘要行按时间顺序展开整轮（思考 + 正文 + 工具卡）。
 */
export function RoundFoldNode({
  round,
  sessionId,
  level,
  renderChild,
  className,
}: RoundFoldNodeProps) {
  const { t } = useTranslation();
  const [open, setOpen] = usePersistentState(`${sessionId}:${round.key}:${level}`, false);
  const summary = buildStepSummary(t, round.stats, round.hasThinking);
  const finalBody = round.finalBodyId
    ? round.messages.find((message) => message.id === round.finalBodyId)
    : undefined;

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      {round.hasFold && (
        <button
          type="button"
          aria-expanded={open}
          title={open ? t('task.step.collapse') : t('task.step.expand')}
          onClick={() => setOpen(!open)}
          className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 py-0.5 text-left"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
          {round.running ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <CircleCheck className="size-3.5 shrink-0 text-muted-foreground/70" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={summary}>
            {summary}
          </span>
        </button>
      )}
      {open
        ? round.blocks.map((block) =>
            block.kind === 'message' ? (
              <div key={block.key} className="min-w-0">
                {renderChild(block.message, 'all')}
              </div>
            ) : (
              <div key={block.key} className="min-w-0">
                <TodoProgressCard todos={block.todos} variant="inline" />
              </div>
            ),
          )
        : finalBody && (
            <div className="min-w-0">{renderChild(finalBody, 'body')}</div>
          )}
    </div>
  );
}
