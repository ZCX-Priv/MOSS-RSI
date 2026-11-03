// src/modules/context/budgeter/estimator.test.ts
// 字节估算测试：UTF-8 口径（含多字节 CJK 与 emoji 代理对）、消息级文本字节构成。

import { describe, test, expect } from 'bun:test';
import {
  estimateTextBytes,
  estimateMessageBytes,
  estimateMessageTokens,
  estimateMessagesTokens,
} from './estimator';
import type { ContextMessage } from '../types';

describe('estimator（字节口径）', () => {
  test('estimateTextBytes：与 Buffer.byteLength(utf8) 一致', () => {
    expect(estimateTextBytes('')).toBe(0);
    expect(estimateTextBytes('abc')).toBe(3);
    // CJK：3 字节/字符
    expect(estimateTextBytes('中文')).toBe(6);
    // emoji（代理对）：4 字节
    expect(estimateTextBytes('🙂')).toBe(4);
  });

  test('estimateMessageBytes：累加 content / name / toolCallId / toolCalls 参数', () => {
    const base: ContextMessage = { role: 'user', content: '中文' };
    const minimal = estimateMessageBytes(base);
    expect(minimal).toBeGreaterThanOrEqual(6);

    const withTool: ContextMessage = {
      role: 'tool',
      content: 'r',
      toolCallId: 'call_1',
      name: 'read',
    };
    expect(estimateMessageBytes(withTool)).toBe(
      minimal - 6 + 1 + 'call_1'.length + 'read'.length,
    );

    const withCalls: ContextMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 't1', name: 'read', arguments: '{"path":"a.ts"}' }],
    };
    expect(estimateMessageBytes(withCalls)).toBeGreaterThan('{"path":"a.ts"}'.length);
  });

  test('estimateMessageBytes 不含图片字节（图片由 view-builder 按文件大小核算）', () => {
    const withImage: ContextMessage = {
      role: 'tool',
      content: 'x',
      images: ['C:\\some\\big.png'],
    };
    const withoutImage: ContextMessage = { role: 'tool', content: 'x' };
    expect(estimateMessageBytes(withImage)).toBe(estimateMessageBytes(withoutImage));
  });

  test('thinking 默认不计入 token（provider 不回传时会虚高数倍）', () => {
    const withThinking: ContextMessage = {
      role: 'assistant',
      content: 'short answer',
      thinking: '很长的思考内容 '.repeat(1000),
    };
    const withoutThinking: ContextMessage = { role: 'assistant', content: 'short answer' };
    expect(estimateMessageTokens(withThinking)).toBe(estimateMessageTokens(withoutThinking));
    expect(estimateMessagesTokens([withThinking])).toBeLessThan(
      estimateMessagesTokens([withThinking], true),
    );
    expect(estimateMessageBytes(withThinking)).toBe(estimateMessageBytes(withoutThinking));
    expect(estimateMessageBytes(withThinking, true)).toBeGreaterThan(
      estimateMessageBytes(withoutThinking),
    );
  });
});
