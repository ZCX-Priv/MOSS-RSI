// src/modules/im/provisioning.ts
// 统一扫码接入层：微信 iLink 后台轮询状态机 + QQ 官方扫码连接器回调。
// 前端只读取本地会话快照，不直接阻塞在上游长轮询；扫码成功后直接落库并启动机器人。

import { randomUUID } from 'node:crypto';
import type { Logger } from '../../core/types';
import { asRecord, errorText, fetchJson, sleep, str } from './adapters/util';
import type { ImController } from './controller';
import type { ImBotStore } from './store';
import type { ImBotStatusSnapshot, ImChannelId } from './types';

export type ImProvisioningStatus =
  | 'starting'
  | 'pending'
  | 'scanned'
  | 'needs_verification'
  | 'refreshing'
  | 'connecting'
  | 'connected'
  | 'expired'
  | 'failed'
  | 'cancelled';

export interface ImProvisioningSnapshot {
  loginId: string;
  channel: ImChannelId;
  status: ImProvisioningStatus;
  /** 交给前端用 qrcode 库编码成图片的原始链接 */
  qrUrl?: string;
  qrRevision: number;
  expiresAt?: number;
  pollIntervalMs: number;
  verificationRequired?: boolean;
  message?: string;
  error?: string;
  bot?: ImBotStatusSnapshot;
  alreadyConnected?: boolean;
}

const WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com/';
const WEIXIN_QR_TTL_MS = 5 * 60_000;
const WEIXIN_LONG_POLL_MS = 35_000;
const QQ_QR_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

const LOGIN_STATUSES = new Set([
  'wait',
  'scaned',
  'confirmed',
  'expired',
  'scaned_but_redirect',
  'need_verifycode',
  'verify_code_blocked',
  'binded_redirect',
]);

const TERMINAL_STATUSES = new Set<ImProvisioningStatus>([
  'connected',
  'expired',
  'failed',
  'cancelled',
]);

const STALE_TOKEN_MESSAGE = '微信登录凭据已失效，请重新扫码接入';

interface QqQrCredentials {
  appId: string;
  appSecret: string;
  userOpenid?: string;
}

interface QqQrCallbacks {
  onSuccess(credentials: QqQrCredentials[]): void;
  onFailure(error: Error): void;
  onQrDisplayed?(url: string): void;
  onQrExpired?(): void;
}

interface QqQrOptions {
  displayQrCodeToConsole?: boolean;
  source?: string;
}

type StartQrConnectFn = (callbacks: QqQrCallbacks, options?: QqQrOptions) => () => void;

interface ProvisioningSession {
  loginId: string;
  channel: ImChannelId;
  status: ImProvisioningStatus;
  qrUrl: string;
  qrRevision: number;
  expiresAt: number | null;
  message: string;
  error: string;
  bot: ImBotStatusSnapshot | null;
  alreadyConnected: boolean;
  createdAt: number;
  controller: AbortController;
  // 微信
  qrcode: string;
  currentBaseUrl: string;
  pendingVerifyCode: string;
  verifyWaiter: (() => void) | null;
  // QQ
  dispose: (() => void) | null;
}

export interface ImProvisioningDeps {
  controller: Pick<ImController, 'createWechatBot' | 'createQqBot' | 'status'>;
  store: ImBotStore;
  logger: Logger;
  /** 测试注入；生产使用适配器共享的 fetchJson */
  fetchJson?: typeof fetchJson;
  /** 测试注入；生产动态加载 @tencent-connect/qqbot-connector */
  startQrConnect?: StartQrConnectFn;
}

function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6),
  };
}

function isWeixinHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'weixin.qq.com'
    || normalized.endsWith('.weixin.qq.com')
    || normalized === 'wechat.com'
    || normalized.endsWith('.wechat.com');
}

/** iLink 返回的连接地址 / 扫码地址必须落在微信官方域名内 */
function normalizeWeixinBaseUrl(value: unknown, fallback: string): string {
  const text = str(value);
  if (!text) return fallback;
  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    throw new Error('微信服务返回了无效的连接地址');
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname) || (url.port && url.port !== '443')) {
    throw new Error('微信服务返回了不受信任的连接地址');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function normalizeWeixinQrUrl(value: unknown): string {
  const text = str(value);
  if (!text) throw new Error('微信服务没有返回扫码地址');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('微信服务返回了无效的扫码地址');
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) {
    throw new Error('微信服务返回了不受信任的扫码地址');
  }
  return url.toString();
}

/** ret/errcode 任一非 0 即视为上游拒绝 */
function rejectedCode(value: Record<string, unknown> | null): string {
  if (!value) return '';
  for (const key of ['ret', 'errcode']) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    const text = String(raw).trim();
    if (text && text !== '0') return text;
  }
  return '';
}

function snapshotOf(session: ProvisioningSession): ImProvisioningSnapshot {
  return {
    loginId: session.loginId,
    channel: session.channel,
    status: session.status,
    qrRevision: session.qrRevision,
    pollIntervalMs: POLL_INTERVAL_MS,
    ...(session.qrUrl ? { qrUrl: session.qrUrl } : {}),
    ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
    ...(session.status === 'needs_verification' ? { verificationRequired: true } : {}),
    ...(session.message ? { message: session.message } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.bot ? { bot: session.bot } : {}),
    ...(session.alreadyConnected ? { alreadyConnected: true } : {}),
  };
}

export class ImProvisioningManager {
  private readonly deps: ImProvisioningDeps;
  private readonly sessions = new Map<string, ProvisioningSession>();
  private readonly activeByChannel = new Map<ImChannelId, string>();
  private closed = false;

  constructor(deps: ImProvisioningDeps) {
    this.deps = deps;
  }

  /** 开始一次扫码绑定；同一渠道重复开始会先取消旧会话 */
  async start(channel: string): Promise<ImProvisioningSnapshot> {
    if (this.closed) throw new Error('扫码接入服务已关闭');
    if (channel !== 'wechat-ilink' && channel !== 'qq-official') {
      throw new Error(`该渠道不支持扫码接入：${channel}`);
    }
    const previousId = this.activeByChannel.get(channel);
    if (previousId) await this.cancel(previousId);

    const session: ProvisioningSession = {
      loginId: randomUUID(),
      channel,
      status: 'starting',
      qrUrl: '',
      qrRevision: 0,
      expiresAt: null,
      message: '',
      error: '',
      bot: null,
      alreadyConnected: false,
      createdAt: Date.now(),
      controller: new AbortController(),
      qrcode: '',
      currentBaseUrl: WEIXIN_BASE_URL,
      pendingVerifyCode: '',
      verifyWaiter: null,
      dispose: null,
    };
    this.sessions.set(session.loginId, session);
    this.activeByChannel.set(channel, session.loginId);
    this.deps.logger.debug('im: 扫码会话已开始', { channel, loginId: session.loginId });

    try {
      if (channel === 'wechat-ilink') await this.startWechat(session);
      else await this.startQq(session);
      return snapshotOf(session);
    } catch (error) {
      const cancelled = session.controller.signal.aborted;
      if (!cancelled && !TERMINAL_STATUSES.has(session.status)) {
        session.status = 'failed';
        session.error = channel === 'qq-official'
          ? `QQ 扫码失败：${errorText(error)}`
          : `微信扫码失败：${errorText(error)}`;
      }
      session.dispose?.();
      session.dispose = null;
      this.markTerminal(session);
      this.prune();
      throw error;
    }
  }

  get(loginId: string): ImProvisioningSnapshot | null {
    const session = this.sessions.get(loginId);
    return session ? snapshotOf(session) : null;
  }

  /** 微信验证码提交：唤醒后台轮询继续查询 */
  async verify(loginId: string, code: string): Promise<ImProvisioningSnapshot> {
    const session = this.requireSession(loginId);
    if (session.channel !== 'wechat-ilink') throw new Error('该渠道不支持验证码');
    if (session.status !== 'needs_verification') throw new Error('当前状态不能提交验证码，请重新获取二维码');
    const value = code.trim();
    if (!/^\d{4,8}$/.test(value)) throw new Error('请输入 4~8 位数字验证码');
    session.pendingVerifyCode = value;
    session.status = 'scanned';
    session.message = '验证码已提交，等待手机确认';
    session.verifyWaiter?.();
    return snapshotOf(session);
  }

  async cancel(loginId: string): Promise<ImProvisioningSnapshot> {
    const session = this.requireSession(loginId);
    if (!TERMINAL_STATUSES.has(session.status)) {
      session.controller.abort();
      session.dispose?.();
      session.dispose = null;
      session.verifyWaiter?.();
      session.status = 'cancelled';
      session.message = '扫码绑定已取消';
      session.error = '';
      session.qrUrl = '';
      session.expiresAt = null;
    }
    this.markTerminal(session);
    this.prune();
    return snapshotOf(session);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) {
      session.controller.abort();
      session.dispose?.();
      session.dispose = null;
      session.verifyWaiter?.();
    }
    this.sessions.clear();
    this.activeByChannel.clear();
  }

  // ---------------------------------------------------------------- 微信

  private async startWechat(session: ProvisioningSession): Promise<void> {
    const localTokens = this.deps.store.list()
      .filter(bot => bot.channel === 'wechat-ilink')
      .map(bot => str(bot.credentials.botToken))
      .filter(Boolean)
      .slice(-10);
    const response = asRecord(await this.loadFetch()(
      `${WEIXIN_BASE_URL}ilink/bot/get_bot_qrcode?bot_type=3`,
      {
        method: 'POST',
        headers: commonHeaders(),
        body: JSON.stringify({ local_token_list: localTokens }),
      },
      10_000,
      session.controller.signal,
    ));
    const rejection = rejectedCode(response);
    if (rejection) throw new Error('微信服务拒绝了二维码申请');
    const qrcode = str(response?.qrcode);
    if (!qrcode) throw new Error('微信服务没有返回二维码令牌');
    session.qrcode = qrcode;
    session.qrUrl = normalizeWeixinQrUrl(response?.qrcode_img_content);
    session.status = 'pending';
    session.expiresAt = Date.now() + WEIXIN_QR_TTL_MS;
    void this.runWechatPoll(session);
  }

  private async runWechatPoll(session: ProvisioningSession): Promise<void> {
    const signal = session.controller.signal;
    let failures = 0;
    try {
      while (!signal.aborted && Date.now() < (session.expiresAt ?? 0)) {
        if (session.status === 'needs_verification' && !session.pendingVerifyCode) {
          await this.waitForVerify(session);
          if (signal.aborted) return;
          if (Date.now() >= (session.expiresAt ?? 0)) break;
          if (!session.pendingVerifyCode) continue;
        }

        try {
          let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`;
          if (session.pendingVerifyCode) {
            endpoint += `&verify_code=${encodeURIComponent(session.pendingVerifyCode)}`;
          }
          const response = asRecord(await this.loadFetch()(
            `${session.currentBaseUrl}${endpoint}`,
            { method: 'GET', headers: commonHeaders() },
            WEIXIN_LONG_POLL_MS,
            signal,
          ));
          const status = str(response?.status);
          if (!LOGIN_STATUSES.has(status)) throw new Error('微信服务返回了无法识别的扫码状态');
          failures = 0;

          if (status === 'wait') {
            session.status = 'pending';
            session.message = '';
          } else if (status === 'scaned') {
            session.pendingVerifyCode = '';
            session.status = 'scanned';
            session.message = '已扫码，请在手机上确认';
          } else if (status === 'need_verifycode') {
            session.pendingVerifyCode = '';
            session.status = 'needs_verification';
            session.message = '请在手机上输入验证码';
          } else if (status === 'verify_code_blocked') {
            session.status = 'failed';
            session.error = '验证码多次错误，请重新获取二维码';
            this.finish(session);
            return;
          } else if (status === 'expired') {
            session.status = 'expired';
            session.message = '二维码已过期，请重新获取';
            this.finish(session);
            return;
          } else if (status === 'scaned_but_redirect') {
            session.currentBaseUrl = normalizeWeixinBaseUrl(response?.redirect_host, session.currentBaseUrl);
            session.status = 'scanned';
            session.message = '已扫码，请在手机上确认';
          } else if (status === 'binded_redirect') {
            const connected = this.deps.controller.status().bots.find(
              bot => bot.channel === 'wechat-ilink' && bot.state === 'connected',
            );
            if (connected) {
              session.status = 'connected';
              session.bot = connected;
              session.alreadyConnected = true;
              session.message = '';
            } else {
              session.status = 'failed';
              session.error = '该微信账号已绑定，但本机没有可恢复的凭据，请删除本地机器人后重试';
            }
            this.finish(session);
            return;
          } else if (status === 'confirmed') {
            const botToken = str(response?.bot_token);
            const accountId = str(response?.ilink_bot_id);
            const ownerUserId = str(response?.ilink_user_id);
            if (!botToken || !accountId || !ownerUserId) {
              session.status = 'failed';
              session.error = '微信授权成功，但返回的账号凭据不完整';
              this.finish(session);
              return;
            }
            session.status = 'connecting';
            session.message = '已确认，正在创建机器人…';
            const baseUrl = normalizeWeixinBaseUrl(response?.baseurl, session.currentBaseUrl);
            let bot: ImBotStatusSnapshot;
            try {
              bot = await this.deps.controller.createWechatBot({
                botToken,
                botId: accountId,
                ownerUserId,
                baseUrl,
              });
            } catch (error) {
              session.status = 'failed';
              session.error = `微信机器人创建失败：${errorText(error)}`;
              this.finish(session);
              return;
            }
            session.status = 'connected';
            session.bot = bot;
            session.message = '';
            session.error = '';
            this.finish(session);
            return;
          }
        } catch (error) {
          if (signal.aborted) {
            session.status = 'cancelled';
            session.message = '扫码绑定已取消';
            return;
          }
          // 扫码状态接口本身是长轮询：35s 无状态变化属于正常超时，继续等待下一次
          if (error instanceof Error && error.name === 'AbortError') {
            session.message = '';
            continue;
          }
          failures += 1;
          const message = errorText(error);
          if (failures >= 3) {
            session.status = 'failed';
            session.error = `微信扫码状态查询失败：${message}`;
            this.finish(session);
            return;
          }
          session.message = `微信扫码状态查询失败：${message}，正在重试…`;
          await sleep(Math.min(30_000, 1_000 * (2 ** (failures - 1))), signal);
        }
      }

      if (!signal.aborted && !TERMINAL_STATUSES.has(session.status)) {
        session.status = 'expired';
        session.message = '二维码已过期，请重新获取';
      }
      this.finish(session);
    } finally {
      session.verifyWaiter = null;
    }
  }

  private waitForVerify(session: ProvisioningSession): Promise<void> {
    const signal = session.controller.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        if (session.verifyWaiter === finish) session.verifyWaiter = null;
        resolve();
      };
      timer = setTimeout(finish, Math.max(0, (session.expiresAt ?? Date.now()) - Date.now() + 100));
      signal.addEventListener('abort', finish, { once: true });
      session.verifyWaiter = finish;
    });
  }

  // ---------------------------------------------------------------- QQ

  private async startQq(session: ProvisioningSession): Promise<void> {
    const start = this.deps.startQrConnect ?? (await this.loadQqConnector());
    let firstResolve: (() => void) | null = null;
    let firstReject: ((error: Error) => void) | null = null;
    const firstQr = new Promise<void>((resolve, reject) => {
      firstResolve = resolve;
      firstReject = reject;
    });

    session.dispose = start({
      onQrDisplayed: url => {
        if (session.controller.signal.aborted || TERMINAL_STATUSES.has(session.status)) return;
        const link = str(url);
        if (!link) return;
        session.qrUrl = link;
        session.qrRevision += 1;
        session.status = 'pending';
        session.message = '';
        session.error = '';
        session.expiresAt = Date.now() + WEIXIN_QR_TTL_MS;
        firstResolve?.();
      },
      onQrExpired: () => {
        if (session.controller.signal.aborted || TERMINAL_STATUSES.has(session.status)) return;
        session.qrUrl = '';
        session.expiresAt = null;
        session.status = 'refreshing';
        session.message = '二维码已过期，正在刷新…';
      },
      onSuccess: credentials => {
        if (session.controller.signal.aborted || TERMINAL_STATUSES.has(session.status)) return;
        session.status = 'connecting';
        session.message = '已扫码，正在创建机器人…';
        void this.completeQq(session, credentials);
      },
      onFailure: error => {
        if (session.controller.signal.aborted || TERMINAL_STATUSES.has(session.status)) {
          firstReject?.(error);
          return;
        }
        session.status = 'failed';
        session.error = `QQ 扫码失败：${errorText(error)}`;
        session.message = '';
        firstReject?.(error);
      },
    }, { displayQrCodeToConsole: false, source: 'MOSS' });

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        firstQr,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('无法生成 QQ 二维码，请稍后重试')), QQ_QR_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async completeQq(session: ProvisioningSession, credentials: QqQrCredentials[]): Promise<void> {
    try {
      const first = Array.isArray(credentials) ? credentials[0] : undefined;
      const appId = str(first?.appId);
      const appSecret = str(first?.appSecret);
      if (!appId || !appSecret) throw new Error('QQ 授权返回的凭据不完整');
      const ownerUserOpenid = str(first?.userOpenid);
      const bot = await this.deps.controller.createQqBot({
        appId,
        appSecret,
        ...(ownerUserOpenid ? { ownerUserOpenid } : {}),
      });
      session.status = 'connected';
      session.bot = bot;
      session.message = '';
      session.error = '';
    } catch (error) {
      if (session.controller.signal.aborted) {
        session.status = 'cancelled';
        session.message = '扫码绑定已取消';
      } else {
        session.status = 'failed';
        session.error = `QQ 机器人创建失败：${errorText(error)}`;
      }
    } finally {
      session.dispose?.();
      session.dispose = null;
      this.finish(session);
    }
  }

  private async loadQqConnector(): Promise<StartQrConnectFn> {
    try {
      const module = await import('@tencent-connect/qqbot-connector');
      return module.startQrConnect as StartQrConnectFn;
    } catch (error) {
      throw new Error(`未安装 QQ 扫码连接器依赖：${errorText(error)}`);
    }
  }

  // ---------------------------------------------------------------- 内部

  private loadFetch(): typeof fetchJson {
    return this.deps.fetchJson ?? fetchJson;
  }

  private requireSession(loginId: string): ProvisioningSession {
    const session = this.sessions.get(loginId);
    if (!session) throw new Error('登录会话不存在或已过期');
    return session;
  }

  private finish(session: ProvisioningSession): void {
    this.markTerminal(session);
    this.prune();
  }

  private markTerminal(session: ProvisioningSession): void {
    if (this.activeByChannel.get(session.channel) === session.loginId) {
      this.activeByChannel.delete(session.channel);
    }
  }

  private prune(): void {
    const terminal = [...this.sessions.values()].filter(session => TERMINAL_STATUSES.has(session.status));
    if (terminal.length <= 16) return;
    terminal
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, terminal.length - 16)
      .forEach(session => this.sessions.delete(session.loginId));
  }
}
