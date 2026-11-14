// src/modules/voice/sherpa-onnx-node.d.ts
// sherpa-onnx-node 无自带类型声明（CJS + JSDoc），此处按实际导出（addon.js 的类）补充最小类型。
// 只声明本模块实际使用的成员，避免过度耦合上游内部字段。

declare module 'sherpa-onnx-node' {
  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface TransducerModelConfig {
    encoder?: string;
    decoder?: string;
    joiner?: string;
  }

  export interface FeatureConfig {
    sampleRate?: number;
    featureDim?: number;
  }

  export interface OnlineModelConfig {
    transducer?: TransducerModelConfig;
    paraformer?: { encoder?: string; decoder?: string };
    zipformer2Ctc?: { model?: string };
    tokens?: string;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
    modelType?: string;
  }

  export interface OfflineModelConfig {
    transducer?: TransducerModelConfig;
    paraformer?: { model?: string };
    dolphin?: { model?: string };
    zipformerCtc?: { model?: string };
    whisper?: {
      encoder?: string;
      decoder?: string;
      language?: string;
      task?: string;
      tailPaddings?: number;
    };
    senseVoice?: {
      model?: string;
      language?: string;
      useInverseTextNormalization?: number;
    };
    tokens?: string;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
    modelType?: string;
  }

  export interface OnlineRecognizerConfig {
    featConfig?: FeatureConfig;
    modelConfig?: OnlineModelConfig;
    decodingMethod?: string;
    maxActivePaths?: number;
    enableEndpoint?: boolean | number;
    rule1MinTrailingSilence?: number;
    rule2MinTrailingSilence?: number;
    rule3MinUtteranceLength?: number;
  }

  export interface OfflineRecognizerConfig {
    featConfig?: FeatureConfig;
    modelConfig?: OfflineModelConfig;
  }

  export interface RecognizerResult {
    text: string;
    tokens?: string[];
    timestamps?: number[];
    /** SenseVoice/Whisper 等模型返回的语言（如 zh/en/ja/ko/yue） */
    lang?: string;
    /** SenseVoice 情绪/事件标签（可选） */
    emotion?: string;
    event?: string;
  }

  export class OnlineStream {
    acceptWaveform(obj: Waveform): void;
    inputFinished(): void;
  }

  export class OnlineRecognizer {
    constructor(config: OnlineRecognizerConfig);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    isEndpoint(stream: OnlineStream): boolean;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): RecognizerResult;
  }

  export class OfflineStream {
    acceptWaveform(obj: Waveform): void;
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(hotwords?: string): OfflineStream;
    decode(stream: OfflineStream): void;
    decodeAsync(stream: OfflineStream): Promise<RecognizerResult>;
    getResult(stream: OfflineStream): RecognizerResult;
  }

  export interface SileroVadModelConfig {
    model: string;
    threshold?: number;
    minSilenceDuration?: number;
    minSpeechDuration?: number;
    windowSize?: number;
    maxSpeechDuration?: number;
  }

  export interface VadConfig {
    sileroVad?: SileroVadModelConfig;
    sampleRate?: number;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
  }

  export interface SpeechSegment {
    start: number;
    samples: Float32Array;
  }

  /** Silero VAD：只对检测到的语音段做解码，避免噪声/静音送进识别模型 */
  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    clear(): void;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    reset(): void;
    flush(): void;
  }

  export function readWave(filename: string): Waveform;
  export const version: string;
  export const onnxruntimeVersion: string;
}
