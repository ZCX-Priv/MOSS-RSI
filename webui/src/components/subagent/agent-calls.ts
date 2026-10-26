// webui/src/components/subagent/agent-calls.ts
// 对话流中 agent（一次性子代理）工具调用的统一识别与结果解析。
//
// 卡片分派不只靠工具名：历史会话 / 命名空间化 / Provider 改写都可能改变名称，
// 参数结构（template + task）作为兜底。长耗时工具的结果消息会落在会话很后面，
// 必须在整条消息列表上按 toolCallId 匹配，而不是只看邻近消息。

import type { TaskMessage, ToolCall } from '../../types/api';

/** agent 工具参数（宽松解析，未知字段忽略） */
export interface AgentCallArgs {
  /** 历史会话可能带 mode；已废弃的 agenteam 模式据此排除 */
  mode?: string;
  /** subagent：模板 agent id */
  template?: string;
  /** subagent：任务描述 */
  task?: string;
}

/** 容错解析工具调用参数；非对象或解析失败返回 null */
export function parseAgentArgs(tc: ToolCall): AgentCallArgs | null {
  try {
    const parsed = JSON.parse(tc.arguments || '{}') as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as AgentCallArgs;
  } catch {
    return null;
  }
}

/**
 * 是否属于 agent 工具的调用（渲染为专属卡片）。
 * 已废弃的 agenteam 模式（历史会话）不再进入专属卡片，回落到通用工具折叠卡。
 */
export function isAgentCall(tc: ToolCall): boolean {
  const args = parseAgentArgs(tc);
  if (args?.mode === 'agenteam') return false;
  if (tc.name === 'agent') return true;
  if (!args) return false;
  return typeof args.template === 'string' && typeof args.task === 'string';
}

/** 工具结果解析产物 */
export interface ToolResultEntry {
  text: string;
  isError: boolean;
}

/**
 * 跨整条消息列表建立 toolCallId → 结果索引。
 * 长耗时工具的结果消息不保证紧邻其 assistant 消息，必须全局匹配。
 */
export function buildToolResultIndex(
  messages: readonly TaskMessage[],
): Map<string, ToolResultEntry> {
  const index = new Map<string, ToolResultEntry>();
  for (const message of messages) {
    const results = message.toolResults;
    if (!results || results.length === 0) continue;
    for (const entry of results) {
      if (!entry.toolCallId || index.has(entry.toolCallId)) continue;
      const text = entry.result.content
        .filter((c) => c.type === 'text')
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('\n');
      index.set(entry.toolCallId, { text, isError: entry.result.isError === true });
    }
  }
  return index;
}
