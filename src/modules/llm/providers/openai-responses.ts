// src/modules/llm/providers/openai-responses.ts
// OpenAI Responses API provider（2025 年新格式）。
// 端点：/v1/responses，使用 input/output 结构，reasoning.effort + reasoning.summary。

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
    // Responses API 用 input 数组替代 messages
    const input = toResponsesInputs(req.messages);

    const body: Record<string, unknown> = {
      model: req.model,
      input,
      stream: req.stream,
    };
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
    // 解析 output 数组：提取 message + reasoning + function_call
    let content = '';
    let thinking: string | undefined;
    const toolCalls: UnifiedToolCall[] = [];

    for (const item of data.output ?? []) {
      if (item.type === 'message' && item.role === 'assistant') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text') {
            content += part.text;
          }
        }
      } else if (item.type === 'reasoning') {
        // reasoning 摘要
        for (const part of item.content ?? []) {
          if (part.type === 'summary_text' || part.type === 'output_text') {
            thinking = (thinking ?? '') + (part.text ?? '');
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

    const usage: UnifiedUsage = {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      reasoning_tokens: undefined,
      cached_tokens: (
        data.usage as { input_tokens_details?: { cached_tokens?: number } } | undefined
      )?.input_tokens_details?.cached_tokens,
    };
    if (typeof data.usage === 'object' && data.usage !== null && 'output_tokens_details' in data.usage) {
      const details = (data.usage as { output_tokens_details?: { reasoning_tokens?: number } }).output_tokens_details;
      if (details?.reasoning_tokens !== undefined) {
        usage.reasoning_tokens = details.reasoning_tokens;
      }
    }

    return {
      content,
      thinking,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: mapStatus(data.status),
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

    const deltas: StreamDelta[] = [];
    switch (data.type) {
      case 'response.output_text.delta':
        if (data.delta) deltas.push({ type: 'text', text: data.delta });
        break;
      case 'response.reasoning_summary_text.delta':
        if (data.delta) deltas.push({ type: 'thinking', text: data.delta });
        break;
      case 'response.function_call_arguments.delta':
        deltas.push({
          type: 'tool_call',
          toolCallId: data.item_id ?? '',
          name: '',
          argumentsDelta: data.delta ?? '',
          index: data.output_index ?? 0,
        });
        break;
      case 'response.output_item.added':
        if (data.item?.type === 'function_call') {
          deltas.push({
            type: 'tool_call',
            toolCallId: data.item.call_id ?? '',
            name: data.item.name ?? '',
            argumentsDelta: '',
            index: data.output_index ?? 0,
          });
        }
        break;
      case 'response.completed':
        if (data.response?.usage) {
          const u = data.response.usage as {
            input_tokens?: number;
            output_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
          };
          deltas.push({
            type: 'usage',
            usage: {
              prompt_tokens: u.input_tokens ?? 0,
              completion_tokens: u.output_tokens ?? 0,
              total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
              cached_tokens: u.input_tokens_details?.cached_tokens,
            },
          });
        }
        deltas.push({ type: 'finish', finishReason: mapStatus(data.response?.status) });
        break;
      default:
        // 忽略其他事件类型
        return null;
    }
    return deltas.length === 0 ? null : deltas.length === 1 ? deltas[0] : deltas;
  }

  resolveEndpoint(cfg: ModelConfig): string {
    const base = cfg.endpoint.replace(/\/$/, '');
    if (base.endsWith('/v1')) return `${base}/responses`;
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
  // system 消息在 Responses API 中用 instructions 字段，或作为 input 中的 system 项
  if (msg.role === 'system') {
    return [{ type: 'system', content: msg.content }];
  }
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
  // user / assistant
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

function mapStatus(s: string | undefined): 'stop' | 'tool_use' | 'length' | 'error' {
  if (!s) return 'stop';
  if (s === 'completed') return 'stop';
  if (s === 'incomplete') return 'length';
  if (s === 'failed') return 'error';
  return 'stop';
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
// 类型定义（OpenAI Responses 原生格式）
// ============================================================================

interface OpenAIResponsesResponse {
  output?: Array<{
    type: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    role?: string;
    status?: string;
    content?: Array<{
      type: string;
      text?: string;
    }>;
  }>;
  status?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

interface OpenAIResponsesStreamEvent {
  type: string;
  delta?: string;
  item_id?: string;
  output_index?: number;
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
  };
  response?: OpenAIResponsesResponse;
}
