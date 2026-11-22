// src/modules/agent/title.ts
// 会话标题生成：收到新会话的首条用户消息后，立即依据问题生成标题（不等待首轮回复结束）。
// 设计：
//   - 非流式单次调用，失败/超时返回 null，由调用方保持原标题（不阻断主流程）；
//   - 提示词外部化为 agent/prompt/title/generate.md，用户可通过 ~/.moss/agent/prompt/title/generate.md 覆盖。

import type { Environment } from '../../core/types';
import type { LLMRouter } from '../contracts';
import { loadPromptFileOrNull } from '../context/prompt-loader';
import { effortToThinking, resolveAuxRequestModel } from './aux-model';

/** 标题长度上限（超过视为模型在回答/解释，而不是标题） */
const MAX_TITLE_CHARS = 30;

/** 标题生成超时（ms） */
const TITLE_TIMEOUT_MS = 30_000;

export interface GenerateSessionTitleInput {
  env: Environment;
  llm: LLMRouter;
  /** provider 模型列表（id → model 映射） */
  apiModels: Array<{ id: string; model: string }>;
  config: {
    enabled: boolean;
    /** 模型 id；'' / 'inherit' = 主模型 */
    model: string;
    reasoningEffort: string;
  };
  /** 本轮主模型请求名 */
  mainRequestModel: string;
  /** 首条用户消息（已剥离内部注入内容由调用方保证） */
  userText: string;
  signal?: AbortSignal;
}

/**
 * 生成会话标题。
 * @returns 清理后的标题；未启用/空输出/失败/超时返回 null。
 */
export async function generateSessionTitle(input: GenerateSessionTitleInput): Promise<string | null> {
  const { env, llm, apiModels, config, mainRequestModel, userText } = input;
  if (!config.enabled) return null;
  const demand = userText.trim();
  if (!demand) return null;

  const systemPrompt = loadPromptFileOrNull(env, 'title/generate.md')?.trim();
  if (!systemPrompt) return null;
  const model = resolveAuxRequestModel(config.model, mainRequestModel, apiModels);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  const onOuterAbort = (): void => controller.abort();
  input.signal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const response = await llm.complete(
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `用户需求：\n${demand.slice(0, 2000)}` },
        ],
        stream: false,
        max_tokens: 48,
        temperature: 0,
        thinking: effortToThinking(config.reasoningEffort),
      },
      controller.signal,
    );
    return parseTitle(response.content);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** 清洗模型输出：去围栏/引号/首行外内容/结尾标点，限制长度 */
export function cleanTitle(raw: string): string | null {
  let text = (raw ?? '').trim();
  if (!text) return null;
  text = text
    .replace(/^```(?:[a-z-]+)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '');
  if (!firstLine) return null;
  let title = firstLine
    .replace(/^[\s"'“”‘’《》「」【】#*>-]+/, '')
    // 尾部引号/括号/标点可能交替出现（如 “标题”。），一次性清除整段尾缀
    .replace(/[\s"'“”‘’《》「」【】*。.!！?？;；:：,，]+$/, '')
    .trim();
  if (!title) return null;
  title = title.slice(0, 40);
  return title;
}

/** 判断清洗后的文本是否更像「回答/自我介绍」而不是标题 */
export function looksLikeAnswerTitle(title: string): boolean {
  if (!title) return false;
  if (title.length > MAX_TITLE_CHARS) return true;
  if (/^(i am|i'm|as an ai|as an assistant|我是|作为|抱歉|很抱歉|当然|好的[,，]|sure[,，])/i.test(title)) {
    return true;
  }
  // 句末标点：中文句号/问号/叹号，或英文标点后跟空白/结尾（避免 v1.2.3 这类版本号误判）
  const sentenceEnds = (title.match(/[。！？!?]|[.](?:\s|$)/g) ?? []).length;
  return sentenceEnds >= 2;
}

/**
 * 解析标题输出：
 * - 优先取 <title>…</title>（强提示词要求模型只输出该标签）；
 * - 无标签时退回 cleanTitle（兼容其他模型）；
 * - 命中「回答特征」返回 null，由调用方保持「新任务」。
 */
export function parseTitle(raw: string): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const tagged = /<title>([\s\S]*?)<\/title>/i.exec(text);
  const title = cleanTitle(tagged ? tagged[1] : text);
  if (!title) return null;
  if (looksLikeAnswerTitle(title)) return null;
  return title;
}
