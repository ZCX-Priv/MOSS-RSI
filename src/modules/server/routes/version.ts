// src/modules/server/routes/version.ts
// GET /api/version

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpResponse, RouteHandler } from '../types';
import type { Environment } from '../../../core/types';

export function createVersionHandler(env: Environment): RouteHandler {
  return async (): Promise<HttpResponse> => {
    // 读取包根 package.json：每次请求实时读取，升级后无需重启即可反映新版本。
    // 不伪造 0.0.0 兜底：读取失败时 version 留空，由前端显示占位符。
    let version = '';
    let channel = 'stable';
    try {
      const pkgPath = join(env.packageRoot, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        version?: unknown;
        channel?: unknown;
      };
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        version = pkg.version.trim();
      }
      if (typeof pkg.channel === 'string' && pkg.channel.trim()) {
        channel = pkg.channel.trim();
      }
    } catch {
      // 包根不可读：version 留空，由前端显示 —
    }
    return {
      status: 200,
      body: {
        version,
        channel,
        buildDate: env.runtimeVersion ? `bun-${env.runtimeVersion}` : undefined,
        // 后端运行平台：前端据此禁用移动端（Android）专属不可用能力
        platform: env.platform,
        arch: env.arch,
        isAndroid: env.isAndroid,
      },
    };
  };
}
