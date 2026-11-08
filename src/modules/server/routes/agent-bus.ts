// src/modules/server/routes/agent-bus.ts
// 多智能体总线快照：GET /api/agent-bus/snapshot?root=<sessionId>&limit=200
// 供任务页「智能体」标签读取成员树与通信审计（内存 + JSONL 合并）。

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import { ErrorCode } from '../../../core/error-codes';
import type { AgentBus } from '../../agent-bus/types';

function toLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(2000, Math.floor(n)));
}

export function createAgentBusSnapshotHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const bus = services.tryResolve<AgentBus>(ServiceNames.AGENT_BUS);
    if (!bus) {
      return { status: 503, body: { error: ErrorCode.AGENT_BUS_UNAVAILABLE } };
    }
    const root = typeof req.query.root === 'string' && req.query.root.trim() !== ''
      ? req.query.root.trim()
      : undefined;
    const limit = toLimit(req.query.limit);
    return { status: 200, body: bus.snapshot(root, limit !== undefined ? { limit } : undefined) };
  };
}
