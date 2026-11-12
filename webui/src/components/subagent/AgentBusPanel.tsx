// webui/src/components/subagent/AgentBusPanel.tsx
// 任务页右侧「智能体」标签：当前任务的智能体树 + 通信记录。
// 数据：REST 快照（历史/刷新后）+ WS agent-bus.event（实时成员与消息）。
// 观察与审计为主；运行中的子代理可在成员行右侧单独终止（含其后代）。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Loader2, RefreshCw, Square } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '../../api/http';
import {
  getAgentBusVersion,
  hydrateAgentBus,
  listAgentBusMembers,
  listAgentBusMessages,
  subscribeAgentBus,
} from '../../lib/agent-bus';
import type { AgentBusMember, AgentBusMessage } from '../../types/api';

type MessageFilter = 'all' | 'channel' | 'direct';

const STATUS_DOT: Record<AgentBusMember['status'], string> = {
  running: 'bg-primary animate-pulse',
  completed: 'bg-success',
  failed: 'bg-danger',
  aborted: 'bg-warning',
};

function formatTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleTimeString();
}

/** 成员状态本地化（agentBus.statusRunning / Completed / Failed / Aborted） */
function statusLabel(status: AgentBusMember['status'], t: (key: string) => string): string {
  const suffix = status.charAt(0).toUpperCase() + status.slice(1);
  return t(`agentBus.status${suffix}`);
}

export function AgentBusPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const version = useSyncExternalStore(subscribeAgentBus, getAgentBusVersion);
  const members = useMemo(() => listAgentBusMembers(sessionId), [sessionId, version]);
  const liveMessages = useMemo(() => listAgentBusMessages(sessionId), [sessionId, version]);

  const [snapshotMessages, setSnapshotMessages] = useState<AgentBusMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  /** 正在终止的子代理 sessionId（防重复点击） */
  const [cancellingSession, setCancellingSession] = useState<string | null>(null);
  const [filter, setFilter] = useState<MessageFilter>('all');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const snapshot = await api.getAgentBusSnapshot({ root: sessionId, limit: 200 });
      hydrateAgentBus(snapshot.members);
      setSnapshotMessages(snapshot.messages);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  /** 终止单个子代理（含其后代）；状态由 agent-bus.event 实时回写 */
  const cancelMember = async (member: AgentBusMember): Promise<void> => {
    if (cancellingSession) return;
    setCancellingSession(member.sessionId);
    try {
      const resp = await api.cancelSubagent(member.sessionId);
      if (!resp.ok) toast.error(t('agentBus.cancelNotRunning'));
    } catch {
      toast.error(t('agentBus.cancelFailed'));
    } finally {
      setCancellingSession(null);
    }
  };

  useEffect(() => {
    setSnapshotMessages([]);
    setSelectedAgent(null);
    void load();
  }, [load]);

  // 快照消息 + 实时消息按 id 合并（实时为准）
  const messages = useMemo(() => {
    const byId = new Map<string, AgentBusMessage>();
    for (const message of snapshotMessages) byId.set(message.id, message);
    for (const message of liveMessages) byId.set(message.id, message);
    return [...byId.values()].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  }, [snapshotMessages, liveMessages]);

  const selectedMember = useMemo(
    () => members.find((m) => m.sessionId === selectedAgent) ?? null,
    [members, selectedAgent],
  );

  const visibleMessages = useMemo(() => {
    return messages.filter((message) => {
      if (filter === 'channel' && message.toAgentId !== null) return false;
      if (filter === 'direct' && message.toAgentId === null) return false;
      if (selectedAgent) {
        return (
          message.fromSessionId === selectedAgent || message.toSessionId === selectedAgent
        );
      }
      return true;
    });
  }, [messages, filter, selectedAgent]);

  // 贴底：新消息到达且用户停留在底部时自动跟随
  const stickBottomRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleMessages.length]);

  const renderMessage = (message: AgentBusMessage) => {
    const to =
      message.toAgentId === null
        ? t('agentBus.channel')
        : message.toAgentId;
    return (
      <div
        key={message.id}
        className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5"
      >
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="shrink-0 font-medium text-foreground/80">
            {message.fromAgentId}
          </span>
          <span className="shrink-0">→</span>
          <span className="shrink-0">{to}</span>
          {message.kind === 'result' && (
            <span className="shrink-0 rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-[9px] text-success">
              {t('subagent.card.completed')}
            </span>
          )}
          <span className="ml-auto shrink-0 tabular-nums">{formatTime(message.createdAt)}</span>
        </div>
        <div className="whitespace-pre-wrap break-words text-[11px] text-foreground">
          {message.content}
        </div>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 头部：标题 + 刷新 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        <Bot className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">{t('agentBus.tree')}</span>
        <span className="text-[10px] text-muted-foreground">{members.length}</span>
        {loading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        <button
          type="button"
          onClick={() => void load()}
          title={t('fileBrowser.refresh')}
          aria-label={t('fileBrowser.refresh')}
          className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      {/* 智能体树 */}
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        {members.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">
            {failed ? t('subagent.card.flowLoadFailed') : t('agentBus.empty')}
          </div>
        ) : (
          <div className="flex max-h-[180px] flex-col gap-0.5 overflow-auto no-scrollbar">
            {members.map((member) => {
              const runningSubagent = member.kind === 'subagent' && member.status === 'running';
              const cancelling = cancellingSession === member.sessionId;
              return (
                <div
                  key={member.sessionId}
                  className={cn(
                    'flex min-w-0 items-center gap-1 rounded-md transition-colors hover:bg-muted/50',
                    selectedAgent === member.sessionId && 'bg-muted',
                  )}
                  style={{ paddingLeft: `${6 + Math.max(0, member.depth) * 14}px` }}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedAgent((prev) =>
                        prev === member.sessionId ? null : member.sessionId,
                      )
                    }
                    className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left"
                  >
                    <span
                      className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[member.status])}
                      aria-hidden
                    />
                    <span className="shrink-0 text-[11px] font-medium text-foreground">
                      {member.agentId}
                    </span>
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {member.name}
                    </span>
                    <span className="ml-auto max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground/70">
                      {statusLabel(member.status, t)}
                    </span>
                  </button>
                  {runningSubagent && (
                    <button
                      type="button"
                      onClick={() => void cancelMember(member)}
                      disabled={cancelling}
                      title={t('agentBus.cancelAgent')}
                      aria-label={t('agentBus.cancelAgent')}
                      className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
                    >
                      {cancelling ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Square className="size-3 fill-current" />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 通信记录 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {(['all', 'channel', 'direct'] as MessageFilter[]).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setFilter(item)}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] transition-colors',
              filter === item
                ? 'border-border bg-muted text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-muted/50',
            )}
          >
            {t(`agentBus.${item}`)}
          </button>
        ))}
        {selectedMember && (
          <button
            type="button"
            onClick={() => setSelectedAgent(null)}
            className="ml-auto truncate rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
            title={selectedMember.name}
          >
            {selectedMember.agentId}
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto no-scrollbar p-2"
      >
        {visibleMessages.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">
            {t('agentBus.emptyMessages')}
          </div>
        ) : (
          visibleMessages.map(renderMessage)
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
        {t('agentBus.auditHint')}
      </div>
    </div>
  );
}
