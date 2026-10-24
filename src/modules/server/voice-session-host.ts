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

import type { Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { VoiceService, VoiceSession } from '../voice';

/** poll 单次 tick 的最大产出条数（防御性上限） */
const MAX_POLLS_PER_TICK = 8;
/** 解码驱动间隔（毫秒）：流式引擎据此节流 decode */
const TICK_INTERVAL_MS = 100;

interface VoiceEntry {
  session: VoiceSession;
  timer: ReturnType<typeof setInterval>;
  send: (msg: unknown) => void;
  frames: number;
  samples: number;
}

/** 创建中的会话（模型加载期间 stop/dispose 需要被记录，避免会话泄漏或丢停止请求） */
interface PendingStart {
  stopRequested: boolean;
  disposed: boolean;
}

export class VoiceSessionHost {
  private readonly entries = new Map<string, VoiceEntry>();
  /** 正在等待 createSession 的连接（模型首次加载耗时数秒） */
  private readonly starting = new Map<string, PendingStart>();

  constructor(
    private readonly services: ServiceRegistry,
    private readonly logger: Logger,
  ) {}

  /** 开始会话（幂等：重复 start 先结束旧会话） */
  async start(connId: string, send: (msg: unknown) => void, modelId?: string): Promise<void> {
    await this.stop(connId);

    const service = this.services.tryResolve<VoiceService>(ServiceNames.VOICE_SERVICE);
    if (!service) {
      send({ type: 'voice.error', payload: { error: 'VOICE_UNAVAILABLE' } });
      return;
    }
    if (!service.getStatus().enabled) {
      send({ type: 'voice.error', payload: { error: 'VOICE_DISABLED' } });
      return;
    }

    const pending: PendingStart = { stopRequested: false, disposed: false };
    this.starting.set(connId, pending);
    try {
      const session = await service.createSession(modelId);
      // 创建期间连接已断开：直接释放，避免会话泄漏
      if (pending.disposed) {
        session.close();
        return;
      }
      // 创建期间收到停止（兼容旧客户端）：冲刷后结束，不发 ready
      if (pending.stopRequested) {
        try {
          const final = await session.finish();
          if (final) send({ type: 'voice.final', payload: { text: final.text } });
        } catch {
          // 忽略
        }
        session.close();
        send({ type: 'voice.stopped' });
        return;
      }
      const timer = setInterval(() => this.tick(connId), TICK_INTERVAL_MS);
      this.entries.set(connId, { session, timer, send, frames: 0, samples: 0 });
      send({ type: 'voice.ready' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('voice session start failed', { error: message });
      if (!pending.disposed) send({ type: 'voice.error', payload: { error: message } });
    } finally {
      if (this.starting.get(connId) === pending) this.starting.delete(connId);
    }
  }

  /** 接收二进制音频帧（PCM int16 LE → float32） */
  acceptBinary(connId: string, buf: Buffer): void {
    const entry = this.entries.get(connId);
    if (!entry) return;
    const count = Math.floor(buf.byteLength / 2);
    if (count === 0) return;
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
    entry.frames += 1;
    entry.samples += count;
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
    const entry = this.entries.get(connId);
    if (!entry) return;
    this.entries.delete(connId);
    clearInterval(entry.timer);
    const finishStartedAt = Date.now();
    this.logger.info('[voice-diag] finish started', {
      connId,
      frames: entry.frames,
      samples: entry.samples,
    });
    try {
      const final = await entry.session.finish();
      this.logger.info('[voice-diag] finish returned', {
        connId,
        elapsedMs: Date.now() - finishStartedAt,
        textLength: final?.text.length ?? 0,
      });
      if (final) entry.send({ type: 'voice.final', payload: { text: final.text } });
    } catch (err) {
      this.logger.warn('voice session finish failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    entry.session.close();
    this.logger.info('[voice-diag] session closed', { connId });
    entry.send({ type: 'voice.stopped' });
  }

  /** 连接断开：静默清理（不发消息） */
  dispose(connId: string): void {
    const pending = this.starting.get(connId);
    if (pending) pending.disposed = true;
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
      entry.send({
        type: result.isFinal ? 'voice.final' : 'voice.partial',
        payload: { text: result.text },
      });
    }
  }
}