// src/modules/hooks/bus.ts
// 钩子事件总线：加载双作用域启用钩子 → matcher 过滤 → 串行执行 → 聚合决策。
// 执行历史环形缓冲（最近 200 条全局；WebUI 展示）。
// fail-open：任何钩子失败按放行处理 + 告警日志（用户扩展不能瘫痪主循环）。

import { Glob } from 'bun';
import type { Environment, Logger } from '../../core/types';
import { executeHook } from './executor';
import { globalHooksDir, listHooks, projectHooksDir } from './storage';
import { BLOCKABLE_EVENTS } from './types';
import type { HookDispatchResult, HookEvent, HookInput, ScopedHookRecord } from './types';

/** 执行历史环形缓冲容量 */
const HISTORY_LIMIT = 200;

export interface HookBusDeps {
  env: Environment;
  logger: Logger;
  /** 默认超时 ms */
  defaultTimeout: () => number;
}

/** matcher 匹配（工具名精确/glob；null/空 = 全匹配） */
function matcherMatches(matcher: string | null, toolName: string | undefined): boolean {
  if (!matcher || matcher === '') return true;
  if (!toolName) return false;
  if (matcher === toolName) return true;
  try {
    return new Glob(matcher).match(toolName);
  } catch {
    return false;
  }
}

export class HookBus {
  private readonly env: Environment;
  private readonly logger: Logger;
  private readonly defaultTimeout: () => number;
  /** 执行历史（最新在前） */
  private history: Array<{
    hookId: string;
    hookName: string;
    event: HookEvent;
    at: string;
    durationMs: number;
    ok: boolean;
    decision: 'allow' | 'deny' | null;
    error?: string;
    stdout?: string;
  }> = [];

  constructor(deps: HookBusDeps) {
    this.env = deps.env;
    this.logger = deps.logger;
    this.defaultTimeout = deps.defaultTimeout;
  }

  private record(entry: (typeof this.history)[number]): void {
    this.history.unshift(entry);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.length = HISTORY_LIMIT;
    }
  }

  /**
   * 派发事件：收集匹配钩子 → 串行执行 → 聚合决策。
   * 任一 deny 即 deny（仅阻止型事件）；SessionStart/Stop 的 stdout 聚合为 contextText。
   */
  async dispatch(event: HookEvent, input: Omit<HookInput, 'event' | 'timestamp'>): Promise<HookDispatchResult> {
    const fullInput: HookInput = {
      ...input,
      event,
      timestamp: new Date().toISOString(),
    };

    // 双作用域收集启用且事件匹配的钩子（项目级优先执行）
    const globalHooks = listHooks(globalHooksDir(this.env), 'global').filter(
      h => h.enabled && h.event === event,
    );
    const projectHooks = listHooks(projectHooksDir(input.cwd), 'project').filter(
      h => h.enabled && h.event === event,
    );
    const candidates: Array<{ hook: ScopedHookRecord; dir: string }> = [
      ...projectHooks.map(hook => ({ hook, dir: projectHooksDir(input.cwd) })),
      ...globalHooks.map(hook => ({ hook, dir: globalHooksDir(this.env) })),
    ];

    const matched = candidates.filter(({ hook }) =>
      matcherMatches(hook.matcher, fullInput.toolName),
    );

    if (matched.length === 0) {
      return { decision: 'allow', executed: 0 };
    }

    const blockable = BLOCKABLE_EVENTS.has(event);
    let decision: 'allow' | 'deny' = 'allow';
    let denyReason: string | undefined;
    let executed = 0;
    const contextParts: string[] = [];

    for (const { hook, dir } of matched) {
      executed++;
      const outcome = await executeHook(hook, fullInput, {
        env: this.env,
        logger: this.logger,
        defaultTimeout: this.defaultTimeout(),
        hooksDir: dir,
      });

      this.record({
        hookId: hook.id,
        hookName: hook.name,
        event,
        at: fullInput.timestamp,
        durationMs: outcome.durationMs,
        ok: outcome.ok,
        decision: outcome.output?.decision ?? (outcome.ok ? null : null),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.stdout ? { stdout: outcome.stdout.slice(0, 2000) } : {}),
      });

      if (!outcome.ok) {
        // fail-open：执行失败按放行 + 告警（不中断后续钩子）
        this.logger.warn('hooks: execution failed (fail-open)', {
          hookId: hook.id,
          hookName: hook.name,
          event,
          error: outcome.error,
        });
        continue;
      }

      if (blockable && outcome.output?.decision === 'deny') {
        decision = 'deny';
        denyReason = outcome.output.reason ?? `blocked by hook ${hook.name}`;
        // deny 短路：不再执行后续钩子
        break;
      }

      // SessionStart/Stop 的 stdout 注入上下文
      if ((event === 'SessionStart' || event === 'Stop') && outcome.stdout.trim() !== '') {
        contextParts.push(outcome.stdout.trim());
      }
    }

    return {
      decision,
      ...(denyReason ? { reason: denyReason } : {}),
      executed,
      ...(contextParts.length > 0 ? { contextText: contextParts.join('\n\n') } : {}),
    };
  }

  /** 执行历史快照（最新在前） */
  getHistory() {
    return [...this.history];
  }
}
