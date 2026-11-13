// src/modules/voice/catalog.ts
// 内置本地语音模型目录（sherpa-onnx 系列）。
//
// 安装优先走 HuggingFace 预解压直链（hf 字段）：只下载模型文件本身，免 bzip2 解压，
// 安装速度显著快于 tar.bz2；url 为 GitHub Releases 归档兜底。
// 归档解压/直链落盘后由 engine 动态扫描文件名（不硬编码 epoch/chunk 后缀），
// 因此新增模型只需在此追加一条元数据即可。

import type { VoiceModelDef } from './types';

/** sherpa-onnx 官方模型下载根路径（GitHub Releases） */
export const SHERPA_MODELS_BASE =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

const MB = 1024 * 1024;

/** 内置模型清单：流式 / 离线多渠道，覆盖中文、中英混说与多语言 */
export const VOICE_MODEL_CATALOG: VoiceModelDef[] = [
  {
    id: 'zipformer-zh',
    engine: 'zipformer',
    mode: 'streaming',
    name: 'Zipformer 中文流式',
    description: '流式 transducer，边说边出字，中文识别延迟最低（推荐）',
    url: `${SHERPA_MODELS_BASE}/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2`,
    hf: {
      repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
      files: [
        { path: 'encoder.int8.onnx', size: 161141793 },
        { path: 'decoder.onnx', size: 5165083 },
        { path: 'joiner.int8.onnx', size: 1033416 },
        { path: 'tokens.txt', size: 20628 },
      ],
    },
    sizeBytes: 167361920,
    rootDir: 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
    languages: ['zh'],
    recommended: true,
  },
  {
    id: 'zipformer-zh-14m',
    engine: 'zipformer',
    mode: 'streaming',
    name: 'Zipformer 14M 极速流式',
    description: '轻量流式模型（约 24MB），加载快、低配机器流畅，精度略低于大模型',
    url: `${SHERPA_MODELS_BASE}/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2`,
    hf: {
      repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
      files: [
        { path: 'encoder-epoch-99-avg-1.int8.onnx', size: 21621684 },
        { path: 'decoder-epoch-99-avg-1.int8.onnx', size: 1888682 },
        { path: 'joiner-epoch-99-avg-1.int8.onnx', size: 1795562 },
        { path: 'tokens.txt', size: 48697 },
      ],
    },
    sizeBytes: 25354625,
    rootDir: 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
    languages: ['zh'],
  },
  {
    id: 'sensevoice-multi',
    engine: 'sensevoice',
    mode: 'offline',
    name: 'SenseVoice 多语言',
    description: '非流式 CTC，中/英/日/韩/粤语，配合 VAD 分句，自动标点',
    url: `${SHERPA_MODELS_BASE}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`,
    hf: {
      repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
      files: [
        { path: 'model.int8.onnx', size: 239233841 },
        { path: 'tokens.txt', size: 315894 },
      ],
    },
    sizeBytes: 239549735,
    rootDir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
    languages: ['zh', 'en', 'ja', 'ko', 'yue'],
  },
  {
    id: 'paraformer-zh',
    engine: 'paraformer',
    mode: 'offline',
    name: 'Paraformer 中文高精度',
    description: '非流式 CTC，中文/中英混说精度高，支持方言，配合 VAD 分句',
    url: `${SHERPA_MODELS_BASE}/sherpa-onnx-paraformer-zh-int8-2025-10-07.tar.bz2`,
    hf: {
      repo: 'csukuangfj/sherpa-onnx-paraformer-zh-int8-2025-10-07',
      files: [
        { path: 'model.int8.onnx', size: 238429929 },
        { path: 'tokens.txt', size: 75756 },
      ],
    },
    sizeBytes: 238505685,
    rootDir: 'sherpa-onnx-paraformer-zh-int8-2025-10-07',
    languages: ['zh', 'en'],
  },
  {
    id: 'dolphin-multi',
    engine: 'dolphin',
    mode: 'offline',
    name: 'Dolphin 多语言',
    description: '非流式 CTC，覆盖 40 种语言与 22 种中文方言，体积小（约 99MB）',
    url: `${SHERPA_MODELS_BASE}/sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02.tar.bz2`,
    hf: {
      repo: 'csukuangfj/sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02',
      files: [
        { path: 'model.int8.onnx', size: 103729802 },
        { path: 'tokens.txt', size: 504662 },
      ],
    },
    sizeBytes: 104234464,
    rootDir: 'sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02',
    languages: ['multi'],
  },
  {
    id: 'whisper-base',
    engine: 'whisper',
    mode: 'offline',
    name: 'Whisper Base 多语言',
    description: '非流式 encoder-decoder，多语言通用；噪声下易幻觉，建议仅在多语种时使用',
    url: `${SHERPA_MODELS_BASE}/sherpa-onnx-whisper-base.tar.bz2`,
    hf: {
      repo: 'csukuangfj/sherpa-onnx-whisper-base',
      files: [
        { path: 'base-encoder.int8.onnx', size: 29120534 },
        { path: 'base-decoder.int8.onnx', size: 130672026 },
        { path: 'base-tokens.txt', size: 816730 },
      ],
    },
    sizeBytes: 160609290,
    rootDir: 'sherpa-onnx-whisper-base',
    languages: ['multi'],
  },
];

/** 按 id 查模型定义 */
export function findModelDef(id: string): VoiceModelDef | undefined {
  return VOICE_MODEL_CATALOG.find((m) => m.id === id);
}

/** 默认模型 id（首个推荐项） */
export function defaultModelId(): string {
  return VOICE_MODEL_CATALOG.find((m) => m.recommended)?.id ?? VOICE_MODEL_CATALOG[0]?.id ?? '';
}

/** 模型安装总体积（优先按直链文件精确求和） */
export function modelSizeBytes(def: VoiceModelDef): number {
  if (def.hf && def.hf.files.length > 0) {
    return def.hf.files.reduce((sum, f) => sum + f.size, 0);
  }
  return def.sizeBytes;
}

/** 供 UI/日志使用的体积文案 */
export function modelSizeMb(def: VoiceModelDef): number {
  return Math.round(modelSizeBytes(def) / MB);
}
