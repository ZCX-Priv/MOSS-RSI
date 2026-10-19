// src/modules/context/index.ts
// 上下文引擎模块入口：注册 CONTEXT_ENGINE 服务（基础设施级，先于 agent 初始化）。
// 职责：上下文拼接（缓存对齐布局）、压缩（结构化摘要）、自愈（工具调用修复）、
// token 预算（校准估算）、治理（每轮请求流水线）、API/WS 遥测。

import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import { ContextEngineServiceImpl } from './api/service';

class ContextModule implements Module {
  private engine: ContextEngineServiceImpl | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.engine = new ContextEngineServiceImpl({
      env: ctx.env,
      config: ctx.config,
      services: ctx.services,
      logger: ctx.logger,
    });
    ctx.services.register(ServiceNames.CONTEXT_ENGINE, this.engine, {
      scope: 'context',
    });
    this.engine.onInitialize();
  }

  async destroy(): Promise<void> {
    this.engine = null;
  }
}

export default (): Module => new ContextModule();

// 公共导出（agent / server 模块使用）
export { ContextEngineServiceImpl } from './api/service';
export type { ContextEngineServiceImpl as ContextEngineServiceImplType } from './api/service';
export type { PrepareRequestOptions } from './api/service';
export type {
  ContextEngineConfig,
  CompactionConfig,
  CompactionRecord,
  ContextBreakdown,
  ContextMessage,
  ContextSessionLike,
  ContextStats,
  HealResult,
  HealLogEntry,
  ImageOptimizationConfig,
  PreparedRequest,
  SessionContextTelemetry,
  SessionStoreBridge,
  SystemSection,
  ThinkingReplayConfig,
} from './types';
export { DEFAULT_CONTEXT_CONFIG } from './types';
