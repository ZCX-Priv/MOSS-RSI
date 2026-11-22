// src/modules/agent-bus/bus.ts
// AgentBus 实现：成员树 + 收件箱 + 频道广播 + JSONL 审计 + 共享白板。
//
// 设计边界：
// - 单进程内存态；成员终态额外写 members.jsonl 账本，刷新/重启后可恢复（running 投影为 aborted）。
// - 消息审计落盘 ~/.moss/agent-bus/<rootSessionId>.jsonl（同步小写入，失败只告警）。
// - 白板落盘 ~/.moss/agent-bus/<rootSessionId>.board.json（原子写；规则主代理独占，讨论所有成员可写）。
// - `send` 只保证「投递到收件箱」，不保证目标已消费；引擎在 run 开始/每轮工具后 drain。
// - 事件通过 EventBus `agent-bus:event` 广播，server 转发为 WS `agent-bus.event`。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventBus, Environment, Logger } from '../../core/types';
import { atomicWriteFile } from '../../utils/fs-atomic';
import type {
  AgentBoardNote,
  AgentBoardNoteKind,
  AgentBoardSnapshot,
  AgentBus,
  AgentBusMember,
  AgentBusMessage,
  AgentBusSnapshot,
  PostBoardNoteInput,
  PostBoardNoteResult,
  RegisterAgentInput,
  SendAgentMessageInput,
  SendAgentMessageResult,
} from './types';

const MAX_TASK_CHARS = 200;
const MAX_MESSAGE_CHARS = 8000;
const MAX_MESSAGES_PER_ROOT = 500;
/** 单条白板内容上限 */
const MAX_BOARD_CONTENT_CHARS = 4000;
/** 每个任务树的规则上限 */
const MAX_BOARD_RULES = 20;
/** 每个任务树的讨论保留上限（环形） */
const MAX_BOARD_DISCUSSION = 200;
/** readBoard 返回的最近讨论条数 */
const BOARD_READ_DISCUSSION = 50;

/** 白板内存状态 */
interface BoardState {
  rules: AgentBoardNote[];
  discussion: AgentBoardNote[];
}

/** 审计文件名安全化（sessionId 由内部生成，仍防御异常字符） */
function safeFileName(id: string): string {
  return id.replace(/[^0-9a-zA-Z._-]/g, '_');
}

/** 成员排序：root → depth → startedAt（与 list 保持一致） */
function compareMembers(a: AgentBusMember, b: AgentBusMember): number {
  if (a.rootSessionId !== b.rootSessionId) return a.rootSessionId < b.rootSessionId ? -1 : 1;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return Date.parse(a.startedAt) - Date.parse(b.startedAt);
}

/** 宽松校验白板条目（损坏的审计行直接忽略） */
function isBoardNote(value: unknown): value is AgentBoardNote {
  if (!value || typeof value !== 'object') return false;
  const note = value as Partial<AgentBoardNote>;
  return (
    typeof note.id === 'string' &&
    (note.kind === 'rule' || note.kind === 'discussion') &&
    typeof note.content === 'string' &&
    typeof note.createdAt === 'string'
  );
}

export class AgentBusImpl implements AgentBus {
  private readonly members = new Map<string, AgentBusMember>();
  private readonly inbox = new Map<string, AgentBusMessage[]>();
  private readonly messages: AgentBusMessage[] = [];
  private readonly rootCounters = new Map<string, number>();
  /** 已从成员账本恢复过序号的 root（避免重复扫描） */
  private readonly counterRestored = new Set<string>();
  /** 共享白板内存缓存（rootSessionId → 规则/讨论） */
  private readonly boards = new Map<string, BoardState>();
  private readonly auditDir: string;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;

  constructor(deps: { env: Environment; eventBus: EventBus; logger: Logger }) {
    this.auditDir = join(deps.env.dataDir, 'agent-bus');
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;
  }

  destroy(): void {
    this.members.clear();
    this.inbox.clear();
    this.messages.length = 0;
    this.rootCounters.clear();
    this.counterRestored.clear();
    this.boards.clear();
  }

  register(input: RegisterAgentInput): AgentBusMember {
    const now = new Date().toISOString();
    const existing = this.members.get(input.sessionId);
    if (existing) {
      // upsert：保留已分配的 agentId / rootSessionId，避免 runner 预注册后引擎再注册改号
      const updated: AgentBusMember = {
        ...existing,
        kind: input.kind,
        template: input.template ?? existing.template,
        name: input.name,
        task: input.task.slice(0, MAX_TASK_CHARS),
        cwd: input.cwd,
        parentSessionId: input.parentSessionId ?? existing.parentSessionId,
        parentToolCallId: input.parentToolCallId ?? existing.parentToolCallId,
        parentAgentId: input.parentSessionId
          ? this.members.get(input.parentSessionId)?.agentId ?? existing.parentAgentId
          : existing.parentAgentId,
        depth: typeof input.depth === 'number' ? input.depth : existing.depth,
        status: 'running',
        startedAt: now,
        finishedAt: undefined,
        finishReason: undefined,
        error: undefined,
      };
      this.members.set(input.sessionId, updated);
      this.appendMemberLedger(updated);
      this.emitMember(updated);
      return updated;
    }

    const parent = input.parentSessionId ? this.members.get(input.parentSessionId) : undefined;
    const rootSessionId =
      parent?.rootSessionId ?? (input.kind === 'main' ? input.sessionId : input.parentSessionId ?? input.sessionId);
    this.ensureRootCounter(rootSessionId);
    const agentId = input.kind === 'main' ? 'main' : this.nextAgentId(rootSessionId);
    const member: AgentBusMember = {
      agentId,
      sessionId: input.sessionId,
      kind: input.kind,
      template: input.template,
      name: input.name,
      task: input.task.slice(0, MAX_TASK_CHARS),
      cwd: input.cwd,
      depth: typeof input.depth === 'number' ? input.depth : parent ? parent.depth + 1 : 0,
      parentSessionId: input.parentSessionId,
      parentAgentId: parent?.agentId,
      parentToolCallId: input.parentToolCallId,
      rootSessionId,
      status: 'running',
      startedAt: now,
    };
    this.members.set(input.sessionId, member);
    this.appendMemberLedger(member);
    this.emitMember(member);
    return member;
  }

  update(
    sessionId: string,
    patch: Partial<Pick<AgentBusMember, 'status' | 'finishedAt' | 'finishReason' | 'error'>>,
  ): void {
    const existing = this.members.get(sessionId);
    if (!existing) return;
    const updated: AgentBusMember = { ...existing, ...patch };
    this.members.set(sessionId, updated);
    this.appendMemberLedger(updated);
    // 子代理结束后清空其收件箱；主代理保留（result 消息等下一次 run 注入）
    if (updated.status !== 'running' && updated.kind === 'subagent') {
      this.inbox.delete(sessionId);
    }
    this.emitMember(updated);
  }

  get(sessionId: string): AgentBusMember | null {
    return this.members.get(sessionId) ?? null;
  }

  getByParentToolCall(toolCallId: string): AgentBusMember | null {
    if (!toolCallId) return null;
    for (const member of this.members.values()) {
      if (member.parentToolCallId === toolCallId) return member;
    }
    return null;
  }

  list(rootSessionId?: string): AgentBusMember[] {
    const all = [...this.members.values()].filter(
      (m) => !rootSessionId || m.rootSessionId === rootSessionId,
    );
    return all.sort(compareMembers);
  }

  send(input: SendAgentMessageInput): SendAgentMessageResult {
    const from = this.members.get(input.fromSessionId);
    if (!from) {
      return { delivered: 0, recipients: [], error: '发送方未注册到智能体总线' };
    }
    const content = input.content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!content) {
      return { delivered: 0, recipients: [], error: '消息内容不能为空' };
    }
    const kind = input.kind ?? 'chat';
    const resolved = this.resolveTargets(from, input.to, kind);
    if (typeof resolved === 'string') {
      return { delivered: 0, recipients: [], error: resolved };
    }
    if (resolved.length === 0) {
      return { delivered: 0, recipients: [], error: '没有可投递的目标智能体' };
    }

    const now = new Date().toISOString();
    // 频道广播：一条消息（toAgentId=null）投递到所有目标收件箱，面板只显示一条
    if (input.to === 'all') {
      const message: AgentBusMessage = {
        id: randomUUID(),
        rootSessionId: from.rootSessionId,
        fromAgentId: from.agentId,
        fromSessionId: from.sessionId,
        fromName: from.name,
        toAgentId: null,
        toSessionId: null,
        channel: `root:${from.rootSessionId}`,
        kind,
        content,
        createdAt: now,
        delivered: false,
      };
      this.pushMessage(message);
      for (const target of resolved) {
        this.enqueue(target.sessionId, message);
      }
      return { delivered: resolved.length, recipients: resolved };
    }

    const recipients: AgentBusMember[] = [];
    for (const target of resolved) {
      const message: AgentBusMessage = {
        id: randomUUID(),
        rootSessionId: target.rootSessionId,
        fromAgentId: from.agentId,
        fromSessionId: from.sessionId,
        fromName: from.name,
        toAgentId: target.agentId,
        toSessionId: target.sessionId,
        channel: `root:${target.rootSessionId}`,
        kind,
        content,
        createdAt: now,
        delivered: false,
      };
      this.pushMessage(message);
      this.enqueue(target.sessionId, message);
      recipients.push(target);
    }
    return { delivered: recipients.length, recipients };
  }

  drainInbox(sessionId: string): AgentBusMessage[] {
    const queued = this.inbox.get(sessionId);
    if (!queued || queued.length === 0) return [];
    this.inbox.delete(sessionId);
    for (const message of queued) message.delivered = true;
    return queued;
  }

  snapshot(rootSessionId?: string, opts?: { limit?: number }): AgentBusSnapshot {
    const limit = Math.max(1, Math.min(2000, opts?.limit ?? 500));
    const members = this.mergePersistedMembers(this.list(rootSessionId), rootSessionId);
    const byId = new Map<string, AgentBusMessage>();
    for (const message of this.messages) {
      if (rootSessionId && message.rootSessionId !== rootSessionId) continue;
      byId.set(message.id, message);
    }
    if (rootSessionId) {
      for (const message of this.readAudit(rootSessionId, limit)) {
        if (!byId.has(message.id)) byId.set(message.id, message);
      }
    } else {
      // 全量快照：按出现的 root 读取各自审计文件（最多 50 个 root，避免扫描失控）
      const roots = new Set<string>([
        ...this.messages.map((m) => m.rootSessionId),
        ...members.map((m) => m.rootSessionId),
      ]);
      for (const root of [...roots].slice(0, 50)) {
        for (const message of this.readAudit(root, limit)) {
          if (!byId.has(message.id)) byId.set(message.id, message);
        }
      }
    }
    const messages = [...byId.values()]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(-limit);
    return {
      members,
      messages,
      ...(rootSessionId
        ? { board: { rules: [...this.board(rootSessionId).rules] } }
        : {}),
    };
  }

  // --------------------------------------------------------------------------
  // 共享白板

  readBoard(rootSessionId: string): AgentBoardSnapshot {
    const state = this.board(rootSessionId);
    return {
      rootSessionId,
      rules: [...state.rules],
      discussion: state.discussion.slice(-BOARD_READ_DISCUSSION),
    };
  }

  postBoard(input: PostBoardNoteInput): PostBoardNoteResult {
    const from = this.members.get(input.fromSessionId);
    if (!from) return { delivered: 0, error: '发送方未注册到智能体总线' };
    const kind: AgentBoardNoteKind = input.kind === 'rule' ? 'rule' : 'discussion';
    const content = input.content.trim().slice(0, MAX_BOARD_CONTENT_CHARS);
    if (!content) return { delivered: 0, error: '白板内容不能为空' };
    const title = (input.title ?? '').trim().slice(0, 120);

    if (kind === 'rule' && from.kind !== 'main') {
      return { delivered: 0, error: '仅主代理可设定白板规则；子代理请使用 discussion 参与讨论' };
    }
    if (kind === 'rule' && !title) {
      return { delivered: 0, error: 'rule 需要 title（同标题会覆盖旧规则）' };
    }

    const state = this.board(from.rootSessionId);
    const now = new Date().toISOString();
    let note: AgentBoardNote;
    if (kind === 'rule') {
      const existing = state.rules.find((item) => item.title === title);
      if (existing) {
        note = {
          ...existing,
          content,
          authorAgentId: from.agentId,
          authorSessionId: from.sessionId,
          authorName: from.name,
          updatedAt: now,
        };
        state.rules = state.rules.map((item) => (item.id === existing.id ? note : item));
      } else {
        if (state.rules.length >= MAX_BOARD_RULES) {
          return {
            delivered: 0,
            error: `白板规则已达上限（${MAX_BOARD_RULES} 条），请先删除旧规则`,
          };
        }
        note = {
          id: randomUUID(),
          rootSessionId: from.rootSessionId,
          kind,
          title,
          content,
          authorAgentId: from.agentId,
          authorSessionId: from.sessionId,
          authorName: from.name,
          createdAt: now,
        };
        state.rules.push(note);
      }
    } else {
      note = {
        id: randomUUID(),
        rootSessionId: from.rootSessionId,
        kind,
        content,
        authorAgentId: from.agentId,
        authorSessionId: from.sessionId,
        authorName: from.name,
        createdAt: now,
      };
      state.discussion.push(note);
      if (state.discussion.length > MAX_BOARD_DISCUSSION) {
        state.discussion.splice(0, state.discussion.length - MAX_BOARD_DISCUSSION);
      }
    }

    this.saveBoard(from.rootSessionId, state);
    this.emitBoard('board', { note, rootSessionId: from.rootSessionId });
    const delivered = this.deliverBoardMessage(
      from,
      kind === 'rule' ? `[白板规则] ${title}：\n${content}` : `[白板讨论] ${content}`,
      kind,
    );
    return { note, delivered };
  }

  removeBoardNote(input: { fromSessionId: string; id: string }): { ok: boolean; error?: string } {
    const from = this.members.get(input.fromSessionId);
    if (!from) return { ok: false, error: '发送方未注册到智能体总线' };
    if (from.kind !== 'main') return { ok: false, error: '仅主代理可删除白板规则' };
    const state = this.board(from.rootSessionId);
    const target = state.rules.find((item) => item.id === input.id);
    if (!target) return { ok: false, error: `未找到白板规则 "${input.id}"` };
    state.rules = state.rules.filter((item) => item.id !== target.id);
    this.saveBoard(from.rootSessionId, state);
    this.emitBoard('board-removed', { rootSessionId: from.rootSessionId, id: target.id });
    this.deliverBoardMessage(
      from,
      `[白板规则已删除] ${target.title ?? target.id}`,
      'rule',
    );
    return { ok: true };
  }

  // --------------------------------------------------------------------------

  private nextAgentId(rootSessionId: string): string {
    const next = (this.rootCounters.get(rootSessionId) ?? 0) + 1;
    this.rootCounters.set(rootSessionId, next);
    return `a${next}`;
  }

  /** 从成员账本恢复 root 的 aN 序号（进程重启后新子代理不与历史成员重号） */
  private ensureRootCounter(rootSessionId: string): void {
    if (this.counterRestored.has(rootSessionId)) return;
    this.counterRestored.add(rootSessionId);
    const persisted = this.readMemberLedger(rootSessionId);
    let max = this.rootCounters.get(rootSessionId) ?? 0;
    for (const member of persisted) {
      const matched = /^a(\d+)$/.exec(member.agentId);
      if (matched) max = Math.max(max, Number(matched[1]));
    }
    this.rootCounters.set(rootSessionId, max);
  }

  /** 成员账本路径 */
  private memberLedgerPath(rootSessionId: string): string {
    return join(this.auditDir, `${safeFileName(rootSessionId)}.members.jsonl`);
  }

  /** 追加成员快照（只追加；读取时按 sessionId 取最后一条） */
  private appendMemberLedger(member: AgentBusMember): void {
    try {
      mkdirSync(this.auditDir, { recursive: true });
      appendFileSync(this.memberLedgerPath(member.rootSessionId), `${JSON.stringify(member)}\n`, 'utf8');
    } catch (err) {
      this.logger.warn('agent-bus: member ledger append failed', {
        rootSessionId: member.rootSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 读取成员账本：按 sessionId 去重（最后一条胜出） */
  private readMemberLedger(rootSessionId: string): AgentBusMember[] {
    try {
      const raw = readFileSync(this.memberLedgerPath(rootSessionId), 'utf8');
      const bySession = new Map<string, AgentBusMember>();
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as AgentBusMember;
          if (
            parsed &&
            typeof parsed.sessionId === 'string' &&
            typeof parsed.rootSessionId === 'string' &&
            typeof parsed.agentId === 'string' &&
            typeof parsed.status === 'string' &&
            typeof parsed.startedAt === 'string'
          ) {
            if (parsed.rootSessionId === rootSessionId) bySession.set(parsed.sessionId, parsed);
          }
        } catch {
          // 损坏行忽略
        }
      }
      return [...bySession.values()];
    } catch {
      return [];
    }
  }

  /**
   * 合并持久成员：内存优先；持久化 running 但内存不存在 = 上次进程退出时未收尾，
   * 投影为 aborted（只投影，不改写账本）。
   */
  private mergePersistedMembers(
    memoryMembers: AgentBusMember[],
    rootSessionId?: string,
  ): AgentBusMember[] {
    if (!rootSessionId) return memoryMembers;
    const bySession = new Map(memoryMembers.map((m) => [m.sessionId, m]));
    for (const persisted of this.readMemberLedger(rootSessionId)) {
      if (bySession.has(persisted.sessionId)) continue;
      bySession.set(
        persisted.sessionId,
        persisted.status === 'running'
          ? {
              ...persisted,
              status: 'aborted',
              finishReason: 'interrupted',
              error: '应用重启导致运行中断',
            }
          : persisted,
      );
    }
    return [...bySession.values()].sort(compareMembers);
  }

  /** 白板落盘路径 */
  private boardPath(rootSessionId: string): string {
    return join(this.auditDir, `${safeFileName(rootSessionId)}.board.json`);
  }

  /** 读取/缓存白板状态（文件损坏时降级为空板） */
  private board(rootSessionId: string): BoardState {
    const cached = this.boards.get(rootSessionId);
    if (cached) return cached;
    let state: BoardState = { rules: [], discussion: [] };
    try {
      const raw = readFileSync(this.boardPath(rootSessionId), 'utf8');
      const parsed = JSON.parse(raw) as { rules?: unknown; discussion?: unknown };
      state = {
        rules: Array.isArray(parsed.rules)
          ? parsed.rules.filter(isBoardNote).filter((n) => n.kind === 'rule')
          : [],
        discussion: Array.isArray(parsed.discussion)
          ? parsed.discussion.filter(isBoardNote).filter((n) => n.kind === 'discussion')
          : [],
      };
    } catch {
      // 文件不存在/损坏：空板
    }
    this.boards.set(rootSessionId, state);
    return state;
  }

  /** 原子写入白板（失败只告警，不影响内存态） */
  private saveBoard(rootSessionId: string, state: BoardState): void {
    try {
      mkdirSync(this.auditDir, { recursive: true });
      atomicWriteFile(this.boardPath(rootSessionId), JSON.stringify(state, null, 2));
    } catch (err) {
      this.logger.warn('agent-bus: board persist failed', {
        rootSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 广播白板事件（WS agent-bus.event） */
  private emitBoard(type: 'board' | 'board-removed', payload: Record<string, unknown>): void {
    void this.eventBus.broadcast('agent-bus:event', { type, ...payload });
  }

  /** 把白板变更实时投递给同 root 的其他成员；主代理即使空闲也保留留言（下次 run 注入） */
  private deliverBoardMessage(
    from: AgentBusMember,
    content: string,
    boardKind: AgentBoardNoteKind,
  ): number {
    const targets = [...this.members.values()].filter(
      (m) =>
        m.rootSessionId === from.rootSessionId &&
        m.sessionId !== from.sessionId &&
        (m.status === 'running' || m.kind === 'main'),
    );
    if (targets.length === 0) return 0;
    const message: AgentBusMessage = {
      id: randomUUID(),
      rootSessionId: from.rootSessionId,
      fromAgentId: from.agentId,
      fromSessionId: from.sessionId,
      fromName: from.name,
      toAgentId: null,
      toSessionId: null,
      channel: `board:${from.rootSessionId}`,
      kind: 'chat',
      content: content.slice(0, MAX_MESSAGE_CHARS),
      createdAt: new Date().toISOString(),
      delivered: false,
      boardKind,
    };
    this.pushMessage(message);
    for (const target of targets) this.enqueue(target.sessionId, message);
    return targets.length;
  }

  private resolveTargets(
    from: AgentBusMember,
    to: string,
    kind: 'chat' | 'result',
  ): AgentBusMember[] | string {
    const target = to.trim();
    if (!target) return '目标智能体不能为空';

    if (target === 'all') {
      return [...this.members.values()].filter(
        (m) =>
          m.rootSessionId === from.rootSessionId &&
          m.sessionId !== from.sessionId &&
          m.status === 'running',
      );
    }

    let resolved: AgentBusMember | undefined;
    if (target === 'parent') {
      resolved = from.parentSessionId ? this.members.get(from.parentSessionId) : undefined;
      if (!resolved) return '当前智能体没有可用的父代理';
    } else {
      // 只允许同一任务树内通信：sessionId 直查也必须校验 root，避免跨任务串话
      const direct = this.members.get(target);
      resolved =
        direct && direct.rootSessionId === from.rootSessionId
          ? direct
          : [...this.members.values()].find(
              (m) => m.rootSessionId === from.rootSessionId && m.agentId === target,
            );
      if (!resolved) {
        const available = this.list(from.rootSessionId)
          .filter((m) => m.sessionId !== from.sessionId)
          .map((m) => `${m.agentId}(${m.name})`)
          .join(', ');
        return `未找到目标智能体 "${target}"${available ? `；可用：${available}` : '；当前没有其他智能体'}`;
      }
    }

    if (resolved.sessionId === from.sessionId) {
      return '不能向自己发送消息';
    }
    // 父代理是特殊收件人：即使当前 run 已结束也允许留言，下一条用户消息开始时注入，
    // 保证 async 子代理的提问/汇报不会因父代理暂时空闲而丢失。
    if (kind === 'chat' && resolved.status !== 'running' && target !== 'parent') {
      return `目标智能体 ${resolved.agentId}(${resolved.name}) 未在运行（status=${resolved.status}）`;
    }
    return [resolved];
  }

  private enqueue(sessionId: string, message: AgentBusMessage): void {
    const list = this.inbox.get(sessionId);
    if (list) list.push(message);
    else this.inbox.set(sessionId, [message]);
  }

  private pushMessage(message: AgentBusMessage): void {
    this.messages.push(message);
    // 单 root 环形上限：避免长会话无限增长
    const sameRoot = this.messages.filter((m) => m.rootSessionId === message.rootSessionId);
    if (sameRoot.length > MAX_MESSAGES_PER_ROOT) {
      const drop = sameRoot.length - MAX_MESSAGES_PER_ROOT;
      let removed = 0;
      for (let i = 0; i < this.messages.length && removed < drop; i++) {
        if (this.messages[i].rootSessionId === message.rootSessionId) {
          this.messages.splice(i, 1);
          i--;
          removed++;
        }
      }
    }
    this.appendAudit(message);
    void this.eventBus.broadcast('agent-bus:event', {
      type: 'message',
      message,
      rootSessionId: message.rootSessionId,
    });
  }

  private emitMember(member: AgentBusMember): void {
    void this.eventBus.broadcast('agent-bus:event', {
      type: 'member',
      member,
      rootSessionId: member.rootSessionId,
    });
  }

  private auditPath(rootSessionId: string): string {
    return join(this.auditDir, `${safeFileName(rootSessionId)}.jsonl`);
  }

  private appendAudit(message: AgentBusMessage): void {
    try {
      mkdirSync(this.auditDir, { recursive: true });
      appendFileSync(this.auditPath(message.rootSessionId), `${JSON.stringify(message)}\n`, 'utf8');
    } catch (err) {
      this.logger.warn('agent-bus: audit append failed', {
        rootSessionId: message.rootSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private readAudit(rootSessionId: string, limit: number): AgentBusMessage[] {
    try {
      const raw = readFileSync(this.auditPath(rootSessionId), 'utf8');
      const lines = raw.split('\n').filter((line) => line.trim() !== '');
      const tail = lines.slice(-limit);
      const out: AgentBusMessage[] = [];
      for (const line of tail) {
        try {
          const parsed = JSON.parse(line) as AgentBusMessage;
          if (
            parsed &&
            typeof parsed.id === 'string' &&
            typeof parsed.content === 'string' &&
            typeof parsed.createdAt === 'string'
          ) {
            out.push(parsed);
          }
        } catch {
          // 损坏行忽略
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
