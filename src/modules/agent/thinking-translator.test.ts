// src/modules/agent/thinking-translator.test.ts
// 思维链翻译单测：语言判定、切段边界、流式译文解析与端到端流式回调。

import { describe, it, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMRouter } from '../contracts';
import type { Environment, Logger } from '../../core/types';
import {
  findSegmentCut,
  looksLikeTargetLanguage,
  ThinkingTranslator,
  TranslationOutputParser,
} from './thinking-translator';

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

function makeEnv(): Environment {
  const missing = join(tmpdir(), 'moss-thinking-translator-nonexistent');
  return { dataDir: missing, packageRoot: missing } as unknown as Environment;
}

/** 构造流式 LLM mock：每次调用按 parts 依次产出 text delta */
function streamRouter(parts: string[]): LLMRouter {
  return {
    complete: async () => ({
      content: '',
      finish_reason: 'stop',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    stream: async function* () {
      for (const text of parts) yield { type: 'text', text } as const;
      yield { type: 'finish', finishReason: 'stop' } as const;
    },
  } as unknown as LLMRouter;
}

describe('looksLikeTargetLanguage', () => {
  it('中文文本判定为中文', () => {
    expect(looksLikeTargetLanguage('我在分析这个问题，需要先读取配置文件。', 'zh')).toBe(true);
  });

  it('英文文本判定为英文', () => {
    expect(looksLikeTargetLanguage('I need to read the config file first.', 'en')).toBe(true);
  });

  it('英文文本对中文目标不命中', () => {
    expect(looksLikeTargetLanguage('I need to read the config file first.', 'zh')).toBe(false);
  });

  it('中文文本对英文目标不命中', () => {
    expect(looksLikeTargetLanguage('我在分析这个问题。', 'en')).toBe(false);
  });

  it('纯数字/符号视为未知（继续翻译）', () => {
    expect(looksLikeTargetLanguage('12345 --- 67890', 'zh')).toBe(false);
  });
});

describe('findSegmentCut', () => {
  it('未达到最小长度不切段', () => {
    expect(findSegmentCut('短句。', 60, 800)).toBe(0);
  });

  it('段落边界优先于句末标点', () => {
    const text = `${'a'.repeat(70)}\n\n${'b'.repeat(20)}`;
    expect(findSegmentCut(text, 60, 800)).toBe(72);
  });

  it('中文句末标点切段', () => {
    const text = `${'思'.repeat(59)}。后续内容`;
    expect(findSegmentCut(text, 60, 800)).toBe(60);
  });

  it('无标点长文本按最大长度强制切分', () => {
    const text = 'x'.repeat(900);
    expect(findSegmentCut(text, 60, 800)).toBe(800);
  });
});

describe('TranslationOutputParser', () => {
  it('只输出 <translation> 标签内的内容，丢弃标签前的回答', () => {
    const parser = new TranslationOutputParser('zh');
    const out1 = parser.push('I need to clarify something. <translation>你好');
    const out2 = parser.push('世界</translation> trailing explanation');
    expect(out1).toBe('你好');
    expect(out2).toBe('世界');
    expect(parser.finish()).toBe('');
  });

  it('无标签但整体是目标语言：整体采用', () => {
    const parser = new TranslationOutputParser('zh');
    const streamed = parser.push('这是一段已经翻译好的中文内容。');
    const tail = parser.finish();
    expect(streamed).toBe('');
    expect(`${streamed}${tail}`).toContain('这是一段已经翻译好的中文内容');
  });

  it('无标签且整体是源语言（英文）：丢弃，避免污染译文', () => {
    const parser = new TranslationOutputParser('zh');
    parser.push('The user asks who I am. I should answer in Chinese.');
    expect(parser.finish()).toBe('');
  });
});

describe('ThinkingTranslator 流式回调', () => {
  it('只回调标签内译文，标签前的回答被丢弃，onStart 只触发一次', async () => {
    const llm = streamRouter([
      'I should answer the user. ',
      '<translation>你',
      '好',
      '</translation>',
    ]);
    let starts = 0;
    const chunks: string[] = [];
    const translator = new ThinkingTranslator({
      env: makeEnv(),
      llm,
      logger,
      apiModels: [],
      config: { model: '', reasoningEffort: 'off' },
      mainRequestModel: 'main-model',
      targetLang: 'zh',
      onStart: () => {
        starts++;
      },
      onDelta: (text) => chunks.push(text),
    });
    translator.push(
      'The user asks: "使用英文思维链，告诉我你是谁" — use English chain of thought. I should respond in Chinese. ',
    );
    translator.endInput();
    await translator.drain(2000);
    const joined = chunks.join('');
    expect(starts).toBe(1);
    expect(joined).toContain('你好');
    expect(joined).not.toContain('I should answer the user');
    expect(joined).not.toContain('<translation>');
  });

  it('同语言思维链不启动翻译', async () => {
    let starts = 0;
    const chunks: string[] = [];
    const translator = new ThinkingTranslator({
      env: makeEnv(),
      llm: streamRouter(['<translation>不应出现</translation>']),
      logger,
      apiModels: [],
      config: { model: '', reasoningEffort: 'off' },
      mainRequestModel: 'main-model',
      targetLang: 'zh',
      onStart: () => {
        starts++;
      },
      onDelta: (text) => chunks.push(text),
    });
    translator.push('我在分析这个问题，需要先读取配置文件，然后再决定下一步怎么做。');
    translator.endInput();
    await translator.drain(500);
    expect(starts).toBe(0);
    expect(chunks.join('')).toBe('');
  });

  it('多段并发翻译，但输出顺序与原文段序一致', async () => {
    let active = 0;
    let maxActive = 0;
    const llm = {
      complete: async () => ({
        content: '',
        finish_reason: 'stop',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      stream: async function* (req: { messages?: Array<{ content?: string }> }) {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          const raw = String(req.messages?.[1]?.content ?? '');
          const source = raw.replace('<source>', '').replace('</source>', '').trim();
          // 延迟使多段任务同时在途，验证并发与按序输出
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          yield { type: 'text', text: `<translation>译(${source})</translation>` } as const;
          yield { type: 'finish', finishReason: 'stop' } as const;
        } finally {
          active--;
        }
      },
    } as unknown as LLMRouter;
    const chunks: string[] = [];
    const translator = new ThinkingTranslator({
      env: makeEnv(),
      llm,
      logger,
      apiModels: [],
      config: { model: '', reasoningEffort: 'off' },
      mainRequestModel: 'main-model',
      targetLang: 'zh',
      onDelta: (text) => chunks.push(text),
    });
    translator.push(
      'Alpha sentence one. Beta sentence two. Gamma sentence three. Delta sentence four. ',
    );
    translator.endInput();
    await translator.drain(3000);

    const joined = chunks.join('');
    expect(maxActive).toBeGreaterThan(1);
    const alpha = joined.indexOf('Alpha');
    const beta = joined.indexOf('Beta');
    const gamma = joined.indexOf('Gamma');
    const delta = joined.indexOf('Delta');
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThan(beta);
    expect(beta).toBeLessThan(gamma);
    expect(gamma).toBeLessThan(delta);
  });

  it('主路径输出英文回答（无标签）时，兜底非流式翻译补上中文', async () => {
    let completes = 0;
    const llm = {
      complete: async () => {
        completes++;
        return {
          content: '用户问我是谁。我应该用中文回答。',
          finish_reason: 'stop',
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
      stream: async function* () {
        yield {
          type: 'text',
          text: 'I am Moss, an AI assistant created by the Moss team.',
        } as const;
        yield { type: 'finish', finishReason: 'stop' } as const;
      },
    } as unknown as LLMRouter;
    const chunks: string[] = [];
    const translator = new ThinkingTranslator({
      env: makeEnv(),
      llm,
      logger,
      apiModels: [],
      config: { model: '', reasoningEffort: 'off' },
      mainRequestModel: 'main-model',
      targetLang: 'zh',
      onDelta: (text) => chunks.push(text),
    });
    translator.push('The user asks who I am. I should answer in Chinese. ');
    translator.endInput();
    await translator.drain(2000);

    const joined = chunks.join('');
    // 文本包含两个句子 → 会被切成两段，兜底至少被调用一次
    expect(completes).toBeGreaterThanOrEqual(1);
    expect(joined).toContain('用户问我是谁');
    expect(joined).not.toContain('I am Moss');
  });
});
