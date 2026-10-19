// src/modules/server/routes/voice-wasm.ts
// 浏览器本地推理（sherpa-onnx WebAssembly）资源服务：
//   GET /api/voice/wasm/manifest?model=<id>  → 文件表（filename/start/end + 总大小 + dataUrl）
//   GET /api/voice/wasm/data?model=<id>      → 字节流（按文件表偏移拼接的模型原始文件）
//
// 背景：WebUI 引入的 Emscripten 产物把「预载文件表」内联在 JS 里，`.data` 本体只是各文件
// 按 offset 的原始字节拼接（格式即 `byteArray.subarray(start, end)` → FS_createDataFile）。
// 为了让浏览器端 WASM 用上「本机已下载的模型」（而非第三方固定模型包/CDN），
// 这里按本机模型目录生成匹配的文件表与字节流，前端据此替换元数据并加载。
//
// 仅支持流式 zipformer（transducer）模型：浏览器在线识别需要 transducer 三件套 + tokens。

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../../core/types';
import { findModelDef } from '../../voice/catalog';
import { resolveModelFiles } from '../../voice/engine';
import type { HttpResponse, RouteHandler } from '../types';

interface WasmFileEntry {
  filename: string;
  start: number;
  end: number;
}

interface WasmBundle {
  modelId: string;
  files: WasmFileEntry[];
  size: number;
  /** 缓存后的 .data 绝对路径 */
  cachePath: string;
}

/** 浏览器端本地推理支持的引擎（仅流式 transducer） */
const BROWSER_ENGINE = 'zipformer';

/** 模型 id 校验（防路径穿越） */
function isSafeModelId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/**
 * 构建（或复用缓存）模型 WASM 数据包。
 * 文件表顺序固定：encoder → decoder → joiner → tokens（与 sherpa-onnx-asr.js 默认相对路径一致）。
 */
function buildBundle(dataDir: string, modelId: string, logger: Logger): WasmBundle {
  const def = findModelDef(modelId);
  if (!def) throw new Error(`未知模型：${modelId}`);
  if (def.engine !== BROWSER_ENGINE) {
    throw new Error(`浏览器本地推理仅支持流式 zipformer 模型（当前：${def.engine}）`);
  }
  const modelDir = join(dataDir, 'models', 'asr', def.rootDir);
  if (!existsSync(modelDir)) throw new Error(`模型未安装：${modelId}`);

  const resolved = resolveModelFiles(modelDir, def.engine);
  const ordered: Array<{ filename: string; path: string }> = [
    { filename: '/encoder.onnx', path: resolved.encoder ?? '' },
    { filename: '/decoder.onnx', path: resolved.decoder ?? '' },
    { filename: '/joiner.onnx', path: resolved.joiner ?? '' },
    { filename: '/tokens.txt', path: resolved.tokens },
  ];

  const files: WasmFileEntry[] = [];
  let offset = 0;
  const sigParts: string[] = [];
  for (const item of ordered) {
    const st = statSync(item.path);
    files.push({ filename: item.filename, start: offset, end: offset + st.size });
    offset += st.size;
    // 签名：路径 + 大小 + mtime，模型被替换/重装后可自动失效重建
    sigParts.push(`${item.path}:${st.size}:${Math.round(st.mtimeMs)}`);
  }
  const size = offset;
  const signature = sigParts.join('|');

  const cacheDir = join(dataDir, 'models', 'asr-wasm');
  const cachePath = join(cacheDir, `${modelId}.data`);
  const manifestPath = join(cacheDir, `${modelId}.json`);

  let valid = false;
  if (existsSync(cachePath) && existsSync(manifestPath)) {
    try {
      const prev = JSON.parse(readFileSync(manifestPath, 'utf8')) as { size?: number; signature?: string };
      valid = prev.size === size && prev.signature === signature && statSync(cachePath).size === size;
    } catch {
      valid = false;
    }
  }

  if (!valid) {
    mkdirSync(cacheDir, { recursive: true });
    const parts = ordered.map((i) => readFileSync(i.path));
    writeFileSync(cachePath, Buffer.concat(parts));
    writeFileSync(manifestPath, JSON.stringify({ modelId, files, size, signature }, null, 2));
    logger.info('voice wasm bundle built', { modelId, size, files: files.length });
  }

  return { modelId, files, size, cachePath };
}

/** GET /api/voice/wasm/manifest：文件表（前端据此替换 loadPackage 元数据） */
export function createVoiceWasmManifestHandler(dataDir: string, logger: Logger): RouteHandler {
  return (req): HttpResponse => {
    const modelId = req.query.model ?? '';
    if (!isSafeModelId(modelId)) return { status: 400, body: { error: 'INVALID_MODEL_ID' } };
    try {
      const bundle = buildBundle(dataDir, modelId, logger);
      return {
        status: 200,
        body: {
          modelId: bundle.modelId,
          files: bundle.files,
          size: bundle.size,
          dataUrl: `/api/voice/wasm/data?model=${encodeURIComponent(bundle.modelId)}`,
        },
      };
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  };
}

/** GET /api/voice/wasm/data：字节流（Emscripten 预载包） */
export function createVoiceWasmDataHandler(dataDir: string, logger: Logger): RouteHandler {
  return (req): HttpResponse => {
    const modelId = req.query.model ?? '';
    if (!isSafeModelId(modelId)) return { status: 400, body: { error: 'INVALID_MODEL_ID' } };
    try {
      const bundle = buildBundle(dataDir, modelId, logger);
      // Buffer 本身即 Uint8Array，直接被 Bun.serve 接受；避免额外拷贝
      const buf = readFileSync(bundle.cachePath);
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(buf.byteLength),
          'Cache-Control': 'no-store',
        },
        body: buf,
      };
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  };
}

/** 清理某模型的 wasm 缓存（卸载模型时调用；失败忽略） */
export function clearVoiceWasmCache(dataDir: string, modelId: string): void {
  try {
    rmSync(join(dataDir, 'models', 'asr-wasm', `${modelId}.data`), { force: true });
    rmSync(join(dataDir, 'models', 'asr-wasm', `${modelId}.json`), { force: true });
  } catch {
    // 忽略
  }
}
