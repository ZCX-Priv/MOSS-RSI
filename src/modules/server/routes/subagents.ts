// src/modules/server/routes/subagents.ts
// 子代理 REST 路由：手动运行一次性 subagent（供 UI 面板与外部调用）
// POST /api/subagents/run

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import { ErrorCode } from '../../../core/error-codes';
import type { SubagentRunner } from '../../subagent/runner';
import type { PermissionMode } from '../../safety/types';

function resolveRunner(services: ServiceRegistry): SubagentRunner | null {
  return services.tryResolve<SubagentRunner>(ServiceNames.SUBAGENT_RUNNER);
}

/** 从请求体提取权限模式（容错） */
function toPermissionMode(v: unknown): PermissionMode | undefined {
  return v === 'ask' || v === 'auto' || v === 'skip' ? v : undefined;
}

export function createRunSubagentHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const runner = resolveRunner(services);
    if (!runner) {
      return { status: 503, body: { error: ErrorCode.SUBAGENT_RUNNER_UNAVAILABLE } };
    }
    const body = (req.body ?? {}) as {
      template?: string;
      task?: string;
      cwd?: string;
      permissionMode?: string;
    };
    if (!body.template?.trim() || !body.task?.trim() || !body.cwd?.trim()) {
      return { status: 400, body: { error: ErrorCode.SUBAGENT_TEMPLATE_REQUIRED } };
    }
    try {
      const output = await runner.run({
        template: body.template,
        task: body.task,
        cwd: body.cwd,
        permissionMode: toPermissionMode(body.permissionMode),
      });
      return { status: 200, body: output };
    } catch (err) {
      return { status: 400, body: { error: ErrorCode.SUBAGENT_TEMPLATE_REQUIRED, message: err instanceof Error ? err.message : String(err) } };
    }
  };
}
