// src/modules/im/index.ts
// IM 连接模块入口：加载配置 → 注册 /api/im/* 路由 → 注册 im.service → 启动已启用机器人。
// 依赖：server（路由/WS 广播）、agent（消息到达时 run）；均为运行期 tryResolve，不阻塞初始化。
//
// 启动性能：store/state 的磁盘读取与机器人网络握手全部在 warmup 中完成，
// initialize 只做控制器/路由/服务注册（毫秒级）。

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
  private store: ImBotStore | null = null;
  private state: ImStateStore | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const store = new ImBotStore(ctx.env.dataDir, ctx.logger);
    const state = new ImStateStore(ctx.env.dataDir, ctx.logger);
    this.store = store;
    this.state = state;

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

    ctx.logger.info('im: module initialized (data load deferred to warmup)');
  }

  /** 后台预热：读取机器人与状态存储，然后连接已启用机器人（网络握手可能数十秒） */
  async warmup(ctx: ModuleContext): Promise<void> {
    try {
      await this.store?.load();
      await this.state?.load();
    } catch (err) {
      ctx.logger.warn('im: store load failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const bots = this.store?.list() ?? [];
    void this.controller
      ?.startAll()
      .catch((err: unknown) => {
        ctx.logger.warn(t('im.moduleInitialized', { bots: bots.length, enabled: 0 }), {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    ctx.logger.info(
      t('im.moduleInitialized', {
        bots: bots.length,
        enabled: bots.filter((bot) => bot.enabled).length,
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
