// src/modules/rules/service.ts
// 规则引擎服务实现：编译集加载（governor/system-prompt 消费）、
// 文件访问登记（agent 工具调用后触发 paths 规则注入）、CRUD 直通（REST 路由消费）。

import type { ConfigService, Environment, Logger } from '../../core/types';
import type { ContextSessionLike } from '../context/types';
import { DEFAULT_RULES_CONFIG } from '../context/types';
import {
  clearRules,
  deleteRuleAnywhere,
  getRuleAnywhere,
  globalRulesDir,
  listRules,
  projectRulesDir,
  upsertRule,
} from './storage';
import { invalidateRuleCache, loadCompiledRuleSet } from './loader';
import { buildRuleInjectionMessage, matchPathRules } from './inject';
import type { CompiledRuleSet, RuleScope, RuleUpsertInput, ScopedRuleRecord } from './types';

export interface RulesEngineServiceDeps {
  env: Environment;
  config: ConfigService;
  logger: Logger;
}

export class RulesEngineServiceImpl {
  private readonly env: Environment;
  private readonly config: ConfigService;
  private readonly logger: Logger;

  constructor(deps: RulesEngineServiceDeps) {
    this.env = deps.env;
    this.config = deps.config;
    this.logger = deps.logger;
  }

  /** 实时读取规则引擎配置 */
  getConfig() {
    const app = this.config.getAppConfig();
    const ctx = (app as { context?: { rules?: Partial<typeof DEFAULT_RULES_CONFIG> } }).context;
    return { ...DEFAULT_RULES_CONFIG, ...(ctx?.rules ?? {}) };
  }

  /** 加载编译后的规则集合（带 mtime 缓存） */
  getCompiledSet(cwd: string): CompiledRuleSet {
    return loadCompiledRuleSet(this.env, cwd);
  }

  /**
   * 文件访问登记：匹配 paths 规则，未注入过的追加 active-rules 锚定消息。
   * 由 agent executeToolCall 工具成功后调用（read/write/edit/glob/grep）。
   * @returns true 表示 session 被修改（调用方需 persist）
   */
  recordFileAccess(
    session: ContextSessionLike,
    filePaths: readonly string[],
    cwd: string,
  ): boolean {
    if (!this.getConfig().enabled || filePaths.length === 0) return false;

    const set = this.getCompiledSet(cwd);
    if (set.pathRules.length === 0) return false;

    const state = session.rulesState ?? { injectedRuleIds: [] };
    session.rulesState = state;
    const injected = new Set(state.injectedRuleIds);

    const maxInject = this.getConfig().maxInjectPerSession;
    let changed = false;

    for (const fp of filePaths) {
      if (typeof fp !== 'string' || fp === '') continue;
      const hits = matchPathRules(set.pathRules, fp, cwd);
      for (const rule of hits) {
        if (injected.has(rule.id)) continue;
        if (state.injectedRuleIds.length >= maxInject) {
          this.logger.warn('rules: session injection limit reached', {
            sessionId: session.id,
            maxInject,
          });
          return changed;
        }
        session.messages.push({
          role: 'user',
          name: 'active-rules',
          content: buildRuleInjectionMessage(rule),
          metadata: { ruleId: rule.id },
          timestamp: new Date().toISOString(),
        });
        injected.add(rule.id);
        state.injectedRuleIds.push(rule.id);
        changed = true;
        this.logger.info('rules: path rule injected', {
          sessionId: session.id,
          ruleId: rule.id,
          ruleName: rule.name,
          path: fp,
        });
      }
    }
    return changed;
  }

  // ========================================================================
  // CRUD 直通（REST 路由消费）
  // ========================================================================

  /** 列出双作用域规则（项目级 + 全局，scope 标注） */
  list(cwd: string): { project: ScopedRuleRecord[]; global: ScopedRuleRecord[] } {
    return {
      project: listRules(projectRulesDir(cwd), 'project'),
      global: listRules(globalRulesDir(this.env), 'global'),
    };
  }

  /** 批量清空规则（scope: all=全局+当前项目 | global | project）。返回删除条数。 */
  clear(cwd: string, scope: 'all' | 'global' | 'project'): number {
    let removed = 0;
    if (scope === 'all' || scope === 'global') {
      removed += clearRules(globalRulesDir(this.env));
    }
    if (scope === 'all' || scope === 'project') {
      removed += clearRules(projectRulesDir(cwd));
    }
    if (removed > 0) invalidateRuleCache();
    return removed;
  }

  /** 按 id 读取（双作用域查找） */
  get(cwd: string, id: string): ScopedRuleRecord | null {
    return getRuleAnywhere(this.env, cwd, id);
  }

  /**
   * 创建/更新规则。
   * @param scope 作用域（决定写入目录）
   * @param oldId 编辑旧规则 id（内容变化时删除旧哈希文件）
   */
  upsert(
    cwd: string,
    scope: RuleScope,
    input: RuleUpsertInput,
    oldId?: string,
  ): ScopedRuleRecord {
    if (!input.name || !input.content) {
      throw new Error('name and content are required');
    }
    const dir = scope === 'project' ? projectRulesDir(cwd) : globalRulesDir(this.env);
    const record = upsertRule(dir, input, oldId ? { oldId } : undefined);
    invalidateRuleCache();
    return { ...record, scope };
  }

  /** 删除规则（双作用域查找） */
  delete(cwd: string, id: string): boolean {
    const ok = deleteRuleAnywhere(this.env, cwd, id);
    if (ok) invalidateRuleCache();
    return ok;
  }

  /** 作用域目录解析（路由/前端展示用） */
  dirs(cwd: string): { global: string; project: string } {
    return { global: globalRulesDir(this.env), project: projectRulesDir(cwd) };
  }
}
