// src/modules/llm/request-budget.test.ts
// 请求体字节护栏测试：序列化字节统计、降级顺序（先丢图后截断）、
// 结构完整性（不删消息、保住 tool_calls ↔ tool 配对）、入参不可变。

import { describe, test, expect } from 'vitest';
import { serializedBodyBytes, shrinkUnifiedRequest } from './request-budget';
import type { UnifiedMessage } from './types';

const OPTS = { keepHeadChars: 10, keepTailChars: 5 };

describe('request-budget（请求体字节护栏）', () => {
  test('serializedBodyBytes 与 UTF-8 序列化字节一致（含 CJK）', () => {
    expect(serializedBodyBytes({ a: '1' })).toBe(Buffer.byteLength('{"a":"1"}', 'utf8'));
    expect(serializedBodyBytes({ a: '中' })).toBe(Buffer.byteLength('{"a":"中"}', 'utf8'));
  });

  test('第一步只丢图片，且优先丢 base64 体积最大的那条', () => {
    const msgs: UnifiedMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b', images: [{ data: 'x'.repeat(10), mimeType: 'image/png' }] },
      { role: 'user', content: 'c', images: [{ data: 'y'.repeat(100), mimeType: 'image/png' }] },
    ];
    const r = shrinkUnifiedRequest(msgs, OPTS);
    expect(r.changed).toBe(true);
    expect(r.droppedImages).toBe(1);
    expect(r.truncatedContents).toBe(0);
    // 最大的图（index 2）被丢；较小的（index 1）保留
    expect(r.messages[2].images).toBeUndefined();
    expect(r.messages[1].images).toHaveLength(1);
    expect(r.messages[2].content).toContain('省略');
    // 入参未被修改
    expect(msgs[2].images).toHaveLength(1);
  });

  test('无图可丢后截断最长的 tool/assistant content（system/user 不动）', () => {
    const long = 'H'.repeat(50) + 'M'.repeat(100) + 'T'.repeat(50);
    const msgs: UnifiedMessage[] = [
      { role: 'system', content: 'S'.repeat(500) },
      { role: 'user', content: 'U'.repeat(500) },
      { role: 'tool', toolCallId: 't1', content: long },
    ];
    const r = shrinkUnifiedRequest(msgs, OPTS);
    expect(r.changed).toBe(true);
    expect(r.truncatedContents).toBe(1);
    expect(r.droppedImages).toBe(0);
    expect(r.messages[0].content).toBe('S'.repeat(500));
    expect(r.messages[1].content).toBe('U'.repeat(500));
    expect(r.messages[2].content.startsWith('H'.repeat(10))).toBe(true);
    expect(r.messages[2].content.endsWith('T'.repeat(5))).toBe(true);
    expect(r.messages[2].content.length).toBeLessThan(long.length);
  });

  test('不删除消息、不破坏 tool_calls ↔ tool 配对（避免触发 400）', () => {
    const msgs: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      {
        role: 'tool',
        toolCallId: 't1',
        content: 'r',
        images: [{ data: 'z'.repeat(50), mimeType: 'image/png' }],
      },
    ];
    const r = shrinkUnifiedRequest(msgs, OPTS);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].toolCalls).toHaveLength(1);
    expect(r.messages[0].toolCalls?.[0].id).toBe('t1');
    expect(r.messages[1].toolCallId).toBe('t1');
  });

  test('无可降级目标时 changed=false', () => {
    const r = shrinkUnifiedRequest([{ role: 'user', content: 'hi' }], OPTS);
    expect(r.changed).toBe(false);
    expect(r.droppedImages).toBe(0);
    expect(r.truncatedContents).toBe(0);
  });
});
