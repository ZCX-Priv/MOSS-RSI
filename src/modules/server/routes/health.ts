// src/modules/server/routes/health.ts
// GET /api/health - 健康检查

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import { ServiceNames } from '../../../core/types';
import type { ServiceRegistry } from '../../../core/types';
import { getStartupSummary } from '../../../core/startup-profiler';

interface ModuleStateInfo {
  getList?: () => Array<{ name: string; state: string }>;
}

export function createHealthHandler(services: ServiceRegistry): RouteHandler {
  return async (_req: HttpRequest): Promise<HttpResponse> => {
    const mod = services.tryResolve<ModuleStateInfo>('kernel.modules');
    const list = mod?.getList?.() ?? [];
    const moduleStates: Record<string, string> = {};
    for (const m of list) moduleStates[m.name] = m.state;
    const serviceNames = services.list();
    return {
      status: 200,
      body: {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: serviceNames,
        uptime: process.uptime(),
        modules: list.length,
        moduleStates,
        // 基准脚本与前端启动态判定：agent.engine 注册即可受理对话
        agentReady: serviceNames.includes(ServiceNames.AGENT_ENGINE),
        startup: getStartupSummary(),
      },
    };
  };
}
