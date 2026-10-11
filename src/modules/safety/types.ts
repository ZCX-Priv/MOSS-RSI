// src/modules/safety/types.ts
// 安全（safety）模块类型定义。
// 统一权限决策入口：所有工具（builtin/custom/MCP/mcp）执行前必须经过 SafetyPolicy.evaluate。
// 设计按 MOSS-OS 服务化架构裁剪。

/** 权限模式（对齐前端 PermissionModeSelector 现有 UI：3 种） */
export type PermissionMode = 'ask' | 'auto' | 'skip';

/**
 * 风险分级（按操作可恢复性分类，fail-closed）：
 *   L0 只读     —— 无副作用（read/glob/grep/list_* 等 + MCP readOnlyHint）
 *   L1 状态     —— 会话内状态，无系统副作用（ask/todo）
 *   L2 可恢复写 —— file-history 备份 + trash 回收站兜底（write/edit/move/delete/copy）
 *   L3 无兜底   —— 任意命令/外部副作用（terminal + MCP destructiveHint + 未标注/自定义工具）
 */
export type RiskClass = 'L0' | 'L1' | 'L2' | 'L3';

/** 权限决策动作 */
export type SafetyAction = 'allow' | 'ask' | 'deny';

/** 决策原因（结构化，供审计日志与前端展示） */
export interface DecisionReason {
  type:
    | 'disabled'
    | 'mode'
    | 'rule'
    | 'dangerousCommand'
    | 'cautionCommand'
    | 'protectedPath'
    | 'mossAccess'
    | 'default';
  /** 命中的规则原文（type='rule' 时） */
  rule?: string;
  /** 命中的危险命令模式描述（type='dangerousCommand'/'cautionCommand' 时） */
  pattern?: string;
  /** 生效的权限模式（type='mode'/'default' 时） */
  mode?: PermissionMode;
}

/** 统一权限决策结果 */
export interface SafetyDecision {
  action: SafetyAction;
  reason: DecisionReason;
  /** ASK 时附带给确认卡片的「始终允许」规则建议（如 "terminal(git commit *)"） */
  ruleSuggestion?: string;
}

/** 权限规则表（allow/deny/ask 同构） */
export interface SafetyRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

/** config.safety 段（Zod schema 内层全 .default() 自愈，旧 config 缺字段自动补全） */
export interface SafetyConfig {
  defaultMode: PermissionMode;
  /** 确认超时（分钟；0=永不超时；替换原写死的 5 分钟） */
  confirmTimeoutMinutes: number;
  /** 危险命令智能拦截总开关 */
  blockDangerousCommands: boolean;
  /** CAUTION 级危险命令策略：ask=弹确认 / deny=直接拒绝 */
  cautionPolicy: 'ask' | 'deny';
  rules: SafetyRules;
  /** 保护路径（~ 前缀展开；写类工具目标路径命中即 DENY） */
  protectedPaths: string[];
}

/** 决策请求（SafetyPolicy.evaluate 入参） */
export interface SafetyRequest {
  toolName: string;
  /** 工具参数（用于提取终端命令 / 写类工具目标路径） */
  params: unknown;
  /** builtin 工具注解 */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  /** MCP 工具注解（mcp__ 前缀直调工具，或 mcp 工具 action=call） */
  mcpAnnotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  mode: PermissionMode;
  sessionId: string;
  cwd: string;
  /** 工具启用状态（由调用方从 ToolRegistry 查询） */
  enabled: boolean;
}
