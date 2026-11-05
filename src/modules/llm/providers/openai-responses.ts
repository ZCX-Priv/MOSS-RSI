// src/modules/llm/providers/openai-responses.ts
// OpenAI Responses API provider（兼容 2025 旧格式与最新标准）。
// 端点：/v1/responses，使用 input/output 结构，reasoning.effort + reasoning.summary。
//
// 兼容策略（刻意保持「请求保守」）：
//  - 请求只使用新老两代都支持的字段：instructions / input / max_output_tokens / reasoning 等；
//    不发送 store/include/text/parallel_tool_calls/stream_options/prompt_cache_* 等新-only 字段。
//  - 解析同时兼容最新输出结构与旧版结构（output_text 聚合、旧 reasoning summary_text、
//    refusal、reasoning_text、incomplete/failed/error 事件）。
//  - 流式解析保持无状态：provider 为单例会被并发会话复用，禁止跨请求累积状态；
//    done 事件与已累计 delta 重复，一律忽略。

import type {
  LLMProvider,
  ModelConfig,
  ProviderFormat,
  StreamDelta,
  UnifiedImage,
  UnifiedMessage,
  UnifiedRequest,
  UnifiedResponse,
  UnifiedToolCall,
  UnifiedUsage,
  ThinkingConfig,
} from '../types';

export class OpenAIResponsesProvider implements LLMProvider {
  readonly format: ProviderFormat = 'openai-responses';

  transformRequest(req: UnifiedRequest, cfg: ModelConfig): unknown {
    // 系统提示统一放入顶层 instructions（Responses API 自发布起即支持，新老端点通用）
    const { instructions, messages } = splitSystemMessages(req.messages);
    const input = toResponsesInputs(messages);

    const body: Record<string, unknown> = {
      model: req.model,
      input,
      stream: req.stream,
    };
    if (instructions) body.instructions = instructions;

    // 采样参数：请求级优先，模型配置兜底（OpenAI 不支持 top_k，忽略）
    const temperature = req.temperature ?? cfg.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    const maxTokens = req.max_tokens ?? cfg.outputTokens;
    if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
    const topP = req.top_p ?? cfg.topP;
    if (topP !== undefined) body.top_p = topP;

    // 工具（Responses API 用 tools 数组，type 为 function）
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(t => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
      if (req.toolChoice) {
        body.tool_choice = req.toolChoice === 'required' ? 'required' : req.toolChoice;
      }
    }

    // 思考控制
    const thinking = mergeThinking(cfg.thinking, req.thinking);
    const thinkingParams = toOpenAIResponsesThinking(thinking);
    Object.assign(body, thinkingParams);

    return body;
  }

  transformResponse(raw: unknown): UnifiedResponse {
    const data = raw as OpenAIResponsesResponse;
    // 解析 output 数组：message / reasoning / function_call；同时兼容旧版结构。
    let content = '';
    let reasoningSummary = '';
    let reasoningContent = '';
    const toolCalls: UnifiedToolCall[] = [];

    for (const item of data.output ?? []) {
      if (item.type === 'message' && item.role === 'assistant') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' || part.type === 'text') {
            content += part.text ?? '';
          } else if (part.type === 'refusal') {
            // 最新标准：模型拒绝回答时正文在 refusal 字段
            content += part.refusal ?? '';
          } else if (typeof part.text === 'string') {
            // 兼容未知/第三方内容块（有 text 即视为正文）
            content += part.text;
          }
        }
      } else if (item.type === 'reasoning') {
        // 最新标准：summary[].text；旧标准：content[].summary_text / output_text
        for (const part of item.summary ?? []) {
          reasoningSummary += part.text ?? '';
        }
        for (const part of item.content ?? []) {
          if (typeof part.text === 'string' && part.text) {
            reasoningContent += part.text;
          } else if (typeof part.refusal === 'string' && part.refusal) {
            reasoningContent += part.refusal;
          }
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id ?? item.id ?? '',
          type: 'function',
          function: {
            name: item.name ?? '',
            arguments: item.arguments ?? '',
          },
        });
      }
    }

    // 旧版聚合字段兜底：output 中没有可用正文时使用 output_text
    if (!content && typeof data.output_text === 'string') {
      content = data.output_text;
    }

    // summary 优先（请求了 summary 时 content 通常为空）；两者都有时避免重复拼接
    const thinking = reasoningSummary || reasoningContent || undefined;
    const usage = toUnifiedUsage(data.usage);

    return {
      content,
      thinking,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: mapStatus(data),
      usage,
      raw,
    };
  }

  transformStreamChunk(raw: string): StreamDelta | StreamDelta[] | null {
    let data: OpenAIResponsesStreamEvent;
    try {
      data = JSON.parse(raw) as OpenAIResponsesStreamEvent;
    } catch {
      return null;
    }

    switch (data.type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        return data.delta ? { type: 'text', text: data.delta } : null;

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return data.delta ? { type: 'thinking', text: data.delta } : null;

      case 'response.output_item.added':
        if (data.item?.type === 'function_call') {
          return {
            type: 'tool_call',
            toolCallId: data.item.call_id ?? '',
            name: data.item.name ?? '',
            // 少数兼容端点会在 added 中直接带完整 arguments；官方通常为空串
            argumentsDelta: data.item.arguments ?? '',
            index: data.output_index ?? 0,
          };
        }
        return null;

      case 'response.function_call_arguments.delta':
        // 关键：item_id ≠ call_id。工具结果的配对准据是 output_item.added 中的 call_id，
        // 这里的增量不得把 item_id 当作 toolCallId（否则会覆盖引擎已记录的正确 call_id）。
        return {
          type: 'tool_call',
          toolCallId: data.call_id ?? '',
          name: '',
          argumentsDelta: data.delta ?? '',
          index: data.output_index ?? 0,
        };

      case 'response.completed': {
        const deltas: StreamDelta[] = [];
        const usage = toUnifiedUsage(data.response?.usage);
        if (data.response?.usage) deltas.push({ type: 'usage', usage });
        deltas.push({ type: 'finish', finishReason: 'stop' });
        return deltas;
      }

      case 'response.incomplete': {
        const reason = data.response?.incomplete_details?.reason;
        const deltas: StreamDelta[] = [];
        if (data.response?.usage) {
          deltas.push({ type: 'usage', usage: toUnifiedUsage(data.response.usage) });
        }
        if (reason === 'content_filter') {
          deltas.push({ type: 'error', message: 'Response incomplete: content_filter' });
          deltas.push({ type: 'finish', finishReason: 'error' });
        } else {
          deltas.push({ type: 'finish', finishReason: 'length' });
        }
        return deltas;
      }

      case 'response.failed': {
        const message = data.response?.error?.message ?? 'Response failed';
        return [
          { type: 'error', message },
          { type: 'finish', finishReason: 'error' },
        ];
      }

      case 'error': {
        return {
          type: 'error',
          message: data.message ?? data.error?.message ?? 'Stream error',
        };
      }

      default:
        // 忽略 response.created/in_progress/queued、各类 done、content_part、
        // annotation 等不产生增量的生命周期事件
        return null;
    }
  }

  resolveEndpoint(cfg: ModelConfig): string {
    const base = cfg.endpoint.replace(/\/$/, '');
    // 用户直接粘贴完整端点时原样使用，避免重复拼接
    if (base.endsWith('/responses')) return base;
    if (base.endsWith('/v1')) return `${base}/responses`;
    // Azure 常见形态：https://host/openai （不带 /v1）
    if (base.endsWith('/openai')) return `${base}/v1/responses`;
    return `${base}/v1/responses`;
  }

  resolveHeaders(cfg: ModelConfig): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    };
  }
}

// ============================================================================
// 思考参数转换
// ============================================================================

export function toOpenAIResponsesThinking(t: ThinkingConfig): Record<string, unknown> {
  if (!t.enabled) return { reasoning: { effort: 'none' } };
  return {
    reasoning: {
      effort: t.effort ?? 'medium',
      summary: 'auto',
    },
  };
}

// ============================================================================
// 内部 helper
// ============================================================================

/**
 * 拆分系统提示与其余消息。
 * Responses API 的 system 提示统一走顶层 instructions；input 中不再保留 system 项。
 */
function splitSystemMessages(msgs: UnifiedMessage[]): {
  instructions: string;
  messages: UnifiedMessage[];
} {
  const systemParts: string[] = [];
  const messages: UnifiedMessage[] = [];
  for (const msg of msgs) {
    if (msg.role === 'system') {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }
    messages.push(msg);
  }
  return { instructions: systemParts.join('\n\n'), messages };
}

/**
 * 统一消息 → Responses API input 数组。
 * function_call_output 只支持字符串 output，图片改由紧随其后的 user message 承载。
 *
 * 关键约束：assistant 的 function_call 之后必须紧跟覆盖全部 call_id 的连续 function_call_output。
 * 因此承载图片的 user message**不能**插在工具块中间——否则会切断工具块，
 * 使靠后的 function_call_output 不再与其 function_call 配对，provider 返回 HTTP 400。
 * 这里改为「延迟发射」：工具块内的图片 user message 先累积，待工具块结束
 * （遇到非 tool 消息或遍历结束）后统一追加，保证 function_call ↔ output 配对完整。
 */
function toResponsesInputs(msgs: UnifiedMessage[]): unknown[] {
  const out: unknown[] = [];
  let pendingImageMsgs: Array<Record<string, unknown>> = [];
  const flush = (): void => {
    if (pendingImageMsgs.length > 0) {
      out.push(...pendingImageMsgs);
      pendingImageMsgs = [];
    }
  };
  for (const msg of msgs) {
    // 非 tool 消息：工具块结束，先补发累积的图片承载消息
    if (msg.role !== 'tool') flush();
    out.push(...toResponsesInput(msg));
    if (msg.role === 'tool' && msg.images && msg.images.length > 0) {
      pendingImageMsgs.push({ type: 'message', role: 'user', content: contentWithImages('[图片]', msg.images) });
    }
  }
  flush();
  return out;
}

/**
 * 单条统一消息 → 一个或多个 Responses input 项。
 *
 * 关键：assistant 的 tool_calls 必须展开为独立的 `function_call` 项，
 * 否则后续的 `function_call_output` 找不到配对的 `call_id`，Responses API 返回 400
 * （「No tool call found for function call output ...」）。
 */
function toResponsesInput(msg: UnifiedMessage): unknown[] {
  if (msg.role === 'tool') {
    // 工具结果：function_call_output
    return [
      {
        type: 'function_call_output',
        call_id: msg.toolCallId,
        output: msg.content,
      },
    ];
  }
  // assistant 带工具调用：正文（若非空）放进 message，工具调用逐个展开为 function_call
  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    const items: unknown[] = [];
    if (msg.content) {
      items.push({ type: 'message', role: 'assistant', content: msg.content });
    }
    for (const tc of msg.toolCalls) {
      items.push({
        type: 'function_call',
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
    return items;
  }
  // user 带图片：多模态内容块
  if (msg.role === 'user' && msg.images && msg.images.length > 0) {
    return [{ type: 'message', role: 'user', content: contentWithImages(msg.content, msg.images) }];
  }
  // user / assistant（EasyInputMessage 允许 content 为字符串）
  return [
    {
      type: 'message',
      role: msg.role,
      content: msg.content,
    },
  ];
}

/** 文本 + 图片 → Responses API 输入内容块（input_text / input_image） */
function contentWithImages(text: string, images: UnifiedImage[]): unknown[] {
  const parts: unknown[] = [];
  if (text) parts.push({ type: 'input_text', text });
  for (const img of images) {
    parts.push({
      type: 'input_image',
      image_url: `data:${img.mimeType};base64,${img.data}`,
    });
  }
  return parts;
}

/** completion 状态 → 统一 finish_reason */
function mapStatus(data: OpenAIResponsesResponse): 'stop' | 'tool_use' | 'length' | 'error' {
  const status = data.status;
  if (!status) return 'stop';
  if (status === 'completed') return 'stop';
  if (status === 'incomplete') {
    return data.incomplete_details?.reason === 'content_filter' ? 'error' : 'length';
  }
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'stop';
}

/** 原生 usage → 统一 usage（兼容 total_tokens 缺失 / 旧版无 details） */
function toUnifiedUsage(u: OpenAIResponsesUsage | undefined): UnifiedUsage {
  const input = u?.input_tokens ?? 0;
  const output = u?.output_tokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: typeof u?.total_tokens === 'number' ? u.total_tokens : input + output,
    reasoning_tokens: u?.output_tokens_details?.reasoning_tokens,
    cached_tokens: u?.input_tokens_details?.cached_tokens,
  };
}

function mergeThinking(
  cfgThinking: ThinkingConfig,
  reqThinking?: ThinkingConfig,
): ThinkingConfig {
  if (!reqThinking) return cfgThinking;
  return {
    enabled: reqThinking.enabled,
    effort: reqThinking.effort ?? cfgThinking.effort,
    budgetTokens: reqThinking.budgetTokens ?? cfgThinking.budgetTokens,
  };
}

// ============================================================================
// 类型定义（OpenAI Responses 原生格式，含旧版兼容字段）
// ============================================================================

interface OpenAIResponsesContentPart {
  type?: string;
  text?: string;
  /** 最新标准：refusal 内容块 */
  refusal?: string;
}

interface OpenAIResponsesOutputItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  role?: string;
  status?: string;
  /** 旧版把 reasoning 摘要放在 content；最新标准放在 summary */
  content?: OpenAIResponsesContentPart[];
  summary?: OpenAIResponsesContentPart[];
}

interface OpenAIResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAIResponsesResponse {
  output?: OpenAIResponsesOutputItem[];
  /** 旧版聚合正文字段 */
  output_text?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  error?: { message?: string; code?: string };
  usage?: OpenAIResponsesUsage;
}

interface OpenAIResponsesStreamEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  output_index?: number;
  /** 部分第三方兼容端点在参数增量事件中提供 call_id */
  call_id?: string;
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: OpenAIResponsesResponse;
  error?: { message?: string; code?: string };
  /** 顶层 error 事件的消息字段 */
  message?: string;
}
