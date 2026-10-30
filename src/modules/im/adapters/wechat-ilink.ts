// src/modules/im/adapters/wechat-ilink.ts
// 微信（iLink）：扫码登录后以「微信机器人身份」收发私聊消息。
// 说明：iLink 得到的是机器人身份，不是个人微信号；普通微信群通常无法邀请加入。
// 协议：get_bot_qrcode → get_qrcode_status → getupdates（长轮询）→ sendmessage。

import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type {
  ImAdapterContext,
  ImChannelAdapter,
  ImChannelDescriptor,
  ImInboundMessage,
  ImMediaRef,
  ImReplyTarget,
  ImSegment,
} from '../types';
import { segmentsToText } from '../segments';
import { DEFAULT_BOT_NAME } from '../identity';
import { asRecord, errorText, fetchBuffer, fetchJson, sleep, str } from './util';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com/';
const PROTOCOL_VERSION = '2.4.6';
const LONG_POLL_TIMEOUT_MS = 35_000;
const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

function baseInfo(): Record<string, string> {
  return { channel_version: PROTOCOL_VERSION, bot_agent: 'MOSS/1.2.0' };
}

function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6),
  };
}

function authHeaders(token: string): Record<string, string> {
  return {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function resolveBaseUrl(value: string): string {
  const text = value.trim();
  if (!text) return DEFAULT_BASE_URL;
  return text.endsWith('/') ? text : `${text}/`;
}

/** iLink 媒体密钥：aeskey 十六进制，或 media.aes_key 的 base64 */
function parseMediaKey(item: Record<string, unknown>): Buffer | null {
  const direct = str(item.aeskey);
  if (/^[0-9a-fA-F]{32}$/.test(direct)) return Buffer.from(direct, 'hex');
  const encoded = str(asRecord(item.media)?.aes_key);
  if (!encoded) return null;
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length === 16) return buffer;
  if (buffer.length === 32 && /^[0-9a-fA-F]{32}$/.test(buffer.toString('ascii'))) {
    return Buffer.from(buffer.toString('ascii'), 'hex');
  }
  return null;
}

/** 媒体下载地址：加密切片参数或完整 URL */
function mediaUrlOf(item: Record<string, unknown>): string | null {
  const media = asRecord(item.media);
  const query = str(media?.encrypt_query_param);
  if (query) return `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(query)}`;
  const full = str(media?.full_url);
  return full || null;
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16 || ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error('微信加密数据或密钥无效');
  }
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** item_list → 统一消息段（文本 / 图片 / 文件） */
function segmentsFromItems(items: unknown): ImSegment[] {
  if (!Array.isArray(items)) return [];
  const segments: ImSegment[] = [];
  for (const item of items) {
    const entry = asRecord(item);
    if (!entry) continue;
    if (entry.type === 1) {
      const text = str(asRecord(entry.text_item)?.text);
      if (text) segments.push({ type: 'text', text });
      continue;
    }
    const imageItem = asRecord(entry.image_item);
    if (imageItem) {
      const url = mediaUrlOf(imageItem);
      const key = parseMediaKey(imageItem);
      if (url && key) {
        const media: ImMediaRef = {
          kind: 'image',
          name: 'image',
          load: async signal => {
            const ciphertext = await fetchBuffer(url, { signal });
            return decryptAesEcb(ciphertext, key);
          },
        };
        segments.push({ type: 'image', media });
      }
      continue;
    }
    const fileItem = asRecord(entry.file_item);
    if (fileItem) {
      const url = mediaUrlOf(fileItem);
      const key = parseMediaKey(fileItem);
      if (url && key) {
        const name = str(fileItem.file_name) || '文件';
        const declared = Number(fileItem.len);
        const media: ImMediaRef = {
          kind: 'file',
          name,
          ...(Number.isFinite(declared) && declared > 0 ? { size: declared } : {}),
          load: async signal => {
            const ciphertext = await fetchBuffer(url, { signal });
            return decryptAesEcb(ciphertext, key);
          },
        };
        segments.push({
          type: 'file',
          media,
          name,
          ...(Number.isFinite(declared) && declared > 0 ? { size: declared } : {}),
        });
      }
    }
  }
  return segments;
}

/** 二维码登录会话（轮询由前端驱动，服务端只保存状态） */
interface LoginSession {
  qrcode: string;
  qrUrl: string;
  baseUrl: string;
  createdAt: number;
  verifyCode: string;
  status: string;
  credentials?: { botToken: string; botId: string; ownerUserId: string };
  error?: string;
}

const LOGIN_TTL_MS = 10 * 60 * 1000;

export class WechatLoginManager {
  private readonly sessions = new Map<string, LoginSession>();

  async start(): Promise<{ loginId: string; qrUrl: string }> {
    this.cleanup();
    const response = asRecord(
      await fetchJson(
        `${DEFAULT_BASE_URL}ilink/bot/get_bot_qrcode?bot_type=3`,
        {
          method: 'POST',
          headers: commonHeaders(),
          body: JSON.stringify({ local_token_list: [] }),
        },
        10_000,
      ),
    );
    const qrcode = str(response?.qrcode);
    const qrUrl = str(response?.qrcode_img_content) || str(response?.qrcode_url);
    if (!qrcode || !qrUrl) throw new Error('微信服务没有返回二维码');
    const loginId = randomUUID();
    this.sessions.set(loginId, {
      qrcode,
      qrUrl,
      baseUrl: DEFAULT_BASE_URL,
      createdAt: Date.now(),
      verifyCode: '',
      status: 'wait',
    });
    return { loginId, qrUrl };
  }

  setVerifyCode(loginId: string, code: string): void {
    const session = this.sessions.get(loginId);
    if (!session) throw new Error('登录会话不存在或已过期');
    session.verifyCode = code.trim();
  }

  /** 拉取一次上游扫码状态（前端每 2s 调一次） */
  async poll(loginId: string): Promise<{
    status: string;
    message?: string;
    credentials?: { botToken: string; botId: string; ownerUserId: string };
  }> {
    const session = this.sessions.get(loginId);
    if (!session) return { status: 'expired', message: '登录会话已过期，请重新获取二维码' };
    if (Date.now() - session.createdAt > LOGIN_TTL_MS) {
      this.sessions.delete(loginId);
      return { status: 'expired', message: '二维码已过期，请重新获取' };
    }
    if (session.status === 'confirmed' && session.credentials) {
      return { status: 'confirmed', credentials: session.credentials };
    }
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`;
    if (session.verifyCode) endpoint += `&verify_code=${encodeURIComponent(session.verifyCode)}`;
    const response = asRecord(
      await fetchJson(`${session.baseUrl}${endpoint}`, { method: 'GET', headers: commonHeaders() }, LONG_POLL_TIMEOUT_MS),
    );
    const status = str(response?.status);
    if (!status) return { status: session.status, message: '微信服务未返回状态' };
    session.status = status;
    if (status === 'confirmed') {
      const botToken = str(response?.bot_token);
      const botId = str(response?.ilink_bot_id);
      const ownerUserId = str(response?.ilink_user_id);
      if (!botToken || !botId || !ownerUserId) {
        return { status: 'expired', message: '微信授权成功但返回的账号凭据不完整，请重试' };
      }
      session.credentials = { botToken, botId, ownerUserId };
      return { status: 'confirmed', credentials: session.credentials };
    }
    if (status === 'expired') {
      return { status, message: '二维码已过期，请重新获取' };
    }
    return { status };
  }

  cancel(loginId: string): void {
    this.sessions.delete(loginId);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > LOGIN_TTL_MS) this.sessions.delete(id);
    }
  }
}

export const descriptor: ImChannelDescriptor = {
  id: 'wechat-ilink',
  label: '微信',
  guide:
    '推荐扫码接入；也可以手动填写已有 iLink 凭据（Bot Token / Bot ID）。扫码得到的是微信机器人身份（不是个人微信号）：支持私聊与图片/文件接收；不支持朋友圈，普通微信群通常无法邀请加入。',
  fields: [
    {
      key: 'botToken',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: 'iLink 扫码返回的 bot_token',
    },
    { key: 'botId', label: 'Bot ID', type: 'text', required: true, placeholder: 'ilink_bot_id' },
    {
      key: 'ownerUserId',
      label: '所属用户 ID（可选）',
      type: 'text',
      required: false,
      placeholder: 'ilink_user_id',
    },
    {
      key: 'baseUrl',
      label: '服务地址（可选）',
      type: 'text',
      required: false,
      defaultValue: DEFAULT_BASE_URL,
    },
  ],
  capabilities: { markdown: false, group: false, qrLogin: true },
  async verify(credentials) {
    const botToken = str(credentials.botToken);
    const botId = str(credentials.botId);
    if (!botToken || !botId) throw new Error('Bot Token 与 Bot ID 必填');
    return { platformId: botId, name: DEFAULT_BOT_NAME };
  },
};

export function createAdapter(ctx: ImAdapterContext): ImChannelAdapter {
  const { bot, logger, signal, onMessage, onStatus, cursor } = ctx;
  const token = str(bot.credentials.botToken);
  const baseUrl = resolveBaseUrl(str(bot.credentials.baseUrl));
  const ownerUserId = str(bot.credentials.ownerUserId);

  let stopped = false;

  const pollLoop = async (): Promise<void> => {
    while (!stopped && !signal.aborted) {
      try {
        const response = asRecord(
          await fetchJson(
            `${baseUrl}ilink/bot/getupdates`,
            {
              method: 'POST',
              headers: authHeaders(token),
              body: JSON.stringify({ get_updates_buf: cursor?.get() ?? '', base_info: baseInfo() }),
            },
            LONG_POLL_TIMEOUT_MS,
            signal,
          ),
        );
        onStatus({ connected: true, lastError: null });
        const ret = response?.ret;
        if (typeof ret === 'number' && ret !== 0) {
          const message = str(response?.errmsg) || `微信服务返回错误码 ${ret}`;
          onStatus({ connected: false, lastError: message });
          if (ret === 401 || ret === 403) {
            onStatus({ lastError: '微信凭据已失效，请重新扫码接入' });
            return;
          }
          await sleep(3_000, signal);
          continue;
        }
        const nextCursor = str(response?.get_updates_buf);
        if (nextCursor) cursor?.set(nextCursor);
        const messages = Array.isArray(response?.msgs) ? response.msgs : [];
        for (const raw of messages) {
          const message = asRecord(raw);
          if (!message) continue;
          if (message.message_type === 2) continue; // 自己发出的消息回显
          const senderId = str(message.from_user_id);
          const messageId = str(message.msg_id) || str(message.client_id) || randomUUID();
          if (!senderId) continue;
          const segments = segmentsFromItems(message.item_list);
          if (segments.length === 0) continue;
          const text = segmentsToText(segments);
          const inbound: ImInboundMessage = {
            botId: bot.botId,
            channel: 'wechat-ilink',
            messageId,
            conversationKey: `direct:${senderId}`,
            kind: 'direct',
            senderId,
            senderName: senderId === ownerUserId ? '我' : senderId.slice(-6),
            segments,
            text,
            addressed: true,
            replyTarget: {
              channel: 'wechat-ilink',
              kind: 'direct',
              userId: senderId,
              contextToken: str(message.context_token),
            },
            receivedAt: new Date().toISOString(),
          };
          onMessage(inbound);
        }
      } catch (error) {
        if (stopped || signal.aborted) return;
        onStatus({ connected: false, lastError: errorText(error) });
        await sleep(3_000, signal);
      }
    }
  };

  return {
    async start() {
      if (!token) throw new Error('微信凭据缺失，请重新扫码接入');
      onStatus({ connected: true, lastError: null });
      void pollLoop();
      logger.info('im: 微信长轮询已启动', { botId: bot.botId });
    },

    async stop() {
      stopped = true;
      onStatus({ connected: false });
    },

    async sendText(target: ImReplyTarget, text: string) {
      const toUserId = str(target.userId);
      if (!toUserId) throw new Error('微信回复目标缺少 userId');
      const contextToken = str(target.contextToken);
      const response = asRecord(
        await fetchJson(
          `${baseUrl}ilink/bot/sendmessage`,
          {
            method: 'POST',
            headers: authHeaders(token),
            body: JSON.stringify({
              msg: {
                from_user_id: '',
                to_user_id: toUserId,
                client_id: `moss-weixin-${randomUUID()}`,
                message_type: 2,
                message_state: 2,
                item_list: [{ type: 1, text_item: { text } }],
                ...(contextToken ? { context_token: contextToken } : {}),
              },
              base_info: baseInfo(),
            }),
          },
          15_000,
        ),
      );
      const ret = response?.ret;
      if (typeof ret === 'number' && ret !== 0) {
        throw new Error(`微信回复失败：${str(response?.errmsg) || `错误码 ${ret}`}`);
      }
    },
  };
}
