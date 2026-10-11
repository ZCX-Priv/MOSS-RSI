// src/modules/hooks/service.ts
// 钩子引擎服务实现：事件分发（agent engine 挂载点调用）、测试触发（WebUI）、
// CRUD 直通（REST 路由）、执行历史查询。

import type { ConfigService, Environment, Logger } from '../../core/types';
import { DEFAULT_HOOKS_CONFIG } from '../context/types';
import { HookBus } from './bus';
import {
  deleteHookAnywhere,
  getHookAnywhere,
  globalHooksDir,
  listHooks,
  listScripts,
  projectHooksDir,
  readScript,
  upsertHook,
  writeScript,
} from './storage';
import { executeHook } from './executor';
import type { HookDispatchResult, HookEvent, HookInput, HookScope, HookUpsertInput, ScopedHookRecord } from './types';

export interface HooksEngineServiceDeps {
  env: Environment;
  config: ConfigService;
  logger: Logger;
}

export class HooksEngineServiceImpl {
  private readonly env: Environment;
  private readonly config: ConfigService;
  private readonly logger: Logger;
  private readonly bus: HookBus;

  constructor(deps: HooksEngineServiceDeps) {
    this.env = deps.env;
    this.config = deps.config;
    this.logger = deps.logger;
    this.bus = new HookBus({
      env: deps.env,
      logger: deps.logger,
      defaultTimeout: () => this.getConfig().defaultTimeout,
    });
  }

  /** 实时读取钩子引擎配置 */
  getConfig() {
    const app = this.config.getAppConfig();
    const ctx = (app as { context?: { hooks?: Partial<typeof DEFAULT_HOOKS_CONFIG> } }).context;
    return { ...DEFAULT_HOOKS_CONFIG, ...(ctx?.hooks ?? {}) };
  }

  /**
   * 事件分发入口（agent engine 六挂载点调用）。
   * 引擎禁用时零开销直通放行。
   */
  async dispatch(
    event: HookEvent,
    input: Omit<HookInput, 'event' | 'timestamp'>,
  ): Promise<HookDispatchResult> {
    if (!this.getConfig().enabled) {
      return { decision: 'allow', executed: 0 };
    }
    return this.bus.dispatch(event, input);
  }

  /** 测试触发（WebUI：按 id 执行单个钩子，sampleInput 为模拟输入） */
  async testFire(
    cwd: string,
    id: string,
    sampleInput: Partial<Omit<HookInput, 'event' | 'timestamp'>>,
  ): Promise<{ ok: boolean; decision: 'allow' | 'deny' | null; reason?: string; durationMs: number; error?: string; stdout?: string } | null> {
    const hook = getHookAnywhere(this.env, cwd, id);
    if (!hook) return null;

    const input: HookInput = {
      event: hook.event,
      sessionId: sampleInput.sessionId ?? 'test-session',
      cwd: sampleInput.cwd ?? cwd,
      ...(sampleInput.toolName !== undefined ? { toolName: sampleInput.toolName } : {}),
      ...(sampleInput.toolInput !== undefined ? { toolInput: sampleInput.toolInput } : {}),
      ...(sampleInput.prompt !== undefined ? { prompt: sampleInput.prompt } : {}),
      timestamp: new Date().toISOString(),
    };

    const dir = hook.scope === 'project' ? projectHooksDir(cwd) : globalHooksDir(this.env);
    const outcome = await executeHook(hook, input, {
      env: this.env,
      logger: this.logger,
      defaultTimeout: this.getConfig().defaultTimeout,
      hooksDir: dir,
    });
    return {
      ok: outcome.ok,
      decision: outcome.output?.decision ?? null,
      ...(outcome.output?.reason ? { reason: outcome.output.reason } : {}),
      durationMs: outcome.durationMs,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.stdout ? { stdout: outcome.stdout.slice(0, 4000) } : {}),
    };
  }

  /** 执行历史（最新在前） */
  getHistory() {
    return this.bus.getHistory();
  }

  // ========================================================================
  // CRUD 直通（REST 路由消费）
  // ========================================================================

  list(cwd: string): { project: ScopedHookRecord[]; global: ScopedHookRecord[] } {
    return {
      project: listHooks(projectHooksDir(cwd), 'project'),
      global: listHooks(globalHooksDir(this.env), 'global'),
    };
  }

  get(cwd: string, id: string): ScopedHookRecord | null {
    return getHookAnywhere(this.env, cwd, id);
  }

  upsert(cwd: string, scope: HookScope, input: HookUpsertInput, oldId?: string): ScopedHookRecord {
    if (!input.name) throw new Error('name is required');
    if (input.type === 'terminal' && !input.command) throw new Error('command is required for terminal hooks');
    if (input.type === 'module' && !input.modulePath) throw new Error('modulePath is required for module hooks');
    const dir = scope === 'project' ? projectHooksDir(cwd) : globalHooksDir(this.env);
    const record = upsertHook(dir, input, oldId ? { oldId } : undefined);
    return { ...record, scope };
  }

  delete(cwd: string, id: string): boolean {
    return deleteHookAnywhere(this.env, cwd, id);
  }

  /** scripts 目录脚本列表与读写（模块钩子管理） */
  scripts(cwd: string, scope: HookScope): string[] {
    const dir = scope === 'project' ? projectHooksDir(cwd) : globalHooksDir(this.env);
    return listScripts(dir);
  }

  writeScriptFile(cwd: string, scope: HookScope, filename: string, content: string): void {
    const dir = scope === 'project' ? projectHooksDir(cwd) : globalHooksDir(this.env);
    writeScript(dir, filename, content);
  }

  readScriptFile(cwd: string, scope: HookScope, filename: string): string | null {
    const dir = scope === 'project' ? projectHooksDir(cwd) : globalHooksDir(this.env);
    return readScript(dir, filename);
  }
}
