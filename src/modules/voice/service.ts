// src/modules/voice/service.ts
// VoiceServiceImpl：本地引擎（sherpa-onnx）实现。
//
// 职责边界：
//   - 模型目录管理（安装/卸载/选择）
//   - 会话创建（委托 engine.ts；失败自动回退到其它已安装模型）
//   - VAD 模型准备（Silero，629KB，失败降级 RMS 分段）
//   - 开关与选择持久化在 appConfig.voice（默认关闭）
//
// 语音识别只使用本地模型，不再支持在线语音服务商。

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger, ModuleContext } from '../../core/types';
import { VOICE_MODEL_CATALOG, defaultModelId, findModelDef, modelSizeBytes } from './catalog';
import { downloadAndExtract, downloadVadModel } from './downloader';
import {
  createLocalSession,
  getSherpaLoadError,
  getVoiceWorkerError,
  invalidateLocalRecognizer,
  listFilesRecursive,
  loadSherpa,
  prewarmLocalEngine,
  recognitionThreads,
  sherpaVersion,
} from './engine';
import type {
  VoiceModelDef,
  VoiceModelStatus,
  VoiceService,
  VoiceSession,
  VoiceStatus,
} from './types';

type ConfigApi = ModuleContext['config'];

/** 结构化日志器的最小接口（与 core Logger 对齐） */
type WarnLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

/** 支持的识别语言（与 SenseVoice / Whisper 语言码对齐） */
const SUPPORTED_LANGUAGES = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue']);

/** 会话创建时等待 VAD 模型下载的上限（毫秒）：超时先用 RMS 回退，下载继续在后台完成 */
const VAD_READY_TIMEOUT_MS = 2500;

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
  private readonly vadRoot: string;
  /** 正在下载的模型进度（id → 0..1） */
  private readonly installing = new Map<string, number>();
  /** 下载已完成、正在解压部署的模型（id 集合） */
  private readonly deploying = new Set<string>();
  /** 安装失败信息（id → message） */
  private readonly installErrors = new Map<string, string>();
  /** 安装串行队列尾部：同一时刻只允许一个模型下载/解压 */
  private installTail: Promise<void> = Promise.resolve();
  private runtime: Awaited<ReturnType<typeof loadSherpa>> = null;

  /** VAD 模型路径（下载成功后缓存） */
  private vadModelPath: string | null = null;
  /** VAD 下载单飞（超时后仍继续在后台完成） */
  private vadDownload: Promise<string | null> | null = null;
  /** VAD 下载失败后的重试时间（避免每次会话都等 2.5s 超时） */
  private vadRetryAt = 0;
  /** 预热定时器（安装/启用/切换模型后触发一次） */
  private prewarmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: VoiceServiceDeps) {
    this.modelsRoot = join(deps.dataDir, 'models', 'asr');
    this.vadRoot = join(this.modelsRoot, 'vad');
  }

  /** 后台预热运行时（不阻塞模块初始化；失败不影响其他功能） */
  warmup(): void {
    void loadSherpa().then((mod) => {
      this.runtime = mod;
      if (mod) {
        this.deps.logger.info('voice runtime ready', { version: sherpaVersion(mod) });
        // 运行时加载完成后，把模型加载也提前到后台（Worker 线程内执行，不阻塞主线程）；
        // 这样重启后端后的第一次录音无需等待冷加载。
        if (this.voiceCfg().enabled) this.schedulePrewarm();
      } else {
        // 记录真实失败原因与平台，便于诊断「为什么不可用」
        this.deps.logger.warn('voice runtime unavailable (sherpa-onnx-node 未加载)', {
          platform: detectPlatform().platform,
          error: getSherpaLoadError() ?? 'unknown',
        });
      }
    });
  }

  private voiceCfg(): {
    enabled: boolean;
    localModel: string;
    language: string;
    languageExplicit: boolean;
  } {
    const raw = this.deps.config.getAppConfig().voice ?? {
      enabled: false,
      localModel: '',
      language: 'auto',
      languageExplicit: false,
    };
    // 旧版本默认写入 language='zh' 且没有显式选择标记：按新默认自动迁移为 auto。
    // 用户一旦通过 UI/API 显式选择语言，languageExplicit=true，之后不再迁移。
    const explicit = raw.languageExplicit === true;
    const language = !explicit && raw.language === 'zh' ? 'auto' : raw.language;
    return {
      enabled: raw.enabled,
      localModel: raw.localModel,
      language,
      languageExplicit: explicit,
    };
  }

  private async patchVoice(
    patch: Partial<{
      enabled: boolean;
      localModel: string;
      language: string;
      languageExplicit: boolean;
    }>,
  ): Promise<void> {
    await this.deps.config.updateAppConfig({ voice: { ...this.voiceCfg(), ...patch } });
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
   * 当前有效本地模型：优先「已配置且已安装」→ auto 模式优先多语种模型 → 任一已安装 → 目录默认项。
   * 注意：默认 zipformer 推荐项保持不变；只有用户未显式选择模型且安装了多语种模型时才切换。
   */
  private activeModelId(): string {
    const cfg = this.voiceCfg();
    if (cfg.localModel && this.isInstalled(cfg.localModel)) return cfg.localModel;
    if (cfg.language === 'auto') {
      // 自动语言优先顺序：SenseVoice（中英日韩粤）→ Dolphin（40 语种）→ Whisper。
      // 不把 Paraformer/zipformer 放进优先列表：它们不是全语种模型，避免改变默认选择。
      for (const id of ['sensevoice-multi', 'dolphin-multi', 'whisper-base']) {
        if (this.isInstalled(id)) return id;
      }
    }
    const installed = VOICE_MODEL_CATALOG.find((m) => this.isInstalled(m.id));
    return installed ? installed.id : defaultModelId();
  }

  /** 会话候选模型：首选模型 → 其它已安装模型（流式优先，其次按目录顺序） */
  private candidateModelIds(preferred: string): string[] {
    const installed = VOICE_MODEL_CATALOG.filter((m) => this.isInstalled(m.id));
    const ordered = [
      ...installed.filter((m) => m.id === preferred),
      ...installed.filter((m) => m.id !== preferred && m.mode === 'streaming'),
      ...installed.filter((m) => m.id !== preferred && m.mode !== 'streaming'),
    ];
    const ids = [...new Set(ordered.map((m) => m.id))];
    return ids.length > 0 ? ids : [preferred];
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
      language: cfg.language,
    };
  }

  listModels(): VoiceModelStatus[] {
    return VOICE_MODEL_CATALOG.map((def) => {
      const installed = this.isInstalled(def.id);
      const deploying = this.deploying.has(def.id);
      const downloading = this.installing.has(def.id);
      const err = this.installErrors.get(def.id);
      const state: VoiceModelStatus['state'] = deploying
        ? 'deploying'
        : downloading
          ? 'downloading'
          : installed
            ? 'installed'
            : err
              ? 'error'
              : 'not-installed';
      const size = modelSizeBytes(def);
      return {
        id: def.id,
        engine: def.engine,
        mode: def.mode,
        name: def.name,
        description: def.description,
        sizeBytes: size,
        languages: def.languages,
        recommended: Boolean(def.recommended),
        state,
        progress: downloading ? this.installing.get(def.id) : undefined,
        installedBytes: installed ? size : undefined,
        error: err,
      };
    });
  }

  async setEnabled(enabled: boolean): Promise<VoiceStatus> {
    await this.patchVoice({ enabled });
    if (enabled) {
      this.ensureVadInBackground();
      this.schedulePrewarm();
    }
    return this.getStatus();
  }

  async setDefaultModel(id: string): Promise<VoiceStatus> {
    if (!findModelDef(id)) throw new Error(`未知模型：${id}`);
    if (!this.isInstalled(id)) throw new Error(`模型未安装：${id}`);
    await this.patchVoice({ localModel: id });
    this.schedulePrewarm();
    return this.getStatus();
  }

  async setLanguage(language: string): Promise<VoiceStatus> {
    if (!SUPPORTED_LANGUAGES.has(language)) throw new Error(`不支持的语言：${language}`);
    // 显式选择后不再参与「旧配置 zh → auto」迁移
    await this.patchVoice({ language, languageExplicit: true });
    this.schedulePrewarm();
    return this.getStatus();
  }

  async installModel(id: string, onProgress?: (p: number) => void): Promise<void> {
    const def = findModelDef(id);
    if (!def) throw new Error(`未知模型：${id}`);
    if (this.isInstalled(id)) {
      onProgress?.(1);
      return;
    }
    if (this.installing.has(id) || this.deploying.has(id)) throw new Error('该模型正在安装中');

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
      this.deploying.delete(id);
      this.installing.delete(id);
      onProgress?.(1);
      return;
    }
    try {
      mkdirSync(this.modelsRoot, { recursive: true });
      await downloadAndExtract(
        def,
        this.modelsRoot,
        (p) => {
          this.installing.set(id, p);
          onProgress?.(p);
        },
        () => {
          // 归档兜底路径：下载完成 → 解压部署，状态单独标记为「部署中」
          this.deploying.add(id);
          onProgress?.(0.9);
        },
      );
      this.deploying.delete(id);
      this.installing.delete(id);
      // 模型文件已更新：丢弃旧识别器缓存，下次录音按新文件重建
      invalidateLocalRecognizer();
      // 首次安装即为默认模型（若尚未设置）
      if (!this.voiceCfg().localModel) await this.patchVoice({ localModel: id });
      this.deps.logger.info('voice model installed', { id });
      this.schedulePrewarm();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deploying.delete(id);
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
    this.deploying.delete(id);
    this.installing.delete(id);
    rmSync(this.modelDir(id), { recursive: true, force: true });
    // 模型目录已删除：丢弃缓存，避免继续使用已卸载模型的识别器
    invalidateLocalRecognizer();
    if (this.voiceCfg().localModel === id) {
      await this.patchVoice({ localModel: '' });
    }
    this.deps.logger.info('voice model removed', { id });
  }

  // ==========================================================================
  // VAD 模型
  // ==========================================================================

  /** 后台准备 VAD（启用语音时调用；失败只记日志，会话会降级 RMS 分段） */
  private ensureVadInBackground(): void {
    if (this.vadModelPath) return;
    if (this.vadDownload) return;
    if (Date.now() < this.vadRetryAt) return;
    this.vadDownload = (async (): Promise<string | null> => {
      try {
        const path = await downloadVadModel(this.vadRoot);
        this.vadModelPath = path;
        this.deps.logger.info('voice vad model ready');
        return path;
      } catch (err) {
        // 失败后 10 分钟内不再重试，避免每个会话都叠加等待
        this.vadRetryAt = Date.now() + 10 * 60 * 1000;
        this.deps.logger.warn('voice vad model unavailable (降级 RMS 分段)', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      } finally {
        this.vadDownload = null;
      }
    })();
  }

  /** 会话创建时的 VAD 获取：最多等 VAD_READY_TIMEOUT_MS，超时不阻塞会话 */
  private async vadModelForSession(): Promise<string | null> {
    if (this.vadModelPath) return this.vadModelPath;
    if (Date.now() < this.vadRetryAt) return null;
    this.ensureVadInBackground();
    const download = this.vadDownload ?? Promise.resolve(null);
    const timeout = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), VAD_READY_TIMEOUT_MS);
      // Node/Bun 的 Timeout 对象支持 unref；不阻止进程退出
      if (timer && typeof timer === 'object') {
        (timer as unknown as { unref?: () => void }).unref?.();
      }
    });
    return Promise.race([download, timeout]);
  }

  // ==========================================================================
  // 预热
  // ==========================================================================

  /** 安排一次后台预热（合并高频调用；0ms 定时器让出当前请求） */
  private schedulePrewarm(): void {
    if (!this.voiceCfg().enabled) return;
    if (this.prewarmTimer !== null) return;
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = null;
      void this.prewarm();
    }, 0);
  }

  /**
   * 预热当前默认模型：模型加载在 Worker 线程执行，主线程不阻塞。
   * 用户第一次按下麦克风时识别器已就绪。
   */
  private async prewarm(): Promise<void> {
    const cfg = this.voiceCfg();
    if (!cfg.enabled) return;
    const id = this.activeModelId();
    const def = findModelDef(id);
    if (!def || !this.isInstalled(id)) return;
    const startedAt = Date.now();
    try {
      await prewarmLocalEngine({
        engine: def.engine,
        mode: def.mode,
        modelDir: this.modelDir(id),
        language: cfg.language,
        vadModel: this.vadModelPath,
        numThreads: recognitionThreads(),
      });
      this.deps.logger.info('voice engine prewarmed', { id, elapsedMs: Date.now() - startedAt });
    } catch (err) {
      this.deps.logger.warn('voice engine prewarm failed', {
        id,
        error: err instanceof Error ? err.message : String(err),
        workerError: getVoiceWorkerError() ?? undefined,
      });
    }
  }

  // ==========================================================================
  // 会话
  // ==========================================================================

  async createSession(modelId?: string): Promise<VoiceSession> {
    const cfg = this.voiceCfg();
    const preferred = modelId && findModelDef(modelId) ? modelId : this.activeModelId();
    const candidates = this.candidateModelIds(preferred);

    let runtime = this.runtime;
    if (!runtime) {
      runtime = await loadSherpa();
      this.runtime = runtime;
    }
    if (!runtime) {
      throw new Error('本地语音运行时不可用：sherpa-onnx-node 未加载（请确认依赖已安装且平台受支持）');
    }

    const vadModel = await this.vadModelForSession();
    let lastError: unknown = null;
    for (const id of candidates) {
      const def = findModelDef(id);
      if (!def || !this.isInstalled(id)) continue;
      try {
        return await createLocalSession(runtime, {
          engine: def.engine,
          mode: def.mode,
          modelDir: this.modelDir(id),
          language: cfg.language,
          vadModel,
          numThreads: recognitionThreads(),
        });
      } catch (err) {
        lastError = err;
        this.deps.logger.warn('voice engine fallback', {
          model: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError ?? '');
    throw new Error(
      reason
        ? `本地语音引擎不可用：${reason}`
        : '本地语音引擎不可用：未找到已安装的模型',
    );
  }
}
