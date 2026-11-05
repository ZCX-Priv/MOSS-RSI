// src/modules/agent/index.ts
// Agent 引擎模块入口：注册 AgentEngine 服务；向 context 引擎注入会话存取桥。

import { t } from '../../core/i18n';
import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import { AgentEngineImpl } from './engine';
import type { ContextEngine } from '../contracts';

class AgentModule implements Module {
  private engine: AgentEngineImpl | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.engine = new AgentEngineImpl({
      services: ctx.services,
      config: ctx.config,
      eventBus: ctx.eventBus,
      logger: ctx.logger,
      env: ctx.env,
    });
    ctx.services.register(ServiceNames.AGENT_ENGINE, this.engine, {
      scope: 'agent',
    });

    // 会话存取桥注入 context 引擎（手动压缩/stats/压缩历史等 API 数据源；
    // 依赖方向 agent → context，引擎通过桥回调访问 session 而不反向依赖）
    const contextEngine = ctx.services.tryResolve<ContextEngine>(ServiceNames.CONTEXT_ENGINE);
    contextEngine?.bindSessionStore({
      get: (id: string) => (this.engine ? this.engine.getSessionForContext(id) : null),
      persist: (session) => {
        this.engine?.persistSessionForContext(session);
      },
    });

    const cfg = ctx.config.getAppConfig().agent;
    ctx.logger.info(t('agent.moduleInitialized'), {
      defaultModel: cfg.defaultModel,
      maxTurns: cfg.maxTurns,
      maxTokens: cfg.maxTokens,
    });
  }

  /** 后台预热：会话/任务磁盘索引（首条对话不依赖索引） */
  async warmup(): Promise<void> {
    await this.engine?.whenReady();
  }

  async destroy(): Promise<void> {
    // 取消 filesys 事件订阅（由 engine.dispose 统一处理）
    this.engine?.dispose();
    this.engine = null;
  }
}

export default (): Module => new AgentModule();
