// src/modules/tools/run_code/forbidden.ts
// PTC 程序内硬禁止的工具名单：需要交互 / 子代理 / 待办时由主流程直接调用原生工具。
// 供 run_code 绑定过滤、系统提示 SDK 与 AgentEngine 嵌套调用 guard 共用。

/** 程序内禁止调用的原生工具名 */
export const PTC_FORBIDDEN_TOOL_NAMES = ['ask', 'agent', 'todo'] as const;

/** 提示词/错误文案中的可读标签 */
export const PTC_FORBIDDEN_TOOL_LABEL = 'ask / agent / todo';

const PTC_FORBIDDEN_TOOL_SET: ReadonlySet<string> = new Set(PTC_FORBIDDEN_TOOL_NAMES);

/** 是否为 PTC 程序内禁止的工具 */
export function isPtcForbiddenTool(name: string): boolean {
  return PTC_FORBIDDEN_TOOL_SET.has(name);
}
