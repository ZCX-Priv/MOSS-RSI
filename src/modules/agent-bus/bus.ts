// src/modules/agent-bus/bus.ts
// AgentBus 实现：成员树 + 收件箱 + 频道广播 + JSONL 审计。
//
// 设计边界：
// - 单进程内存态；完成/失败成员保留供 WebUI 面板回看，进程重启后由新 run 重建。
// - 消息审计落盘 ~/.moss/agent-bus/<rootSessionId>.jsonl（同步小写入，失败只告警）。
// - `send` 只保证「投递到收件箱」，不保证目标已消费；引擎在 run 开始/每轮工具后 drain。
// - 事件通过 EventBus `agent-bus:event` 广播，server 转发为 WS `agent-bus.event`。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventBus, Environment, Logger } from '../../core/types';
import type {
  AgentBus,
  AgentBusMember,
  AgentBusMessage,
  AgentBusSnapshot,
  RegisterAgentInput,
  SendAgentMessageInput,
  SendAgentMessageResult,
} from './types';

const MAX_TASK_CHARS = 200;
const MAX_MESSAGE_CHARS = 8000;
const MAX_MESSAGES_PER_ROOT = 500;

/** 审计文件名安全化（sessionId 由内部生成，仍防御异常字符） */
function safeFileName(id: string): string {
  return id.replace(/[^0-9a-zA-Z._-]/g, '_');
}

export class AgentBusImpl implements AgentBus {
  private readonly members = new Map<string, AgentBusMember>();
  private readonly inbox = new Map<string, AgentBusMessage[]>();
  private readonly messages: AgentBusMessage[] = [];
  private readonly rootCounters = new Map<string, number>();
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
      this.emitMember(updated);
      return updated;
    }

    const parent = input.parentSessionId ? this.members.get(input.parentSessionId) : undefined;
    const rootSessionId =
      parent?.rootSessionId ?? (input.kind === 'main' ? input.sessionId : input.parentSessionId ?? input.sessionId);
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
    return all.sort((a, b) => {
      if (a.rootSessionId !== b.rootSessionId) return a.rootSessionId < b.rootSessionId ? -1 : 1;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return Date.parse(a.startedAt) - Date.parse(b.startedAt);
    });
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
    const members = this.list(rootSessionId);
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
    return { members, messages };
  }

  // --------------------------------------------------------------------------

  private nextAgentId(rootSessionId: string): string {
    const next = (this.rootCounters.get(rootSessionId) ?? 0) + 1;
    this.rootCounters.set(rootSessionId, next);
    return `a${next}`;
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
    if (kind === 'chat' && resolved.status !== 'running') {
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
