// src/modules/server/routes/terminal.ts
// GET /api/terminal/interpreters —— 本机实测可用的终端解释器类型（前端「新建终端」菜单数据源）。
// 数据源为 env-probe 的实测结果（启动时探测、进程级缓存），只返回真实存在的类型。

import type { HttpResponse, RouteHandler } from '../types';
import type { Environment } from '../../../core/types';
import { listInterpreters } from '../../terminal/interpreter';

export function createListInterpretersHandler(env: Environment): RouteHandler {
  return async (): Promise<HttpResponse> => {
    return { status: 200, body: { interpreters: listInterpreters(env.isWindows) } };
  };
}