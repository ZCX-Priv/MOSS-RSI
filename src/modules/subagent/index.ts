// src/modules/subagent/index.ts
// subagent 模块入口：Agent 注册表 + 一次性子代理运行服务。
// 注册 agent.registry 与 subagent.runner 两个服务。
// 持久化：注册表 ~/.moss/agents.json（含 1 个默认 Agent + 4 个内置模板）。

import { t } from '../../core/i18n';
import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AgentEngine } from '../contracts';
import { AgentRegistryImpl } from './registry';
import { SubagentRunner } from './runner';
import { registerAgentTools } from './tools';

class SubagentModule implements Module {
  private runner: SubagentRunner | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    const registry = new AgentRegistryImpl(ctx.env, ctx.logger);
    ctx.services.register(ServiceNames.AGENT_REGISTRY, registry, {
      scope: 'subagent',
    });

    // 子代理运行服务（依赖 AgentEngine；引擎未就绪时降级——不阻断启动）
    const engine = ctx.services.tryResolve<AgentEngine>(ServiceNames.AGENT_ENGINE);
    if (engine) {
      this.runner = new SubagentRunner({
        engine,
        eventBus: ctx.eventBus,
        logger: ctx.logger,
        services: ctx.services,
      });
      ctx.services.register(ServiceNames.SUBAGENT_RUNNER, this.runner, {
        scope: 'subagent',
      });
      // 单一 agent 工具注册（template + task）
      registerAgentTools(ctx.services, this.runner, ctx.logger, ctx.env);
    } else {
      ctx.logger.warn('subagent: agent engine unavailable, runner disabled');
    }

    ctx.logger.info(t('subagent.moduleInitialized'), {
      agentCount: registry.list().length,
      defaultAgent: registry.getDefault().id,
    });
  }

  async destroy(): Promise<void> {
    this.runner?.destroy();
    this.runner = null;
  }
}

export default (): Module => new SubagentModule();
