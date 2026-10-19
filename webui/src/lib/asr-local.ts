// webui/src/lib/asr-local.ts
// 浏览器端本地语音识别（sherpa-onnx WebAssembly）：
// 用于服务端没有本地推理原生库的平台（如安卓/Termux），让手机浏览器自己完成推理。
//
// 加载流程：
//   1. 向后端取「文件表」（manifest）：{ files:[{filename,start,end}], size, dataUrl }
//   2. Emscripten 产物把 `.data` 的偏移表内联在 JS 里（loadPackage 元数据），先用文件表替换它；
//      产物非 MODULARIZE，故需先预置 window.Module，再以经典 <script> 注入（blob URL）。
//   3. Module.locateFile 把 .wasm 指向打包资源、把 .data 指向后端字节流。
//   4. 预载完成后注入 sherpa-onnx-asr.js（定义全局 createOnlineRecognizer），创建流式识别会话。
//
// 模型来源：本机已安装模型（后端 /api/voice/wasm/* 按偏移拼接原始文件），全程同源、无 CDN。

import mainJsSource from 'speech-asr/dist/lib/sherpa-onnx-wasm-main-asr.js?raw';
import mainWasmUrl from 'speech-asr/dist/lib/sherpa-onnx-wasm-main-asr.wasm?url';
import asrHelperUrl from 'speech-asr/dist/lib/sherpa-onnx-asr.js?url';

/** 与后端识别统一的采样率 */
const SAMPLE_RATE = 16000;

interface ModuleLike {
  calledRun?: boolean;
  onRuntimeInitialized?: () => void;
  locateFile?: (path: string, prefix: string) => string;
  print?: (...args: unknown[]) => void;
  printErr?: (...args: unknown[]) => void;
  [key: string]: unknown;
}

interface OnlineStreamLike {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  inputFinished(): void;
  free(): void;
}

interface OnlineRecognizerLike {
  createStream(): OnlineStreamLike;
  isReady(stream: OnlineStreamLike): boolean;
  decode(stream: OnlineStreamLike): void;
  isEndpoint(stream: OnlineStreamLike): boolean;
  reset(stream: OnlineStreamLike): void;
  getResult(stream: OnlineStreamLike): { text?: string };
}

declare global {
  interface Window {
    Module?: ModuleLike;
    createOnlineRecognizer?: (module: ModuleLike, config?: unknown) => OnlineRecognizerLike;
  }
}

export interface LocalAsrManifest {
  modelId: string;
  files: Array<{ filename: string; start: number; end: number }>;
  size: number;
  dataUrl: string;
}

export interface LocalAsrResult {
  text: string;
  isFinal: boolean;
}

export interface LocalAsrSession {
  acceptSamples(samples: Float32Array): void;
  poll(): LocalAsrResult | null;
  finish(): LocalAsrResult | null;
  close(): void;
}

export interface LocalAsrEngine {
  createSession(): LocalAsrSession;
}

// 单页只支持一个模型（Emscripten 运行时与 FS 为全局单例）
let loadedModelId: string | null = null;
let loadingModelId: string | null = null;
let recognizer: OnlineRecognizerLike | null = null;
let loadingPromise: Promise<OnlineRecognizerLike> | null = null;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 取后端文件表 */
async function fetchManifest(modelId: string): Promise<LocalAsrManifest> {
  const resp = await fetch(`/api/voice/wasm/manifest?model=${encodeURIComponent(modelId)}`);
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = (await resp.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      // 非 JSON 错误体：保留状态码描述
    }
    throw new Error(msg);
  }
  return (await resp.json()) as LocalAsrManifest;
}

/** 注入经典 <script> 并等待加载 */
function injectScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`脚本加载失败：${url}`));
    document.head.appendChild(el);
  });
}

/** 用后端文件表替换产物内联的 loadPackage 元数据（偏移表） */
function patchMetadata(source: string, manifest: LocalAsrManifest): string {
  const meta = JSON.stringify({ files: manifest.files, remote_package_size: manifest.size });
  const re = /\{"files":\[[\s\S]*?\],"remote_package_size":\d+\}/;
  if (!re.test(source)) throw new Error('ASR_WASM_METADATA_NOT_FOUND');
  return source.replace(re, meta);
}

/** 加载并初始化 Emscripten 运行时（单例） */
async function ensureRuntime(
  manifest: LocalAsrManifest,
  onProgress?: (phase: string) => void,
): Promise<ModuleLike> {
  onProgress?.('wasm');
  const patched = patchMetadata(mainJsSource, manifest);
  const blobUrl = URL.createObjectURL(new Blob([patched], { type: 'application/javascript' }));

  let readyResolve!: () => void;
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });
  const mod: ModuleLike = {
    // .data → 后端字节流；其余（.wasm）→ 打包资源
    locateFile: (p: string) => (p.endsWith('.data') ? manifest.dataUrl : mainWasmUrl),
    onRuntimeInitialized: () => readyResolve(),
    print: () => {},
    printErr: () => {},
  };
  window.Module = mod;

  try {
    await injectScript(blobUrl);
    await ready;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  onProgress?.('helper');
  if (!window.createOnlineRecognizer) await injectScript(asrHelperUrl);
  if (!window.createOnlineRecognizer) throw new Error('ASR_HELPER_UNAVAILABLE');
  return mod;
}

/** 确保已加载（同一模型复用；不支持会话中途换模型） */
async function ensureRecognizer(
  modelId: string,
  onProgress?: (phase: string) => void,
): Promise<OnlineRecognizerLike> {
  if (recognizer) {
    if (loadedModelId !== modelId) throw new Error('ASR_WASM_MODEL_LOCKED');
    return recognizer;
  }
  if (loadingPromise) {
    if (loadingModelId !== modelId) throw new Error('ASR_WASM_MODEL_LOCKED');
    return loadingPromise;
  }

  loadingModelId = modelId;
  loadingPromise = (async () => {
    onProgress?.('manifest');
    const manifest = await fetchManifest(modelId);
    const mod = await ensureRuntime(manifest, onProgress);
    onProgress?.('init');
    const rec = window.createOnlineRecognizer!(mod);
    recognizer = rec;
    loadedModelId = modelId;
    return rec;
  })();

  try {
    return await loadingPromise;
  } catch (err) {
    loadingPromise = null;
    loadingModelId = null;
    loadedModelId = null;
    throw new Error(describeError(err));
  }
}

/** 基于全局识别器创建一个流式会话（与后端 StreamingSession 同口径） */
function createLocalSession(rec: OnlineRecognizerLike): LocalAsrSession {
  const stream = rec.createStream();
  let last = '';
  let closed = false;
  return {
    acceptSamples(samples: Float32Array): void {
      if (closed || samples.length === 0) return;
      stream.acceptWaveform(SAMPLE_RATE, samples);
    },
    poll(): LocalAsrResult | null {
      if (closed) return null;
      while (rec.isReady(stream)) rec.decode(stream);
      const text = (rec.getResult(stream).text ?? '').trim();
      if (rec.isEndpoint(stream)) {
        rec.reset(stream);
        last = '';
        return text ? { text, isFinal: true } : null;
      }
      if (text && text !== last) {
        last = text;
        return { text, isFinal: false };
      }
      return null;
    },
    finish(): LocalAsrResult | null {
      if (closed) return null;
      stream.inputFinished();
      while (rec.isReady(stream)) rec.decode(stream);
      const text = (rec.getResult(stream).text ?? '').trim();
      last = '';
      return text ? { text, isFinal: true } : null;
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        stream.free();
      } catch {
        // 释放失败忽略
      }
    },
  };
}

/** 创建本地引擎（惰性初始化；失败抛出可读错误） */
export async function createLocalAsrEngine(
  modelId: string,
  onProgress?: (phase: string) => void,
): Promise<LocalAsrEngine> {
  const rec = await ensureRecognizer(modelId, onProgress);
  return { createSession: () => createLocalSession(rec) };
}

/** 本地推理是否可在当前浏览器使用（WASM 支持） */
export function isLocalAsrSupported(): boolean {
  return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
}
