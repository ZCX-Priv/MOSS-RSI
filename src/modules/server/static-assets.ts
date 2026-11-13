// src/modules/server/static-assets.ts
// 前端静态资源服务：从 dist/webui 读取，SPA fallback。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import type { Environment } from '../../core/types';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
};

export class StaticAssets {
  private readonly root: string;
  private readonly indexHtml: string;
  private readonly exists: boolean;
  /**
   * 响应内存缓存：filePath → 完整响应（status/headers/body）。
   * 构建产物不可变（hashed 文件名），首次读盘后驻留内存；
   * no-cache 语义仅体现在响应头（浏览器仍会 revalidate），缓存的是内容。
   * 单用户本地应用全量约 10~20MB，无上限缓存可接受；
   * 消除每请求 readFileSync 同步读盘对 Bun 单线程事件循环的阻塞。
   */
  private readonly cache = new Map<string, { status: number; headers: Record<string, string>; body: Buffer }>();

  constructor(env: Environment) {
    this.root = join(env.packageRoot, 'dist', 'webui');
    this.indexHtml = join(this.root, 'index.html');
    this.exists = existsSync(this.root) && existsSync(this.indexHtml);
  }

  isAvailable(): boolean {
    return this.exists;
  }

  /**
   * 尝试返回静态资源。若路径是 /api 开头或文件不存在返回 null。
   * SPA fallback：未匹配文件时返回 index.html（仅对非资源请求）。
   */
  tryServe(path: string): { status: number; headers: Record<string, string>; body: Buffer | string } | null {
    if (!this.exists) return null;
    if (path.startsWith('/api/') || path.startsWith('/ws')) return null;

    // 防越权：移除 query，规范化
    const cleanPath = normalize(path).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(this.root, cleanPath);

    // 确保解析后仍在 root 内
    if (!filePath.startsWith(this.root)) {
      return { status: 403, headers: {}, body: 'Forbidden' };
    }

    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return this.serveFile(filePath);
    }

    // SPA fallback：对非静态资源请求返回 index.html
    const ext = extname(cleanPath).toLowerCase();
    if (ext === '' || ext === '.html') {
      return this.serveFile(this.indexHtml);
    }
    return null;
  }

  private serveFile(filePath: string): { status: number; headers: Record<string, string>; body: Buffer } {
    const cached = this.cache.get(filePath);
    if (cached) {
      // 返回副本语义不必要：body 为只读响应负载，多请求共享同一 Buffer 安全
      return cached;
    }
    const body = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    // SW 注册脚本与 manifest 固定文件名（无 hash）：强制 no-cache 保证新版本及时生效；
    // index.html 同理；语音采集 worklet 也是无 hash 的运行时脚本，必须 no-cache，
    // 否则更新采集算法后浏览器会继续使用最长 24 小时的旧缓存。
    const fileName = filePath.split(/[\\/]/).pop() ?? '';
    const noCache =
      ext === '.html' ||
      fileName === 'sw.js' ||
      fileName === 'registerSW.js' ||
      fileName === 'manifest.webmanifest' ||
      fileName === 'voice-capture-worklet.js';
    const resp = {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400',
      },
      body,
    };
    // 仅可变内容（hashed 文件名）进内存缓存；no-cache 文件（index.html/sw.js/manifest）
    // 每次读盘——否则重新 build 前端后旧 index.html 会从内存"复活"（须重启后端才能更新）
    if (!noCache) {
      this.cache.set(filePath, resp);
    }
    return resp;
  }
}
