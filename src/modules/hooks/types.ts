// src/modules/hooks/types.ts
// 钩子引擎类型契约：生命周期事件钩子（终端命令 + TS 模块双执行形式）。
// 事件：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SessionEnd。
// 决策协议：PreToolUse 与 UserPromptSubmit 支持 deny（阻止动作）；其余仅通知。

/** 钩子生命周期事件 */
export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SessionEnd';

/** 支持阻止动作的事件（deny 决策生效） */
export const BLOCKABLE_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'UserPromptSubmit',
  'PreToolUse',
]);

export const HOOK_EVENTS: readonly HookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
];

/** 钩子执行形式（'shell' 为旧值，读取时归一化为 'terminal'） */
export type HookType = 'terminal' | 'module';

/** 单个钩子定义（一个 JSON 文件，文件名 = 内容哈希） */
export interface HookRecord {
  /** 内容哈希（sha256 前 16 位 hex） */
  id: string;
  /** 钩子名 */
  name: string;
  /** 生命周期事件 */
  event: HookEvent;
  /** 工具名匹配（精确名或 glob；null/空 = 匹配全部。仅工具类事件有效） */
  matcher: string | null;
  /** 执行形式：terminal 外部命令 / module TS 模块 */
  type: HookType;
  /** type=terminal 时的命令行（支持 ~ 展开与环境变量） */
  command: string;
  /** type=module 时的模块路径（相对 hooks/scripts/） */
  modulePath: string;
  /** 执行超时 ms（0 = 使用引擎默认） */
  timeout: number;
  /** 启用状态 */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 钩子作用域 */
export type HookScope = 'global' | 'project';

/** 带作用域标注的钩子（列表接口返回） */
export interface ScopedHookRecord extends HookRecord {
  scope: HookScope;
}

/** 钩子输入（stdin JSON / TS 模块入参） */
export interface HookInput {
  event: HookEvent;
  sessionId: string;
  cwd: string;
  /** 工具类事件：工具名 */
  toolName?: string;
  /** 工具类事件：工具输入参数 */
  toolInput?: Record<string, unknown>;
  /** 用户消息事件：消息文本 */
  prompt?: string;
  timestamp: string;
}

/** 钩子输出决策 */
export interface HookOutput {
  /** allow = 放行（默认）；deny = 阻止（仅阻止型事件生效） */
  decision: 'allow' | 'deny';
  /** 决策原因（deny 时反馈给 LLM / 用户） */
  reason?: string;
}

/** 钩子执行记录（环形历史，WebUI 展示） */
export interface HookExecutionRecord {
  hookId: string;
  hookName: string;
  event: HookEvent;
  at: string;
  /** 执行耗时 ms */
  durationMs: number;
  ok: boolean;
  /** 决策结果（解析失败/超时为 null） */
  decision: 'allow' | 'deny' | null;
  /** 错误信息（执行失败时） */
  error?: string;
  /** stdout 摘要（截断） */
  stdout?: string;
}

/** 钩子写入输入 */
export interface HookUpsertInput {
  name: string;
  event: HookEvent;
  matcher?: string | null;
  type: HookType;
  command?: string;
  modulePath?: string;
  timeout?: number;
  enabled?: boolean;
}

/** 事件分发聚合结果 */
export interface HookDispatchResult {
  /** 任一钩子 deny 即 deny（仅阻止型事件） */
  decision: 'allow' | 'deny';
  /** deny 原因（首个 deny 钩子的 reason） */
  reason?: string;
  /** 本事件实际执行的钩子数 */
  executed: number;
  /** 通知文本（SessionStart/Stop 钩子 stdout 注入下一轮上下文；可选） */
  contextText?: string;
}
