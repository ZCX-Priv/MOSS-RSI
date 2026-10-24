// src/modules/browser/index.ts
// Browser 模块入口：注册浏览器控制服务（ServiceNames.BROWSER）。
// 初始化只做目录/扩展播种与本地桥接启动，不阻塞内核；内置 Chrome 按需启动。

import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { ComputerService } from '../contracts';
import { BrowserServiceImpl } from './service';

class BrowserModule implements Module {
  private service: BrowserServiceImpl | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    const computer = ctx.services.tryResolve<ComputerService>(ServiceNames.COMPUTER);
    const service = new BrowserServiceImpl({
      env: ctx.env,
      logger: ctx.logger,
      config: ctx.config,
      computer,
    });
    this.service = service;
    ctx.services.register(ServiceNames.BROWSER, service, { scope: 'browser' });
    await service.initialize();
  }

  async destroy(): Promise<void> {
    if (this.service) {
      await this.service.destroy();
    }
  }
}

export default (): Module => new BrowserModule();
