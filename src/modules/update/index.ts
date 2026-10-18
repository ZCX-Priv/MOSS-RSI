// src/modules/update/index.ts
// 更新检查模块：定时检查 npm registry 版本，通过事件总线广播更新通知。

import { t } from '../../core/i18n';
import type { Module, ModuleContext } from '../../core/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NPM_REGISTRIES, cachedRankMirrors } from '../../utils/mirror';

const PACKAGE_NAME = 'moss';

/** 候选 registry 的「<registry>/<pkg>/latest」元数据地址（国内源优先；实测四者均可达） */
function registryCandidates(): { id: string; url: string }[] {
  return NPM_REGISTRIES.map(registry => ({
    id: new URL(registry).host,
    url: `${registry.replace(/\/+$/, '')}/${PACKAGE_NAME}/latest`,
  }));
}

class UpdateModule implements Module {

  private ctx!: ModuleContext;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentVersion = '0.0.0';

  async initialize(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.currentVersion = this.readCurrentVersion();

    const cfg = ctx.config.getAppConfig().update;
    if (!cfg.autoCheck) {
      ctx.logger.info(t('update.autoCheckDisabled'));
      return;
    }

    ctx.logger.info(t('update.initialized'), {
      currentVersion: this.currentVersion,
      channel: cfg.channel,
      checkIntervalHours: cfg.checkIntervalHours,
    });

    // 启动时延迟检查（避免阻塞启动）
    setTimeout(() => {
      this.checkForUpdate().catch(err => {
        ctx.logger.debug(t('update.checkFailed'), {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 5000);

    // 定时检查
    const intervalMs = cfg.checkIntervalHours * 60 * 60 * 1000;
    this.timer = setInterval(() => {
      this.checkForUpdate().catch(() => {});
    }, intervalMs);
  }

  async destroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private readCurrentVersion(): string {
    try {
      const pkgPath = join(this.ctx.env.packageRoot, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      return pkg.version ?? '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  private async checkForUpdate(): Promise<void> {
    try {
      // 多 registry + 测速：国内源（npmmirror 等）通常远快于 registry.npmjs.org；
      // 元数据体积极小，故按延迟排序而非吞吐。全部失败时保持静默 debug，不打扰用户。
      const ranked = await cachedRankMirrors(`npm:${PACKAGE_NAME}`, registryCandidates, {
        metric: 'latency',
        probeBytes: 64 * 1024,
        maxMs: 8000,
      });

      let latest: string | undefined;
      for (const mirror of ranked) {
        try {
          const resp = await fetch(mirror.url, { signal: AbortSignal.timeout(10000) });
          if (!resp.ok) {
            this.ctx.logger.debug(t('update.registryNonOk'), { registry: mirror.id, status: resp.status });
            continue;
          }
          const data = (await resp.json()) as { version?: string };
          if (data.version) {
            latest = data.version;
            break;
          }
        } catch (err) {
          this.ctx.logger.debug(t('update.checkFailed'), {
            registry: mirror.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!latest) return;

      if (isNewerVersion(latest, this.currentVersion)) {
        this.ctx.logger.info(t('update.available', { current: this.currentVersion, latest }));
        await this.ctx.eventBus.broadcast('update:available', {
          current: this.currentVersion,
          latest,
          package: PACKAGE_NAME,
        });

        // 通知前端（通过 Server 模块转发 WS）
        const server = this.ctx.services.tryResolve<{ broadcastWS: (msg: unknown) => void }>('server.instance');
        server?.broadcastWS({
          type: 'update:available',
          payload: { current: this.currentVersion, latest },
        });
      } else {
        this.ctx.logger.debug(t('update.upToDate'), { version: this.currentVersion });
      }
    } catch (err) {
      this.ctx.logger.debug(t('update.checkFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * 简单的语义化版本比较：latest > current 返回 true。
 * 仅支持 X.Y.Z 格式。
 */
function isNewerVersion(latest: string, current: string): boolean {
  const parseVersion = (v: string): [number, number, number] => {
    const parts = v.split('.').map(n => parseInt(n, 10));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [la, lb, lc] = parseVersion(latest);
  const [ca, cb, cc] = parseVersion(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

export default (): Module => new UpdateModule();
