// src/modules/safety/reviewer.test.ts
// 自动审查执行器：JSON 解析、只降级不升级、失败关闭、缓存与推理挡位映射。

import { describe, it, expect } from 'bun:test';
import { SafetyReviewer } from './reviewer';
import type { ConfigService, Logger } from '../../core/types';
import type { LLMRouter } from '../contracts';
import type { UnifiedRequest, UnifiedResponse } from '../llm/types';

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

/** 构造带指定 review 配置的 ConfigService mock */
function configWith(review: Record<string, unknown>): ConfigService {
  return {
    getAppConfig: () => ({ safety: { review } }),
  } as unknown as ConfigService;
}

/** 构造 LLMRouter mock：按队列返回内容，并记录请求 */
function routerWith(responses: Array<string | Error>, captured: UnifiedRequest[] = []): LLMRouter {
  return {
    complete: async (req: UnifiedRequest): Promise<UnifiedResponse> => {
      captured.push(req);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return {
        content: next ?? '',
        finish_reason: 'stop',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
    stream: () => {
      throw new Error('stream not used in reviewer');
    },
  } as unknown as LLMRouter;
}

const BASE_INPUT = {
  toolName: 'terminal',
  params: { command: 'npm install' },
  cwd: '/work/project',
  risk: 'L3' as const,
  userIntent: '安装依赖并跑测试',
  model: 'main-model',
};

describe('SafetyReviewer', () => {
  it('解析合法 allow JSON', async () => {
    const reviewer = new SafetyReviewer({
      config: configWith({}),
      logger,
      llm: routerWith(['{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"安装依赖符合请求"}']),
    });
    const result = await reviewer.review(BASE_INPUT);
    expect(result.decision).toBe('allow');
    expect(result.riskLevel).toBe('low');
    expect(result.source).toBe('model');
  });

  it('容忍 Markdown 代码围栏与前后杂质', async () => {
    const reviewer = new SafetyReviewer({
      config: configWith({}),
      logger,
      llm: routerWith(['结果如下：\n```json\n{"outcome":"deny","rationale":"外发凭据"}\n```']),
    });
    const result = await reviewer.review(BASE_INPUT);
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('外发凭据');
  });

  it('非法输出 → uncertain（失败关闭）', async () => {
    const reviewer = new SafetyReviewer({
      config: configWith({}),
      logger,
      llm: routerWith(['我觉得可以放行']),
    });
    const result = await reviewer.review(BASE_INPUT);
    expect(result.decision).toBe('uncertain');
    expect(result.source).toBe('fallback');
  });

  it('模型异常 → uncertain', async () => {
    const reviewer = new SafetyReviewer({
      config: configWith({}),
      logger,
      llm: routerWith([new Error('timeout')]),
    });
    const result = await reviewer.review(BASE_INPUT);
    expect(result.decision).toBe('uncertain');
    expect(result.reason).toContain('timeout');
  });

  it('critical 风险的 allow 降级为 deny', async () => {
    const reviewer = new SafetyReviewer({
      config: configWith({}),
      logger,
      llm: routerWith(['{"outcome":"allow","risk_level":"critical","user_authorization":"high","rationale":"读密钥"}']),
    });
    const result = await reviewer.review(BASE_INPUT);
    expect(result.decision).toBe('deny');
  });

  it('高风险 + 授权不足的 allow 降级为 deny', async () => {
    const reviewer = new SafetyReviewer({
      config: configWith({}),
      logger,
      llm: routerWith(['{"outcome":"allow","risk_level":"high","user_authorization":"low","rationale":"顺手清理"}']),
    });
    const result = await reviewer.review(BASE_INPUT);
    expect(result.decision).toBe('deny');
  });

  it('相同指纹命中缓存，不重复调用模型', async () => {
    const captured: UnifiedRequest[] = [];
    const reviewer = new SafetyReviewer({
      config: configWith({ cacheTtlMs: 60000 }),
      logger,
      llm: routerWith(['{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"ok"}'], captured),
    });
    const first = await reviewer.review(BASE_INPUT);
    const second = await reviewer.review(BASE_INPUT);
    expect(first.source).toBe('model');
    expect(second.source).toBe('cache');
    expect(captured).toHaveLength(1);
  });

  it('cacheTtlMs=0 时不缓存', async () => {
    const captured: UnifiedRequest[] = [];
    const reviewer = new SafetyReviewer({
      config: configWith({ cacheTtlMs: 0 }),
      logger,
      llm: routerWith([
        '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"ok"}',
        '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"ok"}',
      ], captured),
    });
    await reviewer.review(BASE_INPUT);
    await reviewer.review(BASE_INPUT);
    expect(captured).toHaveLength(2);
  });

  it('推理挡位映射到 thinking 配置', async () => {
    const captured: UnifiedRequest[] = [];
    const reviewer = new SafetyReviewer({
      config: configWith({ reasoningEffort: 'max', cacheTtlMs: 0 }),
      logger,
      llm: routerWith(['{"outcome":"allow","rationale":"ok"}'], captured),
    });
    await reviewer.review(BASE_INPUT);
    expect(captured[0]?.thinking).toEqual({ enabled: true, effort: 'high' });
  });

  it('off 挡位不启用思考', async () => {
    const captured: UnifiedRequest[] = [];
    const reviewer = new SafetyReviewer({
      config: configWith({ reasoningEffort: 'off', cacheTtlMs: 0 }),
      logger,
      llm: routerWith(['{"outcome":"allow","rationale":"ok"}'], captured),
    });
    await reviewer.review(BASE_INPUT);
    expect(captured[0]?.thinking).toEqual({ enabled: false });
  });

  it('review.model 优先于会话模型', async () => {
    const captured: UnifiedRequest[] = [];
    const reviewer = new SafetyReviewer({
      config: configWith({ model: 'cheap-model', cacheTtlMs: 0 }),
      logger,
      llm: routerWith(['{"outcome":"allow","rationale":"ok"}'], captured),
    });
    await reviewer.review(BASE_INPUT);
    expect(captured[0]?.model).toBe('cheap-model');
  });
});
