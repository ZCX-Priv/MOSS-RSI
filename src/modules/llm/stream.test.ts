// src/modules/llm/stream.test.ts
// parseSSEStream 单测：正常解析 / 空闲超时可配置（长程任务放宽的关键）/ 非法值回退。
// 运行：bun test src/modules/llm/stream.test.ts

import { describe, it, expect } from 'bun:test';
import { parseSSEStream } from './stream';

const enc = new TextEncoder();

/** 按顺序产出给定文本块后正常关闭的流 */
function chunksStream(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

/** 永不产出、永不关闭的流（模拟弱网半开 / 模型长思考期间无任何数据） */
function stuckStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      /* 永不 enqueue、永不 close */
    },
  });
}

async function drain(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('parseSSEStream', () => {
  it('正常解析 data: 事件，遇 [DONE] 结束', async () => {
    const out = await drain(
      parseSSEStream(chunksStream(['data: a\n\ndata: b\n\ndata: [DONE]\n\n'])),
    );
    expect(out).toEqual(['a', 'b']);
  });

  it('空闲超时可覆盖：流停滞时抛出明确错误（不静默截断）', async () => {
    const it = parseSSEStream(stuckStream(), { idleTimeoutMs: 50 });
    let err: unknown = null;
    try {
      await drain(it);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/idle timeout/i);
  });

  it('idleTimeoutMs 非法（0 / NaN）时回退内置默认，不误判', async () => {
    expect(await drain(parseSSEStream(chunksStream(['data: x\n\n']), { idleTimeoutMs: 0 }))).toEqual(['x']);
    expect(
      await drain(parseSSEStream(chunksStream(['data: y\n\n']), { idleTimeoutMs: Number.NaN })),
    ).toEqual(['y']);
  });
});