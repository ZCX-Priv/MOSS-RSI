// src/modules/im/adapters/qq-official.ts
// QQ 官方机器人：@tencent-connect/qqbot-nodejs 的 WebSocket 网关，接收 C2C / 群 @ 消息。
// 前置条件（QQ 开放平台）：创建机器人 → 事件订阅选择 WebSocket → 申请群聊/C2C 消息权限。

import type {
  ImAdapterContext,
  ImChannelAdapter,
  ImChannelDescriptor,
  ImInboundMessage,
  ImReplyTarget,
} from '../types';
import { segmentsToText } from '../segments';
import type { ImMediaRef, ImSegment } from '../types';
import { asRecord, errorText, fetchBuffer, fetchJson, str } from './util';

const QQ_TYPING_DURATION_SEC = 60;
const QQ_TYPING_KEEPALIVE_MS = 50_000;
const QQ_RECOVERY_TIMEOUT_MS = 120_000;
const QQ_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const QQ_AUTH_EXPIRED_MESSAGE = 'QQ 授权已失效，请重新扫码绑定';

/** QQ 授权（AppID/AppSecret）失效：旧 secret 已无法换取 access token */
export function isQqAuthorizationError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return text.includes('100016')
    || text.includes('invalid appid or secret')
    || text.includes('invalid appid')
    || text.includes('invalid secret')
    || text.includes('token expired');
}

/** 网络/超时类发送失败才值得重建连接；业务限流等错误不重建 */
function isQqTransportError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return text.includes('network error')
    || text.includes('timeout')
    || text.includes('econn')
    || text.includes('socket')
    || text.includes('连接失败')
    || text.includes('连接超时');
}

interface QQTarget {
  scope: 'c2c' | 'group';
  targetId: string;
  msgId?: string;
}

interface QqTypingEntry {
  timer: ReturnType<typeof setTimeout> | null;
  target: QQTarget;
}

interface QQInbound {
  rawEventType: string;
  kind: 'c2c' | 'group' | 'guild' | 'dm';
  senderId: string;
  senderName?: string;
  senderIsBot?: boolean;
  content: string;
  messageId: string;
  groupOpenid?: string;
  attachments?: Array<{
    content_type?: string;
    url?: string;
    filename?: string;
    size?: number;
    voice_wav_url?: string;
    asr_refer_text?: string;
  }>;
  mentions?: Array<{ is_you?: boolean; id?: string; user_openid?: string; member_openid?: string }>;
  replyTarget?: QQTarget;
}

interface QQDisconnect {
  code: number;
  reason: string;
  willReconnect: boolean;
}

interface QQBotLike {
  on(event: 'ready', handler: (data: unknown) => void): QQBotLike;
  on(event: 'resumed', handler: (data: unknown) => void): QQBotLike;
  on(event: 'disconnected', handler: (event: QQDisconnect) => void): QQBotLike;
  on(event: 'error', handler: (error: Error) => void): QQBotLike;
  on(event: 'message', handler: (ctx: unknown, message: QQInbound) => void | Promise<void>): QQBotLike;
  start(signal?: AbortSignal): Promise<void>;
  stop(): void;
  sendText(target: QQTarget, content: string): Promise<unknown>;
  sendTyping(target: QQTarget, durationSec?: number): Promise<unknown>;
}

interface QQModule {
  QQBot: new (options: Record<string, unknown>) => QQBotLike;
}

function isAddressed(message: QQInbound): boolean {
  if (message.kind !== 'group') return true;
  if (message.rawEventType === 'GROUP_AT_MESSAGE_CREATE') return true;
  return Array.isArray(message.mentions) && message.mentions.some(item => item?.is_you === true);
}

export const descriptor: ImChannelDescriptor = {
  id: 'qq-official',
  label: 'QQ',
  guide:
    '推荐使用手机 QQ 扫码创建/绑定官方机器人；也可手动填写 AppID + AppSecret（需先在 QQ 开放平台创建机器人，事件订阅选择 WebSocket，并申请群聊/C2C 消息权限）。扫码绑定的凭据可能被 QQ 侧回收；长期使用建议在 QQ 开放平台获取 AppID/AppSecret 后手动接入或更新。',
  fields: [
    { key: 'appId', label: 'AppID', type: 'text', required: true },
    { key: 'appSecret', label: 'AppSecret', type: 'password', required: true },
  ],
  capabilities: { markdown: false, group: true, qrLogin: true },
  async verify(credentials) {
    const appId = str(credentials.appId);
    const appSecret = str(credentials.appSecret);
    if (!appId || !appSecret) throw new Error('AppID 与 AppSecret 必填');
    let response: Record<string, unknown> | null;
    try {
      response = asRecord(
        await fetchJson('https://bots.qq.com/app/getAppAccessToken', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId, clientSecret: appSecret }),
        }),
      );
    } catch (error) {
      throw new Error(`QQ 鉴权失败：${errorText(error)}`);
    }
    const accessToken = str(response?.access_token);
    if (!accessToken) {
      throw new Error(`QQ 鉴权失败：${str(response?.message) || str(response?.msg) || '未返回 access_token'}`);
    }
    return { platformId: appId, name: `QQ机器人 ${appId.slice(-4)}` };
  },
};

export function createAdapter(ctx: ImAdapterContext): ImChannelAdapter {
  const { bot, logger, signal, onMessage, onStatus } = ctx;
  const appId = str(bot.credentials.appId);
  const appSecret = str(bot.credentials.appSecret);

  let sdkBot: QQBotLike | null = null;
  let sdkModule: QQModule | null = null;
  let stopped = false;
  let authExpired = false;
  let generation = 0;
  let restartAttempts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  const typingEntries = new Map<string, QqTypingEntry>();

  const handleMessage = (_context: unknown, message: QQInbound): void => {
    if (!message) return;
    if (message.kind !== 'c2c' && message.kind !== 'group') return;
    if (message.senderIsBot === true) return;
    const messageId = str(message.messageId);
    const senderId = str(message.senderId);
    if (!messageId || !senderId) return;
    const isGroup = message.kind === 'group';
    const groupId = str(message.groupOpenid);
    const target: QQTarget = message.replyTarget
      ? { ...message.replyTarget }
      : { scope: isGroup ? 'group' : 'c2c', targetId: isGroup ? groupId : senderId, msgId: messageId };
    if (!target.targetId) return;

    const segments: ImSegment[] = [];
    const contentText = typeof message.content === 'string' ? message.content.trim() : '';
    if (contentText) segments.push({ type: 'text', text: contentText });

    for (const item of message.attachments ?? []) {
      const contentType = (item.content_type ?? '').toLowerCase();
      const url = str(item.url) || str(item.voice_wav_url);
      if (!url) continue;
      const name = str(item.filename) || undefined;
      const kind: ImMediaRef['kind'] = contentType.includes('image')
        ? 'image'
        : contentType.includes('video')
          ? 'video'
          : contentType.includes('voice') || contentType.includes('audio')
            ? 'audio'
            : 'file';
      const media: ImMediaRef = {
        kind,
        name,
        ...(typeof item.size === 'number' ? { size: item.size } : {}),
        ...(contentType ? { mimeType: contentType } : {}),
        load: signal => fetchBuffer(url, { signal }),
      };
      if (kind === 'image') segments.push({ type: 'image', media });
      else if (kind === 'video') segments.push({ type: 'video', media });
      else if (kind === 'audio') {
        segments.push({ type: 'audio', media, transcript: item.asr_refer_text || undefined });
      } else segments.push({ type: 'file', media, name: name ?? '文件' });
    }

    const inbound: ImInboundMessage = {
      botId: bot.botId,
      channel: 'qq-official',
      messageId,
      conversationKey: isGroup ? `group:${groupId}` : `direct:${senderId}`,
      kind: isGroup ? 'group' : 'direct',
      senderId,
      senderName: str(message.senderName) || senderId.slice(-6),
      segments,
      text: segmentsToText(segments),
      addressed: isAddressed(message),
      replyTarget: {
        channel: 'qq-official',
        kind: isGroup ? 'group' : 'direct',
        scope: target.scope,
        targetId: target.targetId,
        msgId: target.msgId ?? messageId,
      },
      receivedAt: new Date().toISOString(),
    };
    onMessage(inbound);
  };

  const clearRestartTimer = (): void => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
  };

  const stopInstance = (): void => {
    // 先使旧实例的事件回调失效，再停止，避免旧 start() 结算触发新的重建
    generation += 1;
    const current = sdkBot;
    sdkBot = null;
    try {
      current?.stop();
    } catch {
      // 忽略
    }
  };

  const markConnected = (): void => {
    authExpired = false;
    restartAttempts = 0;
    clearRecoveryTimer();
    clearRestartTimer();
    onStatus({ connected: true, lastError: null, extra: { authExpired: '' } });
  };

  const markAuthExpired = (): void => {
    authExpired = true;
    clearRecoveryTimer();
    clearRestartTimer();
    for (const entry of typingEntries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    typingEntries.clear();
    stopInstance();
    onStatus({
      connected: false,
      lastError: QQ_AUTH_EXPIRED_MESSAGE,
      extra: { authExpired: 'true' },
    });
  };

  const armRecovery = (): void => {
    if (stopped || authExpired || recoveryTimer) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      scheduleRestart();
    }, QQ_RECOVERY_TIMEOUT_MS);
  };

  const scheduleRestart = (): void => {
    if (stopped || authExpired || restartTimer) return;
    const delay = QQ_RESTART_DELAYS_MS[Math.min(restartAttempts, QQ_RESTART_DELAYS_MS.length - 1)]!;
    restartAttempts += 1;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void restart();
    }, delay);
  };

  const restart = async (): Promise<void> => {
    if (stopped || authExpired) return;
    stopInstance();
    try {
      await launchInstance();
    } catch (error) {
      if (stopped) return;
      if (isQqAuthorizationError(error)) {
        markAuthExpired();
        return;
      }
      onStatus({ connected: false, lastError: errorText(error) });
      scheduleRestart();
    }
  };

  const launchInstance = async (): Promise<void> => {
    if (stopped) return;
    const sdk = sdkModule ?? (sdkModule = (await import('@tencent-connect/qqbot-nodejs')) as unknown as QQModule);
    if (stopped) return;
    const current = ++generation;
    const instance = new sdk.QQBot({
      appId,
      appSecret,
      accountId: bot.botId,
      transport: 'websocket',
      tokenPrefetch: 'sync',
      markdownSupport: false,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (...args: unknown[]) => logger.warn(`[qq-official] ${args.map(String).join(' ')}`),
        error: (...args: unknown[]) => logger.error(`[qq-official] ${args.map(String).join(' ')}`),
      },
    });
    sdkBot = instance;
    let settle: ((error?: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('QQ 机器人网关连接超时（20s）')), 20_000);
      settle = (error?: Error): void => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
    });
    void ready.catch(() => undefined);
    const valid = (): boolean => current === generation && !stopped;

    instance.on('ready', () => {
      if (!valid()) return;
      markConnected();
      settle?.();
    });
    instance.on('resumed', () => {
      if (!valid()) return;
      markConnected();
      settle?.();
    });
    instance.on('disconnected', event => {
      if (!valid()) return;
      onStatus({
        connected: false,
        lastError: `QQ 机器人连接断开：${event.reason || `关闭码 ${event.code}`}`,
        extra: { authExpired: authExpired ? 'true' : '' },
      });
      if (event.willReconnect) armRecovery();
      else scheduleRestart();
    });
    instance.on('error', (error: Error) => {
      if (!valid()) return;
      if (isQqAuthorizationError(error)) {
        markAuthExpired();
        settle?.(new Error(QQ_AUTH_EXPIRED_MESSAGE));
        return;
      }
      onStatus({ connected: false, lastError: errorText(error) });
      armRecovery();
    });
    instance.on('message', handleMessage);
    // start 会挂到连接关闭，不能 await；失败通过 ready/error 暴露
    void instance.start(signal).then(() => {
      if (valid()) scheduleRestart();
    }).catch((error: unknown) => {
      if (!valid()) return;
      if (isQqAuthorizationError(error)) {
        markAuthExpired();
        settle?.(new Error(QQ_AUTH_EXPIRED_MESSAGE));
        return;
      }
      onStatus({ connected: false, lastError: errorText(error) });
      settle?.(new Error(`QQ 机器人连接失败：${errorText(error)}`));
      // start() 已结算，SDK 不会自行重连，直接安排新实例
      scheduleRestart();
    });
    await ready;
    logger.info('im: QQ 机器人网关已连接', { botId: bot.botId });
  };

  return {
    async start() {
      stopped = false;
      authExpired = false;
      restartAttempts = 0;
      clearRestartTimer();
      clearRecoveryTimer();
      stopInstance();
      await launchInstance();
    },

    async stop() {
      stopped = true;
      generation += 1;
      clearRestartTimer();
      clearRecoveryTimer();
      for (const entry of typingEntries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      typingEntries.clear();
      stopInstance();
      onStatus({ connected: false });
    },

    async setTyping(target: ImReplyTarget, active: boolean) {
      const targetId = str(target.targetId);
      // QQ 输入状态仅支持 C2C 私聊，群聊静默跳过
      if (!targetId || target.scope === 'group' || stopped) return;
      if (!active) {
        const entry = typingEntries.get(targetId);
        if (entry?.timer) clearTimeout(entry.timer);
        typingEntries.delete(targetId);
        return;
      }
      const previous = typingEntries.get(targetId);
      if (previous?.timer) clearTimeout(previous.timer);
      const msgId = str(target.msgId);
      const entry: QqTypingEntry = {
        timer: null,
        target: { scope: 'c2c', targetId, ...(msgId ? { msgId } : {}) },
      };
      typingEntries.set(targetId, entry);
      const send = async (): Promise<void> => {
        if (stopped || typingEntries.get(targetId) !== entry || !sdkBot) return;
        try {
          await sdkBot.sendTyping(entry.target, QQ_TYPING_DURATION_SEC);
        } catch (error) {
          typingEntries.delete(targetId);
          if (isQqAuthorizationError(error)) {
            markAuthExpired();
          } else if (!stopped) {
            logger.warn('im: QQ 正在输入发送失败', { botId: bot.botId, error: errorText(error) });
          }
          return;
        }
        if (stopped || typingEntries.get(targetId) !== entry) return;
        entry.timer = setTimeout(() => {
          entry.timer = null;
          void send();
        }, QQ_TYPING_KEEPALIVE_MS);
      };
      await send();
    },

    async sendText(target: ImReplyTarget, text: string) {
      if (!sdkBot) throw new Error('QQ 机器人适配器尚未启动');
      const scope = target.scope === 'group' ? 'group' : 'c2c';
      const targetId = str(target.targetId);
      if (!targetId) throw new Error('QQ 回复目标缺少 targetId');
      const msgId = str(target.msgId);
      try {
        await sdkBot.sendText({ scope, targetId, ...(msgId ? { msgId } : {}) }, text);
      } catch (error) {
        if (isQqAuthorizationError(error)) {
          markAuthExpired();
          throw new Error(QQ_AUTH_EXPIRED_MESSAGE);
        }
        if (isQqTransportError(error)) scheduleRestart();
        throw new Error(`QQ 机器人回复失败：${errorText(error)}`);
      }
    },
  };
}
