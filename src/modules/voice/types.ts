// src/modules/voice/types.ts
// 语音识别（ASR）模块类型定义。
//
// 设计口径：
//   - 本地引擎统一由 sherpa-onnx 承载三种模型架构：
//       zipformer  = 流式 transducer（真流式，边说边出字）
//       sensevoice = 非流式 CTC（极快，配合 VAD 分段）
//       whisper    = 非流式 encoder-decoder（多语言，配合 VAD 分段）
//   - 在线语音服务商（可插拔）与本地引擎共用同一会话抽象。

/** 本地引擎类别（均由 sherpa-onnx 承载不同模型架构） */
export type VoiceLocalEngine = 'zipformer' | 'sensevoice' | 'whisper';

/** 解码模式：流式（online）整段累积 vs 离线（offline）整段解码 */
export type VoiceDecodeMode = 'streaming' | 'offline';

/** 内置模型目录项（静态元数据，不含本地状态） */
export interface VoiceModelDef {
  id: string;
  engine: VoiceLocalEngine;
  mode: VoiceDecodeMode;
  name: string;
  description: string;
  /** 模型归档下载地址（tar.bz2） */
  url: string;
  /** 归档体积（字节）：用于展示与下载进度估算 */
  sizeBytes: number;
  /** 归档解压后的顶层目录名 */
  rootDir: string;
  /** 覆盖语言标签 */
  languages: string[];
  /** 推荐项（UI 标记 + 默认候选） */
  recommended?: boolean;
}

/** 模型安装状态 */
export type VoiceModelState = 'not-installed' | 'downloading' | 'installed' | 'error';

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
  /** 结束输入并冲刷剩余结果（可能返回 final；在线服务商需异步完成上传转写） */
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
  /** 当前语音服务商 id（空串 = 内置本地引擎） */
  providerId: string;
}

/** 语音服务对外接口 */
export interface VoiceService {
  /** 能力总览 */
  getStatus(): VoiceStatus;
  /** 模型目录 + 本地安装状态 */
  listModels(): VoiceModelStatus[];
  /** 设置全局开关 */
  setEnabled(enabled: boolean): VoiceStatus;
  /** 设置默认本地模型（必须已安装） */
  setDefaultModel(id: string): VoiceStatus;
  /** 下载并安装模型（进度回调）；已安装则直接返回 */
  installModel(id: string, onProgress?: (p: number) => void): Promise<void>;
  /** 卸载（删除本地文件） */
  uninstallModel(id: string): Promise<void>;
  /** 创建识别会话；modelId 为空时用默认模型 */
  createSession(modelId?: string): Promise<VoiceSession>;
}