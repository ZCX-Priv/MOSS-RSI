// src/modules/subagent/runner.ts
// SubagentRunner：一次性子代理运行服务。
// 职责：创建隐藏 subagent 会话（落盘 tasks/subagent/）、嵌套深度保护、
// 权限模式继承、中断级联、子代理事件广播（subagent:event）。

import type { EventBus, Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AgentEngine, AgentEvent } from '../contracts';
import type { PermissionMode } from '../safety/types';
import type { ServerInstance } from '../server/types';

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
  permissionMode?: PermissionMode;
  /** 父会话中触发本次子代理的工具调用 id（前端卡片据此精确关联运行过程） */
  parentToolCallId?: string;
  /** 父会话 id（用于继承权限模式、计算嵌套深度） */
  parentSessionId?: string;
  /** 父工具调用的中断信号（停止主 run 时级联中止子代理） */
  signal?: AbortSignal;
}

/** 子代理运行输出 */
export interface SubagentRunOutput {
  sessionId: string;
  taskId: string;
  finishReason: string;
  result: string;
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

  /** 一次性 subagent：模板 agentId + 专属 session，同步返回结果 */
  async run(input: SubagentRunInput): Promise<SubagentRunOutput> {
    if (!input.template?.trim()) throw new Error('template required');
    if (!input.task?.trim()) throw new Error('task required');

    // 嵌套深度保护：主会话 0 → 子代理 1 → 孙 2；再深拒绝。
    // 三个"完全相同任务"的递归派发会指数级开新会话，这里是硬闸门。
    const parentDepth = input.parentSessionId
      ? (this.sessionDepth.get(input.parentSessionId) ?? 0)
      : 0;
    if (parentDepth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(
        `子代理嵌套层级已达上限（${MAX_SUBAGENT_DEPTH} 层）：拒绝在 depth=${parentDepth} 的会话上继续派发`,
      );
    }

    const group = this.ensureSubagentGroup();
    const task = this.engine.createTask(`Subagent · ${input.template}`, group.id);
    this.sessionDepth.set(task.id, parentDepth + 1);

    this.logger.info('subagent: run', {
      template: input.template,
      taskId: task.id,
      depth: parentDepth + 1,
    });

    const controller = new AbortController();
    // 父工具调用中断 → 级联中止本子代理（停止主 run 不再留下孤儿子代理）
    const forwardAbort = () => controller.abort();
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener('abort', forwardAbort, { once: true });
    }
    // headless 标记：子代理会话无人应答权限确认 → 短超时快速失败（见 engine.requestConfirm）
    this.engine.markSessionHeadless?.(task.id, true);
    // 权限继承：显式入参 → 父会话模式 → auto（父 skip 时子代理也不再弹无法应答的确认）
    const inheritedMode: PermissionMode =
      input.permissionMode ??
      (input.parentSessionId ? this.engine.getPermissionMode?.(input.parentSessionId) : undefined) ??
      'auto';

    this.activeRuns.set(task.id, controller);
    this.registerExternalRun(task.id, controller);
    try {
      const result = await this.engine.run({
        sessionId: task.id,
        agentId: input.template,
        userMessage: input.task,
        permissionMode: inheritedMode,
        cwd: input.cwd,
        onEvent: (event: AgentEvent) => {
          void this.eventBus.broadcast('subagent:event', {
            taskId: task.id,
            ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
            event,
          });
        },
        signal: controller.signal,
      });
      return {
        sessionId: task.id,
        taskId: task.id,
        finishReason: result.finishReason,
        result: result.finalText,
      };
    } finally {
      if (input.signal) input.signal.removeEventListener('abort', forwardAbort);
      this.activeRuns.delete(task.id);
      this.unregisterExternalRun(task.id, controller);
    }
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
