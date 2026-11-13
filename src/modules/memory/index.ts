// src/modules/memory/index.ts
// 记忆引擎模块入口：注册 MEMORY_ENGINE 服务（基础设施级，先于 context/agent 初始化）。
// 职责：记忆宫殿存储（哈希 JSON + 目录层次）、BM25 检索（四层记忆栈 L0-L3）、
// LLM 异步蒸馏、memory_* 工具支持。

import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import { MemoryEngineServiceImpl } from './service';

class MemoryModule implements Module {
  private engine: MemoryEngineServiceImpl | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.engine = new MemoryEngineServiceImpl({
      env: ctx.env,
      config: ctx.config,
      services: ctx.services,
      logger: ctx.logger,
    });
    ctx.services.register(ServiceNames.MEMORY_ENGINE, this.engine, {
      scope: 'memory',
    });
    ctx.logger.info('memory: engine initialized', {
      enabled: this.engine.getConfig().enabled,
    });
  }

  async destroy(): Promise<void> {
    this.engine = null;
  }
}

export default (): Module => new MemoryModule();

// 公共导出（context / agent / server / tools 模块使用）
export { MemoryEngineServiceImpl, MEMORY_L1_MSG_NAME, MEMORY_RECALL_MSG_NAME } from './service';
export type { MemoryEngineServiceDeps } from './service';
export type {
  MemoryHall,
  MemoryOrigin,
  MemoryRecord,
  MemoryScope,
  MemoryUpsertInput,
  ScopedMemoryRecord,
  MemoryPalaceTree,
  MemoryRecallSection,
  DistilledMemory,
} from './types';
export { MEMORY_HALLS } from './types';
export { computeMemoryId, projectWing } from './storage';
