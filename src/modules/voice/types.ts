// src/modules/voice/types.ts
// 语音识别（ASR）模块类型定义。
//
// 设计口径：
//   - 本地引擎统一由 sherpa-onnx 承载多种模型架构：
//       zipformer  = 流式 transducer（真流式，边说边出字）
//       paraformer = 离线 CTC（中文高精度，配合 VAD 分段）
//       sensevoice = 非流式 CTC（多语言，配合 VAD 分段）
//       dolphin    = 离线多语言 CTC（40 语种，配合 VAD 分段）
//       whisper    = 非流式 encoder-decoder（多语言，配合 VAD 分段）
//   - 语音识别只使用本地模型，不再支持在线语音服务商。

/** 本地引擎类别（均由 sherpa-onnx 承载不同模型架构） */
export type VoiceLocalEngine = 'zipformer' | 'paraformer' | 'sensevoice' | 'dolphin' | 'whisper';

/** 解码模式：流式（online）整段累积 vs 离线（offline）整段解码 */
export type VoiceDecodeMode = 'streaming' | 'offline';

/** 单个直链模型文件（HuggingFace 预解压文件，免解压安装） */
export interface VoiceModelFile {
  /** 仓库内相对路径（如 encoder.int8.onnx） */
  path: string;
  /** 文件字节数（进度与校验） */
  size: number;
}

/** 内置模型目录项（静态元数据，不含本地状态） */
export interface VoiceModelDef {
  id: string;
  engine: VoiceLocalEngine;
  mode: VoiceDecodeMode;
  name: string;
  description: string;
  /** 模型归档下载地址（tar.bz2；HF 直链不可用时的兜底） */
  url: string;
  /**
   * HuggingFace 预解压文件清单（优先使用）：
   * 直链 https://hf-mirror.com/<repo>/resolve/main/<path>，下载后无需 bzip2 解压。
   */
  hf?: {
    repo: string;
    files: VoiceModelFile[];
  };
  /** 归档体积（字节）：用于展示与下载进度估算 */
  sizeBytes: number;
  /** 归档解压后的顶层目录名（HF 直链安装同样落到该目录） */
  rootDir: string;
  /** 覆盖语言标签 */
  languages: string[];
  /** 推荐项（UI 标记 + 默认候选） */
  recommended?: boolean;
}

/**
 * 模型安装状态。
 * deploying = 下载已完成，正在解压/校验/落盘（前端显示「部署中」而非卡在 90%）。
 */
export type VoiceModelState = 'not-installed' | 'downloading' | 'deploying' | 'installed' | 'error';

/** 暴露给前端的模型状态 */
export interface VoiceModelStatus {
  id: string;
  engine: VoiceLocalEngine;
  mode: VoiceDecodeMode;
  name: string;
  description: string;
  sizeBytes: number;
  languages: string[];
  recommended: boolean;
  state: VoiceModelState;
  /** 下载进度 0..1（仅 downloading 时有意义） */
  progress?: number;
  /** 已安装占用字节（解压后） */
  installedBytes?: number;
  error?: string;
}

/** 解压后动态解析出的模型文件路径（相对模型目录，绝对路径由 service 拼接） */
export interface ResolvedModelFiles {
  tokens: string;
  /** 流式 transducer 三件套 */
  encoder?: string;
  decoder?: string;
  joiner?: string;
  /** 单文件模型（SenseVoice） */
  model?: string;
}

/** 单次识别结果 */
export interface VoiceResult {
  text: string;
  /** true = 该段已确定（endpoint / 整段解码完成）；false = 中间态（可被覆盖） */
  isFinal: boolean;
}

/** 会话句柄：由 service 创建，供 WS 层驱动 */
export interface VoiceSession {
  /** 送入 16kHz 单声道 PCM（float32，取值 [-1,1]） */
  acceptSamples(samples: Float32Array): void;
  /** 取当前结果（可能是 partial）；无变化返回 null */
  poll(): VoiceResult | null;
  /** 结束输入并冲刷剩余结果（可能返回 final） */
  finish(): Promise<VoiceResult | null>;
  /** 释放底层资源 */
  close(): void;
}

/** 语音能力总览（暴露给前端做开关/选择） */
export interface VoiceStatus {
  /** 全局开关（默认关闭；关闭时输入框麦克风按钮隐藏） */
  enabled: boolean;
  /** 运行时是否可用（sherpa-onnx 原生模块加载成功） */
  runtimeAvailable: boolean;
  /** sherpa-onnx 版本（可用时） */
  runtimeVersion?: string;
  /** 运行平台标识：`${process.platform}-${process.arch}`（安卓/Termux 记为 android-<arch>） */
  platform: string;
  /** 该平台是否存在 sherpa-onnx 本地推理预编译原生库 */
  platformSupported: boolean;
  /** 运行时加载失败原因（runtimeAvailable=false 时给出，便于前端精确说明） */
  runtimeError?: string;
  /** 当前默认本地模型 id（空串 = 未选择） */
  defaultModel: string;
  /** 已安装模型 id 列表 */
  installed: string[];
  /** 识别语言（'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue'） */
  language: string;
}

/** 语音服务对外接口 */
export interface VoiceService {
  /** 能力总览 */
  getStatus(): VoiceStatus;
  /** 模型目录 + 本地安装状态 */
  listModels(): VoiceModelStatus[];
  /** 设置全局开关 */
  setEnabled(enabled: boolean): Promise<VoiceStatus>;
  /** 设置默认本地模型（必须已安装） */
  setDefaultModel(id: string): Promise<VoiceStatus>;
  /** 设置识别语言（'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue'） */
  setLanguage(language: string): Promise<VoiceStatus>;
  /** 下载并安装模型（进度回调）；已安装则直接返回 */
  installModel(id: string, onProgress?: (p: number) => void): Promise<void>;
  /** 卸载（删除本地文件） */
  uninstallModel(id: string): Promise<void>;
  /** 创建识别会话；modelId 为空时用默认模型 */
  createSession(modelId?: string): Promise<VoiceSession>;
}