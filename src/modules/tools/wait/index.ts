// src/modules/tools/wait/index.ts
// wait 工具执行入口：纯时间等待、条件等待、时间+条件组合。
//
// 语义：
// - 纯时间：睡满窗口后返回 satisfied；
// - 纯条件：条件满足即返回，到达默认上限仍未满足 → timedOut；
// - 时间+条件：两者都满足才返回；到达时间点仍未满足 → timedOut（正常返回，不报错）；
// - 用户停止（ctx.signal）→ aborted（正常返回，不报错）。
//
// 条件判定依赖四个服务：server.instance（会话运行态）、agent.engine（会话存在性/工具调用状态）、
// terminal.service（命令忙闲）、agent.bus（智能体运行状态）。目标在启动时校验，已结束的目标视为已满足。

import type { ToolContext, ToolResult } from '../types';
import { errorResult } from '../types';
import { ServiceNames } from '../../../core/types';
import type { ServerInstanceLike } from '../../contracts';
import type { TerminalService } from '../../terminal/types';
import type { AgentBus, AgentBusMember } from '../../agent-bus/types';
import {
  WAIT_LIMITS,
  judgeConditions,
  normalizeConditions,
  resolveWindow,
  type NormalizedCondition,
  type ResolvedWindow,
  type WaitMatch,
  type WaitTimeInput,
} from './logic';

/** agent 引擎中 wait 需要的最小能力（结构类型，避免跨模块强依赖） */
interface AgentEngineLike {
  getTask?: (id: string) => unknown;
  getLiveDraft?: (sessionId: string) => { toolCalls?: Array<{ id: string; status: string }> } | null;
}

interface WaitParams {
  time?: WaitTimeInput;
  conditions?: unknown;
  match?: string;
  quiet?: boolean;
}

interface Deps {
  server: ServerInstanceLike | null;
  engine: AgentEngineLike | null;
  terminal: TerminalService | null;
  bus: AgentBus | null;
}

interface ConditionState {
  index: number;
  kind: NormalizedCondition['kind'];
  target: string;
  satisfied: boolean;
  detail: string;
}

type Outcome = 'satisfied' | 'timedOut' | 'aborted';

const DEFAULTS = {
  defaultTimeoutMs: 600_000,
  maxTimeoutMs: WAIT_LIMITS.maxDurationMs,
  pollIntervalMs: 1_000,
  progressIntervalMs: 10_000,
  maxConditions: 16,
} as const;

/** 读取工具配置中的整数（越界钳制，非法回退默认值） */
function readInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function resolveDeps(ctx: ToolContext): Deps {
  return {
    server: ctx.services.tryResolve<ServerInstanceLike>(ServiceNames.SERVER_INSTANCE),
    engine: ctx.services.tryResolve<AgentEngineLike>(ServiceNames.AGENT_ENGINE),
    terminal: ctx.services.tryResolve<TerminalService>(ServiceNames.TERMINAL),
    bus: ctx.services.tryResolve<AgentBus>(ServiceNames.AGENT_BUS),
  };
}

/** wait 的 root 任务树（当前会话未注册总线时以自身为 root） */
function resolveRoot(ctx: ToolContext, deps: Deps): string {
  return deps.bus?.get(ctx.sessionId)?.rootSessionId ?? ctx.sessionId;
}

/**
 * 解析 agent 条件的目标成员：
 * - root 限定在当前任务树内（跨树不匹配）；
 * - agentId 优先，其次 sessionId。
 */
function findAgentMember(
  bus: AgentBus,
  root: string,
  condition: Extract<NormalizedCondition, { kind: 'agent' }>,
): AgentBusMember | null {
  const members = bus.list(root);
  if (condition.agentId) {
    const byAgentId = members.find((m) => m.agentId === condition.agentId);
    if (byAgentId) return byAgentId;
  }
  if (condition.sessionId) {
    return members.find((m) => m.sessionId === condition.sessionId) ?? null;
  }
  return null;
}

/**
 * 启动校验：目标存在、条件结构合法、禁止自等。
 * 返回 null 表示通过；返回字符串表示错误原因。
 */
function validateTargets(conditions: NormalizedCondition[], ctx: ToolContext, deps: Deps): string | null {
  if (conditions.length === 0) return null;

  const needsSession = conditions.some((c) => c.kind === 'session' || c.kind === 'tool');
  if (needsSession) {
    if (!deps.server || typeof deps.server.isSessionRunning !== 'function') {
      return '会话运行态服务不可用（server.instance 未就绪）';
    }
    if (!deps.engine || typeof deps.engine.getTask !== 'function') {
      return '会话存储服务不可用（agent.engine 未暴露 getTask）';
    }
  }
  if (conditions.some((c) => c.kind === 'tool') && (!deps.engine || typeof deps.engine.getLiveDraft !== 'function')) {
    return '工具调用状态服务不可用（agent.engine 未暴露 getLiveDraft）';
  }

  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];

    if (c.kind === 'agent') {
      if (!deps.bus) return `conditions[${i}] 智能体总线不可用（agent.bus 未就绪）`;
      const root = resolveRoot(ctx, deps);
      const member = findAgentMember(deps.bus, root, c);
      if (!member) {
        const target = [c.agentId, c.sessionId].filter(Boolean).join('/');
        return `conditions[${i}] 未找到智能体「${target}」（root=${root}）`;
      }
      if (member.sessionId === ctx.sessionId) {
        return `conditions[${i}] 不能等待当前会话自身（会死锁）；请等待其它智能体`;
      }
      continue;
    }

    if (c.kind === 'session') {
      if (c.sessionId === ctx.sessionId) {
        return `conditions[${i}] 不能等待当前会话自身（会死锁）；请在 run_code 内并发等待其他会话，或改用 terminal 条件`;
      }
      if (deps.engine!.getTask!(c.sessionId) == null) {
        return `conditions[${i}] 目标会话不存在：${c.sessionId}`;
      }
      continue;
    }

    if (c.kind === 'terminal') {
      if (!deps.terminal) return '终端服务不可用（terminal.service 未就绪）';
      let terminalId = c.terminalId;
      if (!terminalId) {
        const fallback = deps.terminal.getDefaultId(c.sessionId);
        if (!fallback) {
          return `conditions[${i}] 会话 ${c.sessionId} 没有默认终端；请先创建终端或显式提供 terminalId`;
        }
        terminalId = fallback;
        c.terminalId = terminalId;
      }
      if (!deps.terminal.get(terminalId)) {
        return `conditions[${i}] 目标终端不存在：${terminalId}`;
      }
      continue;
    }

    // tool
    if (c.sessionId === ctx.sessionId && c.toolCallId === ctx.toolCallId) {
      return `conditions[${i}] 不能等待当前工具调用自身（会死锁）`;
    }
    if (deps.engine!.getTask!(c.sessionId) == null) {
      return `conditions[${i}] 目标会话不存在：${c.sessionId}`;
    }
  }

  return null;
}

/** 逐条件评估当前状态 */
function evaluateConditions(conditions: NormalizedCondition[], ctx: ToolContext, deps: Deps): ConditionState[] {
  return conditions.map((c, index) => {
    if (c.kind === 'agent') {
      const target = [c.agentId, c.sessionId].filter(Boolean).join('/');
      if (!deps.bus) {
        return { index, kind: c.kind, target, satisfied: true, detail: '总线不可用，视为已结束' };
      }
      const member = findAgentMember(deps.bus, resolveRoot(ctx, deps), c);
      if (!member) {
        return { index, kind: c.kind, target, satisfied: true, detail: '智能体已结束（总线中不存在）' };
      }
      const running = member.status === 'running';
      return {
        index,
        kind: c.kind,
        target: `${member.agentId}(${member.sessionId})`,
        satisfied: !running,
        detail: running ? '当前状态 running' : `已结束（${member.status}）`,
      };
    }

    if (c.kind === 'session') {
      const running = deps.server?.isSessionRunning?.(c.sessionId) ?? false;
      return {
        index,
        kind: c.kind,
        target: c.sessionId,
        satisfied: !running,
        detail: running ? '仍在运行' : '已结束',
      };
    }

    if (c.kind === 'terminal') {
      const terminalId = c.terminalId ?? '';
      const busy = terminalId ? (deps.terminal?.isCommandRunning(terminalId) ?? false) : false;
      return {
        index,
        kind: c.kind,
        target: terminalId || '(未解析)',
        satisfied: !busy,
        detail: busy ? '命令执行中' : '命令已结束',
      };
    }

    // tool：目标会话已结束 → 视为该工具已结束
    const running = deps.server?.isSessionRunning?.(c.sessionId) ?? false;
    const target = `${c.sessionId}/${c.toolCallId}`;
    if (!running) {
      return { index, kind: c.kind, target, satisfied: true, detail: '会话已结束' };
    }
    const draft = deps.engine?.getLiveDraft?.(c.sessionId) ?? null;
    const toolCall = draft?.toolCalls?.find((x) => x.id === c.toolCallId);
    const done = toolCall?.status === 'done';
    return {
      index,
      kind: c.kind,
      target,
      satisfied: done,
      detail: toolCall ? `当前状态 ${toolCall.status}` : '当前草稿中尚未出现该工具调用',
    };
  });
}

/** 可中断的等待：signal 触发时立即返回 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function formatSeconds(ms: number): string {
  return (Math.max(0, ms) / 1_000).toFixed(1);
}

/** 构造最终结果（文本摘要 + 结构化 metadata；三种结局都不是错误） */
function buildResult(
  outcome: Outcome,
  startedAt: number,
  now: number,
  match: WaitMatch,
  window: ResolvedWindow,
  timeGiven: boolean,
  timeDone: boolean,
  states: ConditionState[],
  defaultLimitMs: number,
): ToolResult {
  const elapsedMs = Math.max(0, now - startedAt);
  const outcomeLabel = outcome === 'satisfied' ? '已满足' : outcome === 'timedOut' ? '已超时' : '已中止';
  const lines: string[] = [`等待结果：${outcomeLabel}（耗时 ${formatSeconds(elapsedMs)}s）`];

  if (timeGiven) {
    lines.push(`时间条件：${timeDone ? '已到达' : '未到达'}（目标 ${new Date(window.endAt).toISOString()}）`);
  } else if (states.length > 0) {
    lines.push(`等待窗口：未指定时间，使用默认上限 ${(defaultLimitMs / 60_000).toFixed(0)} 分钟`);
  }

  if (states.length > 0) {
    const pending = states.filter((s) => !s.satisfied);
    lines.push(`条件组合：${match}；已满足 ${states.length - pending.length}/${states.length}`);
    for (const s of states) {
      lines.push(`- [${s.kind}] ${s.target}：${s.satisfied ? '已满足' : '未满足'}（${s.detail}）`);
    }
    if (outcome === 'timedOut' && pending.length > 0) {
      lines.push(`未满足条件：${pending.length} 项`);
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    metadata: {
      outcome,
      elapsedMs,
      match,
      timedOut: outcome === 'timedOut',
      aborted: outcome === 'aborted',
      window: { kind: window.kind, endAt: new Date(window.endAt).toISOString() },
      conditions: states.map((s) => ({
        index: s.index,
        kind: s.kind,
        target: s.target,
        satisfied: s.satisfied,
        detail: s.detail,
      })),
    },
  };
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = (params ?? {}) as WaitParams;
    const cfg = ctx.toolConfig ?? {};
    const defaultTimeoutMs = readInt(cfg.defaultTimeoutMs, DEFAULTS.defaultTimeoutMs, 1_000, WAIT_LIMITS.maxDurationMs);
    const maxTimeoutMs = readInt(cfg.maxTimeoutMs, DEFAULTS.maxTimeoutMs, 1_000, WAIT_LIMITS.maxDurationMs);
    const pollIntervalMs = readInt(cfg.pollIntervalMs, DEFAULTS.pollIntervalMs, 100, 10_000);
    const progressIntervalMs = readInt(cfg.progressIntervalMs, DEFAULTS.progressIntervalMs, 1_000, 600_000);
    const maxConditions = readInt(cfg.maxConditions, DEFAULTS.maxConditions, 1, 64);
    const match: WaitMatch = p.match === 'any' ? 'any' : 'all';
    const quiet = p.quiet === true;

    const timeGiven =
      (typeof p.time?.duration === 'string' && p.time.duration.trim() !== '') ||
      (typeof p.time?.until === 'string' && p.time.until.trim() !== '');

    const normalized = normalizeConditions(p.conditions, { sessionId: ctx.sessionId, maxConditions });
    if (!normalized.ok) return errorResult(normalized.error);
    const conditions = normalized.value;

    if (!timeGiven && conditions.length === 0) {
      return errorResult('必须提供 time（duration 或 until）或 conditions 至少一项');
    }

    const startedAt = Date.now();
    const windowResult = resolveWindow(p.time, startedAt, defaultTimeoutMs, maxTimeoutMs);
    if (!windowResult.ok) return errorResult(windowResult.error);
    const window = windowResult.value;

    const timePast = timeGiven && window.endAt <= startedAt;
    // 硬上限（30 分钟）与条件等待的兜底截止
    const hardEndAt = startedAt + WAIT_LIMITS.maxDurationMs;
    const condDeadline = Math.min(timePast || !timeGiven ? startedAt + defaultTimeoutMs : window.endAt, hardEndAt);

    const deps = resolveDeps(ctx);
    const invalid = validateTargets(conditions, ctx, deps);
    if (invalid) return errorResult(invalid);

    let lastProgress = startedAt;

    while (true) {
      const now = Date.now();
      const states = evaluateConditions(conditions, ctx, deps);
      const condDone = judgeConditions(states.map((s) => s.satisfied), match);
      const timeDone = timeGiven ? timePast || now >= window.endAt : true;

      if (ctx.signal?.aborted) {
        return buildResult('aborted', startedAt, now, match, window, timeGiven, timeDone, states, defaultTimeoutMs);
      }

      if (conditions.length === 0) {
        if (timeDone) {
          return buildResult('satisfied', startedAt, now, match, window, timeGiven, timeDone, states, defaultTimeoutMs);
        }
      } else if (condDone && timeDone) {
        return buildResult('satisfied', startedAt, now, match, window, timeGiven, timeDone, states, defaultTimeoutMs);
      }

      const deadline = conditions.length === 0 ? window.endAt : condDeadline;
      if (now >= Math.min(deadline, hardEndAt)) {
        if (conditions.length === 0) {
          // 兜底：纯时间窗口已到（正常路径已在上方返回）
          return buildResult('satisfied', startedAt, now, match, window, timeGiven, timeDone, states, defaultTimeoutMs);
        }
        return buildResult('timedOut', startedAt, now, match, window, timeGiven, timeDone, states, defaultTimeoutMs);
      }

      if (!quiet && now - lastProgress >= progressIntervalMs) {
        lastProgress = now;
        const pending = states.filter((s) => !s.satisfied).length;
        ctx.emit({
          type: 'progress',
          message: `等待中（已 ${(Math.max(0, now - startedAt) / 1_000).toFixed(0)}s）${
            conditions.length > 0 ? `，未满足 ${pending} 项条件` : ''
          }`,
        });
      }

      const waitMs = Math.max(1, Math.min(pollIntervalMs, Math.min(deadline, hardEndAt) - now));
      await sleep(waitMs, ctx.signal);
    }
  },
};
