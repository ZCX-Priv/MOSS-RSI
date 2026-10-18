// src/modules/remote/service.ts
// RemoteService：cloudflared 隧道生命周期管理 + 状态快照。
// 隧道段，按 MOSS 规范 TS 化。
//
// - 单飞：并发 startTunnel 复用同一次 in-flight，避免 spawn 多个 cloudflared 孤儿进程
// - 自动恢复：MOSS 重启后按持久化标记自动重拉隧道（cloudflared 子进程随宿主被杀）
// - 状态打回：隧道进程运行中死亡（崩溃/被杀）→ phase 置 error，别让 UI 永远显示可用

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigService, Logger } from '../../core/types';
import { RemoteAuth } from './auth';
import { LanIpExplorer, isValidIpv4 } from './lan-ip';
import { startQuickTunnel, type QuickTunnel } from './tunnel';
import type { RemoteStatusSnapshot, TunnelState } from './types';

interface TunnelPhaseInfo {
  zh: string;
}

/** 各阶段的进度详情（前端直接展示） */
const PHASE_DETAILS: Record<string, TunnelPhaseInfo> = {
  downloading: { zh: '首次下载 cloudflared（约 20-50MB）' },
  starting: { zh: '启动隧道进程…' },
  registering: { zh: '连接 Cloudflare 边缘（通常 5-30 秒）' },
  ready: { zh: '隧道就绪' },
};

export interface RemoteServiceOptions {
  config: ConfigService;
  logger: Logger;
  auth: RemoteAuth;
  /** remote 数据目录（~/.moss/remote） */
  remoteDir: string;
  /** 主 server 实际端口（快照与隧道回连目标） */
  getPort: () => number;
}

export class RemoteService {
  private readonly config: ConfigService;
  private readonly logger: Logger;
  private readonly auth: RemoteAuth;
  private readonly remoteDir: string;
  private readonly getPort: () => number;
  private readonly lanExplorer = new LanIpExplorer();

  private tunnel: QuickTunnel | null = null;
  private tunnelAbort: AbortController | null = null;
  /** in-flight 隧道启动（单飞） */
  private tunnelPromise: Promise<string> | null = null;
  private readonly tunnelState: TunnelState = { phase: 'idle', detail: '', startedAt: null };

  constructor(opts: RemoteServiceOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.auth = opts.auth;
    this.remoteDir = opts.remoteDir;
    this.getPort = opts.getPort;
  }

  /** 隧道是否运行中。 */
  isTunnelRunning(): boolean {
    return this.tunnel !== null && this.tunnelState.phase === 'ready';
  }

  /** 启动公网隧道（幂等；返回公网 URL）。进度写进 tunnelState；并发调用单飞。 */
  async startTunnel(): Promise<string> {
    if (this.tunnel) return this.tunnel.url;
    if (this.tunnelPromise) return this.tunnelPromise;

    const controller = new AbortController();
    this.tunnelAbort = controller;
    this.tunnelState.startedAt = Date.now();

    // detail 缺省时按阶段取默认文案；tunnel.ts 在 Termux pkg 安装 / 测速选源时会传自定义文案
    const onPhase = (
      phase: 'downloading' | 'starting' | 'registering' | 'ready',
      detail?: string,
    ): void => {
      this.tunnelState.phase = phase;
      this.tunnelState.detail = detail ?? PHASE_DETAILS[phase]?.zh ?? '';
    };

    this.tunnelPromise = (async (): Promise<string> => {
      const p = this.tunnelPromise;
      try {
        const result = await startQuickTunnel({
          port: this.getPort(),
          cacheDir: join(this.remoteDir, 'bin'),
          signal: controller.signal,
          onPhase,
        });
        this.tunnel = result;
        this.tunnelState.phase = 'ready';
        this.tunnelState.detail = PHASE_DETAILS.ready.zh;
        // 隧道进程运行中死亡（崩溃/被杀）→ 状态打回 error
        result.onExit(code => {
          if (controller.signal.aborted) return; // 主动停止（stopTunnel）不算故障
          this.tunnel = null;
          this.tunnelState.phase = 'error';
          this.tunnelState.detail = `隧道进程退出（code=${code}）`;
          this.logger.warn(`remote: 隧道进程退出 code=${code}`);
        });
        // 记录「隧道开启中」标记，供重启后自动恢复
        await this.persistAutoTunnel();
        // 公网隧道就绪 → 轮换公网密码（自定义后不换）
        if (!this.auth.isCustomized('public')) {
          await this.auth.refreshPin('public');
        } else {
          // 自定义密码固定，但轮换会话（旧 cookie 失效，重新输入即可）
          this.auth.rotateSessions();
        }
        this.logger.info(`remote: 公网隧道就绪 ${result.url}`);
        return result.url;
      } catch (err) {
        // stopTunnel 触发的 abort 不算错误：保持 idle
        if (!controller.signal.aborted) {
          this.tunnelState.phase = 'error';
          this.tunnelState.detail = err instanceof Error ? err.message : String(err);
        }
        this.tunnelState.startedAt = null;
        throw err;
      } finally {
        // 只清自己的引用：stop 后立即 start 可能已建新的 in-flight，不能误清
        if (this.tunnelPromise === p) this.tunnelPromise = null;
      }
    })();

    return this.tunnelPromise;
  }

  /** 停止公网隧道。 */
  stopTunnel(): void {
    this.tunnelAbort?.abort();
    this.tunnelAbort = null;
    this.tunnelPromise = null;
    if (this.tunnel) this.tunnel.kill();
    this.tunnel = null;
    this.tunnelState.phase = 'idle';
    this.tunnelState.detail = '';
    this.tunnelState.startedAt = null;
    // 手动关闭后不再自动恢复
    void this.clearAutoTunnel();
  }

  /** 启动时自动恢复上次开启的公网隧道。 */
  async restoreTunnelIfNeeded(): Promise<void> {
    const remote = this.config.getAppConfig().remote;
    if (!remote.enabled) return;
    if (this.tunnel || this.tunnelPromise) return;
    let has = false;
    try {
      const raw = await readFile(this.autoTunnelPath(), 'utf8');
      has = /"at"\s*:/.test(raw);
    } catch {
      return; // 无标记 → 不恢复
    }
    if (!has) return;
    try {
      await this.startTunnel();
      this.logger.info('remote: 已自动恢复公网隧道');
    } catch (err) {
      // 恢复失败保留标记（下次启动再试）
      this.logger.warn(`remote: 自动恢复隧道失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 状态快照（API 返回；不含任何密码明文）。 */
  async status(): Promise<RemoteStatusSnapshot> {
    const remote = this.config.getAppConfig().remote;
    const port = this.getPort();
    const override = isValidIpv4(remote.lanIpOverride) ? remote.lanIpOverride : '';
    const lanIp = override || (await this.lanExplorer.select());
    const lanUrl = lanIp && remote.enabled ? `http://${lanIp}:${port}` : null;
    const candidates = [...new Set(await this.lanExplorer.candidates())];
    if (override && !candidates.includes(override)) candidates.push(override);
    return {
      enabled: remote.enabled,
      port,
      lanEnabled: remote.lanEnabled,
      lanPasswordEnabled: remote.lanPasswordEnabled,
      lanIp,
      lanUrl,
      lanCandidates: candidates,
      lanIpOverride: override,
      tunnel: { ...this.tunnelState },
      tunnelUrl: this.tunnel?.url ?? null,
      publicPasswordCustomized: this.auth.isCustomized('public'),
    };
  }

  /** 停止一切（模块销毁时）。 */
  async dispose(): Promise<void> {
    this.stopTunnel();
  }

  // -------------------------------------------------------------------------

  private autoTunnelPath(): string {
    return join(this.remoteDir, 'tunnel-auto.json');
  }

  private async persistAutoTunnel(): Promise<void> {
    try {
      await mkdir(this.remoteDir, { recursive: true });
      await writeFile(this.autoTunnelPath(), JSON.stringify({ at: Date.now() }), 'utf8');
    } catch {
      // 忽略持久化失败
    }
  }

  private async clearAutoTunnel(): Promise<void> {
    try {
      await rm(this.autoTunnelPath(), { force: true });
    } catch {
      // 忽略
    }
  }
}
