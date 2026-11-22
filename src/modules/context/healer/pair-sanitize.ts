// src/modules/context/healer/pair-sanitize.ts
// tool_use / tool_result 配对完整性修复（从 agent/session.ts sanitizeMessages 迁入）。
// Anthropic（及 OpenAI/Gemini）要求每个 tool_use 后紧跟对应 tool_use_id 的 tool_result：
// - 带 toolCalls 的 assistant：紧随其后必须有覆盖全部 toolCallId 的连续 tool 消息；
//   完整则保留 assistant + 对应 tool 结果（丢弃多余 tool 结果）；
//   不完整则丢弃 toolCalls（保留 assistant 纯文本，文本为空则整条丢弃），并丢弃这些 tool 结果。
// - 孤立 tool 消息（前面无配对 assistant）：丢弃。
// 不修改输入数组，返回新数组。
// 返回值同时携带修复统计（遥测：修复了几处孤立 tool / 缺失 tool_result）。

import type { ContextMessage } from '../types';

export interface SanitizeResult {
  messages: ContextMessage[];
  /** 丢弃的孤立 tool 消息数 */
  droppedOrphanTools: number;
  /** 被剥离 toolCalls 的 assistant 消息数（缺 tool_result 配对） */
  strippedToolCalls: number;
}

export function sanitizeMessages(msgs: readonly ContextMessage[]): SanitizeResult {
  const out: ContextMessage[] = [];
  let droppedOrphanTools = 0;
  let strippedToolCalls = 0;
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const expectedIds = new Set(m.toolCalls.map(tc => tc.id));
      // 收集紧随其后的连续 tool 消息
      const toolResults: ContextMessage[] = [];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === 'tool') {
        toolResults.push(msgs[j]);
        j++;
      }
      const foundIds = new Set(
        toolResults.map(t => t.toolCallId).filter((id): id is string => typeof id === 'string'),
      );
      const allCovered = [...expectedIds].every(id => foundIds.has(id));
      if (allCovered) {
        out.push(m);
        for (const tr of toolResults) {
          if (tr.toolCallId && expectedIds.has(tr.toolCallId)) out.push(tr);
        }
      } else {
        // 不配对：保留 assistant 纯文本（去掉 toolCalls），丢弃这些 tool 结果
        if (m.content && m.content.trim()) {
          out.push({ ...m, toolCalls: undefined });
        }
        strippedToolCalls++;
      }
      droppedOrphanTools += toolResults.length - [...expectedIds].filter(id => foundIds.has(id)).length > 0
        ? Math.max(0, toolResults.filter(t => !t.toolCallId || !expectedIds.has(t.toolCallId)).length)
        : 0;
      i = j;
      continue;
    }
    if (m.role === 'tool') {
      // 孤立 tool 消息（无前导配对 assistant）：丢弃
      droppedOrphanTools++;
      i++;
      continue;
    }
    out.push(m);
    i++;
  }
  return { messages: out, droppedOrphanTools, strippedToolCalls };
}

/**
 * 尾部窗口裁剪后的配对对齐（从 session.ts computeContextWindow 迁入，视图语义）：
 * 1. 丢弃开头孤立的 tool 结果（对应 assistant 不在窗口内）；
 * 2. 带 tool_calls 的 assistant 若缺对应 tool 结果则整组丢弃；
 * 3. 整组丢弃后可能为空 → 兜底保留最后一条。
 */
export function alignWindowBoundaries(kept: ContextMessage[], active: readonly ContextMessage[]): ContextMessage[] {
  const aligned = [...kept];

  // 1. 开头孤立 tool 结果
  while (aligned.length > 1 && aligned[0].role === 'tool') {
    aligned.shift();
  }
  // 2. 缺失 tool 结果的 assistant 整组丢弃（从后往前）
  for (let i = aligned.length - 1; i >= 0; i--) {
    const m = aligned[i];
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const expectedIds = new Set(m.toolCalls.map(tc => tc.id));
      let j = i + 1;
      while (j < aligned.length && aligned[j].role === 'tool') {
        j++;
      }
      const foundIds = new Set(aligned.slice(i + 1, j).map(t => t.toolCallId));
      const allCovered = [...expectedIds].every(id => foundIds.has(id));
      if (!allCovered) {
        aligned.splice(i, j - i);
      }
    }
  }
  // 3. 兜底最后一条（避免空对话触发 provider 400）。
  // 不能直接取末尾：若最后一条是 tool，会形成孤立 tool，provider 仍然 400。
  if (aligned.length === 0 && active.length > 0) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].role !== 'tool') {
        aligned.push(active[i]);
        break;
      }
    }
  }
  return aligned;
}
