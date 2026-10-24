// src/modules/computer/index.ts
// Computer 模块入口：注册 cua-driver 计算机操作服务（ServiceNames.COMPUTER）。
// 模块初始化只做目录准备、驱动探测与后台连接，不阻塞内核启动。
//
// 依赖：mcp/client（McpClient 实现）、server（事件投递惰性解析）；不依赖 tools/agent。

import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { ServerInstance } from '../server/types';
import { ComputerServiceImpl } from './service';

class ComputerModule implements Module {
  private service: ComputerServiceImpl | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    const service = new ComputerServiceImpl({
      logger: ctx.logger,
      config: ctx.config,
      env: ctx.env,
      eventBus: ctx.eventBus,
      // 惰性解析 SERVER_INSTANCE：模块初始化顺序无关；未注册时静默丢弃（无 WS 场景）
      emitter: (sessionId, message) => {
        try {
          const server = ctx.services.tryResolve<ServerInstance>(ServiceNames.SERVER_INSTANCE);
          if (!server) return;
          if (sessionId) server.sendToSession(sessionId, message);
          else server.broadcastWS(message);
        } catch {
          // 投递失败不影响 computer 服务
        }
      },
    });
    this.service = service;

    ctx.services.register(ServiceNames.COMPUTER, service, { scope: 'computer' });
    await service.initialize();
  }

  async destroy(): Promise<void> {
    if (this.service) {
      await this.service.destroy();
    }
  }
}

export default (): Module => new ComputerModule();
