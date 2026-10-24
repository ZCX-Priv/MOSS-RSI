// src/modules/voice/engine.ts
// sherpa-onnx 运行时封装：懒加载原生模块 + 模型文件解析 + 会话（流式 / 非流式）。
//
// 关键约束：sherpa-onnx-node 的 decode 为同步原生调用，会占用调用线程；因此
// 流式会话按「有新音频且就绪」节流解码，非流式会话用 decodeAsync 在原生线程池执行，
// 避免长期阻塞 Bun 事件循环。

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceLocalEngine, VoiceResult, VoiceSession } from './types';
import type {
  OfflineRecognizer as OfflineRecognizerT,
  OfflineStream,
  OnlineRecognizer as OnlineRecognizerT,
  OnlineStream,
} from 'sherpa-onnx-node';

export type SherpaModule = typeof import('sherpa-onnx-node');

/** 采样率：全部本地模型统一 16kHz 单声道 */
export const SAMPLE_RATE = 16000;

/** 环境能量阈值（RMS），低于视为静音 */
const SILENCE_RMS = 0.006;
/** 静音多少毫秒判定一段结束 */
const SILENCE_MS = 900;
/** 段最小长度（毫秒），过短丢弃（避免噪声触发） */
const MIN_SEGMENT_MS = 250;
/** 非流式引擎产生 partial 的最小间隔（毫秒） */
const PARTIAL_INTERVAL_MS = 800;

// ============================================================================
// 运行时加载
// ============================================================================

let cached: SherpaModule | null = null;
let loading: Promise<SherpaModule | null> | null = null;
/** 最近一次加载失败的原因（供状态展示/诊断；成功时清空） */
let loadError: string | null = null;

/** 取最近一次 sherpa-onnx 加载失败原因（null = 无失败记录/已成功） */
export function getSherpaLoadError(): string | null {
  return loadError;
}

/**
 * 懒加载 sherpa-onnx-node（失败不抛出，返回 null；由上层降级提示）。
 *
 * 不缓存失败：瞬时失败（依赖尚未就绪等）不应让运行时永久卡在不可用；
 * 并发调用共享同一个加载 promise，避免重复 import。
 * 失败原因记录到 loadError，便于前端展示「为什么不可用」。
 */
export async function loadSherpa(): Promise<SherpaModule | null> {
  if (cached) return cached;
  if (loading) return loading;
  loading = (async () => {
    try {
      cached = (await import('sherpa-onnx-node')) as SherpaModule;
      loadError = null;
      return cached;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function sherpaVersion(mod: SherpaModule | null): string | undefined {
  return mod?.version;
}

// ============================================================================
// 模型文件解析（动态扫描，不硬编码 epoch/chunk 后缀）
// ============================================================================

/** 递归列出目录下全部文件绝对路径 */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** 在候选 onnx 中按关键字挑选（优先 int8 量化版） */
function pickOnnx(files: string[], keyword: string): string | undefined {
  const re = new RegExp(keyword, 'i');
  const matches = files.filter((f) => f.toLowerCase().endsWith('.onnx') && re.test(f));
  if (matches.length === 0) return undefined;
  const int8 = matches.find((f) => /int8/i.test(f));
  return int8 ?? matches[0];
}

/** 解压后解析模型所需文件（返回绝对路径） */
export function resolveModelFiles(
  modelDir: string,
  engine: VoiceLocalEngine,
): { tokens: string; encoder?: string; decoder?: string; joiner?: string; model?: string } {
  const files = listFilesRecursive(modelDir);
  const tokens = files.find((f) => /tokens\.txt$/i.test(f));
  if (!tokens) throw new Error(`模型目录缺少 tokens.txt: ${modelDir}`);

  if (engine === 'zipformer') {
    const encoder = pickOnnx(files, 'encoder');
    const decoder = pickOnnx(files, 'decoder');
    const joiner = pickOnnx(files, 'joiner');
    if (!encoder || !decoder || !joiner) throw new Error('模型缺少 transducer 三件套（encoder/decoder/joiner）');
    return { tokens, encoder, decoder, joiner };
  }

  if (engine === 'sensevoice') {
    const model = pickOnnx(files, 'model');
    if (!model) throw new Error('模型缺少 model.onnx');
    return { tokens, model };
  }

  // whisper
  const encoder = pickOnnx(files, 'encoder');
  const decoder = pickOnnx(files, 'decoder');
  if (!encoder || !decoder) throw new Error('模型缺少 whisper encoder/decoder');
  return { tokens, encoder, decoder };
}

// ============================================================================
// 音频工具
// ============================================================================

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function concatChunks(chunks: Float32Array[]): Float32Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ============================================================================
// 会话实现
// ============================================================================

/** 异步任务串行队列：同一 recognizer 上的解码必须严格串行（原生实现不支持并发调用） */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** 流式会话（zipformer transducer）：真流式 partial + endpoint final */
class StreamingSession implements VoiceSession {
  private last = '';
  private closed = false;

  constructor(
    private readonly recognizer: OnlineRecognizerT,
    private readonly stream: OnlineStream,
  ) {}

  acceptSamples(samples: Float32Array): void {
    if (this.closed) return;
    this.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  }

  poll(): VoiceResult | null {
    if (this.closed) return null;
    if (!this.recognizer.isReady(this.stream)) return null;
    this.recognizer.decode(this.stream);
    const text = (this.recognizer.getResult(this.stream).text ?? '').trim();
    if (this.recognizer.isEndpoint(this.stream)) {
      this.recognizer.reset(this.stream);
      this.last = '';
      return text ? { text, isFinal: true } : null;
    }
    if (text && text !== this.last) {
      this.last = text;
      return { text, isFinal: false };
    }
    return null;
  }

  async finish(): Promise<VoiceResult | null> {
    if (this.closed) return null;
    this.stream.inputFinished();
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
    const text = (this.recognizer.getResult(this.stream).text ?? '').trim();
    this.last = '';
    return text ? { text, isFinal: true } : null;
  }

  close(): void {
    this.closed = true;
  }
}

/** 非流式会话（SenseVoice / Whisper）：能量静音分段 + 尾部窗口重解码伪流式 */
class OfflineSession implements VoiceSession {
  private seg: Float32Array[] = [];
  private segSamples = 0;
  private silenceMs = 0;
  private results: VoiceResult[] = [];
  private busy = false;
  /** 进行中的异步解码：finish 前必须等它结束，避免同一 recognizer 被并发调用 */
  private inflight: Promise<void> | null = null;
  private lastPartialAt = 0;
  private lastPartial = '';
  private closed = false;

  constructor(
    private readonly recognizer: OfflineRecognizerT,
    /** 同一 recognizer 的全局串行队列（多连接共享识别器时禁止并发解码） */
    private readonly queue: SerialQueue,
  ) {}

  acceptSamples(samples: Float32Array): void {
    if (this.closed) return;
    this.seg.push(samples);
    this.segSamples += samples.length;
    if (rms(samples) < SILENCE_RMS) {
      this.silenceMs += (samples.length / SAMPLE_RATE) * 1000;
    } else {
      this.silenceMs = 0;
    }
    const minSamples = (SAMPLE_RATE * MIN_SEGMENT_MS) / 1000;
    if (this.silenceMs >= SILENCE_MS && this.segSamples >= minSamples) {
      const audio = concatChunks(this.seg);
      this.seg = [];
      this.segSamples = 0;
      this.silenceMs = 0;
      this.lastPartial = '';
      void this.decode(audio, true);
    }
  }

  poll(): VoiceResult | null {
    if (this.results.length > 0) return this.results.shift() ?? null;
    const now = Date.now();
    const minPartial = (SAMPLE_RATE * 400) / 1000;
    if (!this.busy && this.segSamples >= minPartial && now - this.lastPartialAt >= PARTIAL_INTERVAL_MS) {
      this.lastPartialAt = now;
      void this.decode(concatChunks(this.seg), false);
    }
    return null;
  }

  /** 发起一次异步解码；已有解码在进行时返回同一个 promise（不并发调用原生 recognizer） */
  private decode(audio: Float32Array, isFinal: boolean): Promise<void> {
    if (this.busy) return this.inflight ?? Promise.resolve();
    this.busy = true;
    const task = this.queue
      .run(async () => {
        try {
          const stream: OfflineStream = this.recognizer.createStream();
          stream.acceptWaveform({ samples: audio, sampleRate: SAMPLE_RATE });
          const res = await this.recognizer.decodeAsync(stream);
          const text = (res.text ?? '').trim();
          if (!text) return;
          if (isFinal) {
            this.results.push({ text, isFinal: true });
            this.lastPartial = '';
          } else if (text !== this.lastPartial) {
            this.lastPartial = text;
            this.results.push({ text, isFinal: false });
          }
        } catch {
          // 瞬时解码失败忽略（可能是段过短）
        }
      })
      .finally(() => {
        this.busy = false;
        this.inflight = null;
      });
    this.inflight = task;
    return task;
  }

  async finish(): Promise<VoiceResult | null> {
    // 先等在途异步解码结束：绝不能与 decodeAsync 并发使用同一 recognizer
    if (this.inflight) await this.inflight.catch(() => undefined);
    // 末尾整段解码同样经队列，避免与其它会话的解码并发
    return this.queue.run(async () => {
      if (this.segSamples > 0) {
        const audio = concatChunks(this.seg);
        this.seg = [];
        this.segSamples = 0;
        try {
          const stream = this.recognizer.createStream();
          stream.acceptWaveform({ samples: audio, sampleRate: SAMPLE_RATE });
          this.recognizer.decode(stream);
          const text = (this.recognizer.getResult(stream).text ?? '').trim();
          if (text) return { text, isFinal: true };
        } catch {
          // 忽略
        }
      }
      return this.results.shift() ?? null;
    });
  }

  close(): void {
    this.closed = true;
  }
}

// ============================================================================
// 会话工厂
// ============================================================================

export interface LocalSessionInit {
  engine: VoiceLocalEngine;
  /** 模型目录（含解压后的模型文件） */
  modelDir: string;
  numThreads: number;
}

/** 缓存的识别器条目（单条目：只保留当前模型，避免多模型常驻内存） */
interface LocalRecognizerEntry {
  /** 缓存键：`${engine}::${modelDir}` */
  key: string;
  online: OnlineRecognizerT | null;
  offline: OfflineRecognizerT | null;
  /** 离线识别器的全局解码队列（可能被多个连接的会话共享） */
  offlineQueue: SerialQueue;
}

let cachedEntry: LocalRecognizerEntry | null = null;
/** 单飞：同键并发创建共享同一个 promise（避免加载两份模型） */
let pendingEntry: { key: string; promise: Promise<LocalRecognizerEntry> } | null = null;

function recognizerKey(init: LocalSessionInit): string {
  return `${init.engine}::${init.modelDir}`;
}

/** 清空识别器缓存（模型安装/卸载后调用，避免继续使用旧文件构建的实例） */
export function invalidateLocalRecognizer(): void {
  cachedEntry = null;
  pendingEntry = null;
}

/**
 * 取（或创建）本地识别器。
 * 模型加载耗时 2~6 秒，且为同步原生调用；必须跨会话复用，否则每次录音都要重新加载。
 */
export async function ensureLocalRecognizer(
  sherpa: SherpaModule,
  init: LocalSessionInit,
): Promise<LocalRecognizerEntry> {
  const key = recognizerKey(init);
  if (cachedEntry && cachedEntry.key === key) return cachedEntry;
  if (pendingEntry && pendingEntry.key === key) return pendingEntry.promise;

  const promise = (async (): Promise<LocalRecognizerEntry> => {
    const files = resolveModelFiles(init.modelDir, init.engine);
    const featConfig = { sampleRate: SAMPLE_RATE, featureDim: 80 };

    let entry: LocalRecognizerEntry;
    if (init.engine === 'zipformer') {
      const recognizer = new sherpa.OnlineRecognizer({
        featConfig,
        modelConfig: {
          transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
          tokens: files.tokens,
          numThreads: init.numThreads,
          provider: 'cpu',
          debug: false,
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: true,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20,
      });
      entry = { key, online: recognizer, offline: null, offlineQueue: new SerialQueue() };
    } else {
      const modelConfig =
        init.engine === 'sensevoice'
          ? {
              senseVoice: {
                model: files.model,
                language: 'auto',
                useInverseTextNormalization: 1,
              },
              tokens: files.tokens,
              numThreads: init.numThreads,
              provider: 'cpu',
              debug: false,
            }
          : {
              whisper: {
                encoder: files.encoder,
                decoder: files.decoder,
                language: 'zh',
                task: 'transcribe',
              },
              tokens: files.tokens,
              numThreads: init.numThreads,
              provider: 'cpu',
              debug: false,
            };
      const recognizer = await sherpa.OfflineRecognizer.createAsync({ featConfig, modelConfig });
      entry = { key, online: null, offline: recognizer, offlineQueue: new SerialQueue() };
    }
    cachedEntry = entry;
    return entry;
  })();

  pendingEntry = { key, promise };
  try {
    return await promise;
  } catch (err) {
    // 失败不缓存：下次可重试（只清自己的键，避免误删其它模型的成功缓存）
    if (cachedEntry && cachedEntry.key === key) cachedEntry = null;
    throw err;
  } finally {
    if (pendingEntry && pendingEntry.key === key) pendingEntry = null;
  }
}

/** 按引擎类型创建本地识别会话（识别器来自进程内缓存，会话只新建 stream） */
export async function createLocalSession(
  sherpa: SherpaModule,
  init: LocalSessionInit,
): Promise<VoiceSession> {
  const entry = await ensureLocalRecognizer(sherpa, init);

  if (init.engine === 'zipformer') {
    if (!entry.online) throw new Error('语音识别器未初始化（zipformer）');
    return new StreamingSession(entry.online, entry.online.createStream());
  }

  if (!entry.offline) throw new Error('语音识别器未初始化（离线引擎）');
  return new OfflineSession(entry.offline, entry.offlineQueue);
}