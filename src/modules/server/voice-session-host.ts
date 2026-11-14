// src/modules/server/voice-session-host.ts
// WS 语音会话宿主：为每条连接维护一个语音识别会话，驱动解码与结果回推。
//
// 协议（客户端 ↔ 服务端）：
//   客户端 → 服务端：
//     {"type":"voice.start","modelId?":"..."}  开始录音（创建会话）
//     二进制帧（PCM int16 LE @16kHz 单声道）    音频流
//     {"type":"voice.stop"}                     结束录音（冲刷最终结果）
//   服务端 → 客户端：
//     {"type":"voice.ready"}                    会话就绪
//     {"type":"voice.partial","text":"..."}     中间态文本（可被覆盖）
//     {"type":"voice.final","text":"..."}       确定文本
//     {"type":"voice.stopped"}                  会话已结束
//     {"type":"voice.error","error":"..."}      错误
//
// 模型首次加载需要数秒：客户端在收到 ready 前就开始发送音频，
// 这里在会话创建期间缓冲二进制帧，就绪后回放，保证「开口即录、不丢字」。

import type { Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { VoiceService, VoiceSession } from '../voice';

/** poll 单次 tick 的最大产出条数（防御性上限） */
const MAX_POLLS_PER_TICK = 8;
/** 解码驱动间隔（毫秒）：流式引擎据此节流 decode */
const TICK_INTERVAL_MS = 100;
/** 会话创建期间缓冲音频上限（采样数）：30 秒 @16kHz */
const MAX_PENDING_SAMPLES = 16000 * 30;

interface AudioStats {
  peak: number;
  rmsSum: number;
  rmsCount: number;
}

interface VoiceEntry extends AudioStats {
  session: VoiceSession;
  timer: ReturnType<typeof setInterval>;
  send: (msg: unknown) => void;
  frames: number;
  samples: number;
  /** 会话代际：前端据此丢弃上一轮会话的迟到事件 */
  gen: number;
  /** 本轮是否已经产出过任何文本（partial/final）：避免「已识别却误报无语音」 */
  hasText: boolean;
}

/** 创建中的会话（模型加载期间 stop/dispose 需要被记录，避免会话泄漏或丢停止请求） */
interface PendingStart extends AudioStats {
  stopRequested: boolean;
  disposed: boolean;
  gen: number;
  /** 就绪前缓冲的音频（int16 → float32），就绪后按序回放 */
  buffer: Float32Array[];
  bufferSamples: number;
}

/** 累计音频统计（峰值 / RMS 用于区分「没收到声音」与「有声音但没识别出文字」） */
function accumulateStats(stats: AudioStats, samples: Float32Array): void {
  let sum = 0;
  let peak = stats.peak;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  stats.peak = peak;
  stats.rmsSum += sum;
  stats.rmsCount += samples.length;
}

export class VoiceSessionHost {
  private readonly entries = new Map<string, VoiceEntry>();
  /** 正在等待 createSession 的连接（模型首次加载耗时数秒） */
  private readonly starting = new Map<string, PendingStart>();
  /** 会话开始前的音频缓冲（兜底：即使 voice.start 被延迟，音频也不丢） */
  private readonly preBuffers = new Map<string, PendingStart>();
  /** 每条连接当前的会话代际（每次 voice.start 递增） */
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly services: ServiceRegistry,
    private readonly logger: Logger,
  ) {}

  /** 连接建立时预置启动前缓冲（由 ws-handler.registerConnection 调用） */
  prepare(connId: string): void {
    if (this.entries.has(connId) || this.starting.has(connId) || this.preBuffers.has(connId)) return;
    this.preBuffers.set(connId, {
      stopRequested: false,
      disposed: false,
      gen: 0,
      buffer: [],
      bufferSamples: 0,
      peak: 0,
      rmsSum: 0,
      rmsCount: 0,
    });
  }

  /** 开始会话（幂等：重复 start 先结束旧会话） */
  async start(connId: string, send: (msg: unknown) => void, modelId?: string): Promise<void> {
    const startedAt = Date.now();
    // 新会话代际：旧 stop()/finish 的迟到结果不得再落到新会话
    const gen = (this.generations.get(connId) ?? 0) + 1;
    this.generations.set(connId, gen);
    // 旧会话先摘除（音频从此刻起进入 pending 缓冲，不会丢）
    const old = this.entries.get(connId);
    if (old) {
      this.entries.delete(connId);
      clearInterval(old.timer);
    }

    // 同步登记 pending：后续二进制帧即使先到也会被缓冲
    const pending: PendingStart = {
      stopRequested: false,
      disposed: false,
      gen,
      buffer: [],
      bufferSamples: 0,
      peak: 0,
      rmsSum: 0,
      rmsCount: 0,
    };
    // 接管启动前缓冲（voice.start 延迟期间到达的音频）
    const pre = this.preBuffers.get(connId);
    if (pre) {
      this.preBuffers.delete(connId);
      pending.buffer = pre.buffer;
      pending.bufferSamples = pre.bufferSamples;
      pending.peak = pre.peak;
      pending.rmsSum = pre.rmsSum;
      pending.rmsCount = pre.rmsCount;
    }
    this.starting.set(connId, pending);

    // 旧会话冲刷（其 send 仍指向原连接；代际已变化，前端会忽略旧事件）
    if (old) {
      try {
        const final = await old.session.finish();
        if (final) old.send({ type: 'voice.final', payload: { text: final.text, gen: old.gen } });
      } catch {
        // 忽略
      }
      old.session.close();
    }

    const service = this.services.tryResolve<VoiceService>(ServiceNames.VOICE_SERVICE);
    if (!service) {
      this.starting.delete(connId);
      send({ type: 'voice.error', payload: { error: 'VOICE_UNAVAILABLE', gen } });
      return;
    }
    if (!service.getStatus().enabled) {
      this.starting.delete(connId);
      send({ type: 'voice.error', payload: { error: 'VOICE_DISABLED', gen } });
      return;
    }

    try {
      const session = await service.createSession(modelId);
      // 创建期间连接已断开：直接释放，避免会话泄漏
      if (pending.disposed) {
        session.close();
        return;
      }
      // 创建期间又收到新的 voice.start：旧代际直接丢弃，避免覆盖新会话
      if (this.generations.get(connId) !== gen || this.starting.get(connId) !== pending) {
        session.close();
        return;
      }

      // 回放就绪前缓冲的音频（模型加载期间用户说的话）
      for (const chunk of pending.buffer) session.acceptSamples(chunk);
      pending.buffer = [];

      // 创建期间收到停止：冲刷后结束，不发 ready
      if (pending.stopRequested) {
        try {
          const final = await session.finish();
          // 只回推 final：partial 已被 finish 的收尾结果取代，发出去会造成重复上屏
          for (const text of this.drainFinalResults(session)) {
            send({ type: 'voice.final', payload: { text, gen } });
          }
          if (final) {
            send({
              type: 'voice.final',
              payload: {
                text: final.text,
                gen,
                ...(final.language ? { language: final.language } : {}),
              },
            });
          }
        } catch {
          // 忽略
        }
        session.close();
        send({ type: 'voice.stopped', payload: { gen } });
        return;
      }

      const timer = setInterval(() => this.tick(connId), TICK_INTERVAL_MS);
      this.entries.set(connId, {
        session,
        timer,
        send,
        frames: 0,
        samples: pending.bufferSamples,
        peak: pending.peak,
        rmsSum: pending.rmsSum,
        rmsCount: pending.rmsCount,
        gen,
        hasText: false,
      });
      this.logger.info('[voice-diag] session ready', {
        connId,
        modelId: modelId ?? '(default)',
        bufferedSamples: pending.bufferSamples,
        elapsedMs: Date.now() - startedAt,
      });
      send({ type: 'voice.ready', payload: { gen } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('voice session start failed', { error: message });
      if (!pending.disposed) send({ type: 'voice.error', payload: { error: message, gen } });
    } finally {
      if (this.starting.get(connId) === pending) this.starting.delete(connId);
    }
  }

  /** 接收二进制音频帧（PCM int16 LE → float32）；会话未就绪时先缓冲 */
  acceptBinary(connId: string, buf: Buffer): void {
    const count = Math.floor(buf.byteLength / 2);
    if (count === 0) return;

    const entry = this.entries.get(connId);
    if (!entry) {
      // 会话创建中：缓冲音频，就绪后回放（模型加载期间不丢字）
      // 若 voice.start 尚未被处理，则写入「启动前缓冲」，避免音频帧被丢弃。
      const target = this.starting.get(connId) ?? this.preBuffers.get(connId);
      if (!target || target.disposed) return;
      if (target.bufferSamples >= MAX_PENDING_SAMPLES) return;
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
      target.buffer.push(samples);
      target.bufferSamples += count;
      accumulateStats(target, samples);
      return;
    }

    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
    entry.frames += 1;
    entry.samples += count;
    accumulateStats(entry, samples);
    if (entry.frames === 1) {
      this.logger.info('[voice-diag] first binary frame', {
        connId,
        bytes: buf.byteLength,
        samples: count,
        nonZero: samples.some((sample) => sample !== 0),
      });
    }
    entry.session.acceptSamples(samples);
  }

  /** 结束会话并冲刷最终结果 */
  async stop(connId: string): Promise<void> {
    // 模型仍在加载：记录停止意图，由 start() 在创建完成后收尾
    const pending = this.starting.get(connId);
    if (pending) {
      pending.stopRequested = true;
      return;
    }
    // voice.stop 先于 voice.start 到达：丢弃启动前缓冲，避免污染下一次会话
    this.preBuffers.delete(connId);
    const entry = this.entries.get(connId);
    if (!entry) return;
    this.entries.delete(connId);
    clearInterval(entry.timer);
    const finishStartedAt = Date.now();
    const rms = entry.rmsCount > 0 ? Math.sqrt(entry.rmsSum / entry.rmsCount) : 0;
    this.logger.info('[voice-diag] finish started', {
      connId,
      frames: entry.frames,
      samples: entry.samples,
      rms: Number(rms.toFixed(4)),
      peak: Number(entry.peak.toFixed(4)),
      hasText: entry.hasText,
    });
    let final: Awaited<ReturnType<VoiceSession['finish']>> = null;
    try {
      final = await entry.session.finish();
      // 顺序关键：先发送队列中的 final（较早的句子），再发送 finish 的收尾 final。
      // queued partial 一律丢弃——它们已被 final 取代，若在 final 之后发送，
      // 前端 commitVoice() 重置锚点后会把它再插入一次，造成「同一句出现两遍」。
      for (const text of this.drainFinalResults(entry.session)) {
        entry.hasText = true;
        entry.send({ type: 'voice.final', payload: { text, gen: entry.gen } });
      }
      this.logger.info('[voice-diag] finish returned', {
        connId,
        elapsedMs: Date.now() - finishStartedAt,
        textLength: final?.text.length ?? 0,
        rms: Number(rms.toFixed(4)),
        peak: Number(entry.peak.toFixed(4)),
        hasText: entry.hasText,
      });
      if (final) {
        entry.send({
          type: 'voice.final',
          payload: {
            text: final.text,
            gen: entry.gen,
            ...(final.language ? { language: final.language } : {}),
          },
        });
      }
    } catch (err) {
      this.logger.warn('voice session finish failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // 仅在「本轮从未产出任何文字」且无最终文本时提示：
    // 避免已经识别并上屏、只是尾段为空时误报「没有识别出文字」。
    if (!final && !entry.hasText) {
      if (entry.peak < 0.01) {
        entry.send({ type: 'voice.error', payload: { error: 'VOICE_SILENT_INPUT', gen: entry.gen } });
      } else {
        entry.send({ type: 'voice.error', payload: { error: 'VOICE_NO_SPEECH', gen: entry.gen } });
      }
    }
    entry.session.close();
    this.logger.info('[voice-diag] session closed', { connId });
    entry.send({ type: 'voice.stopped', payload: { gen: entry.gen } });
  }

  /** 连接断开：静默清理（不发消息） */
  dispose(connId: string): void {
    const pending = this.starting.get(connId);
    if (pending) pending.disposed = true;
    this.preBuffers.delete(connId);
    this.generations.delete(connId);
    const entry = this.entries.get(connId);
    if (!entry) return;
    this.entries.delete(connId);
    clearInterval(entry.timer);
    entry.session.close();
  }

  /** 单次驱动：取会话产出并回推（partial 覆盖 / final 确定） */
  private tick(connId: string): void {
    const entry = this.entries.get(connId);
    if (!entry) return;
    for (let i = 0; i < MAX_POLLS_PER_TICK; i++) {
      const result = entry.session.poll();
      if (!result) break;
      if (result.text) entry.hasText = true;
      entry.send({
        type: result.isFinal ? 'voice.final' : 'voice.partial',
        payload: { text: result.text, gen: entry.gen },
      });
    }
  }

  /** 取出会话中尚未回推的 final（stop/收尾用）；partial 直接丢弃 */
  private drainFinalResults(session: VoiceSession): string[] {
    const texts: string[] = [];
    for (;;) {
      const result = session.poll();
      if (!result) break;
      if (result.isFinal && result.text) texts.push(result.text);
    }
    return texts;
  }
}
