// webui/src/components/agenteam/AgentTaskFlow.tsx
// 单 agent（subagent / 团队成员）的「微缩任务流」：把该 agent 自己会话的消息
// 以紧凑样式内联到卡片里，并提供跳转到完整任务页的入口。
//
// 数据来源（双通道合并，按消息 id 去重）：
// - 实时：store.messagesBySession[该 agent 会话 id]（agenteam.member.event 复用主 agent reducer 落库）
// - 历史：GET /api/session/:id（补齐页面刷新/早期轮次；运行中按 WS 节流增量重拉）
// agent 的会话 id 就是它的 taskId（TeamMember.sessionId / subagent session=…）。
//
// 只渲染 assistant 消息：过程区不展示「Agent 发给子代理的消息」（任务、环境上下文、
// 记忆注入等 user 角色内容），避免内部上下文泄露。
// 工具行复用主对话的 ToolCallDetails（图标 + 可展开参数/结果，样式一致）。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { buildToolResultIndex, type ToolResultEntry } from './agent-calls';
import type { TaskMessage } from '../../types/api';

interface AgentTaskFlowProps {
  /** agent 自己的会话 id（= 其 taskId）；null 表示尚未派发 */
  sessionId: string | null;
  /** 该 agent 是否仍在运行（空态文案与自动贴底用） */
  running?: boolean;
  /** 是否渲染内置「打开完整任务页」入口（默认 true；Subagent 卡片改为底部常驻按钮时传 false） */
  showOpenButton?: boolean;
  /** 取末 N 条（默认 20） */
  limit?: number;
  className?: string;
}

/** 运行中增量刷新节流（ms）：成员事件高频，避免每个事件都打一次请求 */
const RELOAD_THROTTLE_MS = 1200;

/** 自动贴底判定阈值（px）：距底部小于该值视为"用户正在看最新" */
const STICK_BOTTOM_PX = 24;

/** 时间升序合并：同 id 以实时版本为准（实时有半截回复，历史有早期轮次） */
function mergeMessages(history: TaskMessage[], live: TaskMessage[]): TaskMessage[] {
  const byId = new Map<string, TaskMessage>();
  for (const m of history) byId.set(m.id, m);
  for (const m of live) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });
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
      <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
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
        {preview && (
          <span className="group-open:hidden flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">·</span>
            <span className="min-w-0 truncate text-muted-foreground/70">{preview}</span>
          </span>
        )}
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
}: {
  message: TaskMessage;
  iconMap: Record<string, string>;
  toolResultIndex: Map<string, ToolResultEntry>;
}) {
  if (message.isError) {
    return (
      <pre className="mono whitespace-pre-wrap break-words text-[10px] text-destructive">
        {message.content}
      </pre>
    );
  }
  // 防御性剥离命令注入块（LLM 可见、UI 不可见），与主对话渲染口径一致
  const visibleContent = stripInjectBlock(message.content);
  return (
    <div className="flex flex-col gap-1">
      {message.thinking && <ThinkingLine message={message} />}
      {visibleContent && (
        <div className="text-[11px] text-foreground/90">
          <MarkdownRenderer
            text={visibleContent}
            streaming={!!message.streaming}
            variant="compact"
            defer={!message.streaming}
            cursor={
              message.streaming ? <Loader2 className="ml-1 inline size-2.5 animate-spin" /> : undefined
            }
          />
        </div>
      )}
      {message.toolCalls?.map((tc) => {
        const matched = message.toolResults?.find((tr) => tr.toolCallId === tc.id);
        const indexed = toolResultIndex.get(tc.id);
        return (
          <ToolCallDetails
            key={tc.id}
            toolCall={tc}
            result={matched?.result}
            fallbackText={indexed?.text}
            fallbackIsError={indexed?.isError}
            iconMap={iconMap}
          />
        );
      })}
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
  /** 用户是否停留在底部（决定新内容到达时是否自动贴底） */
  const stickBottomRef = useRef(true);

  // 实时通道：该 agent 会话的消息由 agenteam.member.event 实时写入 store
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
      if (msg.type !== 'agenteam.member.event') return;
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
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_BOTTOM_PX;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [contentSig]);

  if (!sessionId) {
    return (
      <div className={cn('rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground', className)}>
        {running ? t('agenteam.card.starting') : t('agenteam.card.noSessionYet')}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/30 p-2', className)}>
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span>{t('agenteam.card.flowTitle')}</span>
        {loading && <Loader2 className="size-2.5 animate-spin" />}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex max-h-[280px] flex-col gap-2 overflow-auto no-scrollbar"
      >
        {visible.length === 0 && !loading && (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">
            {running
              ? t('agenteam.card.starting')
              : failed
                ? t('agenteam.card.flowLoadFailed')
                : t('agenteam.card.flowEmpty')}
          </div>
        )}
        {visible.map((m) => (
          <div key={m.id} className="flex flex-col gap-1">
            <FlowAssistantMessage
              message={m}
              iconMap={toolIconMap}
              toolResultIndex={toolResultIndex}
            />
          </div>
        ))}
      </div>

      {showOpenButton && (
        <button
          type="button"
          onClick={() => navigate(`/task/${sessionId}`)}
          className="flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-[11px] text-primary-strong transition-colors hover:bg-muted"
        >
          <ExternalLink className="size-3" />
          {t('agenteam.card.openFullTask')}
        </button>
      )}
    </div>
  );
}
