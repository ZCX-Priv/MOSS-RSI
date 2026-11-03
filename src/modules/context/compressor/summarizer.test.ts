// src/modules/context/compressor/summarizer.test.ts
// 摘要区配对净化：中断工具留下的 assistant(tool_calls) → user → tool
// 必须在发给摘要模型前修平，否则 provider 返回 HTTP 400（压缩反复失败）。

import { describe, test, expect } from 'bun:test';
import { sanitizeCompactionRegion } from './summarizer';
import type { ContextMessage } from '../types';

describe('sanitizeCompactionRegion', () => {
  test('无配对 assistant 剥离 toolCalls，孤立 tool 结果丢弃', () => {
    const region: ContextMessage[] = [
      {
        role: 'assistant',
        content: '执行中',
        toolCalls: [{ id: 'call_1', name: 'run_code', arguments: '{}' }],
      },
      { role: 'user', content: '别跑了' },
      { role: 'tool', content: 'Error: aborted', toolCallId: 'call_1', isError: true },
    ];
    const out = sanitizeCompactionRegion(region);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(out[0].toolCalls).toBeUndefined();
    expect(out[0].content).toBe('执行中');
  });

  test('完整配对保持 assistant + tool 顺序', () => {
    const region: ContextMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: '{}' }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'call_1' },
    ];
    const out = sanitizeCompactionRegion(region);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(out[0].toolCalls?.[0].id).toBe('call_1');
  });
});
