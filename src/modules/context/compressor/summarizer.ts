// src/modules/context/compressor/summarizer.ts
// 摘要生成：
// - 摘要请求 messages = [静态 system 前缀, ...被压缩区消息, 压缩指令]
//   ——复用主对话的 system 前缀，摘要请求本身命中前缀缓存
// - 指令从 agent/prompts/compact/compaction.md 加载（{{FOCUS}} 变量），缺失则抛错放弃本轮压缩
// - 单次失败不重试（summarizeOnce 语义）：空结果/截断 → 抛错，由调用方放弃本轮压缩

import type { Environment } from '../../../core/types';
import type { CompactionConfig, ContextMessage } from '../types';
import type { LLMRouter } from '../../contracts';
import type { UnifiedMessage } from '../../llm/types';
import { loadPromptFile, renderTemplate } from '../prompt-loader';

/** 手动压缩附加焦点的引导语前缀 */
const FOCUS_PREFIX = '\n\n本次压缩的附加焦点（优先保留以下内容）：';

/**
 * 加载压缩指令（agent/prompts/compact/compaction.md；缺失则抛错，调用方放弃本轮压缩）。
 * @param focus 手动压缩时的附加焦点文本（可空）
 */
export function loadCompactionInstruction(env: Environment, focus?: string): string {
  const template = loadPromptFile(env, 'compact/compaction.md');
  if (template.trim() === '') {
    throw new Error('compaction prompt missing (compaction.md)');
  }
  const focusBlock = focus && focus.trim() !== '' ? `${FOCUS_PREFIX}${focus.trim()}` : '';
  return renderTemplate(template, { FOCUS: focusBlock });
}

export interface SummarizeInput {
  env: Environment;
  config: CompactionConfig;
  llm: LLMRouter;
  /** 静态系统提示词（cache-aligned 前缀） */
  staticSystemPrompt: string;
  /** 被压缩区消息（活跃、未 compacted） */
  region: ContextMessage[];
  /** 附加焦点（手动压缩） */
  focus?: string;
  /** 摘要模型（已解析的请求 model 名，如 'deepseek-chat'） */
  summaryModelId: string;
}

export class SummarizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SummarizeError';
  }
}

/** 被压缩区消息 → UnifiedMessage（与视图构建相同的转换口径） */
function regionToUnifiedMessages(region: readonly ContextMessage[]): UnifiedMessage[] {
  return region.map(m => ({
    role: m.role,
    content: m.content,
    toolCallId: m.toolCallId,
    toolCalls: m.toolCalls?.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    })),
    name: m.name,
  }));
}

/**
 * 生成压缩摘要（单次请求，失败即抛 SummarizeError，不重试）。
 * 返回纯文本摘要（不含 <compaction-summary> 标签，由调用方包裹）。
 */
export async function summarizeRegion(input: SummarizeInput): Promise<string> {
  const { env, config, llm, staticSystemPrompt, region, focus, summaryModelId } = input;
  if (region.length === 0) {
    throw new SummarizeError('empty compaction region');
  }

  const instruction = loadCompactionInstruction(env, focus);
  const messages: UnifiedMessage[] = [
    { role: 'system', content: staticSystemPrompt },
    ...regionToUnifiedMessages(region),
    { role: 'user', content: instruction },
  ];

  const response = await llm.complete({
    model: summaryModelId,
    messages,
    stream: false,
    max_tokens: config.summaryMaxTokens,
  });

  const summary = response.content.trim();
  if (summary === '') {
    throw new SummarizeError('summarizer returned empty output');
  }
  if (response.finish_reason === 'length') {
    throw new SummarizeError('summarizer output truncated (finish_reason=length)');
  }
  return summary;
}
