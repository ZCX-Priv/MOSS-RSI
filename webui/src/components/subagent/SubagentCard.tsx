// webui/src/components/subagent/SubagentCard.tsx
// 对话流内 Subagent 大卡片（容器卡形态）：
// 头部 = 子代理名 + 任务数 + 进度点阵 + 整体状态徽章；
// 每行 = 一个 subagent 调用（头像 + 显示名 + 序号 + 树形任务描述 + 状态图标），
// 行可展开查看该子代理的「微缩任务流」与最终报告。
// 同一条 assistant 消息内的多个 agent 调用合并到这一张卡片里。

import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronRight, CircleCheck, CircleX, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStore } from '../../store';
import { MarkdownRenderer } from '../../render';
import { getSubagentSession, subscribeSubagentSession } from '../../lib/subagent-sessions';
import { fallbackAvatarSeed, templateAvatarSeed } from '../../lib/agent-avatars';
import { HumationAvatar } from './HumationAvatar';
import { AgentTaskFlow } from './AgentTaskFlow';
import type { ToolCall } from '../../types/api';

/** 单条 agent 调用（一条消息内可有多条） */
export interface SubagentCallItem {
  toolCallId: string;
  template: string;
  task: string;
  status?: ToolCall['status'];
  resultText?: string;
  isError?: boolean;
}

/** agent 结果文本固定前缀（中/英文构建都兼容），剥离后为最终报告正文 */
const SUBAGENT_PREFIX = /^(?:子代理已完成|Subagent finished) \([^)]*\):\n*/;
/** 结果文本中的子代理会话 id（用于展开微缩任务流） */
const SUBAGENT_SESSION = /session=([0-9a-zA-Z_-]+)/;

type RowStatus = 'running' | 'completed' | 'failed';

/** 调用状态归一：generating/executing=运行中；有错误=失败；缺省按完成处理 */
function rowStatusOf(call: SubagentCallItem): RowStatus {
  if (call.status === 'generating' || call.status === 'executing') return 'running';
  return call.isError ? 'failed' : 'completed';
}

/** 进度点阵配色（按行状态） */
const DOT_CLASS: Record<RowStatus, string> = {
  completed: 'bg-emerald-500',
  running: 'bg-blue-500 animate-pulse',
  failed: 'bg-red-500',
};

/** 任务行右侧状态图标 */
function TaskStatusIcon({ status }: { status: RowStatus }) {
  switch (status) {
    case 'completed':
      return <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />;
    case 'failed':
      return <CircleX className="size-3.5 shrink-0 text-red-500" />;
    default:
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-500" />;
  }
}

/** 运行期会话 id：只认「父工具调用 id → 子代理 taskId」的精确绑定（同模板并发不串台） */
function useSubagentSessionBinding(toolCallId: string): string | undefined {
  const [sessionId, setSessionId] = useState<string | undefined>(() =>
    getSubagentSession(toolCallId),
  );
  useEffect(() => {
    setSessionId(getSubagentSession(toolCallId));
    return subscribeSubagentSession((id, sid) => {
      if (id === toolCallId) setSessionId(sid);
    });
  }, [toolCallId]);
  return sessionId;
}

const SubagentRow = memo(function SubagentRow({
  call,
  index,
  displayName,
  expanded,
  onToggle,
}: {
  call: SubagentCallItem;
  index: number;
  displayName: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const status = rowStatusOf(call);
  const running = status === 'running';
  const boundSessionId = useSubagentSessionBinding(call.toolCallId);
  const report = call.resultText?.replace(SUBAGENT_PREFIX, '') ?? '';
  const resultSessionId = call.resultText?.match(SUBAGENT_SESSION)?.[1] ?? null;
  // 过程会话 id：完成后结果文本里的 session 权威；运行中只认精确绑定
  const flowSessionId = resultSessionId ?? boundSessionId ?? null;
  const avatarSeed =
    templateAvatarSeed(call.template) ?? fallbackAvatarSeed(call.template, displayName);

  return (
    <div className="rounded-lg bg-muted/50 px-2.5 py-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-center gap-2 text-left"
      >
        <HumationAvatar seed={avatarSeed} size={24} />
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{displayName}</span>
        <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
          {String(index + 1).padStart(2, '0')}
        </span>
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>
      {/* 树形任务描述 */}
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 select-none text-muted-foreground/50">└</span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={call.task}>
          {call.task}
        </span>
        <TaskStatusIcon status={status} />
      </div>
      {expanded && (
        <div className="mt-2 flex flex-col gap-2">
          <AgentTaskFlow sessionId={flowSessionId} running={running} />
          {!running && report && (
            <div className="flex flex-col gap-1">
              <span className={cn('text-[11px] text-muted-foreground', call.isError && 'text-destructive')}>
                {call.isError ? t('task.errorResult') : t('subagent.card.report')}
              </span>
              <div className="max-h-[300px] overflow-auto no-scrollbar text-xs">
                {call.isError ? (
                  <pre className="mono whitespace-pre-wrap break-all text-destructive">{report}</pre>
                ) : (
                  <MarkdownRenderer text={report} />
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export const SubagentCard = memo(function SubagentCard({ calls }: { calls: SubagentCallItem[] }) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  /** 展开的行 key（同一时刻只展开一行，避免卡片过长） */
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const statuses = useMemo(() => calls.map(rowStatusOf), [calls]);
  const anyRunning = statuses.some((s) => s === 'running');
  const anyFailed = !anyRunning && statuses.some((s) => s === 'failed');
  const overall: RowStatus = anyRunning ? 'running' : anyFailed ? 'failed' : 'completed';

  const templates = new Set(calls.map((c) => c.template || ''));
  const singleTemplate = templates.size === 1 ? calls[0]?.template ?? '' : '';
  const headerName =
    (singleTemplate ? agents.find((a) => a.id === singleTemplate)?.name : '') ||
    singleTemplate ||
    t('subagent.card.title');

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
      {/* 头部：图标 + 名称 + 任务数 + 进度点阵 + 整体状态徽章 */}
      <div className="flex min-w-0 items-center gap-1.5">
        <Bot className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium text-foreground" title={headerName}>
          {headerName}
        </span>
        <span className="shrink-0 text-border">|</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('subagent.card.taskCount', { count: calls.length })}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {calls.length > 0 && (
            <div className="hidden items-center gap-1 sm:flex" aria-hidden>
              {statuses.slice(0, 24).map((status, i) => (
                <span
                  key={calls[i]?.toolCallId ?? i}
                  className={cn('size-1.5 rounded-full', DOT_CLASS[status])}
                />
              ))}
            </div>
          )}
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
              overall === 'running' &&
                'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
              overall === 'failed' &&
                'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-500',
              overall === 'completed' &&
                'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-500',
            )}
          >
            {overall === 'running' && <Loader2 className="size-2.5 animate-spin" />}
            {overall === 'failed' && <CircleX className="size-2.5" />}
            {overall === 'completed' && <CircleCheck className="size-2.5" />}
            {t(`subagent.card.${overall}`)}
          </span>
        </div>
      </div>

      {/* 任务行列表（每行可展开该子代理的执行过程与最终报告） */}
      <div className="flex flex-col gap-1.5">
        {calls.map((call, i) => {
          const displayName =
            agents.find((a) => a.id === call.template)?.name ||
            call.template ||
            t('subagent.card.title');
          return (
            <SubagentRow
              key={call.toolCallId}
              call={call}
              index={i}
              displayName={displayName}
              expanded={expandedRow === call.toolCallId}
              onToggle={() =>
                setExpandedRow((v) => (v === call.toolCallId ? null : call.toolCallId))
              }
            />
          );
        })}
      </div>
    </div>
  );
});
