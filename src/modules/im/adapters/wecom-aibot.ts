// src/modules/im/adapters/wecom-aibot.ts
// 企业微信智能机器人：官方 @wecom/aibot-node-sdk 的 WebSocket 长连接。
// 前置条件（企业微信管理后台）：创建「智能机器人」→ 选择 API 模式 → 使用长连接 → 拿 Bot ID 与 Secret。

import type {
  ImAdapterContext,
  ImChannelAdapter,
  ImChannelDescriptor,
  ImInboundMessage,
  ImReplyTarget,
} from '../types';
import { segmentsToText } from '../segments';
import type { ImMediaRef, ImSegment } from '../types';
import { asRecord, errorText, str } from './util';

interface WecomFrame {
  headers?: { req_id?: string };
  body?: Record<string, unknown>;
}

interface WecomClient {
  connect(): WecomClient;
  disconnect(): void;
  on(event: 'message', handler: (frame: WecomFrame) => void): WecomClient;
  on(event: 'authenticated', handler: () => void): WecomClient;
  on(event: 'disconnected', handler: (reason: string) => void): WecomClient;
  on(event: 'reconnecting', handler: (attempt: number) => void): WecomClient;
  on(event: 'error', handler: (error: Error) => void): WecomClient;
  sendMessage(chatId: string, body: Record<string, unknown>): Promise<unknown>;
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
}

interface WecomModule {
  WSClient: new (options: Record<string, unknown>) => WecomClient;
}

function silentLogger(ctx: ImAdapterContext) {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (...args: unknown[]) => ctx.logger.warn(`[wecom-aibot] ${args.map(String).join(' ')}`),
    error: (...args: unknown[]) => ctx.logger.error(`[wecom-aibot] ${args.map(String).join(' ')}`),
  };
}

export const descriptor: ImChannelDescriptor = {
  id: 'wecom-aibot',
  label: '企业微信智能机器人',
  guide:
    '在企业微信管理后台创建「智能机器人」→ 创建方式选择「API 模式」→ 连接方式选择「使用长连接」→ 复制 Bot ID 并获取 Secret 填到下面。',
  fields: [
    { key: 'botId', label: 'Bot ID', type: 'text', required: true },
    { key: 'secret', label: 'Secret', type: 'password', required: true },
  ],
  capabilities: { markdown: true, group: true, qrLogin: false },
  async verify(credentials) {
    const botId = str(credentials.botId);
    const secret = str(credentials.secret);
    if (!botId || !secret) throw new Error('Bot ID 与 Secret 必填');
    const sdk = (await import('@wecom/aibot-node-sdk')) as unknown as WecomModule;
    const client = new sdk.WSClient({
      botId,
      secret,
      maxReconnectAttempts: 0,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('企业微信长连接认证超时（20s）')), 20_000);
      client.on('authenticated', () => {
        clearTimeout(timer);
        resolve();
      });
      client.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(new Error(`企业微信连接失败：${errorText(error)}`));
      });
      try {
        client.connect();
      } catch (error) {
        clearTimeout(timer);
        reject(new Error(`企业微信连接失败：${errorText(error)}`));
      }
    }).finally(() => {
      try {
        client.disconnect();
      } catch {
        // 校验用连接，断开失败忽略
      }
    });
    return { platformId: botId, name: `企微机器人 ${botId.slice(-4)}` };
  },
};

export function createAdapter(ctx: ImAdapterContext): ImChannelAdapter {
  const { bot, logger, onMessage, onStatus } = ctx;
  const botId = str(bot.credentials.botId);
  const secret = str(bot.credentials.secret);

  let client: WecomClient | null = null;
  let stopped = false;

  /** 企微媒体（image/file/video）：url + aeskey，SDK 负责下载解密 */
  const mediaRef = (content: unknown, kind: ImMediaRef['kind'], name?: string): ImMediaRef | null => {
    const record = asRecord(content);
    const url = str(record?.url);
    if (!url || !client) return null;
    const aesKey = str(record?.aeskey) || undefined;
    return {
      kind,
      name,
      load: async () => {
        const result = await client?.downloadFile(url, aesKey);
        if (!result?.buffer) throw new Error('企业微信未返回文件内容');
        return result.buffer;
      },
    };
  };

  const handleFrame = (frame: WecomFrame): void => {
    if (stopped) return;
    const body = asRecord(frame.body);
    if (!body) return;
    const messageId = str(body.msgid);
    const senderId = str(asRecord(body.from)?.userid);
    const chattype = str(body.chattype) || (str(body.chatid) ? 'group' : 'single');
    const chatId = chattype === 'group' ? str(body.chatid) : senderId;
    if (!messageId || !senderId || !chatId) return;

    const msgtype = str(body.msgtype);
    const segments: ImSegment[] = [];
    if (msgtype === 'text') {
      const text = str(asRecord(body.text)?.content);
      if (text) segments.push({ type: 'text', text });
    } else if (msgtype === 'voice') {
      const transcript = str(asRecord(body.voice)?.content);
      if (transcript) segments.push({ type: 'text', text: transcript });
    } else if (msgtype === 'image') {
      const media = mediaRef(body.image, 'image');
      if (media) segments.push({ type: 'image', media });
    } else if (msgtype === 'file') {
      const media = mediaRef(body.file, 'file', '文件');
      if (media) segments.push({ type: 'file', media, name: '文件' });
    } else if (msgtype === 'video') {
      const media = mediaRef(body.video, 'video');
      if (media) segments.push({ type: 'video', media });
    } else if (msgtype === 'mixed') {
      const items = asRecord(body.mixed)?.msg_item;
      if (Array.isArray(items)) {
        for (const item of items) {
          const entry = asRecord(item);
          if (str(entry?.msgtype) === 'text') {
            const text = str(asRecord(entry?.text)?.content);
            if (text) segments.push({ type: 'text', text });
          } else if (str(entry?.msgtype) === 'image') {
            const media = mediaRef(entry?.image, 'image');
            if (media) segments.push({ type: 'image', media });
          }
        }
      }
    }
    // 群聊回调保留触发时的 @机器人 前缀，属于路由信息而非用户提问
    if (chattype === 'group' && segments[0]?.type === 'text') {
      segments[0] = { type: 'text', text: segments[0].text.replace(/^\s*@\S+(?:\s+|$)/u, '').trim() };
    }

    const inbound: ImInboundMessage = {
      botId: bot.botId,
      channel: 'wecom-aibot',
      messageId,
      conversationKey: chattype === 'group' ? `group:${chatId}` : `direct:${senderId}`,
      kind: chattype === 'group' ? 'group' : 'direct',
      senderId,
      senderName: str(asRecord(body.from)?.name) || senderId.slice(-6),
      segments,
      text: segmentsToText(segments),
      // 企微群聊回调只在 @机器人 时才下发，因此送达即视为已寻址
      addressed: true,
      replyTarget: { channel: 'wecom-aibot', kind: chattype === 'group' ? 'group' : 'direct', chatId },
      receivedAt: new Date().toISOString(),
    };
    onMessage(inbound);
  };

  return {
    async start() {
      const sdk = (await import('@wecom/aibot-node-sdk')) as unknown as WecomModule;
      client = new sdk.WSClient({
        botId,
        secret,
        maxReconnectAttempts: 10,
        logger: silentLogger(ctx),
      });
      client.on('message', handleFrame);
      client.on('authenticated', () => onStatus({ connected: true, lastError: null }));
      client.on('disconnected', () => onStatus({ connected: false }));
      client.on('reconnecting', () => onStatus({ connected: false }));
      client.on('error', (error: Error) => onStatus({ connected: false, lastError: errorText(error) }));
      client.connect();
      logger.info('im: 企业微信长连接已发起', { botId: bot.botId });
    },

    async stop() {
      stopped = true;
      try {
        client?.disconnect();
      } catch {
        // 忽略
      }
      client = null;
      onStatus({ connected: false });
    },

    async sendText(target: ImReplyTarget, text: string) {
      if (!client) throw new Error('企业微信适配器尚未启动');
      const chatId = str(target.chatId);
      if (!chatId) throw new Error('企业微信回复目标缺少 chatId');
      try {
        await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: text } });
      } catch (error) {
        throw new Error(`企业微信回复失败：${errorText(error)}`);
      }
    },
  };
}
