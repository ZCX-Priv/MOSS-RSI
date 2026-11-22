// src/modules/context/compressor/summarizer.ts
// 摘要生成：
// - 摘要请求 messages = [静态 system 前缀, ...被压缩区消息, 压缩指令]
//   ——复用主对话的 system 前缀，摘要请求本身命中前缀缓存
// - 指令从 agent/compact/compaction.md 加载（{{FOCUS}} 变量），缺失则抛错放弃本轮压缩
// - 单次失败不重试（summarizeOnce 语义）：空结果/截断 → 抛错，由调用方放弃本轮压缩

import type { Environment } from '../../../core/types';
import type { CompactionConfig, ContextMessage } from '../types';
import type { LLMRouter } from '../../contracts';
import type { UnifiedMessage, UnifiedRequest, UnifiedResponse } from '../../llm/types';
import { loadPromptFile, renderTemplate } from '../prompt-loader';
import { sanitizeMessages } from '../healer/pair-sanitize';

/** 手动压缩附加焦点的引导语前缀 */
const FOCUS_PREFIX = '\n\n本次压缩的附加焦点（优先保留以下内容）：';

/**
 * 加载压缩指令（agent/compact/compaction.md；缺失则抛错，调用方放弃本轮压缩）。
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

/**
 * 摘要请求前的配对净化（与主发送视图同一口径）。
 * 暴露为纯函数便于测试：assistant(tool_calls) → user → tool 的错位必须在这里被修平。
 */
export function sanitizeCompactionRegion(region: readonly ContextMessage[]): ContextMessage[] {
  return sanitizeMessages(region).messages;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 摘要超时（配置可能来自旧配置文件，运行时兜底） */
function resolveSummaryTimeoutMs(config: CompactionConfig): number {
  const v = config.summaryTimeoutMs;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, 600000) : 120000;
}

/** 是否值得重试的瞬时错误（4xx/空输出/截断不重试） */
function isTransientSummaryError(err: unknown): boolean {
  if (err instanceof SummarizeError) return false;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || status >= 500;
  }
  if (err instanceof TypeError) return true; // fetch failed
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ETIMEDOUT|socket hang up|aborted|timeout|fetch failed/i.test(msg);
}

/**
 * 带总超时的摘要调用：最多 2 次，仅瞬时错误重试，总耗时不超过 timeoutMs。
 * 超时/失败统一转 SummarizeError，由调用方放弃本轮压缩（不修改会话）。
 */
async function completeSummaryWithTimeout(
  llm: LLMRouter,
  request: UnifiedRequest,
  timeoutMs: number,
): Promise<UnifiedResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      return await llm.complete(request, controller.signal);
    } catch (err) {
      lastError = err;
      if (attempt === 1 || !isTransientSummaryError(err)) break;
      const wait = Math.min(500, Math.max(0, deadline - Date.now()));
      if (wait <= 0) break;
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError ?? '');
  if (lastError === undefined || /aborted|timeout/i.test(msg)) {
    throw new SummarizeError(`summarizer timed out after ${timeoutMs}ms`);
  }
  throw new SummarizeError(msg);
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
  // 摘要请求必须与主请求同一配对净化口径：用户中断工具会留下
  // assistant(tool_calls) → user → tool 的错位，直接原样发送会被 provider 以
  // “insufficient tool messages following tool_calls message” 拒绝（HTTP 400）。
  const sanitized = sanitizeCompactionRegion(region);
  if (sanitized.length === 0) {
    throw new SummarizeError('no valid messages after tool pair sanitize');
  }
  const messages: UnifiedMessage[] = [
    { role: 'system', content: staticSystemPrompt },
    ...regionToUnifiedMessages(sanitized),
    { role: 'user', content: instruction },
  ];

  const response = await completeSummaryWithTimeout(
    llm,
    {
      model: summaryModelId,
      messages,
      stream: false,
      max_tokens: config.summaryMaxTokens,
    },
    resolveSummaryTimeoutMs(config),
  );

  const summary = response.content.trim();
  if (summary === '') {
    throw new SummarizeError('summarizer returned empty output');
  }
  if (response.finish_reason === 'length') {
    throw new SummarizeError('summarizer output truncated (finish_reason=length)');
  }
  return summary;
}
