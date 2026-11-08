// src/modules/agent-bus/index.ts
// 多智能体总线模组：注册 agent.bus 服务（critical 阶段，先于 agent 加载）。
// 总线本身不启动子进程，只维护内存成员树 + 收件箱 + JSONL 审计。

import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import { AgentBusImpl } from './bus';

class AgentBusModule implements Module {
  private bus: AgentBusImpl | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.bus = new AgentBusImpl({
      env: ctx.env,
      eventBus: ctx.eventBus,
      logger: ctx.logger,
    });
    ctx.services.register(ServiceNames.AGENT_BUS, this.bus, { scope: 'agent-bus' });
    ctx.logger.info('agent-bus: initialized', { auditDir: `${ctx.env.dataDir}/agent-bus` });
  }

  async destroy(): Promise<void> {
    this.bus?.destroy();
    this.bus = null;
  }
}

export default (): Module => new AgentBusModule();
