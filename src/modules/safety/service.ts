// src/modules/safety/service.ts
// SafetyService：统一权限决策服务（ServiceNames.SAFETY）。
// 职责：组装 PolicyEnv（config 实时读取 + 会话/项目规则）、执行决策、
// 生成「始终允许」规则建议、会话级/项目级规则管理、全局规则持久化、决策审计日志。

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger, ConfigService, Environment } from '../../core/types';
import type {
  SafetyDecision,
  SafetyRequest,
  SafetyRules,
  SafetyConfig,
  SafetyReviewConfig,
  PermissionMode,
} from './types';
import { evaluate as evaluatePolicy, normalizeMode } from './policy';
import { systemRoot, SYSTEM_SCOPE } from '../filesys/roots';
import { atomicWriteFile } from '../../utils/fs-atomic';

/** 空规则表 */
const EMPTY_RULES: SafetyRules = { allow: [], deny: [], ask: [] };

/** 字符串数组过滤（容错：非字符串项丢弃） */
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/** 自动审查配置兜底（reviewer 与本服务共用） */
export function normalizeReviewConfig(raw: unknown): SafetyReviewConfig {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawEffort = typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort.trim() : '';
  // 旧版固定挡位 max → high（新值原样保留，交给所选模型的 thinkingLevels）
  const reasoningEffort = rawEffort === 'max' ? 'high' : rawEffort.slice(0, 32) || 'off';
  const rawSensitivity = cfg.sensitivity;
  return {
    enabled: cfg.enabled !== false,
    model: typeof cfg.model === 'string' ? cfg.model : '',
    reasoningEffort,
    sensitivity:
      rawSensitivity === 'low' || rawSensitivity === 'high' ? rawSensitivity : 'medium',
    timeoutMs:
      typeof cfg.timeoutMs === 'number' && cfg.timeoutMs >= 1000
        ? Math.min(cfg.timeoutMs, 300000)
        : 30000,
    onReviewFailure: cfg.onReviewFailure === 'deny' ? 'deny' : 'ask',
    cacheTtlMs:
      typeof cfg.cacheTtlMs === 'number' && cfg.cacheTtlMs >= 0
        ? Math.min(cfg.cacheTtlMs, 3600000)
        : 60000,
    maxIntentChars:
      typeof cfg.maxIntentChars === 'number' && cfg.maxIntentChars >= 200
        ? Math.min(cfg.maxIntentChars, 20000)
        : 4000,
  };
}

/** 会话级规则存储（内存；刷新即失效——设计决策） */
interface SessionRuleEntry {
  allow: string[];
  deny: string[];
  ask: string[];
}

export class SafetyService {
  private readonly sessionRules = new Map<string, SessionRuleEntry>();
  /** 项目级规则缓存：cwd → { mtimeMs, rules } */
  private readonly projectRulesCache = new Map<string, { mtimeMs: number; rules: SafetyRules }>();
  private readonly logger: Logger;
  private readonly config: ConfigService | null;
  private readonly env: Environment;

  constructor(logger: Logger, config: ConfigService | null, env: Environment) {
    this.logger = logger;
    this.config = config;
    this.env = env;
  }

  /** 读取 config.safety 段（容错：config 不可用或段缺失时回退内置默认；段存在时内层由 Zod 默认值自愈补全） */
  private readSafetyConfig(): SafetyConfig {
    const fallback: SafetyConfig = {
      defaultMode: 'ask',
      confirmTimeoutMinutes: 5,
      blockDangerousCommands: true,
      cautionPolicy: 'ask',
      rules: { allow: [], deny: [], ask: [] },
      protectedPaths: ['~/.ssh', '~/.gnupg', '~/.aws'],
      review: normalizeReviewConfig(undefined),
    };
    if (!this.config) return fallback;
    try {
      const safety = this.config.getAppConfig().safety;
      if (!safety) return fallback;
      return {
        defaultMode: normalizeMode(safety.defaultMode),
        confirmTimeoutMinutes:
          typeof safety.confirmTimeoutMinutes === 'number' && safety.confirmTimeoutMinutes >= 0
            ? safety.confirmTimeoutMinutes
            : 5,
        blockDangerousCommands: safety.blockDangerousCommands !== false,
        cautionPolicy: safety.cautionPolicy === 'deny' ? 'deny' : 'ask',
        rules: {
          allow: strArr(safety.rules?.allow),
          deny: strArr(safety.rules?.deny),
          ask: strArr(safety.rules?.ask),
        },
        protectedPaths: strArr(safety.protectedPaths),
        review: normalizeReviewConfig(safety.review),
      };
    } catch {
      return fallback;
    }
  }

  /** 全局默认权限模式（config.safety.defaultMode） */
  getDefaultMode(): PermissionMode {
    return this.readSafetyConfig().defaultMode;
  }

  /** 确认超时（分钟；0=永不超时） */
  getConfirmTimeoutMinutes(): number {
    return this.readSafetyConfig().confirmTimeoutMinutes;
  }

  /** 自动审查配置（config.safety.review；实时读取） */
  getReviewConfig(): SafetyReviewConfig {
    return this.readSafetyConfig().review;
  }

  /** 统一决策入口 */
  evaluate(req: SafetyRequest): SafetyDecision {
    const safetyCfg = this.readSafetyConfig();
    const decision = evaluatePolicy(req, {
      sessionRules: this.sessionRules.get(req.sessionId),
      projectRules: this.listProjectRules(req.cwd),
      globalRules: safetyCfg.rules,
      blockDangerousCommands: safetyCfg.blockDangerousCommands,
      cautionPolicy: safetyCfg.cautionPolicy,
      protectedPaths: safetyCfg.protectedPaths,
      home: this.env.homeDir,
      systemRoot: systemRoot(),
      configDir: this.env.configDir,
      dataDir: this.env.dataDir,
    });
    // 决策审计日志（集中式，便于排查"为什么被拦"）
    this.logger.info(
      `[safety] ${decision.action.toUpperCase()} ${req.toolName} (mode=${req.mode} reason=${decision.reason.type}` +
        `${decision.reason.rule ? ` rule=${decision.reason.rule}` : ''}` +
        `${decision.reason.pattern ? ` pattern=${decision.reason.pattern}` : ''})`,
    );
    return decision;
  }

  /**
   * 读取项目级权限规则（{cwd}/.moss/permissions.json）。
   * 文件缺失/解析失败返回空规则；按 mtime 缓存，写入后失效。
   */
  listProjectRules(cwd: string): SafetyRules {
    if (!cwd || cwd === SYSTEM_SCOPE) return EMPTY_RULES;
    const file = join(cwd, '.moss', 'permissions.json');
    try {
      if (!existsSync(file)) return EMPTY_RULES;
      const mtimeMs = statSync(file).mtimeMs;
      const cached = this.projectRulesCache.get(cwd);
      if (cached && cached.mtimeMs === mtimeMs) return cached.rules;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const rules: SafetyRules = {
        allow: strArr(parsed.allow),
        deny: strArr(parsed.deny),
        ask: strArr(parsed.ask),
      };
      this.projectRulesCache.set(cwd, { mtimeMs, rules });
      return rules;
    } catch (err) {
      this.logger.warn(`[safety] failed to read project rules: ${file}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return EMPTY_RULES;
    }
  }

  /** 整体写入项目级规则（设置页编辑用；原子写入并失效缓存） */
  async saveProjectRules(cwd: string, rules: SafetyRules): Promise<boolean> {
    if (!cwd || cwd === SYSTEM_SCOPE) return false;
    try {
      const dir = join(cwd, '.moss');
      mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify({ version: 1, ...rules }, null, 2) + '\n';
      atomicWriteFile(join(dir, 'permissions.json'), payload);
      this.projectRulesCache.delete(cwd);
      this.logger.info(`[safety] project rules saved (cwd=${cwd})`);
      return true;
    } catch (err) {
      this.logger.warn(`[safety] failed to save project rules (cwd=${cwd})`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** 追加单条项目级规则（确认卡片「始终允许(本项目)」） */
  async addProjectRule(
    cwd: string,
    list: 'allow' | 'deny' | 'ask',
    rule: string,
  ): Promise<boolean> {
    const current = this.listProjectRules(cwd);
    if (current[list].includes(rule)) return true;
    const next: SafetyRules = { ...current, [list]: [...current[list], rule] };
    const ok = await this.saveProjectRules(cwd, next);
    if (ok) this.logger.info(`[safety] project rule added: ${list} ${rule} (cwd=${cwd})`);
    return ok;
  }

  /** 添加会话级规则（「始终允许(会话)」） */
  addSessionRule(sessionId: string, list: 'allow' | 'deny' | 'ask', rule: string): void {
    let entry = this.sessionRules.get(sessionId);
    if (!entry) {
      entry = { allow: [], deny: [], ask: [] };
      this.sessionRules.set(sessionId, entry);
    }
    if (!entry[list].includes(rule)) entry[list].push(rule);
    this.logger.info(`[safety] session rule added: ${list} ${rule} (session=${sessionId})`);
  }

  /** 清理会话规则（会话删除时调用，防内存泄漏） */
  clearSessionRules(sessionId: string): void {
    this.sessionRules.delete(sessionId);
  }

  /** 添加全局持久规则（「始终允许(全局)」→ config.safety.rules + 自动广播 config:changed） */
  async addGlobalRule(list: 'allow' | 'deny' | 'ask', rule: string): Promise<boolean> {
    if (!this.config) return false;
    try {
      const cfg = this.readSafetyConfig();
      if (cfg.rules[list].includes(rule)) return true;
      const next: SafetyRules = { ...cfg.rules, [list]: [...cfg.rules[list], rule] };
      await this.config.updateAppConfig({ safety: { ...cfg, rules: next } });
      this.logger.info(`[safety] global rule added: ${list} ${rule}`);
      return true;
    } catch (err) {
      this.logger.warn(`[safety] failed to persist global rule: ${rule}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * 生成「始终允许」规则建议：
   *   terminal: heredoc(<<)→前缀 | 多行→首行 | 单行→2 词前缀 | 兜底→精确命令
   *   MCP   → mcp__server__tool
   *   其他  → 工具名
   */
  generateRuleSuggestion(toolName: string, params: unknown): string {
    if (toolName === 'terminal' && params && typeof params === 'object' && 'command' in params) {
      const cmd = (params as Record<string, unknown>).command;
      if (typeof cmd === 'string' && cmd.trim()) {
        return `terminal(${suggestTerminalContent(cmd)})`;
      }
    }
    return toolName;
  }
}

/** 终端命令的规则 content 建议 */
function suggestTerminalContent(command: string): string {
  const trimmed = command.trim();
  // heredoc：提取 << 之前的稳定前缀
  const heredocIdx = trimmed.indexOf('<<');
  if (heredocIdx > 0) {
    const prefix = trimmed.slice(0, heredocIdx).trim();
    if (prefix) return `${prefix} *`;
  }
  // 多行命令：首行
  if (trimmed.includes('\n')) {
    const firstLine = trimmed.split('\n')[0].trim();
    if (firstLine) return `${firstLine} *`;
  }
  // 单行：2 词前缀（git commit -m 'x' → git commit *）
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) return `${words[0]} ${words[1]} *`;
  return words[0] || trimmed;
}
