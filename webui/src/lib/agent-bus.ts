// webui/src/lib/agent-bus.ts
// 多智能体总线的前端实时态：成员（按 sessionId）+ 消息（按 id）+ 父工具调用绑定。
//
// 用途：
// - SubagentCard 按 parentToolCallId 精确取运行状态（async 后台运行不依赖工具结果）；
// - 任务页「智能体」标签与 REST 快照合并展示。
// 本模块只保存可展示状态，不承担请求逻辑。

import type { AgentBusMember, AgentBusMessage } from '../types/api';

const membersBySession = new Map<string, AgentBusMember>();
/** parentToolCallId → sessionId（同一时刻一个工具调用只对应一个子代理） */
const sessionByParentToolCall = new Map<string, string>();
const messagesById = new Map<string, AgentBusMessage>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // 单个监听异常不影响其他订阅者
    }
  }
}

/** 应用成员更新（同状态且无新信息的重复事件直接忽略，避免高频重渲染） */
export function applyAgentBusMember(member: AgentBusMember): void {
  const prev = membersBySession.get(member.sessionId);
  if (
    prev &&
    prev.status === member.status &&
    prev.finishedAt === member.finishedAt &&
    prev.task === member.task &&
    prev.name === member.name
  ) {
    return;
  }
  membersBySession.set(member.sessionId, member);
  if (member.parentToolCallId) {
    sessionByParentToolCall.set(member.parentToolCallId, member.sessionId);
  }
  notify();
}

/** 应用消息（按 id 去重；上限 1000 条，超出丢弃最旧） */
export function applyAgentBusMessage(message: AgentBusMessage): void {
  if (messagesById.has(message.id)) return;
  messagesById.set(message.id, message);
  if (messagesById.size > 1000) {
    const oldest = messagesById.keys().next().value;
    if (typeof oldest === 'string') messagesById.delete(oldest);
  }
  notify();
}

/** REST 快照水合（只补成员；消息由面板自行合并） */
export function hydrateAgentBus(members: AgentBusMember[]): void {
  let changed = false;
  for (const member of members) {
    const prev = membersBySession.get(member.sessionId);
    if (!prev || prev.status !== member.status || prev.finishedAt !== member.finishedAt) {
      membersBySession.set(member.sessionId, member);
      if (member.parentToolCallId) {
        sessionByParentToolCall.set(member.parentToolCallId, member.sessionId);
      }
      changed = true;
    }
  }
  if (changed) notify();
}

export function getAgentBySessionId(sessionId: string): AgentBusMember | undefined {
  return membersBySession.get(sessionId);
}

export function getAgentByParentToolCall(toolCallId: string): AgentBusMember | undefined {
  const sessionId = sessionByParentToolCall.get(toolCallId);
  return sessionId ? membersBySession.get(sessionId) : undefined;
}

/** 当前已知成员（可按 root 过滤；按 depth/开始时间排序） */
export function listAgentBusMembers(rootSessionId?: string): AgentBusMember[] {
  return [...membersBySession.values()]
    .filter((m) => !rootSessionId || m.rootSessionId === rootSessionId)
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return Date.parse(a.startedAt) - Date.parse(b.startedAt);
    });
}

/** 当前已知消息（可按 root 过滤；时间升序） */
export function listAgentBusMessages(rootSessionId?: string): AgentBusMessage[] {
  return [...messagesById.values()]
    .filter((m) => !rootSessionId || m.rootSessionId === rootSessionId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** useSyncExternalStore 的 getSnapshot：版本号变化触发订阅者重渲染 */
export function getAgentBusVersion(): number {
  return version;
}

export function subscribeAgentBus(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
