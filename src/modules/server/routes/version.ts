// src/modules/server/routes/version.ts
// GET /api/version

import type { HttpResponse, RouteHandler } from '../types';
import type { Environment } from '../../../core/types';

export function createVersionHandler(env: Environment): RouteHandler {
  return async (): Promise<HttpResponse> => {
    // 读取 package.json version
    let version = '0.0.0';
    let channel = 'stable';
    try {
      // Bun: 直接 require package.json
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require(`${env.packageRoot}/package.json`);
      version = pkg.version ?? version;
      channel = pkg.channel ?? channel;
    } catch {
      // 降级
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
