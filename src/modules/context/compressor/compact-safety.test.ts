// src/modules/context/compressor/compact-safety.test.ts
// 压缩安全性：超时、瞬时重试、4xx 不重试、锚点丢失、失败不改会话。

import { describe, it, expect } from 'bun:test';
import { compactSession } from './index';
import { DEFAULT_COMPACTION_CONFIG, type CompactionConfig, type ContextMessage, type ContextSessionLike } from '../types';
import type { Environment, Logger } from '../../../core/types';
import type { LLMRouter } from '../../contracts';
import type { UnifiedRequest, UnifiedResponse, UnifiedUsage } from '../../llm/types';

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => logger,
  setLevel: () => {},
  getLevel: () => 'info',
};

const env = {
  dataDir: 'C:/nonexistent-moss-test',
  packageRoot: process.cwd(),
} as Environment;

const usage: UnifiedUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function okResponse(content: string): UnifiedResponse {
  return { content, finish_reason: 'stop', usage };
}

function makeSession(count: number): ContextSessionLike {
  const messages: ContextMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${'x'.repeat(500)}#${i}`,
      timestamp: new Date().toISOString(),
    });
  }
  return { id: 's1', messages, updatedAt: new Date().toISOString() };
}

function makeLlm(complete: (req: UnifiedRequest, signal?: AbortSignal) => Promise<UnifiedResponse>): LLMRouter {
  return { complete } as unknown as LLMRouter;
}

function config(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
  return { ...DEFAULT_COMPACTION_CONFIG, ...overrides };
}

function baseInput(session: ContextSessionLike, llm: LLMRouter, cfg: CompactionConfig) {
  return {
    env,
    config: cfg,
    llm,
    logger,
    staticSystemPrompt: 'SYSTEM',
    summaryModelId: 'test-model',
    summaryModelConfigured: 'inherit',
    windowTokens: 100,
    trigger: 'auto' as const,
  };
}

describe('compactSession 安全性', () => {
  it('摘要超时：放弃本轮且会话逐条不变', async () => {
    const session = makeSession(10);
    const before = [...session.messages];
    let calls = 0;
    const llm = makeLlm((_req, signal) => {
      calls++;
      return new Promise<UnifiedResponse>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });

    const outcome = await compactSession(
      session,
      baseInput(session, llm, config({ summaryTimeoutMs: 30 })),
    );

    expect(outcome.record).toBeNull();
    expect(outcome.reason).toContain('timed out');
    expect(session.messages).toEqual(before);
    // 总预算在第一次尝试就耗尽：不再发起第二次请求
    expect(calls).toBe(1);
  });

  it('瞬时错误重试 1 次后成功', async () => {
    const session = makeSession(10);
    let calls = 0;
    const llm = makeLlm(async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      return okResponse('summary of the region');
    });

    const outcome = await compactSession(session, baseInput(session, llm, config()));

    expect(outcome.record).not.toBeNull();
    expect(calls).toBe(2);
    expect(session.messages.length).toBe(3); // 1 条摘要 + 2 条尾部
  });

  it('4xx 不重试', async () => {
    const session = makeSession(10);
    const before = [...session.messages];
    let calls = 0;
    const llm = makeLlm(async () => {
      calls++;
      throw Object.assign(new Error('bad request'), { status: 400 });
    });

    const outcome = await compactSession(session, baseInput(session, llm, config()));

    expect(outcome.record).toBeNull();
    expect(calls).toBe(1);
    expect(session.messages).toEqual(before);
  });

  it('摘要期间消息被外部改动（锚点丢失）：放弃且不插入摘要', async () => {
    const session = makeSession(10);
    const llm = makeLlm(async () => {
      // 可压缩区是前 8 条，最后一条是索引 7；模拟摘要期间被删除
      session.messages.splice(7, 1);
      return okResponse('summary');
    });

    const outcome = await compactSession(session, baseInput(session, llm, config()));

    expect(outcome.record).toBeNull();
    expect(outcome.reason).toContain('anchor');
    expect(session.messages.some(m => m.name === 'compaction-summary')).toBe(false);
    expect(session.compactions ?? []).toHaveLength(0);
  });
});
