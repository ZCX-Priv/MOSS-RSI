// src/modules/hooks/index.ts
// 钩子引擎模块入口：注册 HOOKS_ENGINE 服务（基础设施级，先于 agent 初始化）。
// 职责：生命周期事件钩子（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd）、
// 终端命令 + TS 模块双执行形式、fail-open 降级、执行历史。

import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import { HooksEngineServiceImpl } from './service';

class HooksModule implements Module {
  private engine: HooksEngineServiceImpl | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.engine = new HooksEngineServiceImpl({
      env: ctx.env,
      config: ctx.config,
      logger: ctx.logger,
    });
    ctx.services.register(ServiceNames.HOOKS_ENGINE, this.engine, {
      scope: 'hooks',
    });
    ctx.logger.info('hooks: engine initialized', {
      enabled: this.engine.getConfig().enabled,
      defaultTimeout: this.engine.getConfig().defaultTimeout,
    });
  }

  async destroy(): Promise<void> {
    this.engine = null;
  }
}

export default (): Module => new HooksModule();

// 公共导出（agent / server 模块使用）
export { HooksEngineServiceImpl } from './service';
export type { HooksEngineServiceDeps } from './service';
export type {
  HookEvent,
  HookType,
  HookRecord,
  HookScope,
  HookInput,
  HookOutput,
  HookUpsertInput,
  ScopedHookRecord,
  HookExecutionRecord,
  HookDispatchResult,
} from './types';
export { HOOK_EVENTS, BLOCKABLE_EVENTS } from './types';
