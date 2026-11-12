// webui/src/components/subagent/AgentBusPanel.tsx
// 任务页右侧「智能体」标签：当前任务的运行中智能体树 + 通信记录。
// 数据：REST 快照（历史/刷新后）+ WS agent-bus.event（实时成员与消息）。
// 树只渲染 status=running 的成员（主代理 + 子代理），按 parentSessionId 还原拓扑；
// 已完成/失败/中止的成员不进入树，避免把历史成员当成当前状态。
// 节点为卡片形态（与对话流 SubagentCard 行一致），不可展开智能体内容；
// 运行中的子代理可在节点右侧单独终止（含其后代）。

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
import { fallbackAvatarSeed, templateAvatarSeed } from '../../lib/agent-avatars';
import { HumationAvatar } from './HumationAvatar';
import type { AgentBusMember, AgentBusMessage } from '../../types/api';

type MessageFilter = 'all' | 'channel' | 'direct';

/** 运行中智能体树节点（父子关系由 parentSessionId 还原） */
interface RunningNode {
  member: AgentBusMember;
  children: RunningNode[];
}

/**
 * 只保留运行中成员，并按拓扑建树：
 * 父节点不在运行集合中（已完成/已消失）时，子节点提升为根——
 * async 子代理会在父 run 结束后继续运行，不能成为孤儿。
 */
function buildRunningTree(members: AgentBusMember[]): RunningNode[] {
  const running = members.filter((m) => m.status === 'running');
  const visible = new Set(running.map((m) => m.sessionId));
  const children = new Map<string, AgentBusMember[]>();
  const roots: AgentBusMember[] = [];
  for (const member of running) {
    const parentId =
      member.parentSessionId && visible.has(member.parentSessionId)
        ? member.parentSessionId
        : null;
    if (!parentId) {
      roots.push(member);
      continue;
    }
    const list = children.get(parentId);
    if (list) list.push(member);
    else children.set(parentId, [member]);
  }
  const byStart = (a: AgentBusMember, b: AgentBusMember): number =>
    Date.parse(a.startedAt) - Date.parse(b.startedAt);
  const toNode = (member: AgentBusMember): RunningNode => ({
    member,
    children: (children.get(member.sessionId) ?? []).sort(byStart).map(toNode),
  });
  return roots.sort(byStart).map(toNode);
}

/** 树节点总数（含后代） */
function countNodes(nodes: RunningNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

function formatTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleTimeString();
}

/** 单个运行中节点卡片（不可展开内容；点击过滤通信记录，右侧按钮终止子代理） */
function RunningTreeNode({
  node,
  selectedAgent,
  onSelect,
  onCancel,
  cancellingSession,
}: {
  node: RunningNode;
  selectedAgent: string | null;
  onSelect: (sessionId: string) => void;
  onCancel: (member: AgentBusMember) => void;
  cancellingSession: string | null;
}) {
  const { t } = useTranslation();
  const member = node.member;
  const avatarSeed =
    templateAvatarSeed(member.template) ?? fallbackAvatarSeed(member.template, member.name);
  const cancelling = cancellingSession === member.sessionId;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(member.sessionId)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onSelect(member.sessionId);
        }}
        className={cn(
          'cursor-pointer rounded-lg border border-border/70 bg-muted/40 px-2.5 py-2 transition-colors hover:bg-muted/70',
          selectedAgent === member.sessionId && 'border-primary/40 bg-primary/5',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <HumationAvatar seed={avatarSeed} size={22} />
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {member.name}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {member.agentId}
          </span>
          <Loader2 className="ml-auto size-3 shrink-0 animate-spin text-primary" />
          {member.kind === 'subagent' && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCancel(member);
              }}
              onKeyDown={(event) => event.stopPropagation()}
              disabled={cancelling}
              title={t('agentBus.cancelAgent')}
              aria-label={t('agentBus.cancelAgent')}
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
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 select-none text-muted-foreground/50">└</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground" title={member.task}>
            {member.task}
          </span>
        </div>
      </div>
      {node.children.length > 0 && (
        <div className="ml-3 flex flex-col gap-1.5 border-l border-border/60 pl-2">
          {node.children.map((child) => (
            <RunningTreeNode
              key={child.member.sessionId}
              node={child}
              selectedAgent={selectedAgent}
              onSelect={onSelect}
              onCancel={onCancel}
              cancellingSession={cancellingSession}
            />
          ))}
        </div>
      )}
    </div>
  );
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
  const cancelMember = useCallback(
    async (member: AgentBusMember): Promise<void> => {
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
    },
    [cancellingSession, t],
  );

  useEffect(() => {
    setSnapshotMessages([]);
    setSelectedAgent(null);
    void load();
  }, [load]);

  // 树只保留运行中成员，并按父会话还原拓扑
  const runningTree = useMemo(() => buildRunningTree(members), [members]);
  const runningCount = useMemo(() => countNodes(runningTree), [runningTree]);

  // 选中的成员结束后清理过滤条件，避免通信记录被不可见的 agent 锁死
  useEffect(() => {
    if (!selectedAgent) return;
    const stillRunning = members.some(
      (member) => member.sessionId === selectedAgent && member.status === 'running',
    );
    if (!stillRunning) setSelectedAgent(null);
  }, [members, selectedAgent]);

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
    () =>
      members.find(
        (member) => member.sessionId === selectedAgent && member.status === 'running',
      ) ?? null,
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
      {/* 头部：标题 + 运行中数量 + 刷新 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        <Bot className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">{t('agentBus.tree')}</span>
        <span className="text-[10px] text-muted-foreground">{runningCount}</span>
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

      {/* 运行中智能体树（卡片 + 拓扑；不包含已结束成员） */}
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        {runningCount === 0 ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">
            {failed ? t('subagent.card.flowLoadFailed') : t('agentBus.empty')}
          </div>
        ) : (
          <div className="flex max-h-[280px] flex-col gap-1.5 overflow-auto no-scrollbar">
            {runningTree.map((node) => (
              <RunningTreeNode
                key={node.member.sessionId}
                node={node}
                selectedAgent={selectedAgent}
                onSelect={(id) =>
                  setSelectedAgent((prev) => (prev === id ? null : id))
                }
                onCancel={(member) => void cancelMember(member)}
                cancellingSession={cancellingSession}
              />
            ))}
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
