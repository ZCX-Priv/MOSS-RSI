// src/modules/context/compressor/summarizer.ts
// 摘要生成：
// - 摘要请求 messages = [静态 system 前缀, ...被压缩区消息, 压缩指令]
//   ——复用主对话的 system 前缀，摘要请求本身命中前缀缓存
// - 指令从 agent/prompts/compact/compaction.md 加载（{{FOCUS}} 变量），缺失回退内置七段式
// - 单次失败不重试（summarizeOnce 语义）：空结果/截断 → 抛错，由调用方放弃本轮压缩

import type { Environment } from '../../../core/types';
import type { CompactionConfig, ContextMessage } from '../types';
import type { LLMRouter } from '../../contracts';
import type { UnifiedMessage } from '../../llm/types';
import { loadPromptFile, renderTemplate } from '../prompt-loader';

/** 压缩指令内置兜底（compact/compaction.md 缺失时使用；七段式结构化简报） */
export const FALLBACK_COMPACTION_PROMPT = `将前面的对话前缀压缩为一份可持续使用的任务简报。
严格按以下标题输出（某节无内容时省略该节）：

## 持续事实与约束
用户陈述且仍然有效的一切——名称、路径、ID、版本、令牌、偏好、以及硬性"禁止 X"规则——尽量保留用户原话。宁多勿少：这是持久契约。

## 目标
用户的请求与意图。

## 决策与理由
目前做出的关键选择及其原因——避免后续重新争论或推翻。

## 文件与代码
读取或修改过的文件，以及其中的关键事实：函数签名、行号位置、数据形状、所做的精确编辑。要具体——这是无需重读全部文件即可继续行动的依据。

## 命令与结果
运行的命令（构建、测试、git 等）及其关键结果——什么通过了、什么失败了、重要的错误文本。

## 错误与修复
遇到过的问题及其解决（或未解决）方式——避免重复同样的死胡同。

## 待办与下一步
仍在进行中或尚未开始的事项，以及最具体的下一步行动。

规则：极简——用要点与片段，不写散文。标识符、路径、数字必须原样保留。合并已有 <compaction-summary> 中的有效事实，删除被后续消息取代的内容。不要发明消息中不存在的信息；不确定的内容宁可省略。只输出结构化 Markdown 简报，不要调用工具，不要输出推理过程。{{FOCUS}}`;

/** 手动压缩附加焦点的引导语前缀 */
const FOCUS_PREFIX = '\n\n本次压缩的附加焦点（优先保留以下内容）：';

/**
 * 加载压缩指令（agent/prompts/compact/compaction.md → 内置兜底）。
 * @param focus 手动压缩时的附加焦点文本（可空）
 */
export function loadCompactionInstruction(env: Environment, focus?: string): string {
  const template = loadPromptFile(env, 'compact/compaction.md', FALLBACK_COMPACTION_PROMPT);
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
