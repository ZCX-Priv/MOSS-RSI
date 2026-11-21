// src/modules/agent/thinking-translator.ts
// 思维链实时翻译：把流式 thinking 文本切段，多段并发调用翻译模型，并按原文顺序流式回调译文。
//
// 设计：
//   - 同语言跳过：累计到判定阈值后按字符集比例判断，避免对已是目标语言的思维链做无意义翻译；
//   - 强约束翻译提示词 + <translation> 标签解析：模型只能输出标签内译文，
//     标签前的「回答/前言」全部丢弃，避免把思维链里的问题当成用户请求来回答；
//   - 流式 + 并发：最多 3 段并行翻译；当前输出头段逐 token 流式回调，后续段先缓冲，
//     轮到其顺序时再输出 → 压缩总延迟且保证译文顺序与原文一致；
//   - 失败降级：连续失败 3 次停止本轮翻译，不影响主对话；
//   - drain 有超时上限，绝不让翻译拖死 agent turn。

import type { Environment, Logger } from '../../core/types';
import type { LLMRouter } from '../contracts';
import { loadPromptFileOrNull, renderTemplate } from '../context/prompt-loader';
import { effortToThinking, resolveAuxRequestModel } from './aux-model';

/** 单段最小字符数（低于此长度不切段，避免碎片化调用） */
const MIN_SEGMENT_CHARS = 16;
/** 单段最大字符数（无标点长文本强制切分） */
const MAX_SEGMENT_CHARS = 240;
/** 语言判定所需的最小累计字符数 */
const LANGUAGE_DECIDE_CHARS = 32;
/** 单段翻译超时（ms） */
const SEGMENT_TIMEOUT_MS = 15_000;
/** 连续失败上限（达到后停止本轮翻译） */
const MAX_CONSECUTIVE_FAILURES = 3;
/** 并发翻译段数（按原文顺序输出，压缩落后于主思维链的时间） */
const MAX_CONCURRENT_SEGMENTS = 3;

const OPEN_TAG = '<translation>';
const CLOSE_TAG = '</translation>';

export interface ThinkingTranslatorOptions {
  env: Environment;
  llm: LLMRouter;
  logger: Logger;
  /** provider 模型列表（id → model 映射） */
  apiModels: Array<{ id: string; model: string }>;
  config: { model: string; reasoningEffort: string };
  /** 主模型请求名（配置继承时的兜底） */
  mainRequestModel: string;
  /** 目标语言：'zh' | 'en' */
  targetLang: 'zh' | 'en';
  signal?: AbortSignal;
  /** 语言判定为需要翻译时回调一次（前端据此显示「翻译中…」） */
  onStart?: () => void;
  /** 译文增量回调（流式 token；调用方负责追加与推送事件） */
  onDelta: (text: string) => void;
}

/**
 * 判断文本是否已经是目标语言（字符集比例启发式）。
 * - 目标 zh：CJK 占（CJK + 拉丁字母）比例 ≥ 0.5；
 * - 目标 en：CJK 占比 ≤ 0.02；
 * - 无字母（纯符号/数字）视为未知，返回 false（继续翻译）。
 */
export function looksLikeTargetLanguage(text: string, target: 'zh' | 'en'): boolean {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) cjk++;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++;
  }
  const total = cjk + latin;
  if (total === 0) return false;
  const ratio = cjk / total;
  return target === 'zh' ? ratio >= 0.5 : ratio <= 0.02;
}

/**
 * 在缓冲区中寻找切段位置（返回切点下标；0 = 暂不切）。
 * 优先段落边界（\n\n / \n），其次句末标点（中英文）；超过最大长度强制切分。
 */
export function findSegmentCut(
  buffer: string,
  minChars = MIN_SEGMENT_CHARS,
  maxChars = MAX_SEGMENT_CHARS,
): number {
  const len = buffer.length;
  if (len < minChars) return 0;
  for (let i = minChars - 1; i < len; i++) {
    const ch = buffer[i];
    if (ch === '\n') {
      // \n\n 视为一个整体段落边界
      return i + (buffer[i + 1] === '\n' ? 2 : 1);
    }
    if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '!' || ch === '?' || ch === ';') {
      return i + 1;
    }
    if (ch === '.' && (i + 1 >= len || /\s/.test(buffer[i + 1]))) {
      return i + 1;
    }
  }
  return len >= maxChars ? maxChars : 0;
}

/**
 * 流式译文解析器：只放行 <translation>…</translation> 内的文本。
 * - 标签前的回答/前言全部丢弃；
 * - 流结束时仍无标签：仅当全文像目标语言时才整体采用，否则丢弃。
 */
export class TranslationOutputParser {
  private readonly targetLang: 'zh' | 'en';
  private raw = '';
  private cursor = 0;
  private seenOpen = false;
  private closed = false;

  constructor(targetLang: 'zh' | 'en') {
    this.targetLang = targetLang;
  }

  /** 接收一个流式分片，返回本次应追加的译文（可能为空串） */
  push(chunk: string): string {
    if (!chunk || this.closed) return '';
    this.raw += chunk;
    if (!this.seenOpen) {
      const open = this.raw.indexOf(OPEN_TAG);
      if (open < 0) return '';
      this.seenOpen = true;
      this.cursor = open + OPEN_TAG.length;
    }
    const close = this.raw.indexOf(CLOSE_TAG, this.cursor);
    // 未见闭合标签时，只保留「可能构成闭合标签前缀」的尾部字符，
    // 避免把半个 </translation> 当译文输出，同时不延迟普通正文。
    let safeEnd = close >= 0 ? close : this.raw.length;
    if (close < 0) {
      const maxHold = Math.min(CLOSE_TAG.length - 1, this.raw.length - this.cursor);
      for (let k = maxHold; k > 0; k--) {
        if (CLOSE_TAG.startsWith(this.raw.slice(this.raw.length - k))) {
          safeEnd = this.raw.length - k;
          break;
        }
      }
    }
    if (safeEnd <= this.cursor) {
      if (close >= 0) this.closed = true;
      return '';
    }
    const text = this.raw.slice(this.cursor, safeEnd);
    this.cursor = safeEnd;
    if (close >= 0) this.closed = true;
    return text;
  }

  /** 流结束：补齐尾部；无标签时按目标语言兜底。返回最终应追加的译文 */
  finish(): string {
    if (this.closed) return '';
    this.closed = true;
    if (!this.seenOpen) {
      const text = this.raw.trim();
      if (!text) return '';
      return looksLikeTargetLanguage(text, this.targetLang) ? text : '';
    }
    const close = this.raw.indexOf(CLOSE_TAG, this.cursor);
    const end = close >= 0 ? close : this.raw.length;
    if (end <= this.cursor) return '';
    let text = this.raw.slice(this.cursor, end);
    // 去掉可能被截断的闭合标签前缀（max_tokens 截断场景）
    for (let k = Math.min(CLOSE_TAG.length - 1, text.length); k > 0; k--) {
      if (CLOSE_TAG.startsWith(text.slice(text.length - k))) {
        text = text.slice(0, text.length - k);
        break;
      }
    }
    this.cursor = end;
    return text;
  }
}

interface PendingSegment {
  seq: number;
  text: string;
}

export class ThinkingTranslator {
  private readonly opts: ThinkingTranslatorOptions;
  private readonly systemPrompt: string;
  private readonly targetName: string;
  private buffer = '';
  /** 待翻译段（按 seq 递增入队） */
  private pending: PendingSegment[] = [];
  private nextSeq = 0;
  /** 下一个待输出到前端的段序号（并发但严格按序输出） */
  private nextEmitSeq = 0;
  private activeCount = 0;
  /** 每段已产出但尚未轮到的译文缓冲 */
  private readonly buffers = new Map<number, string>();
  /** 已完成（成功/失败/丢弃）的段序号 */
  private readonly completed = new Set<number>();
  /** 已实际输出过内容的段（用于决定是否补换行） */
  private readonly emittedSeqs = new Set<number>();
  private readonly activeControllers = new Set<AbortController>();
  private idleWaiters: Array<() => void> = [];
  private inputEnded = false;
  private failed = false;
  private languageDecided = false;
  private sameLanguage = false;
  private started = false;
  private consecutiveFailures = 0;
  /** 主翻译提示词缺失时禁用翻译（thinking 原样透传，不阻断主流程） */
  private readonly disabled: boolean;

  constructor(opts: ThinkingTranslatorOptions) {
    this.opts = opts;
    this.targetName = opts.targetLang === 'en' ? 'English' : '简体中文';
    const base = loadPromptFileOrNull(opts.env, 'translate/thinking.md');
    this.disabled = !base || base.trim() === '';
    this.systemPrompt = this.disabled
      ? ''
      : renderTemplate(base as string, { TARGET_LANGUAGE: this.targetName });
  }

  /** 接收 thinking 增量 */
  push(delta: string): void {
    if (!delta || this.failed || this.inputEnded || this.disabled) return;
    this.buffer += delta;
    this.decideLanguageIfReady();
    if (this.sameLanguage) {
      this.buffer = '';
      return;
    }
    this.extractSegments();
  }

  /** thinking 结束：冲刷残余文本并停止接收（幂等） */
  endInput(): void {
    if (this.inputEnded || this.disabled) return;
    this.inputEnded = true;
    if (!this.languageDecided) this.decideLanguage(true);
    if (this.sameLanguage) {
      this.buffer = '';
      return;
    }
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) this.enqueueSegment(rest);
  }

  /** 中止全部请求并丢弃队列（停止/中断时调用） */
  abort(): void {
    this.failed = true;
    this.pending = [];
    this.buffer = '';
    this.buffers.clear();
    this.completed.clear();
    this.emittedSeqs.clear();
    for (const controller of this.activeControllers) {
      try {
        controller.abort();
      } catch {
        // 已中止
      }
    }
    this.activeControllers.clear();
  }

  /** 等待所有段输出完毕；超过 timeoutMs 则中止剩余翻译（保证主流程不被拖死） */
  async drain(timeoutMs: number): Promise<void> {
    this.endInput();
    if (this.sameLanguage || this.failed || this.disabled) return;
    this.pump();
    if (this.activeCount === 0 && this.pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
    });
    const result = await Promise.race([this.waitForIdle().then(() => 'done' as const), timeout]);
    if (timer !== null) clearTimeout(timer);
    if (result === 'timeout') this.abort();
  }

  // --------------------------------------------------------------------------

  private decideLanguageIfReady(): void {
    if (this.languageDecided || this.buffer.length < LANGUAGE_DECIDE_CHARS) return;
    this.decideLanguage(false);
  }

  private decideLanguage(force: boolean): void {
    if (this.languageDecided) return;
    if (!force && this.buffer.length < LANGUAGE_DECIDE_CHARS) return;
    this.languageDecided = true;
    this.sameLanguage = looksLikeTargetLanguage(this.buffer, this.opts.targetLang);
    if (this.sameLanguage) {
      this.pending = [];
      this.buffer = '';
      return;
    }
    this.notifyStart();
  }

  private notifyStart(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.opts.onStart?.();
    } catch (err) {
      this.opts.logger.warn('agent: thinking translation onStart failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private extractSegments(): void {
    if (!this.languageDecided) return;
    for (;;) {
      const cut = findSegmentCut(this.buffer);
      if (cut <= 0) break;
      const segment = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (segment) this.enqueueSegment(segment);
    }
  }

  private enqueueSegment(text: string): void {
    if (!text) return;
    this.pending.push({ seq: this.nextSeq++, text });
    this.pump();
  }

  /** 在并发上限内启动翻译任务 */
  private pump(): void {
    if (this.failed || this.sameLanguage || !this.languageDecided) return;
    while (this.activeCount < MAX_CONCURRENT_SEGMENTS && this.pending.length > 0) {
      const segment = this.pending.shift();
      if (!segment) break;
      this.activeCount++;
      void this.translateSegment(segment.seq, segment.text).finally(() => {
        this.activeCount--;
        this.pump();
        this.resolveIdleIfDone();
      });
    }
    this.resolveIdleIfDone();
  }

  /** 按 seq 顺序把已就绪的缓冲输出到 onDelta */
  private flushHead(): void {
    if (this.failed || this.sameLanguage) return;
    for (;;) {
      const seq = this.nextEmitSeq;
      const buffered = this.buffers.get(seq);
      if (buffered) {
        this.buffers.delete(seq);
        this.emit(buffered);
      }
      if (!this.completed.has(seq)) break;
      this.completed.delete(seq);
      // 每段结束后补一个换行（解析器只输出正文，不包含排版换行）
      if (this.emittedSeqs.has(seq)) {
        this.emittedSeqs.delete(seq);
        this.emit('\n');
      }
      this.nextEmitSeq++;
    }
  }

  private emit(text: string): void {
    if (!text) return;
    try {
      this.opts.onDelta(text);
    } catch (err) {
      this.opts.logger.warn('agent: thinking translation callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private resolveIdleIfDone(): void {
    if (this.activeCount > 0 || this.pending.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private waitForIdle(): Promise<void> {
    if (this.activeCount === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** 流式翻译单段；无论成功/失败都标记 completed，保证后续段能按序推进 */
  private async translateSegment(seq: number, segment: string): Promise<void> {
    if (this.failed || this.opts.signal?.aborted) {
      this.completed.add(seq);
      this.flushHead();
      return;
    }
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const onOuterAbort = (): void => controller.abort();
    this.opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), SEGMENT_TIMEOUT_MS);
    const parser = new TranslationOutputParser(this.opts.targetLang);
    let sawText = false;
    const append = (text: string): void => {
      if (!text || this.failed) return;
      sawText = true;
      this.buffers.set(seq, (this.buffers.get(seq) ?? '') + text);
      this.emittedSeqs.add(seq);
      this.flushHead();
    };
    try {
      const stream = this.opts.llm.stream(
        {
          model: resolveAuxRequestModel(
            this.opts.config.model,
            this.opts.mainRequestModel,
            this.opts.apiModels,
          ),
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: `<source>\n${segment}\n</source>` },
          ],
          stream: true,
          max_tokens: Math.min(2048, Math.max(256, Math.ceil(segment.length * 3))),
          temperature: 0,
          thinking: effortToThinking(this.opts.config.reasoningEffort),
        },
        controller.signal,
      );
      for await (const delta of stream) {
        if (delta.type !== 'text') continue;
        append(parser.push(delta.text));
      }
      append(parser.finish());
      if (sawText) {
        this.consecutiveFailures = 0;
      } else if (!this.failed && !this.opts.signal?.aborted) {
        // 主路径（标签格式）整段无产出：用最小提示词兜底一次，避免整段译文丢失
        const ok = await this.translateFallback(segment, append);
        if (ok) {
          this.consecutiveFailures = 0;
        } else if (!this.failed) {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.stop('consecutive-failures');
          }
        }
      }
    } catch (err) {
      if (!this.failed && !this.opts.signal?.aborted) {
        this.opts.logger.warn('agent: thinking translation segment failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!this.failed && !this.opts.signal?.aborted) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.stop('consecutive-failures');
        }
      }
    } finally {
      clearTimeout(timer);
      this.opts.signal?.removeEventListener('abort', onOuterAbort);
      this.activeControllers.delete(controller);
      this.completed.add(seq);
      this.flushHead();
    }
  }

  /** 主路径无产出时的最小提示词兜底（非流式）；提示词缺失或成功返回 false/true */
  private async translateFallback(
    segment: string,
    append: (text: string) => void,
  ): Promise<boolean> {
    const fallbackTemplate = loadPromptFileOrNull(this.opts.env, 'translate/thinking-fallback.md');
    if (!fallbackTemplate) return false;
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const onOuterAbort = (): void => controller.abort();
    this.opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), SEGMENT_TIMEOUT_MS);
    try {
      const response = await this.opts.llm.complete(
        {
          model: resolveAuxRequestModel(
            this.opts.config.model,
            this.opts.mainRequestModel,
            this.opts.apiModels,
          ),
          messages: [
            {
              role: 'system',
              content: renderTemplate(fallbackTemplate, { TARGET_LANGUAGE: this.targetName }),
            },
            { role: 'user', content: segment },
          ],
          stream: false,
          max_tokens: Math.min(2048, Math.max(256, Math.ceil(segment.length * 3))),
          temperature: 0,
          thinking: effortToThinking(this.opts.config.reasoningEffort),
        },
        controller.signal,
      );
      const raw = (response.content ?? '').trim();
      if (!raw) return false;
      // 兼容兜底模型仍然输出标签的情况
      const tagged = /<translation>([\s\S]*?)<\/translation>/i.exec(raw);
      const text = (tagged ? tagged[1] : raw).trim();
      if (!text) return false;
      if (looksLikeTargetLanguage(text, this.opts.targetLang)) {
        append(text);
        return true;
      }
      if (!this.failed && !this.opts.signal?.aborted) {
        this.opts.logger.warn('agent: thinking translation discarded', {
          targetLang: this.opts.targetLang,
          rawHead: raw.slice(0, 120),
        });
      }
      return false;
    } catch (err) {
      if (!this.failed && !this.opts.signal?.aborted) {
        this.opts.logger.warn('agent: thinking translation fallback failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    } finally {
      clearTimeout(timer);
      this.opts.signal?.removeEventListener('abort', onOuterAbort);
      this.activeControllers.delete(controller);
    }
  }

  private stop(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.pending = [];
    this.buffer = '';
    this.buffers.clear();
    this.completed.clear();
    this.emittedSeqs.clear();
    for (const controller of this.activeControllers) {
      try {
        controller.abort();
      } catch {
        // 已中止
      }
    }
    this.activeControllers.clear();
    this.opts.logger.warn('agent: thinking translation stopped', { reason });
  }
}
