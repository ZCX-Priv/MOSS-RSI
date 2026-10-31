// src/modules/im/index.ts
// IM 连接模块入口：加载配置 → 注册 /api/im/* 路由 → 注册 im.service → 启动已启用机器人。
// 依赖：server（路由/WS 广播）、agent（消息到达时 run）；均为运行期 tryResolve，不阻塞初始化。

import { t } from '../../core/i18n';
import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { ServerInstance } from '../server/types';
import { ImController } from './controller';
import { ImProvisioningManager } from './provisioning';
import { createImRoutes } from './routes';
import { ImStateStore } from './state';
import { ImBotStore } from './store';
import type { ImStatusSnapshot } from './types';

/** 对外暴露的 IM 服务（其他模块/路由可读状态） */
export interface ImService {
  status(): ImStatusSnapshot;
  descriptors(): ReturnType<ImController['descriptors']>;
}

class ImModule implements Module {
  private ctx!: ModuleContext;
  private controller: ImController | null = null;
  private provisioning: ImProvisioningManager | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const store = new ImBotStore(ctx.env.dataDir, ctx.logger);
    const state = new ImStateStore(ctx.env.dataDir, ctx.logger);
    await store.load();
    await state.load();

    const server = ctx.services.tryResolve<ServerInstance>(ServiceNames.SERVER_INSTANCE);
    const controller = new ImController({
      store,
      state,
      logger: ctx.logger,
      services: ctx.services,
      server,
      dataDir: ctx.env.dataDir,
    });
    this.controller = controller;

    const provisioning = new ImProvisioningManager({
      controller,
      store,
      logger: ctx.logger,
    });
    this.provisioning = provisioning;

    // 路由注册（server 未就绪时跳过，避免把 IM 模块拖入错误状态）
    if (server) {
      for (const route of createImRoutes(controller, provisioning)) {
        server.addRoute(route);
      }
    } else {
      ctx.logger.warn(t('im.serverUnavailable'));
    }

    ctx.services.register<ImService>(
      ServiceNames.IM_SERVICE,
      {
        status: () => controller.status(),
        descriptors: () => controller.descriptors(),
      },
      { scope: 'im' },
    );

    await controller.startAll();
    const bots = store.list();
    ctx.logger.info(
      t('im.moduleInitialized', {
        bots: bots.length,
        enabled: bots.filter(bot => bot.enabled).length,
      }),
    );
  }

  async destroy(): Promise<void> {
    await this.provisioning?.close();
    this.provisioning = null;
    await this.controller?.dispose();
    this.controller = null;
    this.ctx.logger.info(t('im.moduleStopped'));
  }
}

export default (): Module => new ImModule();
