// src/modules/llm/providers/multimodal.test.ts
// 多模态图片映射测试：user 附件图片 / tool 结果图片 → 各 provider 原生请求结构。
// 覆盖统一约定：data 为纯 base64（不含 data URI 前缀）。

import { describe, test, expect } from 'vitest';
import { OpenAIChatProvider } from './openai-chat';
import { OpenAIResponsesProvider } from './openai-responses';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import type { ModelConfig, UnifiedImage, UnifiedMessage, UnifiedRequest } from '../types';

const IMG: UnifiedImage = { data: 'AAAA', mimeType: 'image/png', path: 'D:\\a.png' };

function cfg(format: ModelConfig['format']): ModelConfig {
  return { format, endpoint: 'https://x', apiKey: 'k', model: 'm', thinking: { enabled: false } };
}

function req(messages: UnifiedMessage[]): UnifiedRequest {
  return { model: 'm', messages, stream: false };
}

describe('多模态图片映射', () => {
  test('openai-chat：user 图片 → content parts；tool 图片 → 工具块之后追加 user 消息', () => {
    const body = new OpenAIChatProvider().transformRequest(
      req([
        { role: 'user', content: '看', images: [IMG] },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { role: 'tool', content: '[image: image/png]', toolCallId: 'tc1', images: [IMG] },
      ]),
      cfg('openai-chat'),
    ) as { messages: Array<Record<string, unknown>> };

    const userContent = body.messages[0].content as unknown[];
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent[1]).toMatchObject({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });

    const toolIdx = body.messages.findIndex(m => m.role === 'tool');
    // tool 消息 content 仍为字符串（OpenAI Chat 不支持数组）
    expect(body.messages[toolIdx].content).toBe('[image: image/png]');
    // 图片 user 消息在工具块之后（单 tool 时即紧随其后）
    expect(body.messages[toolIdx + 1].role).toBe('user');
    expect(JSON.stringify(body.messages[toolIdx + 1])).toContain('data:image/png;base64,AAAA');
  });

  test('openai-chat：多 tool + 中间 tool 带图片 → tool 消息连续覆盖全部 id，图片 user 消息在工具块之后', () => {
    const body = new OpenAIChatProvider().transformRequest(
      req([
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc1', type: 'function', function: { name: 'read', arguments: '{}' } },
            { id: 'tc2', type: 'function', function: { name: 'grep', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: '[image: image/png]', toolCallId: 'tc1', images: [IMG] },
        { role: 'tool', content: 'ok', toolCallId: 'tc2' },
      ]),
      cfg('openai-chat'),
    ) as { messages: Array<Record<string, unknown>> };

    const assistantIdx = body.messages.findIndex(m => Array.isArray(m.tool_calls));
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    // assistant.tool_calls 之后必须紧跟覆盖全部 tool_call_id 的连续 tool 消息
    expect(body.messages[assistantIdx + 1].role).toBe('tool');
    expect(body.messages[assistantIdx + 1].tool_call_id).toBe('tc1');
    expect(body.messages[assistantIdx + 2].role).toBe('tool');
    expect(body.messages[assistantIdx + 2].tool_call_id).toBe('tc2');
    // 图片 user 消息被延迟到整个工具块之后
    expect(body.messages[assistantIdx + 3].role).toBe('user');
    expect(JSON.stringify(body.messages[assistantIdx + 3])).toContain('data:image/png;base64,AAAA');
  });

  test('openai-responses：多 tool + 中间 tool 带图片 → function_call/function_call_output 连续配对，图片 user 消息在工具块之后', () => {
    const body = new OpenAIResponsesProvider().transformRequest(
      req([
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '调用工具',
          toolCalls: [
            { id: 'tc1', type: 'function', function: { name: 'read', arguments: '{}' } },
            { id: 'tc2', type: 'function', function: { name: 'grep', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: '[image: image/png]', toolCallId: 'tc1', images: [IMG] },
        { role: 'tool', content: 'ok', toolCallId: 'tc2' },
      ]),
      cfg('openai-responses'),
    ) as { input: Array<Record<string, unknown>> };

    const fcIdx1 = body.input.findIndex(i => i.type === 'function_call' && i.call_id === 'tc1');
    const fcIdx2 = body.input.findIndex(i => i.type === 'function_call' && i.call_id === 'tc2');
    const outIdx1 = body.input.findIndex(i => i.type === 'function_call_output' && i.call_id === 'tc1');
    const outIdx2 = body.input.findIndex(i => i.type === 'function_call_output' && i.call_id === 'tc2');
    // assistant.tool_calls 必须展开为 function_call 项（否则 output 找不到配对会 400）
    expect(fcIdx1).toBeGreaterThanOrEqual(0);
    expect(fcIdx2).toBeGreaterThanOrEqual(0);
    expect(body.input[fcIdx1]).toMatchObject({ type: 'function_call', call_id: 'tc1', name: 'read' });
    // 两个 function_call_output 必须连续，且都排在 function_call 之后（中间不得插入 user 消息）
    expect(outIdx1).toBeGreaterThan(fcIdx2);
    expect(outIdx2).toBe(outIdx1 + 1);
    // 图片 user 消息被延迟到整个工具块之后
    expect(body.input[outIdx2 + 1].role).toBe('user');
    expect(JSON.stringify(body.input[outIdx2 + 1])).toContain('data:image/png;base64,AAAA');
  });

  test('anthropic：tool_result.content 内嵌 image block（不新增 user 消息）', () => {
    const body = new AnthropicProvider().transformRequest(
      req([{ role: 'tool', content: '读完了', toolCallId: 'tu1', name: 'read', images: [IMG] }]),
      cfg('anthropic'),
    ) as { messages: Array<{ content: Array<{ type: string; content?: unknown[] }> }> };

    // 只有一条消息（无额外 user 消息，避免破坏角色交替）
    expect(body.messages).toHaveLength(1);
    const block = body.messages[0].content[0];
    expect(block.type).toBe('tool_result');
    expect(block.content?.[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  test('anthropic：user 图片 → content blocks', () => {
    const body = new AnthropicProvider().transformRequest(
      req([{ role: 'user', content: '看', images: [IMG] }]),
      cfg('anthropic'),
    ) as { messages: Array<{ content: unknown[] }> };

    expect(body.messages[0].content[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  test('gemini：tool 图片 → functionResponse 同 content 追加 inlineData', () => {
    const body = new GeminiProvider().transformRequest(
      req([{ role: 'tool', content: '{"ok":true}', toolCallId: 'tu1', name: 'read', images: [IMG] }]),
      cfg('gemini'),
    ) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };

    const parts = body.contents[0].parts;
    expect(parts[0].functionResponse).toBeDefined();
    expect(parts[1]).toMatchObject({ inlineData: { mimeType: 'image/png', data: 'AAAA' } });
  });

  test('openai-responses：user 图片 → input_image', () => {
    const body = new OpenAIResponsesProvider().transformRequest(
      req([{ role: 'user', content: '看', images: [IMG] }]),
      cfg('openai-responses'),
    ) as { input: Array<{ content: Array<Record<string, unknown>> }> };

    expect(body.input[0].content[0]).toMatchObject({ type: 'input_text', text: '看' });
    expect(body.input[0].content[1]).toMatchObject({
      type: 'input_image',
      image_url: 'data:image/png;base64,AAAA',
    });
  });

  test('无图片时 content 保持原字符串（零回归）', () => {
    const body = new OpenAIChatProvider().transformRequest(
      req([{ role: 'user', content: 'hi' }]),
      cfg('openai-chat'),
    ) as { messages: Array<{ content: unknown }> };
    expect(body.messages[0].content).toBe('hi');
  });
});
