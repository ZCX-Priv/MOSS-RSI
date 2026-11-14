// src/modules/subagent/runner.ts
// SubagentRunner：一次性子代理运行服务（sync/async）。
// 职责：创建隐藏 subagent 会话（落盘 tasks/subagent/）、嵌套深度保护、
// 权限模式继承、中断级联（sync 随工具调用；async 随父 run abort / 删除会话 / 手动终止）、
// 子代理事件广播（subagent:event）、多智能体总线注册与 async 结果回执。
// 生命周期：父 run 正常完成不终止 async（后台跑完并回执）；只有 abort/删除/手动终止才级联取消。

import type { ConfigService, EventBus, Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AgentEngine, AgentEvent } from '../contracts';
import type { PermissionMode } from '../safety/types';
import type { ServerInstance } from '../server/types';
import type { AgentBus, AgentBusMember } from '../agent-bus/types';
import type { AgentRegistry } from './types';

/** subagent 隐藏分组固定 id（dir=subagent，平坦存放每次会话） */
const SUBAGENT_GROUP_ID = 'subagent';

/** 子代理默认最大嵌套深度（配置缺失时的兜底；用户可在设置中调整） */
const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

/** 子代理运行输入 */
export interface SubagentRunInput {
  /** 模板 agent id（或注册表任意 agent id） */
  template: string;
  task: string;
  cwd: string;
  /** 同步等待结果 / 后台运行（async 立即返回 agentId，结果通过总线回执） */
  mode?: 'sync' | 'async';
  permissionMode?: PermissionMode;
  /** 本次运行的工具白名单覆盖（不传=模板配置；空数组等同不传） */
  toolAllowlist?: string[];
  /** 本次运行的最大轮数覆盖（0=不限制；不传=模板/全局配置） */
  maxTurns?: number;
  /** 父会话最近一条用户请求（仅用于帮助子代理理解目标，不扩大任务范围） */
  parentGoal?: string;
  /** 父会话中触发本次子代理的工具调用 id（前端卡片据此精确关联运行过程） */
  parentToolCallId?: string;
  /** 父会话 id（用于继承权限模式、计算嵌套深度、注册总线成员） */
  parentSessionId?: string;
  /**
   * 父 run 的中断信号。
   * sync / async 都继承：主 run 被 abort（用户停止 / 发送新消息打断）时级联中止；
   * 主 run 正常完成不会 abort，因此 async 子代理继续在后台跑完并回执。
   */
  signal?: AbortSignal;
}

/** 子代理运行输出（sync） */
export interface SubagentRunOutput {
  sessionId: string;
  taskId: string;
  /** 模板显示名（自定义 Agent 的名称；解析失败回退 id） */
  name: string;
  finishReason: string;
  result: string;
}

/** 子代理启动输出（async） */
export interface SubagentStartOutput {
  agentId: string;
  sessionId: string;
  taskId: string;
  template: string;
  /** 模板显示名（前端卡片直接展示，避免运行时新建的自定义 Agent 显示 id） */
  name: string;
  status: 'running';
}

interface PreparedRun {
  taskId: string;
  depth: number;
  controller: AbortController;
  permissionMode: PermissionMode;
}

export class SubagentRunner {
  private readonly engine: AgentEngine;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly services: ServiceRegistry;
  /** 进行中的子代理 run：sessionId → AbortController */
  private readonly activeRuns = new Map<string, AbortController>();
  /** 会话嵌套深度：sessionId → depth（主会话 0，子代理逐层 +1） */
  private readonly sessionDepth = new Map<string, number>();
  /** 因父级取消而中止的 async 子代理：不再向父会话投递过期 result 回执 */
  private readonly stoppedByParent = new Set<string>();

  constructor(deps: {
    engine: AgentEngine;
    eventBus: EventBus;
    logger: Logger;
    services: ServiceRegistry;
  }) {
    this.engine = deps.engine;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;
    this.services = deps.services;
  }

  destroy(): void {
    for (const controller of this.activeRuns.values()) {
      controller.abort();
    }
    this.activeRuns.clear();
    this.sessionDepth.clear();
  }

  /** 同步一次性 subagent：模板 agentId + 专属 session，阻塞返回结果 */
  async run(input: SubagentRunInput): Promise<SubagentRunOutput> {
    const prepared = this.prepare(input);
    const output = await this.execute(input, prepared, { forwardParentSignal: true });
    return output;
  }

  /**
   * 异步后台 subagent：立即返回 agentId/sessionId。
   * 父 run 正常完成不会 abort signal → 后台子代理继续跑完并回执；
   * 用户停止 / 打断发送会 abort 父 signal → 级联中止（见 execute 的 forwardParentSignal）。
   * 完成后通过 AgentBus 向父代理投递 result 消息（父代理下一轮注入）。
   */
  start(input: SubagentRunInput): SubagentStartOutput {
    const prepared = this.prepare(input);
    const member = this.registerBusMember(input, prepared);
    const output: SubagentStartOutput = {
      agentId: member?.agentId ?? '',
      sessionId: prepared.taskId,
      taskId: prepared.taskId,
      template: input.template,
      name: this.templateName(input.template),
      status: 'running',
    };
    void this.execute(input, prepared, { forwardParentSignal: true }).catch((err) => {
      this.logger.warn('subagent: async run failed', {
        sessionId: prepared.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return output;
  }

  /** 取消一个子代理及其全部后代（agent_status cancel / 前端单 Agent 终止按钮） */
  stop(sessionId: string): boolean {
    let stopped = false;
    const controller = this.activeRuns.get(sessionId);
    if (controller) {
      controller.abort();
      this.bus()?.update(sessionId, { status: 'aborted', finishedAt: new Date().toISOString() });
      stopped = true;
    }
    // 递归后代：终止父节点后不能让孙代理成为孤儿
    for (const child of this.runningChildren(sessionId)) {
      if (this.stop(child.sessionId)) stopped = true;
    }
    return stopped;
  }

  /**
   * 取消整个任务树下所有运行中的子代理（删除会话等场景）。
   * 只对「父节点不在待取消集合中」的根节点调用 stop（stop 自带后代递归），
   * 避免同一成员被重复 abort/广播。返回实际发出取消的成员数量。
   */
  cancelTree(rootSessionId: string): number {
    const bus = this.bus();
    if (!bus) return 0;
    const running = bus
      .list(rootSessionId)
      .filter((m) => m.kind === 'subagent' && m.status === 'running');
    const runningIds = new Set(running.map((m) => m.sessionId));
    let count = 0;
    for (const member of running) {
      // 父节点也在取消集合中 → 由父节点的 stop 递归处理
      if (member.parentSessionId && runningIds.has(member.parentSessionId)) continue;
      if (this.stop(member.sessionId)) count += 1;
    }
    return count;
  }

  /** 某成员直接派生的、仍在运行的后代 */
  private runningChildren(sessionId: string): AgentBusMember[] {
    const bus = this.bus();
    if (!bus) return [];
    return bus
      .list()
      .filter(
        (m) =>
          m.kind === 'subagent' &&
          m.status === 'running' &&
          m.parentSessionId === sessionId,
      );
  }

  status(sessionId: string): AgentBusMember | null {
    return this.bus()?.get(sessionId) ?? null;
  }

  /** 当前任务树的全部成员（含主代理；root 缺省时按 sessionId 解析 root） */
  list(rootSessionId?: string): AgentBusMember[] {
    const bus = this.bus();
    if (!bus) return [];
    if (rootSessionId) return bus.list(rootSessionId);
    return bus.list();
  }

  // --------------------------------------------------------------------------

  private bus(): AgentBus | null {
    return this.services.tryResolve<AgentBus>(ServiceNames.AGENT_BUS);
  }

  /** 实时读取子代理最大嵌套层级（设置热更新立即生效） */
  private maxSubagentDepth(): number {
    try {
      const config = this.services.tryResolve<ConfigService>(ServiceNames.CONFIG_SERVICE);
      const value = config?.getAppConfig().agent.maxSubagentDepth;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
        return Math.min(5, Math.floor(value));
      }
    } catch {
      // 配置不可用：使用默认值
    }
    return DEFAULT_MAX_SUBAGENT_DEPTH;
  }

  /** 校验 + 创建隐藏任务 + 深度/权限/中断登记 */
  private prepare(input: SubagentRunInput): PreparedRun {
    if (!input.template?.trim()) throw new Error('template required');
    if (!input.task?.trim()) throw new Error('task required');

    // 嵌套深度保护：主会话 0 → 子代理 1 → 孙 2；上限由设置实时读取。
    const maxDepth = this.maxSubagentDepth();
    const parentDepth = input.parentSessionId
      ? this.sessionDepth.get(input.parentSessionId) ?? 0
      : 0;
    if (parentDepth >= maxDepth) {
      throw new Error(
        `子代理嵌套层级已达上限（${maxDepth} 层）：拒绝在 depth=${parentDepth} 的会话上继续派发。可在「设置 → 智能体」中调整最大嵌套层级。`,
      );
    }

    const group = this.ensureSubagentGroup();
    const task = this.engine.createTask(`Subagent · ${input.template}`, group.id);
    const depth = parentDepth + 1;
    this.sessionDepth.set(task.id, depth);

    this.logger.info('subagent: run', {
      template: input.template,
      taskId: task.id,
      depth,
      mode: input.mode ?? 'sync',
    });

    const controller = new AbortController();
    // headless 标记：子代理会话无人直接应答，但权限确认会汇总到主会话中控岛（带来源）。
    this.engine.markSessionHeadless?.(task.id, true);
    // 权限继承：显式入参 → 父会话模式 → auto；且子代理权限不得超过父会话（不可提升）。
    const RANK: Record<PermissionMode, number> = { skip: 0, auto: 1, ask: 2 };
    const parentMode = input.parentSessionId
      ? this.engine.getPermissionMode?.(input.parentSessionId)
      : undefined;
    const requested = input.permissionMode ?? parentMode ?? 'auto';
    const permissionMode: PermissionMode =
      parentMode && RANK[requested] < RANK[parentMode] ? parentMode : requested;

    this.activeRuns.set(task.id, controller);
    this.registerExternalRun(task.id, controller);

    return { taskId: task.id, depth, controller, permissionMode };
  }

  /** 实际执行：注册总线、运行引擎、清理、async 结果回执 */
  private async execute(
    input: SubagentRunInput,
    prepared: PreparedRun,
    opts: { forwardParentSignal: boolean },
  ): Promise<SubagentRunOutput> {
    const { taskId, depth, controller, permissionMode } = prepared;
    // 父 run 被 abort（用户停止 / 打断发送）→ 立即级联中止；标记后不再向父会话投递过期回执
    const forwardAbort = (): void => {
      this.stoppedByParent.add(taskId);
      controller.abort();
    };
    if (opts.forwardParentSignal && input.signal) {
      if (input.signal.aborted) forwardAbort();
      else input.signal.addEventListener('abort', forwardAbort, { once: true });
    }

    this.registerBusMember(input, prepared);

    try {
      // 父任务目标只用于理解上下文，明确标注「不是本次任务范围」，避免子代理扩大范围。
      const userMessage = input.parentGoal?.trim()
        ? `父任务目标（仅用于理解上下文，不是本次任务范围）：\n${input.parentGoal.trim()}\n\n任务：\n${input.task}`
        : input.task;
      const result = await this.engine.run({
        sessionId: taskId,
        agentId: input.template,
        userMessage,
        permissionMode,
        cwd: input.cwd,
        ...(input.toolAllowlist ? { toolAllowlist: input.toolAllowlist } : {}),
        ...(typeof input.maxTurns === 'number' ? { maxTurns: input.maxTurns } : {}),
        bus: {
          kind: 'subagent',
          template: input.template,
          name: this.templateName(input.template),
          parentSessionId: input.parentSessionId,
          parentToolCallId: input.parentToolCallId,
          taskSummary: input.task,
          depth,
        },
        onEvent: (event: AgentEvent) => {
          void this.eventBus.broadcast('subagent:event', {
            taskId,
            ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
            event,
          });
        },
        signal: controller.signal,
      });
      const output: SubagentRunOutput = {
        sessionId: taskId,
        taskId,
        name: this.templateName(input.template),
        finishReason: result.finishReason,
        result: result.finalText,
      };
      if (input.mode === 'async' && !this.stoppedByParent.has(taskId)) {
        this.sendResultToParent(input, taskId, result.finalText, result.finishReason);
      }
      return output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.bus()?.update(taskId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
      });
      if (input.mode === 'async' && !this.stoppedByParent.has(taskId)) {
        this.sendResultToParent(input, taskId, `执行失败：${message}`, 'error');
      }
      throw err;
    } finally {
      if (opts.forwardParentSignal && input.signal) {
        input.signal.removeEventListener('abort', forwardAbort);
      }
      this.activeRuns.delete(taskId);
      this.sessionDepth.delete(taskId);
      this.stoppedByParent.delete(taskId);
      this.unregisterExternalRun(taskId, controller);
    }
  }

  private registerBusMember(
    input: SubagentRunInput,
    prepared: PreparedRun,
  ): AgentBusMember | null {
    const bus = this.bus();
    if (!bus) return null;
    return bus.register({
      sessionId: prepared.taskId,
      kind: 'subagent',
      template: input.template,
      name: this.templateName(input.template),
      task: input.task,
      cwd: input.cwd,
      parentSessionId: input.parentSessionId,
      parentToolCallId: input.parentToolCallId,
      depth: prepared.depth,
    });
  }

  private sendResultToParent(
    input: SubagentRunInput,
    taskId: string,
    content: string,
    finishReason: string,
  ): void {
    const bus = this.bus();
    if (!bus || !input.parentSessionId) return;
    const text = content.trim() || '（子代理无输出）';
    const result = bus.send({
      fromSessionId: taskId,
      to: 'parent',
      kind: 'result',
      content: `完成原因=${finishReason}\n\n${text}`,
    });
    if (result.error) {
      this.logger.warn('subagent: result delivery failed', {
        taskId,
        error: result.error,
      });
    }
  }

  private templateName(template: string): string {
    const registry = this.services.tryResolve<AgentRegistry>(ServiceNames.AGENT_REGISTRY);
    return registry?.get(template)?.name || template;
  }

  /** 获取/创建 subagent 隐藏分组（id='subagent'，dir=subagent，hidden；平坦存放每次会话） */
  private ensureSubagentGroup(): { id: string } {
    const groups = this.engine.listTaskGroups();
    const existing = groups.find((g) => g.id === SUBAGENT_GROUP_ID);
    if (existing) return existing;
    return this.engine.createTaskGroup('Subagent', 'manual', {
      id: SUBAGENT_GROUP_ID,
      dir: 'subagent',
      hidden: true,
    });
  }

  /** 注册外部活跃 run（前端任务页 running 判定 / task.abort 可中断） */
  private registerExternalRun(sessionId: string, controller: AbortController): void {
    const server = this.services.tryResolve<ServerInstance>(ServiceNames.SERVER_INSTANCE);
    server?.registerExternalRun(sessionId, controller);
  }

  /** 注销外部活跃 run */
  private unregisterExternalRun(sessionId: string, controller: AbortController): void {
    const server = this.services.tryResolve<ServerInstance>(ServiceNames.SERVER_INSTANCE);
    server?.unregisterExternalRun(sessionId, controller);
  }
}
