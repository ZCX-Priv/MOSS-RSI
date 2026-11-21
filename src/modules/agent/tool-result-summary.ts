// src/modules/agent/tool-result-summary.ts
// 工具结果摘要：工具执行完成后，把完整结果交给摘要模型压缩，再把摘要写入会话供主模型使用。
// 设计：
//   - 默认关闭；开启后模型可在工具调用参数中用 resultMode 选择 summary（默认）或 original；
//   - 短结果（< minChars）、错误结果、original 模式一律保留原文；
//   - 摘要失败/超时/空输出返回 null，调用方回退原文（不阻断工具链路）；
//   - 提示词外部化为 agent/tool-result/summary.md，用户可覆盖。

import type { Environment } from '../../core/types';
import type { LLMRouter } from '../contracts';
import type { ToolResultSummaryConfig } from '../context/types';
import { loadPromptFileOrNull } from '../context/prompt-loader';
import { effortToThinking, resolveAuxRequestModel } from './aux-model';

/** 摘要过程中的工具结果模式 */
export type ToolResultMode = 'summary' | 'original';

/** 摘要请求超时（ms） */
const SUMMARY_TIMEOUT_MS = 60_000;
/** 工具参数序列化进摘要请求时的最大字符数 */
const ARGS_PREVIEW_CHARS = 2000;

export interface SummarizeToolResultInput {
  env: Environment;
  llm: LLMRouter;
  apiModels: Array<{ id: string; model: string }>;
  config: ToolResultSummaryConfig;
  /** 本轮主模型请求名 */
  mainRequestModel: string;
  toolName: string;
  args: unknown;
  /** 工具结果的完整文本（未截断） */
  text: string;
  isError?: boolean;
  resultMode: ToolResultMode;
  signal?: AbortSignal;
}

function stringifyArgs(args: unknown): string {
  try {
    const text = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    return text.length > ARGS_PREVIEW_CHARS ? `${text.slice(0, ARGS_PREVIEW_CHARS)}…` : text;
  } catch {
    return String(args);
  }
}

/**
 * 按配置生成工具结果摘要。
 * @returns 摘要文本；不满足摘要条件或失败时返回 null（调用方保留原文）。
 */
export async function summarizeToolResult(
  input: SummarizeToolResultInput,
): Promise<string | null> {
  const { env, llm, apiModels, config, mainRequestModel, toolName, args, text, isError, resultMode } = input;
  if (!config.enabled || resultMode === 'original' || isError) return null;
  if (text.length < Math.max(0, config.minChars)) return null;

  const systemPrompt = loadPromptFileOrNull(env, 'tool-result/summary.md');
  if (!systemPrompt) return null;
  const model = resolveAuxRequestModel(config.model, mainRequestModel, apiModels);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
  const onOuterAbort = (): void => controller.abort();
  input.signal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const response = await llm.complete(
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content:
              `工具名：${toolName}\n` +
              `参数：${stringifyArgs(args)}\n\n` +
              `原始结果（共 ${text.length} 字符）：\n${text}`,
          },
        ],
        stream: false,
        max_tokens: 2048,
        temperature: 0,
        thinking: effortToThinking(config.reasoningEffort),
      },
      controller.signal,
    );
    const summary = (response.content ?? '').trim();
    if (!summary) return null;
    return summary;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onOuterAbort);
  }
}
