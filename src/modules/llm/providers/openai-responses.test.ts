// src/modules/llm/providers/openai-responses.test.ts
// Responses API provider：请求构造（instructions / 工具配对 / 端点解析）
// 与非流式/流式双格式解析（含旧版聚合字段与最新事件）。

import { describe, test, expect } from 'bun:test';
import { OpenAIResponsesProvider } from './openai-responses';
import type { ModelConfig, StreamDelta, UnifiedMessage, UnifiedRequest } from '../types';

function cfg(): ModelConfig {
  return {
    format: 'openai-responses',
    endpoint: 'https://api.openai.com',
    apiKey: 'k',
    model: 'm',
    thinking: { enabled: false },
  };
}

function req(messages: UnifiedMessage[]): UnifiedRequest {
  return { model: 'm', messages, stream: false };
}

interface RequestBodyShape {
  instructions?: string;
  input?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  stream?: boolean;
}

describe('openai-responses 请求构造', () => {
  test('system 消息进入 instructions，input 不再包含 system 项', () => {
    const body = new OpenAIResponsesProvider().transformRequest(
      req([
        { role: 'system', content: '规则 A' },
        { role: 'system', content: '规则 B' },
        { role: 'user', content: '你好' },
      ]),
      cfg(),
    ) as RequestBodyShape;

    expect(body.instructions).toBe('规则 A\n\n规则 B');
    expect(body.input).toHaveLength(1);
    expect(body.input?.[0]).toMatchObject({ type: 'message', role: 'user', content: '你好' });
    expect(body.input?.some((item) => item.role === 'system')).toBe(false);
  });

  test('tool 调用/结果连续配对，工具块中的图片消息延迟到工具块之后', () => {
    const body = new OpenAIResponsesProvider().transformRequest(
      req([
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":"a.png"}' } },
            { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"p":"b.txt"}' } },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call_1',
          content: '[image: image/png]',
          images: [{ data: 'AAAA', mimeType: 'image/png' }],
        },
        { role: 'tool', toolCallId: 'call_2', content: 'file content' },
        { role: 'user', content: '继续' },
      ]),
      cfg(),
    ) as RequestBodyShape;

    const input = body.input ?? [];
    // function_call 展开为独立项，function_call_output 紧随其后
    expect(input[1]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'read' });
    expect(input[2]).toMatchObject({ type: 'function_call', call_id: 'call_2', name: 'read' });
    expect(input[3]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    expect(input[4]).toMatchObject({ type: 'function_call_output', call_id: 'call_2' });
    // 图片消息在工具块结束后、下一条 user 消息之前
    const imageMsg = input[5] as { role?: string; content?: unknown };
    expect(imageMsg.role).toBe('user');
    expect(JSON.stringify(imageMsg.content)).toContain('data:image/png;base64,AAAA');
    expect(input[6]).toMatchObject({ type: 'message', role: 'user', content: '继续' });
  });

  test('端点已包含 /responses 时原样使用；/openai 末尾补 /v1', () => {
    const provider = new OpenAIResponsesProvider();
    expect(provider.resolveEndpoint({ ...cfg(), endpoint: 'https://api.openai.com/v1/responses/' })).toBe(
      'https://api.openai.com/v1/responses',
    );
    expect(provider.resolveEndpoint({ ...cfg(), endpoint: 'https://api.openai.com/v1' })).toBe(
      'https://api.openai.com/v1/responses',
    );
    expect(provider.resolveEndpoint({ ...cfg(), endpoint: 'https://x.openai.azure.com/openai' })).toBe(
      'https://x.openai.azure.com/openai/v1/responses',
    );
  });
});

describe('openai-responses 非流式响应解析', () => {
  test('最新结构：output_text + reasoning.summary + function_call + usage', () => {
    const result = new OpenAIResponsesProvider().transformResponse({
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '思考内容' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回答' }] },
        { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"p":"a.ts"}' },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    });

    expect(result.content).toBe('回答');
    expect(result.thinking).toBe('思考内容');
    expect(result.tool_calls?.[0]).toMatchObject({
      id: 'call_1',
      function: { name: 'read', arguments: '{"p":"a.ts"}' },
    });
    expect(result.finish_reason).toBe('stop');
    expect(result.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      reasoning_tokens: 2,
      cached_tokens: 4,
    });
  });

  test('旧版结构：reasoning.content[].summary_text + output_text 聚合兜底', () => {
    const result = new OpenAIResponsesProvider().transformResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'reasoning', content: [{ type: 'summary_text', text: '旧思考' }] }],
      output_text: '旧回答',
      usage: { input_tokens: 3, output_tokens: 2 },
    });

    expect(result.content).toBe('旧回答');
    expect(result.thinking).toBe('旧思考');
    expect(result.finish_reason).toBe('length');
    expect(result.usage.total_tokens).toBe(5);
  });

  test('refusal 内容块按正文返回；content_filter 映射 error', () => {
    const result = new OpenAIResponsesProvider().transformResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: '无法回答' }] },
      ],
    });

    expect(result.content).toBe('无法回答');
    expect(result.finish_reason).toBe('error');
  });

  test('failed 状态映射 error', () => {
    const result = new OpenAIResponsesProvider().transformResponse({
      status: 'failed',
      output: [],
      error: { message: 'boom' },
    });
    expect(result.finish_reason).toBe('error');
  });
});

describe('openai-responses 流式事件解析', () => {
  test('output_item.added 提供 call_id，参数增量不得覆盖为 item_id', () => {
    const provider = new OpenAIResponsesProvider();
    const added = provider.transformStreamChunk(
      JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '' },
      }),
    ) as StreamDelta;
    expect(added).toMatchObject({
      type: 'tool_call',
      toolCallId: 'call_1',
      name: 'read',
      index: 0,
    });

    const delta = provider.transformStreamChunk(
      JSON.stringify({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 0,
        delta: '{"p":',
      }),
    ) as StreamDelta;
    expect(delta).toMatchObject({
      type: 'tool_call',
      toolCallId: '',
      argumentsDelta: '{"p":',
      index: 0,
    });
  });

  test('reasoning_text.delta 映射 thinking；refusal.delta 映射 text', () => {
    const provider = new OpenAIResponsesProvider();
    expect(
      provider.transformStreamChunk(
        JSON.stringify({ type: 'response.reasoning_text.delta', delta: '推理' }),
      ),
    ).toEqual({ type: 'thinking', text: '推理' });
    expect(
      provider.transformStreamChunk(
        JSON.stringify({ type: 'response.refusal.delta', delta: '拒绝' }),
      ),
    ).toEqual({ type: 'text', text: '拒绝' });
  });

  test('completed 产出 usage + finish；incomplete/failed/error 产出错误', () => {
    const provider = new OpenAIResponsesProvider();

    const completed = provider.transformStreamChunk(
      JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    ) as StreamDelta[];
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ type: 'usage' });
    expect(completed[1]).toEqual({ type: 'finish', finishReason: 'stop' });

    const incomplete = provider.transformStreamChunk(
      JSON.stringify({
        type: 'response.incomplete',
        response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
      }),
    ) as StreamDelta[];
    expect(incomplete[0]).toMatchObject({ type: 'error' });
    expect(incomplete[1]).toEqual({ type: 'finish', finishReason: 'error' });

    const failed = provider.transformStreamChunk(
      JSON.stringify({
        type: 'response.failed',
        response: { status: 'failed', error: { message: 'boom' } },
      }),
    ) as StreamDelta[];
    expect(failed[0]).toEqual({ type: 'error', message: 'boom' });
    expect(failed[1]).toEqual({ type: 'finish', finishReason: 'error' });

    expect(provider.transformStreamChunk(JSON.stringify({ type: 'error', message: '网络错误' }))).toEqual({
      type: 'error',
      message: '网络错误',
    });
  });

  test('未知/生命周期事件（created、done、content_part）一律忽略', () => {
    const provider = new OpenAIResponsesProvider();
    for (const type of [
      'response.created',
      'response.in_progress',
      'response.queued',
      'response.output_item.done',
      'response.content_part.added',
      'response.output_text.done',
      'response.function_call_arguments.done',
    ]) {
      expect(provider.transformStreamChunk(JSON.stringify({ type }))).toBeNull();
    }
  });
});
