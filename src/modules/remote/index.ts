// src/modules/remote/index.ts
// remote 模块入口：远程控制 MOSS agent（局域网 + cloudflared 公网隧道访问 webui）。
//
// 职责：
// - 初始化认证器（8 位密码 + sessionKey）、隧道服务、请求门卫
// - 通过 ServerInstance.setRequestGuard 注入门卫（fetch 最前拦截，覆盖 HTTP/WS/静态资源//mcp 端点，远程模块下同）
// - 通过 ServerInstance.addRoute 注册 /api/remote/* 管理路由
// - 远程总开关切换 → 配置更新 + 延迟热重绑（server.rebind；响应先发出，前端弹窗轮询 health）
//
// 参考实践：Max/dsh-pocket-main（DeepSeek Harness 的 dsh-pocket 插件）。

import { t } from '../../core/i18n';
import { isDevMode } from '../../core/env';
import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { ServerInstance } from '../server/types';
import type { HttpRequest, HttpResponse, Route } from '../server/types';
import { RemoteAuth, isValidPin } from './auth';
import { RemoteGuard } from './guard';
import { RemoteService } from './service';
import type { RemotePasswordsView, RemoteStatusSnapshot } from './types';

/** 响应发出后延迟多久执行热重绑（给 HTTP 响应发送留时间，避免前端拿到网络错误） */
const REBIND_DELAY_MS = 300;

class RemoteModule implements Module {

  private ctx!: ModuleContext;
  private auth!: RemoteAuth;
  private service!: RemoteService;
  private server!: ServerInstance;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const remoteDir = `${ctx.env.dataDir}/remote`;

    this.auth = new RemoteAuth(remoteDir);
    await this.auth.loadOrInit();

    // server 模块先于 remote 初始化（kernel 固定顺序），直接 resolve
    this.server = ctx.services.resolve<ServerInstance>(ServiceNames.SERVER_INSTANCE);

    this.service = new RemoteService({
      config: ctx.config,
      logger: ctx.logger,
      auth: this.auth,
      remoteDir,
      getPort: () => this.server.port,
    });

    // 注入请求门卫（远程开启时拦截非本机请求；未开启零开销直通）
    const guard = new RemoteGuard({
      config: ctx.config,
      auth: this.auth,
      isTunnelRunning: () => this.service.isTunnelRunning(),
    });
    this.server.setRequestGuard(guard);

    // 注册管理路由
    for (const route of this.buildRoutes()) {
      this.server.addRoute(route);
    }

    // 注册服务（供其他模块消费状态）
    ctx.services.register(ServiceNames.REMOTE_SERVICE, this.service, { scope: 'server' });

    // 自动恢复上次开启的公网隧道（cloudflared 子进程随 MOSS 重启被杀）
    await this.service.restoreTunnelIfNeeded();

    ctx.logger.info(t('remote.started'));
  }

  async destroy(): Promise<void> {
    await this.service.dispose();
    this.ctx.logger.info(t('remote.stopped'));
  }

  // ========================================================================
  // 管理路由
  // ========================================================================

  private buildRoutes(): Route[] {
    return [
      { method: 'GET', pattern: '/api/remote/status', handler: this.handleStatus(), auth: true },
      { method: 'POST', pattern: '/api/remote/enable', handler: this.handleSetEnabled(true), auth: true },
      { method: 'POST', pattern: '/api/remote/disable', handler: this.handleSetEnabled(false), auth: true },
      { method: 'POST', pattern: '/api/remote/lan', handler: this.handleLanToggle(), auth: true },
      { method: 'POST', pattern: '/api/remote/lan/password', handler: this.handleLanPassword(), auth: true },
      { method: 'POST', pattern: '/api/remote/lan-ip', handler: this.handleLanIpOverride(), auth: true },
      { method: 'POST', pattern: '/api/remote/tunnel/start', handler: this.handleTunnelStart(), auth: true },
      { method: 'POST', pattern: '/api/remote/tunnel/stop', handler: this.handleTunnelStop(), auth: true },
      { method: 'POST', pattern: '/api/remote/tunnel/password', handler: this.handleTunnelPassword(), auth: true },
      { method: 'GET', pattern: '/api/remote/passwords', handler: this.handlePasswords(), auth: true },
    ];
  }

  /** GET /api/remote/status：状态快照（设置页轮询）。 */
  private handleStatus() {
    return async (): Promise<HttpResponse> => {
      const snapshot: RemoteStatusSnapshot = await this.service.status();
      return { status: 200, body: snapshot };
    };
  }

  /**
   * POST /api/remote/enable | /api/remote/disable：远程总开关。
   * 配置更新 → 延迟热重绑（127.0.0.1 ⇄ 0.0.0.0）；响应先发出，
   * 前端随后弹进度窗轮询 /api/health 直到服务恢复。
   * 关闭时同时停公网隧道（绑回 loopback 后隧道流量会绕过门卫，必须停）。
   */
  private handleSetEnabled(enabled: boolean) {
    return async (req: HttpRequest): Promise<HttpResponse> => {
      const cfg = this.ctx.config.getAppConfig();
      if (cfg.remote.enabled === enabled) {
        return { status: 200, body: { rebound: false, enabled } };
      }
      await this.ctx.config.updateAppConfig({
        remote: { ...cfg.remote, enabled },
      });
      if (!enabled) {
        this.service.stopTunnel();
      }
      // dev 模式：remote 开关不改变绑定（始终回环），报告与实际一致
      const dev = isDevMode();
      const hostname = dev
        ? '127.0.0.1'
        : (enabled ? '0.0.0.0' : (cfg.security.bindLocalhostOnly ? '127.0.0.1' : cfg.server.host));
      if (dev && enabled) {
        this.ctx.logger.warn('dev mode: remote access stays loopback-only');
      }
      this.scheduleRebind(hostname);
      this.ctx.logger.info(t(enabled ? 'remote.enabled' : 'remote.disabled'), { hostname });
      return { status: 200, body: { rebound: true, enabled, hostname } };
    };
  }

  /** POST /api/remote/lan：局域网开关（即时生效——门卫每请求实时读配置）。 */
  private handleLanToggle() {
    return async (req: HttpRequest): Promise<HttpResponse> => {
      const body = req.body as { enabled?: boolean } | null;
      const enabled = Boolean(body?.enabled);
      const cfg = this.ctx.config.getAppConfig();
      await this.ctx.config.updateAppConfig({
        remote: { ...cfg.remote, lanEnabled: enabled },
      });
      return { status: 200, body: { lanEnabled: enabled } };
    };
  }

  /** POST /api/remote/lan/password：局域网密码操作（refresh/custom/disable/enable）。 */
  private handleLanPassword() {
    return async (req: HttpRequest): Promise<HttpResponse> => {
      const body = req.body as { action?: string; value?: string } | null;
      const cfg = this.ctx.config.getAppConfig();
      switch (body?.action) {
        case 'refresh': {
          const pin = await this.auth.refreshPin('lan');
          this.auth.rotateSessions();
          return { status: 200, body: { pin } };
        }
        case 'custom': {
          const value = String(body.value ?? '');
          if (!isValidPin(value)) {
            return { status: 400, body: { error: 'PIN must be 8 digits' } };
          }
          await this.auth.setCustomPin('lan', value);
          this.auth.rotateSessions();
          return { status: 200, body: { pin: value } };
        }
        case 'disable':
          await this.ctx.config.updateAppConfig({
            remote: { ...cfg.remote, lanPasswordEnabled: false },
          });
          return { status: 200, body: { lanPasswordEnabled: false } };
        case 'enable':
          await this.ctx.config.updateAppConfig({
            remote: { ...cfg.remote, lanPasswordEnabled: true },
          });
          return { status: 200, body: { lanPasswordEnabled: true } };
        default:
          return { status: 400, body: { error: 'Unknown action' } };
      }
    };
  }

  /** POST /api/remote/lan-ip：局域网地址手动覆盖（空串 = 自动选择）。 */
  private handleLanIpOverride() {
    return async (req: HttpRequest): Promise<HttpResponse> => {
      const body = req.body as { ip?: string } | null;
      const ip = String(body?.ip ?? '').trim();
      const cfg = this.ctx.config.getAppConfig();
      await this.ctx.config.updateAppConfig({
        remote: { ...cfg.remote, lanIpOverride: ip },
      });
      return { status: 200, body: { lanIpOverride: ip } };
    };
  }

  /**
   * POST /api/remote/tunnel/start：开启公网隧道。
   * 服务端强校验免责声明勾选（disclaimerAccepted），无法绕过。
   */
  private handleTunnelStart() {
    return async (req: HttpRequest): Promise<HttpResponse> => {
      const body = req.body as { disclaimerAccepted?: boolean } | null;
      if (body?.disclaimerAccepted !== true) {
        return { status: 400, body: { error: 'Disclaimer must be accepted' } };
      }
      const cfg = this.ctx.config.getAppConfig();
      if (!cfg.remote.enabled) {
        return { status: 409, body: { error: 'Remote access is disabled' } };
      }
      try {
        const url = await this.service.startTunnel();
        return { status: 200, body: { url, phase: 'ready' } };
      } catch (err) {
        return {
          status: 502,
          body: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    };
  }

  /** POST /api/remote/tunnel/stop：关闭公网隧道。 */
  private handleTunnelStop() {
    return async (): Promise<HttpResponse> => {
      this.service.stopTunnel();
      return { status: 200, body: { stopped: true } };
    };
  }

  /** POST /api/remote/tunnel/password：公网密码操作（refresh/custom）。 */
  private handleTunnelPassword() {
    return async (req: HttpRequest): Promise<HttpResponse> => {
      const body = req.body as { action?: string; value?: string } | null;
      switch (body?.action) {
        case 'refresh': {
          const pin = await this.auth.refreshPin('public');
          this.auth.rotateSessions();
          return { status: 200, body: { pin } };
        }
        case 'custom': {
          const value = String(body.value ?? '');
          if (!isValidPin(value)) {
            return { status: 400, body: { error: 'PIN must be 8 digits' } };
          }
          await this.auth.setCustomPin('public', value);
          this.auth.rotateSessions();
          return { status: 200, body: { pin: value } };
        }
        default:
          return { status: 400, body: { error: 'Unknown action' } };
      }
    };
  }

  /** GET /api/remote/passwords：密码明文视图（设置页显示；仅已认证者可达）。 */
  private handlePasswords() {
    return async (): Promise<HttpResponse> => {
      const view: RemotePasswordsView = {
        lan: this.auth.getPin('lan'),
        public: this.auth.getPin('public'),
        lanPasswordEnabled: this.ctx.config.getAppConfig().remote.lanPasswordEnabled,
        publicCustomized: this.auth.isCustomized('public'),
      };
      return { status: 200, body: view };
    };
  }

  // ========================================================================

  /** 延迟热重绑：先让本 API 响应发出，再切换绑定（前端弹窗轮询 health）。 */
  private scheduleRebind(hostname: string): void {
    setTimeout(() => {
      this.server
        .rebind(hostname)
        .then(() => {
          this.ctx.logger.info(t('remote.rebound'), { hostname });
        })
        .catch(err => {
          // rebind 失败时 server 内部已按原 hostname 回滚
          this.ctx.logger.error(t('remote.rebindFailed'), {
            error: err instanceof Error ? err.message : String(err),
            hostname,
          });
        });
    }, REBIND_DELAY_MS);
  }
}

export default (): Module => new RemoteModule();
