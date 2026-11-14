// src/modules/voice/engine.ts
// sherpa-onnx 运行时封装：懒加载原生模块 + 模型文件解析 + 会话（流式 / 离线）。
//
// 关键约束：sherpa-onnx-node 的 decode 为同步原生调用，会占用调用线程；因此
// 流式会话按「有新音频且就绪」节流解码，非流式会话用 decodeAsync 在原生线程池执行，
// 避免长期阻塞 Bun 事件循环。
//
// 离线引擎（SenseVoice / Paraformer / Dolphin / Whisper）统一走 Silero VAD 分段：
// 只把真实语音送进模型，噪声/静音不解码，从根上消除「底噪被识别成日文/德语」与
// Whisper 在静音上的重复幻觉。

import { availableParallelism } from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';
import type {
  VoiceDecodeMode,
  VoiceLocalEngine,
  VoiceResult,
  VoiceSession,
} from './types';
import type {
  OfflineRecognizer as OfflineRecognizerT,
  OfflineStream,
  OnlineRecognizer as OnlineRecognizerT,
  OnlineStream,
  Vad as VadT,
} from 'sherpa-onnx-node';

export type SherpaModule = typeof import('sherpa-onnx-node');

/** 采样率：全部本地模型统一 16kHz 单声道 */
export const SAMPLE_RATE = 16000;

/** 环境能量阈值（RMS），VAD 不可用时作为静音判定回退 */
const SILENCE_RMS = 0.008;
/** 静音多少毫秒判定一段结束（RMS 回退） */
const SILENCE_MS = 700;
/** 段最小长度（毫秒），过短丢弃（避免噪声触发） */
const MIN_SEGMENT_MS = 250;
/** 离线引擎产生 partial 的最小间隔（毫秒） */
const PARTIAL_INTERVAL_MS = 900;
/** partial 解码所需的最短语音（毫秒） */
const MIN_PARTIAL_MS = 450;
/** 单段最长音频（毫秒）：超长段强制切分，避免 Whisper 长音频退化 */
const MAX_SEGMENT_MS = 20_000;
/** 峰值归一化目标（仅语音段） */
const NORMALIZE_PEAK = 0.9;
/** 低于该峰值视为无有效语音，不做放大 */
const NORMALIZE_MIN_PEAK = 0.02;

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

/** 识别线程数：2~4 之间（过多线程在短音频上反而增加调度开销） */
export function recognitionThreads(): number {
  let cores = 4;
  try {
    cores = availableParallelism();
  } catch {
    cores = 4;
  }
  return Math.min(4, Math.max(2, Math.floor(cores / 2)));
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

  if (engine === 'sensevoice' || engine === 'paraformer' || engine === 'dolphin') {
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

/**
 * 峰值归一化：quiet 语音放大到 0.9 峰值，改善小音量识别；
 * 噪声/静音（峰值过低）不做放大，避免把底噪推成「语音」。
 */
function normalizeSpeech(audio: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < audio.length; i++) {
    const abs = Math.abs(audio[i]);
    if (abs > peak) peak = abs;
  }
  if (peak < NORMALIZE_MIN_PEAK || peak >= NORMALIZE_PEAK) return audio;
  const scale = NORMALIZE_PEAK / peak;
  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) out[i] = audio[i] * scale;
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
  private stream: OnlineStream;
  private last = '';
  private closed = false;

  constructor(private readonly recognizer: OnlineRecognizerT) {
    this.stream = recognizer.createStream();
  }

  /**
   * 端点/异常后重建流：等价于 reset，但不会残留任何解码状态。
   * 旧流不再持有强引用，交给 GC 释放原生句柄。
   */
  private rotateStream(): void {
    this.stream = this.recognizer.createStream();
    this.last = '';
  }

  acceptSamples(samples: Float32Array): void {
    if (this.closed) return;
    try {
      this.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    } catch (err) {
      // 原生层异常：重建流，保证后续音频还能继续识别
      console.warn('[voice] streaming acceptWaveform failed, recreating stream', err);
      this.rotateStream();
    }
  }

  poll(): VoiceResult | null {
    if (this.closed) return null;
    try {
      if (!this.recognizer.isReady(this.stream)) return null;
      this.recognizer.decode(this.stream);
      const text = (this.recognizer.getResult(this.stream).text ?? '').trim();
      if (this.recognizer.isEndpoint(this.stream)) {
        // 端点后直接换新流：避免 reset 失败时永久停在 endpoint 状态（后续句子不出字）
        this.rotateStream();
        return text ? { text, isFinal: true } : null;
      }
      if (text && text !== this.last) {
        this.last = text;
        return { text, isFinal: false };
      }
      return null;
    } catch (err) {
      // 瞬时解码失败：重建流后下一 tick 继续，避免整轮录音因一次异常永久卡死
      console.warn('[voice] streaming decode failed, recreating stream', err);
      this.rotateStream();
      return null;
    }
  }

  async finish(): Promise<VoiceResult | null> {
    if (this.closed) return null;
    try {
      this.stream.inputFinished();
      while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
      const text = (this.recognizer.getResult(this.stream).text ?? '').trim();
      this.last = '';
      return text ? { text, isFinal: true } : null;
    } catch (err) {
      console.warn('[voice] streaming finish failed', err);
      this.last = '';
      return null;
    }
  }

  close(): void {
    this.closed = true;
  }
}

/** 离线会话可调参数 */
interface OfflineSessionOptions {
  engine: VoiceLocalEngine;
  /** Silero VAD 模型路径（null = 使用 RMS 回退） */
  vadModel: string | null;
}

/**
 * 非流式会话（SenseVoice / Paraformer / Dolphin / Whisper）：
 *   - Silero VAD 分段：只解码真实语音，噪声/静音不送模型；
 *   - 解码严格排队，busy 时排队而不是丢弃音频；
 *   - partial 只解码当前语音段并节流（Whisper 不产生 partial，避免重复幻觉）。
 */
class OfflineSession implements VoiceSession {
  private vad: VadT | null = null;
  private vadBroken = false;
  /** 当前语音段（partial 用；VAD 段尾会切段） */
  private speech: Float32Array[] = [];
  private speechSamples = 0;
  /** RMS 回退分段状态 */
  private fallbackSeg: Float32Array[] = [];
  private fallbackSamples = 0;
  private silenceMs = 0;
  /** 本会话的解码链（保证 finish 能等待全部在途解码） */
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  private results: VoiceResult[] = [];
  private lastPartialAt = 0;
  private lastPartialText = '';
  private closed = false;

  constructor(
    private readonly sherpa: SherpaModule,
    private readonly recognizer: OfflineRecognizerT,
    /** 同一 recognizer 的全局串行队列（多连接共享识别器时禁止并发解码） */
    private readonly queue: SerialQueue,
    private readonly opts: OfflineSessionOptions,
  ) {
    if (opts.vadModel) {
      try {
        this.vad = new sherpa.Vad(
          {
            sileroVad: {
              model: opts.vadModel,
              threshold: 0.5,
              minSilenceDuration: 0.35,
              minSpeechDuration: 0.2,
              windowSize: 512,
              maxSpeechDuration: MAX_SEGMENT_MS / 1000,
            },
            sampleRate: SAMPLE_RATE,
            numThreads: 1,
            provider: 'cpu',
            debug: false,
          },
          60,
        );
      } catch {
        this.vad = null;
      }
    }
  }

  acceptSamples(samples: Float32Array): void {
    if (this.closed) return;

    if (this.vad && !this.vadBroken) {
      try {
        this.vad.acceptWaveform(samples);
        this.speech.push(samples);
        this.speechSamples += samples.length;

        // VAD 段尾：取完整语音段排队解码
        while (!this.vad.isEmpty()) {
          const seg = this.vad.front();
          this.vad.pop();
          this.enqueueFinal(seg.samples);
          this.speech = [];
          this.speechSamples = 0;
        }

        // 异常情况（长时间无停顿）强制切段，避免无限增长
        if (this.speechSamples >= (SAMPLE_RATE * MAX_SEGMENT_MS) / 1000) {
          this.enqueueFinal(concatChunks(this.speech));
          this.speech = [];
          this.speechSamples = 0;
        }
        return;
      } catch {
        // VAD 原生异常：降级到 RMS 分段，后续不再尝试
        this.vadBroken = true;
        this.vad = null;
      }
    }

    // RMS 回退（VAD 不可用时）
    this.fallbackSeg.push(samples);
    this.fallbackSamples += samples.length;
    if (rms(samples) < SILENCE_RMS) {
      this.silenceMs += (samples.length / SAMPLE_RATE) * 1000;
    } else {
      this.silenceMs = 0;
    }
    const minSamples = (SAMPLE_RATE * MIN_SEGMENT_MS) / 1000;
    if (this.silenceMs >= SILENCE_MS && this.fallbackSamples >= minSamples) {
      const audio = concatChunks(this.fallbackSeg);
      this.fallbackSeg = [];
      this.fallbackSamples = 0;
      this.silenceMs = 0;
      this.enqueueFinal(audio);
    }
  }

  poll(): VoiceResult | null {
    if (this.results.length > 0) return this.results.shift() ?? null;

    // Whisper 不做 partial：短窗解码容易产生重复幻觉
    if (this.opts.engine === 'whisper') return null;
    if (this.queued > 0) return null;

    const audio = this.vad && !this.vadBroken ? this.speech : this.fallbackSeg;
    const sampleCount = this.vad && !this.vadBroken ? this.speechSamples : this.fallbackSamples;
    const now = Date.now();
    if (
      sampleCount >= (SAMPLE_RATE * MIN_PARTIAL_MS) / 1000 &&
      now - this.lastPartialAt >= PARTIAL_INTERVAL_MS
    ) {
      this.lastPartialAt = now;
      this.enqueuePartial(concatChunks(audio));
    }
    return null;
  }

  /** 最终段解码（结果进入 results，由 poll 取出） */
  private enqueueFinal(audio: Float32Array): void {
    this.enqueueDecode(audio, true);
  }

  /** 中间态解码（可覆盖；失败静默） */
  private enqueuePartial(audio: Float32Array): void {
    this.enqueueDecode(audio, false);
  }

  private enqueueDecode(audio: Float32Array, isFinal: boolean): void {
    if (audio.length === 0) return;
    const samples = normalizeSpeech(audio);
    this.queued += 1;
    const task = this.pending.then(() =>
      this.queue.run(async () => {
        try {
          const stream: OfflineStream = this.recognizer.createStream();
          stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
          const res = await this.recognizer.decodeAsync(stream);
          const text = (res.text ?? '').trim();
          if (!text) return;
          if (isFinal) {
            this.results.push({ text, isFinal: true });
            this.lastPartialText = '';
          } else if (text !== this.lastPartialText) {
            this.lastPartialText = text;
            this.results.push({ text, isFinal: false });
          }
        } catch {
          // 单段解码失败忽略；不阻断后续段
        }
      }),
    );
    this.pending = task.catch(() => undefined);
    void task.finally(() => {
      this.queued -= 1;
    });
  }

  async finish(): Promise<VoiceResult | null> {
    // VAD 冲刷：把仍在进行中的语音段立即产出
    if (this.vad && !this.vadBroken) {
      try {
        this.vad.flush();
        while (!this.vad.isEmpty()) {
          const seg = this.vad.front();
          this.vad.pop();
          this.enqueueFinal(seg.samples);
        }
        this.speech = [];
        this.speechSamples = 0;
      } catch {
        // 忽略：按已排队结果返回
      }
    } else if (this.fallbackSamples > 0) {
      const audio = concatChunks(this.fallbackSeg);
      this.fallbackSeg = [];
      this.fallbackSamples = 0;
      this.enqueueFinal(audio);
    }

    // 等待全部在途解码（含队列中的最终段）
    await this.pending.catch(() => undefined);

    // 汇总尚未取走的 final（已通过 poll 发出的不再重复）
    const texts = this.results.filter((r) => r.isFinal).map((r) => r.text);
    this.results = [];
    if (texts.length > 0) return { text: texts.join(' '), isFinal: true };
    return null;
  }

  close(): void {
    this.closed = true;
    try {
      this.vad?.clear();
    } catch {
      // 忽略
    }
    this.vad = null;
  }
}

// ============================================================================
// 会话工厂
// ============================================================================

export interface LocalSessionInit {
  engine: VoiceLocalEngine;
  mode: VoiceDecodeMode;
  /** 模型目录（含解压后的模型文件） */
  modelDir: string;
  /** 识别语言（'auto' | 'zh' | 'en' ...；只对 SenseVoice / Whisper 生效） */
  language: string;
  /** Silero VAD 模型路径（null = RMS 回退） */
  vadModel: string | null;
  numThreads: number;
}

/** 缓存的识别器条目（单条目：只保留当前模型，避免多模型常驻内存） */
interface LocalRecognizerEntry {
  /** 缓存键：`${engine}::${mode}::${modelDir}::${language}` */
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
  return `${init.engine}::${init.mode}::${init.modelDir}::${init.language}`;
}

/** 清空识别器缓存（模型安装/卸载后调用，避免继续使用旧文件构建的实例） */
export function invalidateLocalRecognizer(): void {
  cachedEntry = null;
  pendingEntry = null;
  // Worker 内的识别器缓存同步清理（安装/卸载模型后必须重建）
  if (workerHost) {
    // 主线程缓存键一并失效：下一次 createSession 会重新 init，
    // 否则 Worker 已清空识别器而主线程仍以为就绪，导致 start 失败回退。
    workerHost.key = '';
    workerHost.ready = Promise.resolve();
    try {
      workerHost.worker.postMessage({ type: 'reset' } satisfies VoiceWorkerRequest);
    } catch {
      // Worker 已退出：下次会话会重新创建
    }
  }
}

/** Whisper 不接受 'auto'（原生层会直接报错退出）：空串表示自动检测 */
function whisperLanguage(language: string): string {
  return language === 'auto' || language === '' ? '' : language;
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
    if (init.mode === 'streaming') {
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
        // 语音输入法口径：说完短停顿即提交，同时保留较长静音兜底
        rule1MinTrailingSilence: 1.2,
        rule2MinTrailingSilence: 0.8,
        rule3MinUtteranceLength: 20,
      });
      entry = { key, online: recognizer, offline: null, offlineQueue: new SerialQueue() };
    } else {
      const base = {
        tokens: files.tokens,
        numThreads: init.numThreads,
        provider: 'cpu',
        debug: false,
      };
      const modelConfig =
        init.engine === 'sensevoice'
          ? {
              senseVoice: {
                model: files.model,
                language: init.language === 'auto' ? 'auto' : init.language,
                useInverseTextNormalization: 1,
              },
              ...base,
            }
          : init.engine === 'paraformer'
            ? { paraformer: { model: files.model }, ...base }
            : init.engine === 'dolphin'
              ? { dolphin: { model: files.model }, ...base }
              : {
                  whisper: {
                    encoder: files.encoder,
                    decoder: files.decoder,
                    language: whisperLanguage(init.language),
                    task: 'transcribe',
                  },
                  ...base,
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

/** 按引擎类型创建本地识别会话（进程内实现；Worker 不可用时的兜底） */
export async function createLocalSessionInProcess(
  sherpa: SherpaModule,
  init: LocalSessionInit,
): Promise<VoiceSession> {
  const entry = await ensureLocalRecognizer(sherpa, init);

  if (init.mode === 'streaming') {
    if (!entry.online) throw new Error('语音识别器未初始化（流式引擎）');
    return new StreamingSession(entry.online);
  }

  if (!entry.offline) throw new Error('语音识别器未初始化（离线引擎）');
  return new OfflineSession(sherpa, entry.offline, entry.offlineQueue, {
    engine: init.engine,
    vadModel: init.vadModel,
  });
}

// ============================================================================
// Worker 宿主：模型加载与解码移出主线程
//
// 动机：流式识别器 `new OnlineRecognizer(...)` 是同步原生调用（本机 5~6 秒），
// 在主线程执行会冻结 HTTP/WS/静态资源，导致重启后首次录音完全收不到音频。
// 把识别器放进 Worker 后，主线程始终响应；后端启动时可安全地后台预热。
// ============================================================================

/** 主线程 → Worker 请求（与 engine-worker.ts 保持一致） */
export type VoiceWorkerRequest =
  | {
      type: 'init';
      engine: VoiceLocalEngine;
      mode: VoiceDecodeMode;
      modelDir: string;
      language: string;
      numThreads: number;
    }
  | { type: 'start'; sessionId: string; vadModel: string | null }
  | { type: 'audio'; sessionId: string; samples: Float32Array }
  | { type: 'stop'; sessionId: string }
  | { type: 'close'; sessionId: string }
  | { type: 'reset' };

/** Worker → 主线程事件 */
export type VoiceWorkerEvent =
  | { type: 'inited'; elapsedMs: number }
  | { type: 'init-error'; error: string }
  | { type: 'started'; sessionId: string }
  | { type: 'start-error'; sessionId: string; error: string }
  | { type: 'result'; sessionId: string; result: VoiceResult }
  | { type: 'stopped'; sessionId: string; final: VoiceResult | null }
  | { type: 'error'; sessionId?: string; error: string };

/** Worker init 键：vadModel 属于会话，不参与识别器缓存键 */
function workerKey(init: LocalSessionInit): string {
  return `${init.engine}::${init.mode}::${init.modelDir}::${init.language}::${init.numThreads}`;
}

/** Worker 入口：打包产物优先，开发模式回退到 TS 源文件（Bun 可直接运行） */
function workerScriptPath(): string {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'voice-engine-worker.js');
  if (existsSync(bundled)) return bundled;
  return fileURLToPath(new URL('./engine-worker.ts', import.meta.url));
}

interface WorkerHost {
  worker: Worker;
  key: string;
  ready: Promise<void>;
  initWaiter: { resolve: () => void; reject: (err: Error) => void } | null;
  sessions: Map<string, WorkerSession>;
  terminating: boolean;
}

let workerHost: WorkerHost | null = null;
/** 最近一次 Worker 初始化/运行失败原因（供服务层日志） */
let workerError: string | null = null;

export function getVoiceWorkerError(): string | null {
  return workerError;
}

/**
 * Worker 会话：接口仍为同步 poll（结果由 Worker 异步推送到本地队列），
 * 从而保持 VoiceSessionHost 的驱动模型不变。
 */
class WorkerSession implements VoiceSession {
  readonly started: Promise<void>;
  private startResolve: (() => void) | null = null;
  private startReject: ((err: Error) => void) | null = null;
  private finishResolve: ((result: VoiceResult | null) => void) | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly queue: VoiceResult[] = [];
  private closed = false;

  constructor(
    readonly id: string,
    private readonly host: WorkerHost,
  ) {
    this.started = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
  }

  acceptSamples(samples: Float32Array): void {
    if (this.closed) return;
    // transfer：音频帧由 Host 每帧新建，转移后主线程不再持有，零拷贝
    this.host.worker.postMessage(
      { type: 'audio', sessionId: this.id, samples } satisfies VoiceWorkerRequest,
      [samples.buffer as ArrayBuffer],
    );
  }

  poll(): VoiceResult | null {
    return this.queue.shift() ?? null;
  }

  finish(): Promise<VoiceResult | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise<VoiceResult | null>((resolve) => {
      this.finishResolve = resolve;
      this.finishTimer = setTimeout(() => this.settleFinish(null), 15_000);
      try {
        this.host.worker.postMessage({ type: 'stop', sessionId: this.id } satisfies VoiceWorkerRequest);
      } catch {
        this.settleFinish(null);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.settleFinish(null);
    this.host.sessions.delete(this.id);
    try {
      this.host.worker.postMessage({ type: 'close', sessionId: this.id } satisfies VoiceWorkerRequest);
    } catch {
      // Worker 已退出：忽略
    }
  }

  onStarted(): void {
    this.startResolve?.();
    this.startResolve = null;
    this.startReject = null;
  }

  onStartError(err: Error): void {
    this.startReject?.(err);
    this.startResolve = null;
    this.startReject = null;
  }

  onResult(result: VoiceResult): void {
    if (this.closed) return;
    this.queue.push(result);
  }

  onStopped(final: VoiceResult | null): void {
    this.settleFinish(final);
  }

  onError(): void {
    this.onStartError(new Error('voice worker session error'));
    this.settleFinish(null);
  }

  private settleFinish(result: VoiceResult | null): void {
    if (this.finishTimer !== null) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    const resolve = this.finishResolve;
    this.finishResolve = null;
    resolve?.(result);
  }
}

function handleWorkerEvent(host: WorkerHost, event: VoiceWorkerEvent): void {
  switch (event.type) {
    case 'inited': {
      const waiter = host.initWaiter;
      host.initWaiter = null;
      workerError = null;
      waiter?.resolve();
      return;
    }
    case 'init-error': {
      const waiter = host.initWaiter;
      host.initWaiter = null;
      workerError = event.error;
      // 清空键：允许下次会话重试 Worker（失败可能只是瞬时资源问题）
      host.key = '';
      waiter?.reject(new Error(event.error));
      return;
    }
    case 'started':
      host.sessions.get(event.sessionId)?.onStarted();
      return;
    case 'start-error':
      host.sessions.get(event.sessionId)?.onStartError(new Error(event.error));
      return;
    case 'result':
      host.sessions.get(event.sessionId)?.onResult(event.result);
      return;
    case 'stopped':
      host.sessions.get(event.sessionId)?.onStopped(event.final);
      return;
    case 'error':
      workerError = event.error;
      if (event.sessionId) host.sessions.get(event.sessionId)?.onError();
      return;
    default:
      return;
  }
}

function handleWorkerFailure(host: WorkerHost, err: Error): void {
  workerError = err.message;
  const waiter = host.initWaiter;
  host.initWaiter = null;
  waiter?.reject(err);
  for (const session of host.sessions.values()) session.onError();
  host.sessions.clear();
  if (workerHost === host) workerHost = null;
}

function spawnWorkerHost(): WorkerHost {
  // Bun 的 WorkerOptions 支持 type: 'module'（Node 类型定义未收录，做窄化转型）
  const worker = new Worker(workerScriptPath(), { type: 'module' } as unknown as WorkerOptions);
  const host: WorkerHost = {
    worker,
    key: '',
    ready: Promise.resolve(),
    initWaiter: null,
    sessions: new Map(),
    terminating: false,
  };
  worker.on('message', (event: VoiceWorkerEvent) => handleWorkerEvent(host, event));
  worker.on('error', (err: Error) => handleWorkerFailure(host, err));
  worker.on('exit', (code: number) => {
    if (!host.terminating) {
      handleWorkerFailure(host, new Error(`voice worker exited (${code})`));
    } else if (workerHost === host) {
      workerHost = null;
    }
  });
  return host;
}

/** 确保 Worker 已按指定模型完成初始化（模型加载在 Worker 线程内，不阻塞主线程） */
async function ensureWorkerReady(init: LocalSessionInit): Promise<WorkerHost> {
  if (!workerHost) workerHost = spawnWorkerHost();
  const host = workerHost;
  const key = workerKey(init);
  if (host.key === key) {
    await host.ready;
    return host;
  }

  host.key = key;
  host.ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      host.initWaiter = null;
      host.key = '';
      reject(new Error('voice worker init timeout'));
    }, 20_000);
    host.initWaiter = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    };
  });
  host.worker.postMessage({
    type: 'init',
    engine: init.engine,
    mode: init.mode,
    modelDir: init.modelDir,
    language: init.language,
    numThreads: init.numThreads,
  } satisfies VoiceWorkerRequest);
  await host.ready;
  return host;
}

/** 后台预热识别器（不创建会话；模型加载在 Worker 内完成） */
export async function prewarmLocalEngine(init: LocalSessionInit): Promise<void> {
  await ensureWorkerReady(init);
}

/**
 * 创建本地识别会话：优先 Worker（主线程零阻塞），Worker 不可用时回退进程内实现。
 */
export async function createLocalSession(
  sherpa: SherpaModule,
  init: LocalSessionInit,
): Promise<VoiceSession> {
  try {
    const host = await ensureWorkerReady(init);
    const session = new WorkerSession(randomUUID(), host);
    host.sessions.set(session.id, session);
    host.worker.postMessage({
      type: 'start',
      sessionId: session.id,
      vadModel: init.vadModel,
    } satisfies VoiceWorkerRequest);
    await session.started;
    return session;
  } catch (err) {
    workerError = err instanceof Error ? err.message : String(err);
    // Worker 路径失败：退回进程内实现，保证语音仍可用
    return createLocalSessionInProcess(sherpa, init);
  }
}
