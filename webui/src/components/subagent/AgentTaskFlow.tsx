// webui/src/components/subagent/AgentTaskFlow.tsx
// 单 agent（一次性子代理）的「微缩任务流」：把该 agent 自己会话的消息
// 以紧凑样式内联到卡片里，并提供跳转到完整任务页的入口。
//
// 数据来源（双通道合并，按消息 id 去重）：
// - 实时：store.messagesBySession[该 agent 会话 id]（subagent.event 复用主 agent reducer 落库）
// - 历史：GET /api/session/:id（补齐页面刷新/早期轮次；运行中按 WS 节流增量重拉）
// agent 的会话 id 就是它的 taskId（subagent 结果里的 session=…）。
//
// 只渲染 assistant 消息：过程区不展示「Agent 发给子代理的消息」（任务、环境上下文、
// 记忆注入等 user 角色内容），避免内部上下文泄露。
// 工具行复用主对话的 ToolCallDetails（图标 + 可展开参数/结果，样式一致）。

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Atom, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '../../api/http';
import { wsClient } from '../../api/ws';
import { MarkdownRenderer } from '../../render';
import { useStore } from '../../store';
import { stripInjectBlock } from '../../lib/inject-block';
import { formatThinkingSeconds, thinkingPreview } from '../../lib/thinking-preview';
import { ToolCallDetails } from '../shared/ToolCallDetails';
import { RunCodeCard } from '../shared/RunCodeCard';
import { TodoProgressCard } from '../shared/TodoProgressCard';
import { ThinkingPreview } from '../shared/ThinkingPreview';
import { buildToolResultIndex, isAgentCall, parseAgentArgs, type ToolResultEntry } from './agent-calls';
import type { SubagentCallItem } from './SubagentCard';
import type { TaskMessage, ToolCall } from '../../types/api';

/**
 * 嵌套 Subagent 卡片懒加载：SubagentCard 反向懒加载 AgentTaskFlow（避免静态循环依赖），
 * 运行时递归仅受后端 MAX_SUBAGENT_DEPTH=2 限制。
 */
const SubagentCard = lazy(() =>
  import('./SubagentCard').then((m) => ({ default: m.SubagentCard })),
);

interface AgentTaskFlowProps {
  /** agent 自己的会话 id（= 其 taskId）；null 表示尚未派发 */
  sessionId: string | null;
  /** 该 agent 是否仍在运行（空态文案与自动贴底用） */
  running?: boolean;
  /** 是否渲染内置「打开完整任务页」入口（默认 true） */
  showOpenButton?: boolean;
  /** 取末 N 条（默认 20） */
  limit?: number;
  className?: string;
}

/** 运行中增量刷新节流（ms）：子代理事件高频，避免每个事件都打一次请求 */
const RELOAD_THROTTLE_MS = 1200;

/** 自动贴底判定阈值（px）：距底部小于该值视为"用户正在看最新" */
const STICK_BOTTOM_PX = 24;

/** 时间升序合并：同 id 以实时版本为准（实时有半截回复，历史有早期轮次） */
function mergeMessages(history: TaskMessage[], live: TaskMessage[]): TaskMessage[] {
  const byId = new Map<string, TaskMessage>();
  for (const m of history) byId.set(m.id, m);
  for (const m of live) {
    const prev = byId.get(m.id);
    byId.set(m.id, prev ? mergeToolState(prev, m) : m);
  }
  return [...byId.values()].sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });
}

/**
 * 同 id 消息合并：实时内容优先，但工具状态与结果取并集。
 * 实时副本可能因事件丢失缺少 toolResult 或残留 executing；历史副本则是无 status 的裸投影。
 * 规则：有结果 → done；实时缺 status/live 时回退历史值。
 */
function mergeToolState(historyMsg: TaskMessage, liveMsg: TaskMessage): TaskMessage {
  const results = new Map<string, NonNullable<TaskMessage['toolResults']>[number]>();
  for (const entry of historyMsg.toolResults ?? []) results.set(entry.toolCallId, entry);
  for (const entry of liveMsg.toolResults ?? []) results.set(entry.toolCallId, entry);
  const toolCalls = liveMsg.toolCalls?.map((tc) => {
    const fromHistory = historyMsg.toolCalls?.find((item) => item.id === tc.id);
    const status = results.has(tc.id) ? ('done' as const) : (tc.status ?? fromHistory?.status);
    const live = tc.live ?? fromHistory?.live;
    return {
      ...tc,
      ...(status ? { status } : {}),
      ...(live ? { live } : {}),
    };
  });
  return {
    ...liveMsg,
    // 实时副本没有快照时保留历史快照：否则节流重拉后卡片会被实时版本覆盖而消失
    ...(liveMsg.todoSnapshot === undefined && historyMsg.todoSnapshot !== undefined
      ? { todoSnapshot: historyMsg.todoSnapshot }
      : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(results.size > 0 ? { toolResults: [...results.values()] } : {}),
  };
}

/** 思考状态行：流式中实时计时 + 最新片段预览（与主对话 MessageBubble 同构，紧凑尺寸） */
const ThinkingLine = memo(function ThinkingLine({ message }: { message: TaskMessage }) {
  const { t } = useTranslation();
  // 流式思考期间每 100ms 刷新「当前时刻」，驱动状态行秒数递增
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!message.thinkingStreaming) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 100);
    return () => clearInterval(id);
  }, [message.thinkingStreaming]);

  let thinkMs: number | null = null;
  if (message.thinkingMs != null) {
    thinkMs = Math.max(0, message.thinkingMs);
  } else if (message.thinkingStartedAt) {
    const started = Date.parse(message.thinkingStartedAt);
    if (Number.isFinite(started)) {
      if (message.thinkingStreaming) {
        thinkMs = Math.max(0, nowMs - started);
      } else if (message.thinkingEndedAt) {
        const ended = Date.parse(message.thinkingEndedAt);
        if (Number.isFinite(ended)) thinkMs = Math.max(0, ended - started);
      }
    }
  }
  const preview = message.thinkingStreaming ? thinkingPreview(message.thinking) : '';

  return (
    <details className="group">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        {message.thinkingStreaming ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : (
          <Atom className="size-3 shrink-0" />
        )}
        <span className="shrink-0">
          {message.thinkingStreaming ? t('task.thinkingStreaming') : t('task.thinkingDone')}
        </span>
        {thinkMs != null && (
          <>
            <span className="shrink-0">·</span>
            <span className="shrink-0 tabular-nums">
              {t('task.thinkingElapsed', { sec: formatThinkingSeconds(thinkMs) })}
            </span>
          </>
        )}
        {preview && <ThinkingPreview text={preview} />}
      </summary>
      <div className="mt-1">
        <MarkdownRenderer
          text={message.thinking ?? ''}
          streaming={!!message.thinkingStreaming}
          variant="compact"
        />
      </div>
    </details>
  );
});

/** 单条 assistant 消息：思考行 + 流式正文 + 工具折叠行（与主对话一致） */
const FlowAssistantMessage = memo(function FlowAssistantMessage({
  message,
  iconMap,
  toolResultIndex,
  sessionId,
}: {
  message: TaskMessage;
  iconMap: Record<string, string>;
  toolResultIndex: Map<string, ToolResultEntry>;
  /** 子代理自己的会话 id（工具卡懒加载必须按它取结果，而不是主会话） */
  sessionId?: string | null;
}) {
  /** 子代理自己的会话 todos（与主会话隔离；实时由 subagent.todo 写入） */
  const todos = useStore((s) => (sessionId ? s.todosBySession[sessionId] : undefined));
  if (message.isError) {
    return (
      <pre className="mono whitespace-pre-wrap break-words text-[10px] text-destructive">
        {message.content}
      </pre>
    );
  }
  // 防御性剥离命令注入块（LLM 可见、UI 不可见），与主对话渲染口径一致
  const visibleContent = stripInjectBlock(message.content);
  // agent 调用走 SubagentCard（与主会话同口径）；todo 走专属卡片；其余走通用工具卡
  const toolCalls = message.toolCalls ?? [];
  const agentCalls = toolCalls.filter((tc) => isAgentCall(tc));
  const otherCalls = toolCalls.filter((tc) => tc.name !== 'todo' && !isAgentCall(tc));
  // todo 卡片：优先级 = 消息自身快照（历史）→ 子代理会话实时清单（与主会话同一口径）
  const todoSnapshot = message.todoSnapshot ?? todos;
  const hasTodoCall = toolCalls.some((tc) => tc.name === 'todo');
  const showTodoCard =
    (todoSnapshot?.length ?? 0) > 0 &&
    (message.todoSnapshot !== undefined || hasTodoCall);
  // 嵌套 agent 调用 → SubagentCallItem（结果从全局索引兜底，长耗时结果不紧邻本消息）
  const agentItems: SubagentCallItem[] = agentCalls.map((tc) => {
    const indexed = toolResultIndex.get(tc.id);
    const args = parseAgentArgs(tc) ?? {};
    return {
      toolCallId: tc.id,
      template: args.template ?? '',
      task: args.task ?? '',
      ...(args.mode ? { mode: args.mode } : {}),
      status: indexed ? 'done' : tc.status,
      ...(indexed ? { resultText: indexed.text, isError: indexed.isError } : {}),
      ...(indexed?.lazy ? { lazy: true } : {}),
      ...(indexed?.agentName ? { name: indexed.agentName } : {}),
    };
  });
  return (
    <div className="flex flex-col gap-1">
      {message.thinking && <ThinkingLine message={message} />}
      {visibleContent && (
        <div className="text-sm text-foreground">
          <MarkdownRenderer
            text={visibleContent}
            streaming={!!message.streaming}
            defer={!message.streaming}
            cursor={
              message.streaming ? <Loader2 className="ml-1 inline size-2.5 animate-spin" /> : undefined
            }
          />
        </div>
      )}
      {otherCalls.map((tc) => {
        const matched = message.toolResults?.find((tr) => tr.toolCallId === tc.id);
        const indexed = toolResultIndex.get(tc.id);
        // 结果即完成：实时副本可能残留 executing，历史索引已拿到结果时按完成渲染
        const resolved: ToolCall =
          indexed && tc.status !== 'done' ? { ...tc, status: 'done' } : tc;
        if (tc.name === 'run_code') {
          return (
            <RunCodeCard
              key={tc.id}
              toolCall={resolved}
              result={matched?.result}
              fallbackText={indexed?.text}
              fallbackIsError={indexed?.isError}
              iconMap={iconMap}
              sessionId={sessionId ?? undefined}
            />
          );
        }
        return (
          <ToolCallDetails
            key={tc.id}
            toolCall={resolved}
            result={matched?.result}
            fallbackText={indexed?.text}
            fallbackIsError={indexed?.isError}
            iconMap={iconMap}
            sessionId={sessionId ?? undefined}
          />
        );
      })}
      {agentItems.length > 0 && (
        <Suspense fallback={<div className="text-[11px] text-muted-foreground">…</div>}>
          <SubagentCard calls={agentItems} sessionId={sessionId ?? undefined} />
        </Suspense>
      )}
      {showTodoCard && <TodoProgressCard todos={todoSnapshot!} variant="inline" />}
    </div>
  );
});

export function AgentTaskFlow({ sessionId, running, limit = 20, className, showOpenButton = true }: AgentTaskFlowProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 滚动内容包裹层：ResizeObserver 观察真实高度变化（水合/工具卡展开/结果补拉） */
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** 用户是否停留在底部（决定新内容到达时是否自动贴底） */
  const stickBottomRef = useRef(true);
  /** 上一帧 scrollTop：仅「变小」才视为用户主动上滑 */
  const lastTopRef = useRef(0);

  // 实时通道：该 agent 会话的消息由 subagent.event 实时写入 store
  const liveMessages = useStore((s) => (sessionId ? s.messagesBySession[sessionId] : undefined));
  // 工具名 → 图标键（与主对话同源）
  const toolIconMap = useStore((s) => s.toolIconMap);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const resp = await api.getSessionHistory(sessionId, { limit });
      // 只保留 assistant 消息：user 角色含 Agent 发送的任务与内部注入上下文
      // （env-context / memory-l1 虽已被适配层按 name 丢弃，任务消息仍在），一律不展示。
      setMessages(resp.messages.filter((m) => m.role === 'assistant'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [sessionId, limit]);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    let alive = true;
    setLoading(true);
    void load().finally(() => {
      if (alive) setLoading(false);
    });
    const unsub = wsClient.onMessage((msg) => {
      if (msg.type !== 'subagent.event') return;
      const payload = (msg.payload ?? {}) as { taskId?: string | null };
      if (payload.taskId !== sessionId) return;
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void load();
      }, RELOAD_THROTTLE_MS);
    });
    return () => {
      alive = false;
      unsub();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [sessionId, load]);

  // WS 重连后补拉一次历史：睡眠/断网期间丢失的 subagent.event 不会自动重放，
  // 不补拉会让「执行过程」永久停在旧状态。
  const wsStatus = useStore((s) => s.wsStatus);
  const prevWsStatusRef = useRef(wsStatus);
  useEffect(() => {
    const prev = prevWsStatusRef.current;
    prevWsStatusRef.current = wsStatus;
    if (!sessionId) return;
    if (wsStatus === 'open' && prev !== 'open' && prev !== 'connecting') {
      void load();
    }
  }, [wsStatus, sessionId, load]);

  // 双通道合并（id 去重，实时覆盖历史）；过程区只保留 assistant 消息
  const merged = useMemo(
    () => mergeMessages(messages, liveMessages ?? []).filter((m) => m.role === 'assistant'),
    [messages, liveMessages],
  );

  // 工具结果全局索引：长耗时工具的结果消息可能落在后续消息里，按 toolCallId 兜底匹配
  const toolResultIndex = useMemo(() => buildToolResultIndex(merged), [merged]);

  const visible = useMemo(() => merged.slice(-limit), [merged, limit]);

  // 内容签名：消息数 / 末条正文与思考长度变化时触发贴底
  const last = visible[visible.length - 1];
  const contentSig = last
    ? `${visible.length}|${last.id}|${last.content.length}|${last.thinking?.length ?? 0}|${last.toolCalls?.length ?? 0}`
    : '0';

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const dist = el.scrollHeight - top - el.clientHeight;
    // 仅「用户主动上滑」（scrollTop 相对上一帧变小）才脱离跟随；
    // 回到底部（向下滚动且距底 <= 阈值）才恢复。手动上滑后不再被内容增长拽回。
    if (top < lastTopRef.current - 1) {
      stickBottomRef.current = false;
    } else if (top >= lastTopRef.current && dist <= STICK_BOTTOM_PX) {
      stickBottomRef.current = true;
    }
    lastTopRef.current = top;
  }, []);

  /** 贴底：程序化滚动后同步 lastTop，避免下一次 scroll 事件被方向判定误判为用户上滑 */
  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !stickBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  }, []);

  // 内容高度变化即跟随：Markdown 渐进水合、工具卡延迟展开、结果补拉都不会改变 contentSig，
  // 只在「消息长度变化」时贴底会停在中途（子代理过程流不自动到位的根因）。
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => pinToBottom());
    ro.observe(content);
    return () => ro.disconnect();
  }, [pinToBottom]);

  useEffect(() => {
    pinToBottom();
  }, [contentSig, pinToBottom]);

  if (!sessionId) {
    return (
      <div className={cn('rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground', className)}>
        {running ? t('subagent.card.starting') : t('subagent.card.noSessionYet')}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/30 p-2', className)}>
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span>{t('subagent.card.flowTitle')}</span>
        {loading && <Loader2 className="size-2.5 animate-spin" />}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        // 滚轮向上 / 触摸位移立即脱离跟随：一档滚轮未超阈值时也不能被内容增长拽回
        onWheel={(e) => {
          if (e.deltaY < 0) stickBottomRef.current = false;
        }}
        onTouchMove={() => {
          stickBottomRef.current = false;
        }}
        // 关闭浏览器原生滚动锚定：高度变化由 ResizeObserver 统一贴底，避免双重补偿抖动
        style={{ overflowAnchor: 'none' }}
        className="max-h-[360px] overflow-auto no-scrollbar"
      >
        <div ref={contentRef} className="flex flex-col gap-2">
          {visible.length === 0 && !loading && (
            <div className="px-1 py-2 text-[11px] text-muted-foreground">
              {running
                ? t('subagent.card.starting')
                : failed
                  ? t('subagent.card.flowLoadFailed')
                  : t('subagent.card.flowEmpty')}
            </div>
          )}
          {visible.map((m) => (
            <div key={m.id} className="flex flex-col gap-1">
              <FlowAssistantMessage
                message={m}
                iconMap={toolIconMap}
                toolResultIndex={toolResultIndex}
                sessionId={sessionId}
              />
            </div>
          ))}
        </div>
      </div>

      {showOpenButton && (
        <button
          type="button"
          onClick={() => navigate(`/task/${sessionId}`)}
          className="flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-[11px] text-primary-strong transition-colors hover:bg-muted"
        >
          <ExternalLink className="size-3" />
          {t('subagent.card.openFullTask')}
        </button>
      )}
    </div>
  );
}
