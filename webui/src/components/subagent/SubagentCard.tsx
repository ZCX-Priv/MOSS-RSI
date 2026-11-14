// webui/src/components/subagent/SubagentCard.tsx
// 对话流内 Subagent 大卡片（容器卡形态）：
// 头部 = 子代理名 + 任务数 + 进度点阵 + 整体状态徽章；
// 每行 = 一个 subagent 调用（头像 + 显示名 + 序号 + 树形任务描述 + 状态图标），
// 行可展开查看该子代理的「微缩任务流」与最终报告。
// 同一条 assistant 消息内的多个 agent 调用合并到这一张卡片里。

import { lazy, memo, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronRight, CircleCheck, CircleX, Loader2, Square } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '../../api/http';
import { useStore } from '../../store';
import { usePersistentState } from '../../lib/ui-state';
import { MarkdownRenderer } from '../../render';
import { getSubagentSession, subscribeSubagentSession } from '../../lib/subagent-sessions';
import {
  getAgentByParentToolCall,
  subscribeAgentBus,
} from '../../lib/agent-bus';
import { useLazyToolResult } from '../../lib/lazy-tool-results';
import { fallbackAvatarSeed, templateAvatarSeed } from '../../lib/agent-avatars';
import { HumationAvatar } from './HumationAvatar';
import type { ToolCall, ToolResult } from '../../types/api';

/** 子代理任务流懒加载：只有行展开时才引入（避免每个子代理卡都加载事件渲染图） */
const AgentTaskFlow = lazy(() =>
  import('./AgentTaskFlow').then((m) => ({ default: m.AgentTaskFlow })),
);

/** 单条 agent 调用（一条消息内可有多条） */
export interface SubagentCallItem {
  toolCallId: string;
  template: string;
  /** 模板显示名（工具结果 metadata 携带；运行时新建的自定义 Agent 也能显示名称） */
  name?: string;
  task: string;
  /** sync / async（历史会话可能缺省） */
  mode?: string;
  status?: ToolCall['status'];
  resultText?: string;
  isError?: boolean;
  /** 分页历史轻量投影：展开该行时才拉取完整报告 */
  lazy?: boolean;
}

/** agent 结果文本固定前缀（中/英文构建都兼容），剥离后为最终报告正文 */
const SUBAGENT_PREFIX = /^(?:子代理已完成|Subagent finished) \([^)]*\):\n*/;
/** 结果文本中的子代理会话 id（用于展开微缩任务流） */
const SUBAGENT_SESSION = /session=([0-9a-zA-Z_-]+)/;

type RowStatus = 'running' | 'completed' | 'failed';

/** 调用状态归一：优先总线实时状态（async 后台运行不依赖工具结果）；缺省按工具状态 */
function rowStatusOf(call: SubagentCallItem, memberStatus?: string): RowStatus {
  if (memberStatus === 'running') return 'running';
  if (memberStatus === 'failed' || memberStatus === 'aborted') return 'failed';
  if (memberStatus === 'completed') return 'completed';
  // 已有结果即完成：工具状态可能因事件丢失/历史合并滞后，结果是最强完成信号
  if (call.resultText !== undefined) return call.isError ? 'failed' : 'completed';
  if (call.status === 'generating' || call.status === 'executing') return 'running';
  // async 已返回「已启动」但总线尚未水合：先按运行中显示，避免卡片瞬间显示已完成
  if (call.mode === 'async' && !call.isError) return 'running';
  return call.isError ? 'failed' : 'completed';
}

/** 订阅总线：getSnapshot 返回状态字符串，状态不变时不会触发重渲（避免任一 Agent 事件重渲全部卡片） */
function useAgentBusMember(toolCallId: string) {
  const status = useSyncExternalStore(
    subscribeAgentBus,
    () => getAgentByParentToolCall(toolCallId)?.status ?? '',
  );
  return useMemo(() => getAgentByParentToolCall(toolCallId), [toolCallId, status]);
}

/** 进度点阵配色（按行状态） */
const DOT_CLASS: Record<RowStatus, string> = {
  completed: 'bg-success',
  running: 'bg-primary animate-pulse',
  failed: 'bg-danger',
};

/** 任务行右侧状态图标 */
function TaskStatusIcon({ status }: { status: RowStatus }) {
  switch (status) {
    case 'completed':
      return <CircleCheck className="size-3.5 shrink-0 text-success" />;
    case 'failed':
      return <CircleX className="size-3.5 shrink-0 text-danger" />;
    default:
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
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
  parentSessionId,
}: {
  call: SubagentCallItem;
  index: number;
  displayName: string;
  expanded: boolean;
  onToggle: () => void;
  /** 父会话 id（子代理过程流内嵌时为其自身会话 id；缺省用当前激活会话） */
  parentSessionId?: string;
}) {
  const { t } = useTranslation();
  const activeSessionId = useStore((s) => s.activeSessionId);
  const member = useAgentBusMember(call.toolCallId);
  const status = rowStatusOf(call, member?.status);
  const running = status === 'running';
  const boundSessionId = useSubagentSessionBinding(call.toolCallId);
  const [cancelling, setCancelling] = useState(false);
  /**
   * 首次展开后保持过程流挂载：折叠只隐藏，不卸载。
   * 避免每次展开都重新 import AgentTaskFlow、拉会话历史、重建过程列表（卡顿/闪烁来源）。
   */
  const [flowMounted, setFlowMounted] = useState(false);
  useEffect(() => {
    if (expanded) setFlowMounted(true);
  }, [expanded]);
  // 轻量历史投影：行展开时才拉取完整报告（折叠态不请求、不解析长文本）
  const lightResult = useMemo<ToolResult | undefined>(() => {
    if (call.resultText === undefined && !call.lazy) return undefined;
    return {
      content: [{ type: 'text', text: call.resultText ?? '' }],
      ...(call.isError ? { isError: true } : {}),
      ...(call.lazy ? { metadata: { __mossLazy: true } } : {}),
    };
  }, [call.resultText, call.isError, call.lazy]);
  const hydratedResult = useLazyToolResult(
    parentSessionId ?? activeSessionId,
    call.toolCallId,
    lightResult,
    expanded,
  );
  const fullText = hydratedResult
    ? hydratedResult.content
        .filter((c) => c.type === 'text')
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('\n')
    : call.resultText;
  const report = fullText?.replace(SUBAGENT_PREFIX, '') ?? '';
  const resultSessionId = fullText?.match(SUBAGENT_SESSION)?.[1] ?? null;
  // 过程会话 id：完成后结果文本里的 session 权威；运行中走精确绑定 / 总线成员
  const flowSessionId = resultSessionId ?? boundSessionId ?? member?.sessionId ?? null;
  const avatarSeed =
    templateAvatarSeed(call.template) ?? fallbackAvatarSeed(call.template, displayName);

  /** 单 Agent 终止：终止该子代理及其后代（后端 runner.stop 递归处理） */
  const cancelAgent = async (): Promise<void> => {
    if (!flowSessionId || cancelling) return;
    setCancelling(true);
    try {
      const resp = await api.cancelSubagent(flowSessionId);
      if (!resp.ok) toast.error(t('subagent.card.stopAgentNotRunning'));
    } catch {
      toast.error(t('subagent.card.stopAgentFailed'));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="rounded-lg bg-muted/50 px-2.5 py-2">
      <div className="flex w-full min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
        {running && (
          <button
            type="button"
            onClick={() => void cancelAgent()}
            disabled={cancelling || !flowSessionId}
            title={t('subagent.card.stopAgent')}
            aria-label={t('subagent.card.stopAgent')}
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
          >
            {cancelling ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Square className="size-3 fill-current" />
            )}
          </button>
        )}
      </div>
      {/* 树形任务描述 */}
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 select-none text-muted-foreground/50">└</span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={call.task}>
          {call.task}
        </span>
        <TaskStatusIcon status={status} />
      </div>
      {flowMounted && (
        <div className={expanded ? 'mt-2 flex flex-col gap-2' : 'hidden'}>
          <Suspense fallback={<div className="text-[11px] text-muted-foreground">…</div>}>
            <AgentTaskFlow sessionId={flowSessionId} running={running} />
          </Suspense>
          {!running && report && (
            <div className="flex flex-col gap-1">
              <span className={cn('text-[11px] text-muted-foreground', call.isError && 'text-destructive')}>
                {call.isError ? t('task.errorResult') : t('subagent.card.report')}
              </span>
              <div className="max-h-[300px] overflow-auto no-scrollbar text-xs">
                {call.isError ? (
                  <pre className="mono whitespace-pre-wrap break-all text-destructive">{report}</pre>
                ) : (
                  <MarkdownRenderer text={report} defer />
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export const SubagentCard = memo(function SubagentCard({
  calls,
  sessionId,
}: {
  calls: SubagentCallItem[];
  /** 父会话 id（子代理过程流内嵌时传其自身会话 id；缺省用当前激活会话） */
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  /** 展开的行 key（跨挂载持久化；同一时刻只展开一行，避免卡片过长） */
  const expansionKey = `${sessionId ?? 'default'}:subagent:${calls[0]?.toolCallId ?? 'empty'}:expanded`;
  const [expandedRow, setExpandedRow] = usePersistentState<string | null>(expansionKey, null);
  // 总线状态签名：只有本卡片内 Agent 的状态变化才重渲，避免全局事件风暴
  const busSig = useSyncExternalStore(subscribeAgentBus, () =>
    calls.map((call) => getAgentByParentToolCall(call.toolCallId)?.status ?? '').join('|'),
  );

  const statuses = useMemo(
    () =>
      calls.map((call) =>
        rowStatusOf(call, getAgentByParentToolCall(call.toolCallId)?.status),
      ),
    [calls, busSig],
  );
  const anyRunning = statuses.some((s) => s === 'running');
  const anyFailed = !anyRunning && statuses.some((s) => s === 'failed');
  const overall: RowStatus = anyRunning ? 'running' : anyFailed ? 'failed' : 'completed';

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
      {/* 头部：图标 + 固定「智能体」+ 智能体数量 + 进度点阵 + 整体状态徽章 */}
      <div className="flex min-w-0 items-center gap-1.5">
        <Bot className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {t('subagent.card.title')}
        </span>
        <span className="shrink-0 text-border">|</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('subagent.card.agentCount', { count: calls.length })}
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
                'border-primary/30 bg-primary/10 text-primary-text',
              overall === 'failed' &&
                'border-danger/30 bg-danger/10 text-danger',
              overall === 'completed' &&
                'border-success/30 bg-success/10 text-success',
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
          // 名称解析优先级：结果 metadata（实时/历史都可靠）→ 总线成员 → agents 注册表 → id
          const displayName =
            call.name ||
            getAgentByParentToolCall(call.toolCallId)?.name ||
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
              parentSessionId={sessionId}
            />
          );
        })}
      </div>
    </div>
  );
});
