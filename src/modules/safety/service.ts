// src/modules/safety/service.ts
// SafetyService：统一权限决策服务（ServiceNames.SAFETY）。
// 职责：组装 PolicyEnv（config 实时读取 + 会话规则）、执行决策、
// 生成「始终允许」规则建议、会话级规则管理、全局规则持久化、决策审计日志。

import type { Logger, ConfigService, Environment } from '../../core/types';
import type { SafetyDecision, SafetyRequest, SafetyRules, SafetyConfig, PermissionMode } from './types';
import { evaluate as evaluatePolicy, normalizeMode } from './policy';
import { systemRoot } from '../filesys/roots';

/** 会话级规则存储（内存；刷新即失效——设计决策） */
interface SessionRuleEntry {
  allow: string[];
  deny: string[];
  ask: string[];
}

export class SafetyService {
  private readonly sessionRules = new Map<string, SessionRuleEntry>();
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
    };
    if (!this.config) return fallback;
    try {
      const safety = this.config.getAppConfig().safety;
      if (!safety) return fallback;
      const strArr = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
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

  /** 统一决策入口 */
  evaluate(req: SafetyRequest): SafetyDecision {
    const safetyCfg = this.readSafetyConfig();
    const decision = evaluatePolicy(req, {
      sessionRules: this.sessionRules.get(req.sessionId),
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
