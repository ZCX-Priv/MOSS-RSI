// src/modules/im/adapters/wechat-ilink.ts
// 微信（iLink）：扫码登录后以「微信机器人身份」收发私聊消息。
// 说明：iLink 得到的是机器人身份，不是个人微信号；普通微信群通常无法邀请加入。
// 协议：notifystart → getupdates（长轮询）→ sendmessage；notifystop 下线。

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
import { asRecord, errorText, fetchBuffer, fetchJson, HttpError, sleep, str } from './util';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com/';
const PROTOCOL_VERSION = '2.4.6';
const LONG_POLL_TIMEOUT_MS = 35_000;
const NOTIFY_TIMEOUT_MS = 10_000;
const START_RETRY_DELAYS_MS = [250, 1_000, 3_000];
const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const STALE_TOKEN_MESSAGE = '微信登录凭据已失效，请重新扫码接入';
const TYPING_KEEPALIVE_MS = 5_000;
const TYPING_REQUEST_TIMEOUT_MS = 10_000;
const TYPING_STOP_TIMEOUT_MS = 5_000;

interface WechatTypingEntry {
  ticket: string;
  timer: ReturnType<typeof setTimeout> | null;
}

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

/** ret/errcode 任一非 0 即视为上游拒绝；-14 表示登录凭据失效 */
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

function rejectionMessage(value: Record<string, unknown> | null, code: string, prefix: string): string {
  return `${prefix}：${str(value?.errmsg) || `错误码 ${code}`}`;
}

/** 仅网络错误、超时与 408/425/429/5xx 可重试（启动通知） */
function retryableStartError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error && error.name === 'AbortError') return true;
  return error instanceof TypeError;
}

function backoffMs(failures: number): number {
  return Math.min(30_000, 1_000 * (2 ** Math.min(failures - 1, 4)));
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

/** item_list → 统一消息段（文本 / 语音转写 / 图片 / 文件） */
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
    if (entry.type === 3) {
      const transcript = str(asRecord(entry.voice_item)?.text);
      if (transcript) segments.push({ type: 'text', text: transcript });
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
  let typingClosed = false;
  const typingEntries = new Map<string, WechatTypingEntry>();
  const typingQueues = new Map<string, Promise<void>>();

  /** 凭据只用于「对方正在输入」；失败全部降级为日志，不影响消息收发 */
  const fetchTypingTicket = async (toUserId: string, contextToken: string): Promise<string> => {
    const response = asRecord(
      await fetchJson(
        `${baseUrl}ilink/bot/getconfig`,
        {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({
            ilink_user_id: toUserId,
            ...(contextToken ? { context_token: contextToken } : {}),
            base_info: baseInfo(),
          }),
        },
        TYPING_REQUEST_TIMEOUT_MS,
        signal,
      ),
    );
    const code = rejectedCode(response);
    if (code) throw new Error(rejectionMessage(response, code, '微信正在输入凭证获取失败'));
    const ticket = str(response?.typing_ticket);
    if (!ticket) throw new Error('微信未返回正在输入凭证');
    return ticket;
  };

  const sendTypingStatus = async (
    toUserId: string,
    ticket: string,
    status: 1 | 2,
    timeoutMs: number,
    useAdapterSignal: boolean,
  ): Promise<void> => {
    const response = asRecord(
      await fetchJson(
        `${baseUrl}ilink/bot/sendtyping`,
        {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({
            ilink_user_id: toUserId,
            typing_ticket: ticket,
            status,
            base_info: baseInfo(),
          }),
        },
        timeoutMs,
        useAdapterSignal ? signal : undefined,
      ),
    );
    const code = rejectedCode(response);
    if (code) throw new Error(rejectionMessage(response, code, '微信正在输入状态更新失败'));
  };

  /** 同一用户的启动/停止串行执行，避免 status 1 与 2 乱序 */
  const queueTyping = (toUserId: string, operation: () => Promise<void>): Promise<void> => {
    const previous = typingQueues.get(toUserId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    const tracked = task.catch(() => undefined);
    typingQueues.set(toUserId, tracked);
    void tracked.finally(() => {
      if (typingQueues.get(toUserId) === tracked) typingQueues.delete(toUserId);
    });
    return task;
  };

  const scheduleTyping = (toUserId: string, entry: WechatTypingEntry): void => {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void queueTyping(toUserId, async () => {
        if (typingClosed || stopped || typingEntries.get(toUserId) !== entry) return;
        try {
          await sendTypingStatus(toUserId, entry.ticket, 1, TYPING_REQUEST_TIMEOUT_MS, true);
          if (typingClosed || stopped || typingEntries.get(toUserId) !== entry) return;
          scheduleTyping(toUserId, entry);
        } catch (error) {
          if (typingEntries.get(toUserId) === entry) typingEntries.delete(toUserId);
          if (!typingClosed && !stopped) {
            logger.warn('im: 微信正在输入心跳失败', { botId: bot.botId, error: errorText(error) });
          }
        }
      });
    }, TYPING_KEEPALIVE_MS);
  };

  const startTypingFor = async (toUserId: string, contextToken: string): Promise<void> => {
    if (typingClosed || stopped) return;
    const existing = typingEntries.get(toUserId);
    let ticket = existing?.ticket ?? '';
    try {
      if (!ticket) ticket = await fetchTypingTicket(toUserId, contextToken);
      if (typingClosed || stopped) return;
      await sendTypingStatus(toUserId, ticket, 1, TYPING_REQUEST_TIMEOUT_MS, true);
    } catch (error) {
      if (existing?.timer) clearTimeout(existing.timer);
      if (existing && typingEntries.get(toUserId) === existing) typingEntries.delete(toUserId);
      if (!typingClosed && !stopped) {
        logger.warn('im: 微信正在输入启动失败', { botId: bot.botId, error: errorText(error) });
      }
      return;
    }
    if (typingClosed || stopped) return;
    if (existing?.timer) clearTimeout(existing.timer);
    const entry: WechatTypingEntry = { ticket, timer: null };
    typingEntries.set(toUserId, entry);
    scheduleTyping(toUserId, entry);
  };

  const stopTypingFor = async (toUserId: string): Promise<void> => {
    const entry = typingEntries.get(toUserId);
    if (!entry) return;
    typingEntries.delete(toUserId);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      await sendTypingStatus(toUserId, entry.ticket, 2, TYPING_STOP_TIMEOUT_MS, false);
    } catch (error) {
      logger.warn('im: 微信正在输入取消失败', { botId: bot.botId, error: errorText(error) });
    }
  };

  const notifyStart = async (): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw new Error('微信连接已停止');
      try {
        const response = asRecord(
          await fetchJson(
            `${baseUrl}ilink/bot/msg/notifystart`,
            { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ base_info: baseInfo() }) },
            NOTIFY_TIMEOUT_MS,
          ),
        );
        const code = rejectedCode(response);
        if (code) {
          if (code === '-14') throw new Error(STALE_TOKEN_MESSAGE);
          throw new Error(rejectionMessage(response, code, '微信连接启动失败'));
        }
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          throw new Error(STALE_TOKEN_MESSAGE);
        }
        const wait = START_RETRY_DELAYS_MS[attempt];
        if (wait === undefined || !retryableStartError(error)) throw error;
        logger.warn('im: 微信上线通知失败，准备重试', {
          botId: bot.botId,
          error: errorText(error),
        });
        await sleep(wait, signal);
      }
    }
  };

  const notifyStop = async (): Promise<void> => {
    try {
      const response = asRecord(
        await fetchJson(
          `${baseUrl}ilink/bot/msg/notifystop`,
          { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ base_info: baseInfo() }) },
          NOTIFY_TIMEOUT_MS,
        ),
      );
      const code = rejectedCode(response);
      if (code) {
        logger.warn('im: 微信下线通知未被确认', { botId: bot.botId, code });
      }
    } catch (error) {
      logger.warn('im: 微信下线通知失败', { botId: bot.botId, error: errorText(error) });
    }
  };

  const pollLoop = async (): Promise<void> => {
    let failures = 0;
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
        const code = rejectedCode(response);
        if (code) {
          if (code === '-14') {
            onStatus({ connected: false, lastError: STALE_TOKEN_MESSAGE });
            return;
          }
          failures += 1;
          onStatus({
            connected: false,
            lastError: rejectionMessage(response, code, '微信消息同步被拒绝'),
          });
          await sleep(backoffMs(failures), signal);
          continue;
        }
        failures = 0;
        onStatus({ connected: true, lastError: null });
        const nextCursor = str(response?.get_updates_buf);
        if (nextCursor) cursor?.set(nextCursor);
        const messages = Array.isArray(response?.msgs) ? response.msgs : [];
        for (const raw of messages) {
          const message = asRecord(raw);
          if (!message) continue;
          if (message.message_type === 2) continue; // 自己发出的消息回显
          const senderId = str(message.from_user_id);
          const messageId = str(message.message_id) || str(message.msg_id) || str(message.client_id) || randomUUID();
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
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          onStatus({ connected: false, lastError: STALE_TOKEN_MESSAGE });
          return;
        }
        // 35s 长轮询自身超时：本轮无新消息，保持连接
        if (error instanceof Error && error.name === 'AbortError') {
          failures = 0;
          onStatus({ connected: true, lastError: null });
          continue;
        }
        failures += 1;
        onStatus({ connected: false, lastError: errorText(error) });
        await sleep(backoffMs(failures), signal);
      }
    }
  };

  return {
    async start() {
      if (!token) throw new Error('微信凭据缺失，请重新扫码接入');
      await notifyStart();
      onStatus({ connected: true, lastError: null });
      void pollLoop();
      logger.info('im: 微信长轮询已启动', { botId: bot.botId });
    },

    async stop() {
      stopped = true;
      typingClosed = true;
      for (const [toUserId, entry] of typingEntries) {
        if (entry.timer) clearTimeout(entry.timer);
        void sendTypingStatus(toUserId, entry.ticket, 2, TYPING_STOP_TIMEOUT_MS, false).catch(() => undefined);
      }
      typingEntries.clear();
      typingQueues.clear();
      await notifyStop();
      onStatus({ connected: false });
    },

    async setTyping(target: ImReplyTarget, active: boolean) {
      const toUserId = str(target.userId);
      if (!toUserId || typingClosed || stopped) return;
      const contextToken = str(target.contextToken);
      if (!active) {
        await queueTyping(toUserId, () => stopTypingFor(toUserId));
        return;
      }
      await queueTyping(toUserId, () => startTypingFor(toUserId, contextToken));
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
      const code = rejectedCode(response);
      if (code) {
        throw new Error(rejectionMessage(response, code, '微信回复失败'));
      }
    },
  };
}
