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

interface QQTarget {
  scope: 'c2c' | 'group';
  targetId: string;
  msgId?: string;
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

interface QQBotLike {
  on(event: 'ready', handler: (data: unknown) => void): QQBotLike;
  on(event: 'resumed', handler: (data: unknown) => void): QQBotLike;
  on(event: 'error', handler: (error: Error) => void): QQBotLike;
  on(event: 'message', handler: (ctx: unknown, message: QQInbound) => void | Promise<void>): QQBotLike;
  start(signal?: AbortSignal): Promise<void>;
  stop(): void;
  sendText(target: QQTarget, content: string): Promise<unknown>;
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
  label: 'QQ 机器人（官方）',
  guide:
    '在 QQ 开放平台创建机器人，获取 AppID 与 AppSecret；事件订阅选择 WebSocket，并为机器人申请群聊/C2C 消息权限。填好后点「添加」。',
  fields: [
    { key: 'appId', label: 'AppID', type: 'text', required: true },
    { key: 'appSecret', label: 'AppSecret', type: 'password', required: true },
  ],
  capabilities: { markdown: false, group: true, qrLogin: false },
  async verify(credentials) {
    const appId = str(credentials.appId);
    const appSecret = str(credentials.appSecret);
    if (!appId || !appSecret) throw new Error('AppID 与 AppSecret 必填');
    const response = asRecord(
      await fetchJson('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
      }),
    );
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

  return {
    async start() {
      const sdk = (await import('@tencent-connect/qqbot-nodejs')) as unknown as QQModule;
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
      instance.on('ready', () => {
        onStatus({ connected: true, lastError: null });
        settle?.();
      });
      instance.on('resumed', () => {
        onStatus({ connected: true, lastError: null });
        settle?.();
      });
      instance.on('error', (error: Error) => {
        onStatus({ connected: false, lastError: errorText(error) });
        settle?.(new Error(`QQ 机器人连接失败：${errorText(error)}`));
      });
      instance.on('message', handleMessage);
      // start 会挂到连接关闭，不能 await；失败通过 ready/error 暴露
      void instance.start(signal).catch((error: unknown) => {
        onStatus({ connected: false, lastError: errorText(error) });
        settle?.(new Error(`QQ 机器人连接失败：${errorText(error)}`));
      });
      await ready;
      logger.info('im: QQ 机器人网关已连接', { botId: bot.botId });
    },

    async stop() {
      try {
        sdkBot?.stop();
      } catch {
        // 忽略
      }
      sdkBot = null;
      onStatus({ connected: false });
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
        throw new Error(`QQ 机器人回复失败：${errorText(error)}`);
      }
    },
  };
}
