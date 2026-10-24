// webui/src/hooks/useVoiceInput.ts
// 语音输入 hook：麦克风采集（AudioWorklet，16kHz 单声道）→ WS 二进制音频 →
// 后端流式识别 → partial/final 回调（供编辑器实时上屏）。
//
// 本地推理：音频经本机 WS 发往后端 sherpa-onnx 识别，全程不出本机、不调云 API。
//
// 健壮性设计（三端 + 移动端兼容）：
//   - 前置环境校验（安全上下文 / mediaDevices 可用性），失败给出可读错误码；
//   - getUserMedia 约束渐进降级 + 设备占用（NotReadableError）延迟重试；
//   - AudioContext 采样率兜底（16k 创建失败则用系统采样率，由 worklet 重采样回 16k）；
//   - AudioWorklet 加载兜底（静态资源 → blob URL）；
//   - DOMException 统一映射为可读错误码，交由上层做多语言提示。

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/http';
import { wsClient } from '../api/ws';
import { createLocalAsrEngine, isLocalAsrSupported, type LocalAsrSession } from '../lib/asr-local';
import type { VoiceModelStatus, VoiceStatus } from '../types/api';

/** AudioWorklet 处理器源码（仅作 blob 兜底；首选静态资源 /voice-capture-worklet.js） */
const CAPTURE_WORKLET_SOURCE = `
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.target = opts.targetSampleRate || 16000;
    this.chunks = [];
    this.length = 0;
    const ratio = sampleRate / this.target;
    this.integerRatio = Math.abs(ratio - Math.round(ratio)) < 0.01 ? Math.round(ratio) : 0;
    this.ratio = ratio;
    this.sum = 0;
    this.count = 0;
    this.tail = null;
    this.pos = 0;
  }
  _resample(ch) {
    if (this.integerRatio === 1) return ch;
    if (this.integerRatio > 1) {
      const R = this.integerRatio;
      const out = [];
      let sum = this.sum;
      let count = this.count;
      for (let i = 0; i < ch.length; i++) {
        sum += ch[i];
        count++;
        if (count === R) { out.push(sum / R); sum = 0; count = 0; }
      }
      this.sum = sum;
      this.count = count;
      return out.length ? Float32Array.from(out) : null;
    }
    let buf;
    if (!this.tail || this.tail.length === 0) buf = ch;
    else {
      buf = new Float32Array(this.tail.length + ch.length);
      buf.set(this.tail, 0);
      buf.set(ch, this.tail.length);
    }
    const M = buf.length;
    const out = [];
    let pos = this.pos;
    for (;;) {
      const i = Math.floor(pos);
      if (i + 1 >= M) break;
      const f = pos - i;
      out.push(buf[i] + (buf[i + 1] - buf[i]) * f);
      pos += this.ratio;
    }
    const keepFrom = Math.min(Math.floor(pos), Math.max(0, M - 1));
    this.tail = buf.slice(keepFrom);
    this.pos = pos - keepFrom;
    return out.length ? Float32Array.from(out) : null;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    // 声道下混：设备可能是立体声，语音落在任一通道都不能丢
    let ch;
    if (input.length === 1) ch = input[0];
    else {
      ch = new Float32Array(input[0].length);
      for (let c = 0; c < input.length; c++) {
        const src = input[c];
        for (let i = 0; i < ch.length; i++) ch[i] += src[i];
      }
      for (let i = 0; i < ch.length; i++) ch[i] /= input.length;
    }
    if (this.target && sampleRate !== this.target) {
      ch = this._resample(ch);
      if (!ch || ch.length === 0) return true;
    }
    this.chunks.push(ch);
    this.length += ch.length;
    if (this.length >= 1024) {
      const out = new Float32Array(this.length);
      let off = 0;
      for (const c of this.chunks) { out.set(c, off); off += c.length; }
      this.port.postMessage(out, [out.buffer]);
      this.chunks = [];
      this.length = 0;
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCaptureProcessor);
`;

/** 采集采样率：与后端识别统一 16kHz */
const TARGET_SAMPLE_RATE = 16000;

/** 设备占用（NotReadableError）重试等待 */
const BUSY_RETRY_DELAY_MS = 350;

/** 会话就绪超时：首次加载本地模型可能需数秒，超时视为失败（避免无声空转） */
const READY_TIMEOUT_MS = 30_000;

/** 录音开始后多久没有任何识别结果就提示一次（不中断录音） */
const NO_RESULT_NOTICE_MS = 10_000;

/** 取消哨兵：teardown 打断挂起的 start() 时使用（不产生用户可见错误） */
const CANCEL_ERROR = new Error('voice-start-cancelled');

/** 语音采集错误码（上层据此做多语言提示；非本枚举值则视为原始错误文本原样展示） */
export type VoiceErrorCode =
  | 'INSECURE_CONTEXT'
  | 'MEDIA_DEVICES_UNAVAILABLE'
  | 'NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'NOT_READABLE'
  | 'NOT_SUPPORTED'
  | 'AUDIO_WORKLET_UNAVAILABLE'
  | 'WS_NOT_CONNECTED'
  | 'READY_TIMEOUT'
  | 'LOCAL_MODEL_UNAVAILABLE'
  | 'LOCAL_ENGINE_FAILED';

/** 带错误码的启动异常 */
class VoiceStartError extends Error {
  constructor(public readonly code: VoiceErrorCode) {
    super(code);
    this.name = 'VoiceStartError';
  }
}

/** 服务端返回的会话错误（错误码由后端给出，原样上抛） */
class VoiceSessionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'VoiceSessionError';
  }
}

/** getUserMedia 渐进降级约束序列（从严到宽） */
const AUDIO_CONSTRAINTS: MediaTrackConstraints[] = [
  // 听写需要原始波形：关闭浏览器音频处理，避免 AEC/NS/AGC 破坏识别
  { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  { channelCount: 1 },
  {},
];

/** DOMException → 错误码/原文 */
function mapStartError(err: unknown): string {
  if (err instanceof VoiceStartError) return err.code;
  const name = err instanceof DOMException ? err.name : (err as { name?: string } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'NOT_ALLOWED';
    case 'NotFoundError':
      return 'NOT_FOUND';
    case 'NotReadableError':
      return 'NOT_READABLE';
    case 'NotSupportedError':
    case 'OverconstrainedError':
      return 'NOT_SUPPORTED';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

export interface UseVoiceStatusResult {
  status: VoiceStatus | null;
  refresh: () => Promise<void>;
}

/** 语音能力状态（总开关/运行时/默认模型）：TaskInput 据此决定是否显示麦克风按钮 */
export function useVoiceStatus(): UseVoiceStatusResult {
  const [status, setStatus] = useState<VoiceStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getVoiceStatus());
    } catch {
      // 后端未就绪：保持 null（按钮按「未开启」处理）
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, refresh };
}

export interface UseVoiceModelsResult {
  models: VoiceModelStatus[];
  refresh: () => Promise<void>;
}

/** 本地模型目录 + 安装状态（设置页用；下载中自动轮询刷新进度） */
export function useVoiceModels(): UseVoiceModelsResult {
  const [models, setModels] = useState<VoiceModelStatus[]>([]);

  const refresh = useCallback(async () => {
    try {
      const resp = await api.listVoiceModels();
      setModels(resp.models);
    } catch {
      // 忽略
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 存在下载中的模型时轮询进度
  const downloading = models.some((m) => m.state === 'downloading');
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void refresh(), 800);
    return () => clearInterval(timer);
  }, [downloading, refresh]);

  return { models, refresh };
}

export interface UseVoiceInputOptions {
  /** 识别执行位置：server = 后端本地引擎（WS 传输音频）；local = 浏览器端 WASM 本地推理 */
  engine?: 'server' | 'local';
  /** local 模式使用的模型 id */
  localModelId?: string;
  /** 提示（如 local 模式准备模型耗时时的告知）：参数为 i18n 文案键 */
  onNotice?: (key: string) => void;
  /** 中间态文本（可被覆盖） */
  onPartial: (text: string) => void;
  /** 确定文本 */
  onFinal: (text: string) => void;
  /** 错误提示：已知错误码（VoiceErrorCode）或原始错误文本 */
  onError?: (code: string) => void;
}

export interface UseVoiceInputResult {
  /** 正在录音（按钮显示波形） */
  recording: boolean;
  /** 会话建立中（模型加载等） */
  busy: boolean;
  /** 实时音量 0..1（波形动画数据源） */
  level: number;
  toggle: () => void;
  stop: () => void;
}

/** 语音输入：点击开始/再次点击停止，识别文本实时上屏 */
export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const { onPartial, onFinal, onError, onNotice, engine = 'server', localModelId } = options;
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);

  // 回调/reffs（避免因回调变化重建采集链路）
  const onPartialRef = useRef(onPartial);
  const onFinalRef = useRef(onFinal);
  const onErrorRef = useRef(onError);
  const onNoticeRef = useRef(onNotice);
  const engineRef = useRef<'server' | 'local'>(engine);
  const localModelIdRef = useRef<string | undefined>(localModelId);
  onPartialRef.current = onPartial;
  onFinalRef.current = onFinal;
  onErrorRef.current = onError;
  onNoticeRef.current = onNotice;
  engineRef.current = engine;
  localModelIdRef.current = localModelId;

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  /** 是否已开始（用于忽略重复 toggle） */
  const startingRef = useRef(false);
  /** 挂起的就绪等待（voice.ready 解析 / voice.error 或超时拒绝） */
  const readyWaiterRef = useRef<{ resolve: () => void; reject: (err: unknown) => void } | null>(null);
  /** 就绪超时定时器 */
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 无识别结果提示定时器 */
  const noResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 本轮录音是否已收到过识别结果 */
  const hasResultRef = useRef(false);
  /** 是否已向服务端发起会话（用于异常时取消） */
  const sessionStartedRef = useRef(false);
  /** 浏览器本地推理会话（engine=local 时） */
  const sessionRef = useRef<LocalAsrSession | null>(null);
  /** 本地推理轮询定时器 */
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 释放采集资源（幂等） */
  const releaseCapture = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      workletRef.current?.disconnect();
      analyserRef.current?.disconnect();
      sourceRef.current?.disconnect();
    } catch {
      // 忽略
    }
    workletRef.current = null;
    analyserRef.current = null;
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx) void ctx.close().catch(() => undefined);
    setLevel(0);
  }, []);

  /** 释放全部资源（幂等）：采集、会话、挂起的就绪等待与定时器一并清理 */
  const teardown = useCallback(() => {
    releaseCapture();
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (sessionRef.current) {
      try {
        sessionRef.current.close();
      } catch {
        // 忽略
      }
      sessionRef.current = null;
    }
    if (readyTimerRef.current !== null) {
      clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    }
    if (noResultTimerRef.current !== null) {
      clearTimeout(noResultTimerRef.current);
      noResultTimerRef.current = null;
    }
    // 打断挂起的 start()（组件卸载等场景），避免其永久等待
    const waiter = readyWaiterRef.current;
    readyWaiterRef.current = null;
    waiter?.reject(CANCEL_ERROR);
    sessionStartedRef.current = false;
    hasResultRef.current = false;
  }, [releaseCapture]);

  /** WS 语音事件订阅 */
  useEffect(() => {
    const off = wsClient.onMessage((msg) => {
      const type = (msg as { type?: string }).type;
      if (!type || !type.startsWith('voice.')) return;
      const payload = (msg as { payload?: { text?: string; error?: string } }).payload;
      switch (type) {
        case 'voice.partial':
          if (payload?.text) {
            if (!hasResultRef.current) console.info('[voice-diag] first partial', { length: payload.text.length });
            hasResultRef.current = true;
            onPartialRef.current(payload.text);
          }
          break;
        case 'voice.final':
          if (payload?.text) {
            if (!hasResultRef.current) console.info('[voice-diag] first final', { length: payload.text.length });
            hasResultRef.current = true;
            onFinalRef.current(payload.text);
          }
          break;
        case 'voice.ready': {
          if (readyTimerRef.current !== null) {
            clearTimeout(readyTimerRef.current);
            readyTimerRef.current = null;
          }
          const waiter = readyWaiterRef.current;
          readyWaiterRef.current = null;
          waiter?.resolve();
          break;
        }
        case 'voice.error': {
          const waiter = readyWaiterRef.current;
          readyWaiterRef.current = null;
          if (waiter) {
            // 会话创建失败：交给 start() 的 catch 统一收尾
            waiter.reject(new VoiceSessionError(payload?.error ?? 'VOICE_ERROR'));
            break;
          }
          // 录音中途失败：退出录音态并释放麦克风
          teardown();
          setRecording(false);
          setBusy(false);
          onErrorRef.current?.(payload?.error ?? 'VOICE_ERROR');
          break;
        }
        case 'voice.stopped':
          break;
        default:
          break;
      }
    });
    return off;
  }, [teardown]);

  /** 停止：释放采集并结束会话 */
  const stop = useCallback(() => {
    console.info('[voice-diag] stop requested', { recording, engine: engineRef.current });
    if (recording) {
      if (engineRef.current === 'local') {
        // 本地推理：冲刷剩余结果并上屏（teardown 会关闭会话，故先取结果）
        const session = sessionRef.current;
        if (session) {
          try {
            const res = session.finish();
            if (res?.text) onFinalRef.current(res.text);
          } catch {
            // 忽略
          }
        }
      } else if (sessionStartedRef.current) {
        wsClient.send({ type: 'voice.stop' });
      }
    }
    teardown();
    console.info('[voice-diag] capture teardown completed');
    setRecording(false);
    setBusy(false);
  }, [recording, teardown]);

  /** 获取麦克风流：前置校验 + 约束渐进降级 + 设备占用重试 */
  const acquireStream = useCallback(async (): Promise<MediaStream> => {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      throw new VoiceStartError('INSECURE_CONTEXT');
    }
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') {
      throw new VoiceStartError('MEDIA_DEVICES_UNAVAILABLE');
    }
    let lastErr: unknown = null;
    for (let round = 0; round < 2; round++) {
      for (const audio of AUDIO_CONSTRAINTS) {
        try {
          return await md.getUserMedia({ video: false, audio });
        } catch (err) {
          lastErr = err;
          const name = err instanceof DOMException ? err.name : (err as { name?: string } | null)?.name;
          // 权限/安全问题需用户处理，继续降级无意义 → 直接抛出
          if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotFoundError') {
            throw err;
          }
          // OverconstrainedError / NotSupportedError / 未知 → 尝试更宽松的约束
        }
      }
      const lastName = lastErr instanceof DOMException ? lastErr.name : (lastErr as { name?: string } | null)?.name;
      // 设备被占用（NotReadableError）：等待片刻再整体重试一次
      if (lastName === 'NotReadableError' && round === 0) {
        await new Promise((r) => setTimeout(r, BUSY_RETRY_DELAY_MS));
        continue;
      }
      break;
    }
    throw lastErr;
  }, []);

  /** 录音开始后 10s 无任何识别结果时提示一次（不中断录音） */
  const armNoResultWatchdog = useCallback(() => {
    hasResultRef.current = false;
    if (noResultTimerRef.current !== null) {
      clearTimeout(noResultTimerRef.current);
    }
    noResultTimerRef.current = setTimeout(() => {
      noResultTimerRef.current = null;
      if (!hasResultRef.current) onNoticeRef.current?.('taskInput.voiceNoResult');
    }, NO_RESULT_NOTICE_MS);
  }, []);

  /** 建立采集链路（会话已就绪后才调用）：AudioContext + AudioWorklet + 音量波形 */
  const beginCapture = useCallback(
    async (stream: MediaStream, isLocal: boolean) => {
      streamRef.current = stream;

      // AudioContext：优先 16k；不支持则用系统采样率（worklet 会重采样回 16k）
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      } catch {
        ctx = new AudioContext();
      }
      ctxRef.current = ctx;
      if (ctx.state === 'suspended') await ctx.resume();

      // AudioWorklet：静态资源优先，失败回退 blob URL
      let workletLoaded = false;
      try {
        await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}voice-capture-worklet.js`);
        workletLoaded = true;
      } catch {
        workletLoaded = false;
      }
      if (!workletLoaded) {
        const blob = new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        try {
          await ctx.audioWorklet.addModule(url);
          workletLoaded = true;
        } catch {
          workletLoaded = false;
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (!workletLoaded) throw new VoiceStartError('AUDIO_WORKLET_UNAVAILABLE');

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyserRef.current = analyser;

      // 显式单声道：由浏览器在进入 worklet 前完成立体声→单声道下混
      const worklet = new AudioWorkletNode(ctx, 'voice-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
      });
      workletRef.current = worklet;
      let firstFrameLogged = false;
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const samples = event.data;
        if (!samples || samples.length === 0) return;
        if (!firstFrameLogged) {
          firstFrameLogged = true;
          console.info('[voice-diag] first capture frame', {
            samples: samples.length,
            nonZero: samples.some((sample) => sample !== 0),
          });
        }
        if (isLocal) {
          // 本地推理：Float32 直接喂给 WASM 会话（无需 int16/WS）
          sessionRef.current?.acceptSamples(samples);
          return;
        }
        const i16 = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
          const s = Math.max(-1, Math.min(1, samples[i]));
          i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        wsClient.sendBinary(i16.buffer);
      };

      source.connect(analyser);
      source.connect(worklet);
      // worklet 不产出音频，连接 destination 仅用于驱动 process 回调
      worklet.connect(ctx.destination);

      // 音量驱动波形
      const data = new Uint8Array(analyser.fftSize);
      let lastUpdate = 0;
      const tick = (now: number) => {
        const a = analyserRef.current;
        if (!a) return;
        a.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        // 节流到约 20fps：避免每帧 setState 触发整块输入区重渲染
        if (now - lastUpdate >= 50) {
          lastUpdate = now;
          setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      if (isLocal) {
        // 本地推理：定时轮询会话产出（partial / final）
        pollRef.current = setInterval(() => {
          const session = sessionRef.current;
          if (!session) return;
          const res = session.poll();
          if (!res) return;
          hasResultRef.current = true;
          if (res.isFinal) onFinalRef.current(res.text);
          else onPartialRef.current(res.text);
        }, 100);
      }

      setRecording(true);
      setBusy(false);
      armNoResultWatchdog();
    },
    [armNoResultWatchdog],
  );

  const start = useCallback(async () => {
    if (startingRef.current || recording) return;
    startingRef.current = true;
    setBusy(true);
    let serverSession = false;
    /** 采集中间态：失败/取消时需要把已拿到的流停掉（避免权限弹窗迟到导致麦克风常亮） */
    const pending: { stream: MediaStream | null; cancelled: boolean } = {
      stream: null,
      cancelled: false,
    };
    try {
      const isLocal = engineRef.current === 'local';
      if (isLocal) {
        // 浏览器本地推理：先备好引擎（可能需下载模型），再采集
        if (!isLocalAsrSupported()) throw new VoiceStartError('LOCAL_MODEL_UNAVAILABLE');
        const modelId = localModelIdRef.current;
        if (!modelId) throw new VoiceStartError('LOCAL_MODEL_UNAVAILABLE');
        onNoticeRef.current?.('taskInput.voiceLocalPreparing');
        const [eng, stream] = await Promise.all([createLocalAsrEngine(modelId), acquireStream()]);
        sessionRef.current = eng.createSession();
        await beginCapture(stream, true);
        return;
      }

      if (!wsClient.isOpen()) throw new VoiceStartError('WS_NOT_CONNECTED');

      // 并行：尽早弹出麦克风授权 + 创建服务端会话；就绪后才开始采集与录音
      const streamPromise = acquireStream();
      streamPromise.then(
        (s) => {
          if (pending.cancelled) s.getTracks().forEach((t) => t.stop());
          else pending.stream = s;
        },
        () => undefined,
      );
      const readyPromise = new Promise<void>((resolve, reject) => {
        readyWaiterRef.current = { resolve, reject };
      });
      serverSession = true;
      sessionStartedRef.current = true;
      wsClient.send({ type: 'voice.start' });
      readyTimerRef.current = setTimeout(() => {
        readyTimerRef.current = null;
        const waiter = readyWaiterRef.current;
        readyWaiterRef.current = null;
        waiter?.reject(new VoiceStartError('READY_TIMEOUT'));
      }, READY_TIMEOUT_MS);

      const [stream] = await Promise.all([streamPromise, readyPromise]);
      pending.stream = null;
      await beginCapture(stream, false);
    } catch (err) {
      pending.cancelled = true;
      pending.stream?.getTracks().forEach((t) => t.stop());
      if (err === CANCEL_ERROR) return; // teardown 已收尾（组件卸载等）
      teardown();
      if (serverSession) wsClient.send({ type: 'voice.stop' });
      setBusy(false);
      onErrorRef.current?.(err instanceof VoiceSessionError ? err.code : mapStartError(err));
    } finally {
      startingRef.current = false;
    }
  }, [recording, acquireStream, beginCapture, teardown]);

  const toggle = useCallback(() => {
    if (recording) stop();
    else void start();
  }, [recording, start, stop]);

  // 组件卸载：确保释放麦克风
  useEffect(() => () => teardown(), [teardown]);

  return { recording, busy, level, toggle, stop };
}
