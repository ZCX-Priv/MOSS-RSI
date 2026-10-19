// src/modules/context/compiler/image-optimizer.ts
// 发送前图片优化（TinyPNG 式）：在保留细节的前提下压缩内联 base64 体积，降低请求体字节压力。
// - 使用 sharp（运行时动态 import；不可用时自动降级为“不压缩，发送原图”）
// - 缓存：内存 LRU，key 含 path+mtime+size+配置指纹（文件变更/配置变更自动失效）
// - 只优化可编码的位图（png/jpg/jpeg/webp/bmp）；gif 与 svg 原样返回
// - 绝不让优化失败阻断请求：任何异常一律回退原图

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { Logger } from '../../../core/types';
import type { ImageOptimizationConfig } from '../types';

/** 单张图片的“可发送”表示（base64 纯串，无 data URI 前缀） */
export interface OptimizedImage {
  /** 纯 base64 */
  data: string;
  mimeType: string;
  /** 编码后字节数（base64 前的原始字节） */
  bytes: number;
  /** 是否真正执行了优化（false=回退原图/未优化） */
  optimized: boolean;
  width?: number;
  height?: number;
}

/** 扩展名 → MIME（与 view-builder 的可发送图片口径一致，不含 svg） */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 可优化扩展名（gif 有动画帧风险，跳过；svg 走代码通道） */
const OPTIMIZABLE_EXTS = new Set<string>(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

/** 内存缓存上限（条） */
const CACHE_LIMIT = 32;

/** auto 格式下按原扩展名选择的编码格式 */
function autoFormat(ext: string): 'png' | 'jpeg' | 'webp' {
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.webp') return 'webp';
  return 'png'; // png / bmp → png
}

const FORMAT_MIME: Record<'png' | 'jpeg' | 'webp', string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

// ============================================================================
// sharp 最小结构类型（避免强依赖其类型声明，规避编译期耦合）
// ============================================================================

interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(opts: { width: number; height: number; fit: 'inside'; withoutEnlargement: boolean }): SharpPipeline;
  png(opts?: Record<string, unknown>): SharpPipeline;
  jpeg(opts?: Record<string, unknown>): SharpPipeline;
  webp(opts?: Record<string, unknown>): SharpPipeline;
  toBuffer(): Promise<Buffer>;
  metadata(): Promise<{ width?: number; height?: number }>;
}

type SharpFactory = (
  input: Buffer,
  options?: Record<string, unknown>,
) => SharpPipeline;

/** 原始文件 → OptimizedImage（不做任何编码） */
function readOriginal(absPath: string): OptimizedImage | null {
  try {
    const buf = readFileSync(absPath);
    const mime = MIME_BY_EXT[extname(absPath).toLowerCase()] ?? 'application/octet-stream';
    return { data: buf.toString('base64'), mimeType: mime, bytes: buf.length, optimized: false };
  } catch {
    return null;
  }
}

export class ImageOptimizer {
  private readonly logger: Logger;
  private readonly getConfig: () => ImageOptimizationConfig;
  /** sharp 模块加载 Promise（进程级一次；失败缓存 null 不再重试） */
  private sharpPromise: Promise<SharpFactory | null> | null = null;
  /** 内存 LRU：key → 优化结果 */
  private readonly cache = new Map<string, OptimizedImage>();

  constructor(logger: Logger, getConfig: () => ImageOptimizationConfig) {
    this.logger = logger;
    this.getConfig = getConfig;
  }

  /** 懒加载 sharp；不可用时返回 null（后续调用直接走原图回退） */
  private loadSharp(): Promise<SharpFactory | null> {
    if (!this.sharpPromise) {
      this.sharpPromise = import('sharp')
        .then(mod => {
          const m = mod as unknown as { default?: unknown };
          const factory = (m.default ?? mod) as unknown;
          return typeof factory === 'function' ? (factory as SharpFactory) : null;
        })
        .catch(err => {
          this.logger.warn('context: sharp unavailable, image optimization disabled', {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
    }
    return this.sharpPromise;
  }

  /**
   * 优化单张图片（带缓存与降级）。返回 null 表示文件不可读（调用方跳过该图）。
   * 关闭优化 / 不可优化扩展名 / sharp 不可用 / 编码失败 → 返回原图（optimized=false）。
   */
  async optimizeImage(absPath: string): Promise<OptimizedImage | null> {
    const original = readOriginal(absPath);
    if (!original) return null;

    const cfg = this.getConfig();
    const ext = extname(absPath).toLowerCase();
    if (!cfg.enabled || !OPTIMIZABLE_EXTS.has(ext)) return original;

    let size = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(absPath);
      if (!st.isFile()) return original;
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      return original;
    }
    if (size < cfg.skipBelowBytes) return original;

    const key = `${absPath}|${mtimeMs}|${size}|${cfg.maxEdgePx}|${cfg.quality}|${cfg.format}|${cfg.lossless}|${cfg.maxInlineBytesPerImage}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const sharp = await this.loadSharp();
    if (!sharp) return original;

    let buf: Buffer;
    try {
      buf = readFileSync(absPath);
    } catch {
      return original;
    }

    try {
      const result = await this.encode(sharp, buf, ext, cfg, original.bytes);
      const final = result && result.bytes < original.bytes ? result : original;
      this.cachePut(key, final);
      return final;
    } catch (err) {
      this.logger.warn('context: image optimization failed, using original', {
        path: absPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return original;
    }
  }

  /** 读原图（不经优化）；供不支持优化的路径直接使用 */
  readOriginal(absPath: string): OptimizedImage | null {
    return readOriginal(absPath);
  }

  /** 执行编码：按配置选择格式/质量；超单图上限时降质量重试一次；失败抛错由上层回退 */
  private async encode(
    sharp: SharpFactory,
    buf: Buffer,
    ext: string,
    cfg: ImageOptimizationConfig,
    originalBytes: number,
  ): Promise<OptimizedImage> {
    const fmt = cfg.format === 'auto' ? autoFormat(ext) : cfg.format;
    const first = await this.encodeOnce(sharp, buf, fmt, cfg, cfg.maxEdgePx, cfg.quality);
    if (cfg.maxInlineBytesPerImage > 0 && first.bytes > cfg.maxInlineBytesPerImage) {
      // 二次收紧：更小长边 + 更低质量
      const second = await this.encodeOnce(
        sharp,
        buf,
        fmt,
        cfg,
        Math.min(cfg.maxEdgePx, 1024),
        Math.max(50, cfg.quality - 15),
      );
      return second.bytes < first.bytes ? second : first;
    }
    void originalBytes;
    return first;
  }

  /** 单次编码：resize（仅缩不放）→ 目标格式编码 */
  private async encodeOnce(
    sharp: SharpFactory,
    buf: Buffer,
    fmt: 'png' | 'jpeg' | 'webp',
    cfg: ImageOptimizationConfig,
    maxEdgePx: number,
    quality: number,
  ): Promise<OptimizedImage> {
    let pipe = sharp(buf).rotate();
    // resize：仅当尺寸超过上限时缩小（withoutEnlargement 保证不放大小图）
    pipe = pipe.resize({
      width: maxEdgePx,
      height: maxEdgePx,
      fit: 'inside',
      withoutEnlargement: true,
    });
    if (fmt === 'png') {
      pipe = cfg.lossless
        ? pipe.png({ compressionLevel: 9, adaptiveFiltering: true })
        : pipe.png({ palette: true, quality, compressionLevel: 9, effort: 7 });
    } else if (fmt === 'jpeg') {
      pipe = pipe.jpeg({ quality, mozjpeg: true });
    } else {
      pipe = cfg.lossless
        ? pipe.webp({ lossless: true, effort: 6 })
        : pipe.webp({ quality, effort: 6 });
    }
    const out = await pipe.toBuffer();
    // 尺寸元数据（尽力而为；失败忽略）
    let width: number | undefined;
    let height: number | undefined;
    try {
      const meta = await sharp(out).metadata();
      width = meta.width;
      height = meta.height;
    } catch {
      // 忽略
    }
    return {
      data: out.toString('base64'),
      mimeType: FORMAT_MIME[fmt],
      bytes: out.length,
      optimized: true,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    };
  }

  /** LRU 写入（超限淘汰最旧） */
  private cachePut(key: string, value: OptimizedImage): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
