// src/modules/subagent/runner.ts
// SubagentRunner：一次性子代理运行服务（sync/async）。
// 职责：创建隐藏 subagent 会话（落盘 tasks/subagent/）、嵌套深度保护、
// 权限模式继承、中断级联（仅 sync）、子代理事件广播（subagent:event）、
// 多智能体总线注册与 async 结果回执。

import type { EventBus, Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AgentEngine, AgentEvent } from '../contracts';
import type { PermissionMode } from '../safety/types';
import type { ServerInstance } from '../server/types';
import type { AgentBus, AgentBusMember } from '../agent-bus/types';
import type { AgentRegistry } from './types';

/** subagent 隐藏分组固定 id（dir=subagent，平坦存放每次会话） */
const SUBAGENT_GROUP_ID = 'subagent';

/** 子代理最大嵌套深度（主=0 → 子=1 → 孙=2；再深直接拒绝，防止递归派发拖垮进程） */
const MAX_SUBAGENT_DEPTH = 2;

/** 子代理运行输入 */
export interface SubagentRunInput {
  /** 模板 agent id（或注册表任意 agent id） */
  template: string;
  task: string;
  cwd: string;
  /** 同步等待结果 / 后台运行（async 立即返回 agentId，结果通过总线回执） */
  mode?: 'sync' | 'async';
  permissionMode?: PermissionMode;
  /** 父会话中触发本次子代理的工具调用 id（前端卡片据此精确关联运行过程） */
  parentToolCallId?: string;
  /** 父会话 id（用于继承权限模式、计算嵌套深度、注册总线成员） */
  parentSessionId?: string;
  /** 父工具调用的中断信号（sync 停止主 run 时级联中止子代理；async 不继承） */
  signal?: AbortSignal;
}

/** 子代理运行输出（sync） */
export interface SubagentRunOutput {
  sessionId: string;
  taskId: string;
  finishReason: string;
  result: string;
}

/** 子代理启动输出（async） */
export interface SubagentStartOutput {
  agentId: string;
  sessionId: string;
  taskId: string;
  template: string;
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
   * 异步后台 subagent：立即返回 agentId/sessionId，不随父工具 signal 中断。
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
      status: 'running',
    };
    void this.execute(input, prepared, { forwardParentSignal: false }).catch((err) => {
      this.logger.warn('subagent: async run failed', {
        sessionId: prepared.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return output;
  }

  /** 取消一个后台/运行中的子代理（主代理 agent_status cancel） */
  stop(sessionId: string): boolean {
    const controller = this.activeRuns.get(sessionId);
    if (!controller) return false;
    controller.abort();
    this.bus()?.update(sessionId, { status: 'aborted', finishedAt: new Date().toISOString() });
    return true;
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

  /** 校验 + 创建隐藏任务 + 深度/权限/中断登记 */
  private prepare(input: SubagentRunInput): PreparedRun {
    if (!input.template?.trim()) throw new Error('template required');
    if (!input.task?.trim()) throw new Error('task required');

    // 嵌套深度保护：主会话 0 → 子代理 1 → 孙 2；再深拒绝。
    const parentDepth = input.parentSessionId
      ? this.sessionDepth.get(input.parentSessionId) ?? 0
      : 0;
    if (parentDepth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(
        `子代理嵌套层级已达上限（${MAX_SUBAGENT_DEPTH} 层）：拒绝在 depth=${parentDepth} 的会话上继续派发`,
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
    // headless 标记：子代理会话无人应答权限确认 → 短超时快速失败（见 engine.requestConfirm）
    this.engine.markSessionHeadless?.(task.id, true);
    // 权限继承：显式入参 → 父会话模式 → auto（父 skip 时子代理也不再弹无法应答的确认）
    const permissionMode: PermissionMode =
      input.permissionMode ??
      (input.parentSessionId ? this.engine.getPermissionMode?.(input.parentSessionId) : undefined) ??
      'auto';

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
    const forwardAbort = (): void => controller.abort();
    if (opts.forwardParentSignal && input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener('abort', forwardAbort, { once: true });
    }

    this.registerBusMember(input, prepared);

    try {
      const result = await this.engine.run({
        sessionId: taskId,
        agentId: input.template,
        userMessage: input.task,
        permissionMode,
        cwd: input.cwd,
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
        finishReason: result.finishReason,
        result: result.finalText,
      };
      if (input.mode === 'async') {
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
      if (input.mode === 'async') {
        this.sendResultToParent(input, taskId, `执行失败：${message}`, 'error');
      }
      throw err;
    } finally {
      if (opts.forwardParentSignal && input.signal) {
        input.signal.removeEventListener('abort', forwardAbort);
      }
      this.activeRuns.delete(taskId);
      this.sessionDepth.delete(taskId);
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
