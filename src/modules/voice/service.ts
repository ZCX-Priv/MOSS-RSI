// src/modules/voice/service.ts
// VoiceServiceImpl：本地引擎（sherpa-onnx）与在线语音服务商的统一实现。
//
// 职责边界：
//   - 本地：模型目录管理（安装/卸载/选择）+ 会话创建（委托 engine.ts）
//   - 在线：kind='voice' 服务商（OpenAI 兼容 /audio/transcriptions 整段转写）
//   - 开关与选择持久化在 appConfig.voice（默认关闭）

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger, ModuleContext, ProviderConfig } from '../../core/types';
import { VOICE_MODEL_CATALOG, defaultModelId, findModelDef } from './catalog';
import { downloadAndExtract } from './downloader';
import { SAMPLE_RATE, createLocalSession, getSherpaLoadError, listFilesRecursive, loadSherpa, sherpaVersion } from './engine';
import type {
  VoiceModelDef,
  VoiceModelStatus,
  VoiceResult,
  VoiceService,
  VoiceSession,
  VoiceStatus,
} from './types';

type ConfigApi = ModuleContext['config'];

/** 结构化日志器的最小接口（与 core Logger 对齐） */
type WarnLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

// ============================================================================
// 音频工具（在线转写用）
// ============================================================================

function concatSamples(chunks: Float32Array[]): Float32Array {
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

/** float32 单声道 → 16-bit PCM WAV */
function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let o = 0;
  const writeStr = (s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(o++, s.charCodeAt(i));
  };
  writeStr('RIFF');
  view.setUint32(o, 36 + dataSize, true);
  o += 4;
  writeStr('WAVE');
  writeStr('fmt ');
  view.setUint32(o, 16, true);
  o += 4;
  view.setUint16(o, 1, true);
  o += 2; // PCM
  view.setUint16(o, 1, true);
  o += 2; // mono
  view.setUint32(o, sampleRate, true);
  o += 4;
  view.setUint32(o, sampleRate * 2, true);
  o += 4;
  view.setUint16(o, 2, true);
  o += 2; // block align
  view.setUint16(o, 16, true);
  o += 2; // bits per sample
  writeStr('data');
  view.setUint32(o, dataSize, true);
  o += 4;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Uint8Array(buffer);
}

interface OnlineVoiceConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  language: string;
}

/** 规范化转写端点：允许用户填 base 地址，自动补 /audio/transcriptions */
function resolveTranscriptionUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  if (/\/audio\/transcriptions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/audio/transcriptions`;
}

async function transcribeOnline(cfg: OnlineVoiceConfig, audio: Float32Array): Promise<string> {
  const wav = encodeWav(audio, SAMPLE_RATE);
  // 拷贝到独立 ArrayBuffer：BlobPart 要求 ArrayBufferView<ArrayBuffer>，避免共享缓冲歧义
  const wavBuffer = new ArrayBuffer(wav.byteLength);
  new Uint8Array(wavBuffer).set(wav);
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', cfg.model || 'whisper-1');
  if (cfg.language && cfg.language !== 'auto') form.append('language', cfg.language);

  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const resp = await fetch(resolveTranscriptionUrl(cfg.endpoint), {
    method: 'POST',
    headers,
    body: form,
  });
  if (!resp.ok) {
    throw new Error(`在线语音转写失败：HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { text?: string };
  return (data.text ?? '').trim();
}

/** 在线会话：本地缓存音频，finish 时整段上传转写（无中间态） */
class OnlineTranscriptionSession implements VoiceSession {
  private chunks: Float32Array[] = [];
  private closed = false;

  constructor(private readonly cfg: OnlineVoiceConfig) {}

  acceptSamples(samples: Float32Array): void {
    if (this.closed) return;
    this.chunks.push(samples);
  }

  poll(): VoiceResult | null {
    return null; // 在线无流式中间态
  }

  async finish(): Promise<VoiceResult | null> {
    if (this.closed) return null;
    const audio = concatSamples(this.chunks);
    this.chunks = [];
    if (audio.length < (SAMPLE_RATE * 200) / 1000) return null; // 过短丢弃
    const text = await transcribeOnline(this.cfg, audio);
    return text ? { text, isFinal: true } : null;
  }

  close(): void {
    this.closed = true;
  }
}

// ============================================================================
// 服务实现
// ============================================================================

/** sherpa-onnx-node 提供预编译原生库的平台（node 平台名-arch；安卓/bionic 不在其列） */
const SUPPORTED_PLATFORMS = new Set([
  'win32-x64',
  'win32-ia32',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
]);

/**
 * 运行平台识别：安卓/Termux 记为 android-<arch> 并判定为不受支持
 * （sherpa-onnx-node 无 bionic 预编译库；Termux 原生 Bun 亦非官方支持）。
 */
function detectPlatform(): { platform: string; supported: boolean } {
  const isTermux =
    Boolean(process.env.TERMUX_VERSION) || (process.env.PREFIX ?? '').includes('com.termux');
  const platform = isTermux ? `android-${process.arch}` : `${process.platform}-${process.arch}`;
  return { platform, supported: !isTermux && SUPPORTED_PLATFORMS.has(platform) };
}

export interface VoiceServiceDeps {
  logger: WarnLogger;
  config: ConfigApi;
  /** 数据根目录（~/.moss），模型解压到 <dataDir>/models/asr/<rootDir> */
  dataDir: string;
}

export class VoiceServiceImpl implements VoiceService {
  private readonly modelsRoot: string;
  /** 正在下载的模型进度（id → 0..1） */
  private readonly installing = new Map<string, number>();
  /** 安装失败信息（id → message） */
  private readonly installErrors = new Map<string, string>();
  /** 安装串行队列尾部：同一时刻只允许一个模型下载/解压 */
  private installTail: Promise<void> = Promise.resolve();
  private runtime: Awaited<ReturnType<typeof loadSherpa>> = null;

  constructor(private readonly deps: VoiceServiceDeps) {
    this.modelsRoot = join(deps.dataDir, 'models', 'asr');
  }

  /** 后台预热运行时（不阻塞模块初始化；失败不影响其他功能） */
  warmup(): void {
    void loadSherpa().then((mod) => {
      this.runtime = mod;
      if (mod) {
        this.deps.logger.info('voice runtime ready', { version: sherpaVersion(mod) });
      } else {
        // 记录真实失败原因与平台，便于诊断「为什么不可用」
        this.deps.logger.warn('voice runtime unavailable (sherpa-onnx-node 未加载)', {
          platform: detectPlatform().platform,
          error: getSherpaLoadError() ?? 'unknown',
        });
      }
    });
  }

  private voiceCfg(): { enabled: boolean; providerId: string; localModel: string; language: string } {
    const cfg = this.deps.config.getAppConfig().voice;
    return cfg ?? { enabled: false, providerId: '', localModel: '', language: 'auto' };
  }

  private patchVoice(patch: Partial<{ enabled: boolean; providerId: string; localModel: string; language: string }>): void {
    this.deps.config.updateAppConfig({ voice: { ...this.voiceCfg(), ...patch } });
  }

  private modelDir(id: string): string {
    const def = findModelDef(id);
    return join(this.modelsRoot, def ? def.rootDir : id);
  }

  /** 判定模型是否已安装：目录内同时存在 .onnx 与 tokens.txt */
  isInstalled(id: string): boolean {
    const dir = this.modelDir(id);
    if (!existsSync(dir)) return false;
    try {
      const files = listFilesRecursive(dir);
      return (
        files.some((f) => f.toLowerCase().endsWith('.onnx')) &&
        files.some((f) => /tokens\.txt$/i.test(f))
      );
    } catch {
      return false;
    }
  }

  /**
   * 当前有效本地模型：优先「已配置且已安装」→ 任一已安装 → 目录默认项。
   * 避免卸载默认模型后回退到一个并未安装的模型，导致语音整体不可用。
   */
  private activeModelId(): string {
    const cfg = this.voiceCfg();
    if (cfg.localModel && this.isInstalled(cfg.localModel)) return cfg.localModel;
    const installed = VOICE_MODEL_CATALOG.find((m) => this.isInstalled(m.id));
    return installed ? installed.id : defaultModelId();
  }

  getStatus(): VoiceStatus {
    const cfg = this.voiceCfg();
    const installed = VOICE_MODEL_CATALOG.filter((m) => this.isInstalled(m.id)).map((m) => m.id);
    const { platform, supported } = detectPlatform();
    return {
      enabled: cfg.enabled,
      runtimeAvailable: Boolean(this.runtime),
      runtimeVersion: this.runtime ? sherpaVersion(this.runtime) : undefined,
      platform,
      platformSupported: supported,
      runtimeError: this.runtime ? undefined : (getSherpaLoadError() ?? undefined),
      defaultModel: this.activeModelId(),
      installed,
      providerId: cfg.providerId,
    };
  }

  listModels(): VoiceModelStatus[] {
    return VOICE_MODEL_CATALOG.map((def) => {
      const installed = this.isInstalled(def.id);
      const downloading = this.installing.has(def.id);
      const err = this.installErrors.get(def.id);
      const state: VoiceModelStatus['state'] = downloading
        ? 'downloading'
        : installed
          ? 'installed'
          : err
            ? 'error'
            : 'not-installed';
      return {
        id: def.id,
        engine: def.engine,
        mode: def.mode,
        name: def.name,
        description: def.description,
        sizeBytes: def.sizeBytes,
        languages: def.languages,
        recommended: Boolean(def.recommended),
        state,
        progress: downloading ? this.installing.get(def.id) : undefined,
        installedBytes: installed ? def.sizeBytes : undefined,
        error: err,
      };
    });
  }

  setEnabled(enabled: boolean): VoiceStatus {
    this.patchVoice({ enabled });
    return this.getStatus();
  }

  setDefaultModel(id: string): VoiceStatus {
    if (!findModelDef(id)) throw new Error(`未知模型：${id}`);
    if (!this.isInstalled(id)) throw new Error(`模型未安装：${id}`);
    this.patchVoice({ localModel: id });
    return this.getStatus();
  }

  async installModel(id: string, onProgress?: (p: number) => void): Promise<void> {
    const def = findModelDef(id);
    if (!def) throw new Error(`未知模型：${id}`);
    if (this.isInstalled(id)) {
      onProgress?.(1);
      return;
    }
    if (this.installing.has(id)) throw new Error('该模型正在下载中');

    this.installErrors.delete(id);
    // 入队即置 0：排队中的模型在 UI 上有确定状态（而非无进度地空转）
    this.installing.set(id, 0);

    // 串行执行：并发大文件下载会互相拖慢甚至卡死（且共享镜像带宽），故排队而非并行
    const run = this.installTail.then(() => this.runInstall(def, onProgress));
    this.installTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 实际安装主体（在串行队列内执行） */
  private async runInstall(def: VoiceModelDef, onProgress?: (p: number) => void): Promise<void> {
    const id = def.id;
    // 排队期间可能已被其它路径装好
    if (this.isInstalled(id)) {
      this.installing.delete(id);
      onProgress?.(1);
      return;
    }
    try {
      mkdirSync(this.modelsRoot, { recursive: true });
      await downloadAndExtract(def, this.modelsRoot, (p) => {
        this.installing.set(id, p);
        onProgress?.(p);
      });
      this.installing.delete(id);
      // 首次安装即为默认模型（若尚未设置）
      if (!this.voiceCfg().localModel) this.patchVoice({ localModel: id });
      this.deps.logger.info('voice model installed', { id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.installing.delete(id);
      this.installErrors.set(id, msg);
      this.deps.logger.error('voice model install failed', { id, error: msg });
      throw err;
    }
  }

  async uninstallModel(id: string): Promise<void> {
    const def = findModelDef(id);
    if (!def) throw new Error(`未知模型：${id}`);
    this.installErrors.delete(id);
    this.installing.delete(id);
    rmSync(this.modelDir(id), { recursive: true, force: true });
    if (this.voiceCfg().localModel === id) {
      this.patchVoice({ localModel: '' });
    }
    this.deps.logger.info('voice model removed', { id });
  }

  private findVoiceProvider(id: string): ProviderConfig | undefined {
    const api = this.deps.config.getApiConfig();
    return api.providers.find((p) => p.id === id && p.kind === 'voice');
  }

  async createSession(modelId?: string): Promise<VoiceSession> {
    const cfg = this.voiceCfg();

    // 在线服务商优先（providerId 非空时）
    if (cfg.providerId) {
      const provider = this.findVoiceProvider(cfg.providerId);
      if (!provider) throw new Error('语音服务商不存在或类型不匹配');
      return new OnlineTranscriptionSession({
        endpoint: provider.endpoint,
        apiKey: provider.apiKey,
        model: provider.voiceModel ?? 'whisper-1',
        language: cfg.language,
      });
    }

    // 本地引擎
    const id = modelId || this.activeModelId();
    const def = findModelDef(id);
    if (!def) throw new Error(`未知模型：${id}`);
    if (!this.isInstalled(id)) throw new Error(`模型未安装：${id}`);

    // 确保运行时已加载（warmup 为异步，此处兜底等待）
    let runtime = this.runtime;
    if (!runtime) {
      runtime = await loadSherpa();
      this.runtime = runtime;
    }
    if (!runtime) {
      throw new Error('本地语音运行时不可用：sherpa-onnx-node 未加载（请确认依赖已安装且平台受支持）');
    }
    return createLocalSession(runtime, {
      engine: def.engine,
      modelDir: this.modelDir(id),
      numThreads: 2,
    });
  }
}