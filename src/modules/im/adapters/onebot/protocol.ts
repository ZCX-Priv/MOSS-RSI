// src/modules/im/adapters/onebot/protocol.ts
// OneBot 11 协议层：请求/响应信封、消息段解析（数组或 CQ 字符串）、转换为统一消息段。

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ImInboundMessage, ImMediaRef, ImSegment } from '../../types';
import { segmentsToText } from '../../segments';
import { asRecord, idText, str } from '../util';

export interface OneBotResponse {
  status: 'ok' | 'failed';
  retcode: number;
  data?: unknown;
  message?: string;
  wording?: string;
  echo?: unknown;
}

export interface OneBotActionClient {
  call(action: string, params: Record<string, unknown>, echo?: unknown): Promise<OneBotResponse>;
  isConnected(): boolean;
}

export interface OneBotRawSegment {
  type: string;
  data: Record<string, unknown>;
}

interface OneBotEventBase {
  post_type?: string;
  [key: string]: unknown;
}

/** 统一响应信封（不同协议端字段缺失时给出合理默认） */
export function normalizeResponse(value: unknown): OneBotResponse {
  const record = asRecord(value);
  if (!record) {
    return { status: 'failed', retcode: 1400, message: '协议端返回了无法解析的响应' };
  }
  const status = record.status === 'ok' || record.status === 'async' ? 'ok' : 'failed';
  const retcode = typeof record.retcode === 'number' ? record.retcode : status === 'ok' ? 0 : 100;
  return {
    status,
    retcode,
    ...(record.data !== undefined ? { data: record.data } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof record.wording === 'string' ? { wording: record.wording } : {}),
    ...(record.echo !== undefined ? { echo: record.echo } : {}),
  };
}

export function okResponse(data: unknown, echo?: unknown): OneBotResponse {
  return { status: 'ok', retcode: 0, data, ...(echo !== undefined ? { echo } : {}) };
}

export function failedResponse(message: string, retcode = 100, echo?: unknown): OneBotResponse {
  return { status: 'failed', retcode, message, ...(echo !== undefined ? { echo } : {}) };
}

/** 解析 CQ 码字符串为消息段（兼容 post_format=string 的协议端） */
export function parseCqString(value: string): OneBotRawSegment[] {
  const segments: OneBotRawSegment[] = [];
  const pattern = /\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  const pushText = (text: string): void => {
    if (!text) return;
    segments.push({ type: 'text', data: { text } });
  };
  while ((match = pattern.exec(value)) !== null) {
    pushText(value.slice(cursor, match.index));
    const type = match[1] ?? '';
    const data: Record<string, unknown> = {};
    const params = match[2] ?? '';
    for (const pair of params.split(',')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const key = pair.slice(0, eq);
      const raw = pair.slice(eq + 1);
      data[key] = raw
        .replace(/&#91;/g, '[')
        .replace(/&#93;/g, ']')
        .replace(/&#44;/g, ',')
        .replace(/&amp;/g, '&');
    }
    segments.push({ type, data });
    cursor = match.index + match[0].length;
  }
  pushText(value.slice(cursor));
  return segments;
}

/** 消息字段 → 原始段数组（兼容数组与 CQ 字符串） */
export function rawSegmentsOf(message: Record<string, unknown>): OneBotRawSegment[] {
  const raw = message.message;
  if (Array.isArray(raw)) {
    const segments: OneBotRawSegment[] = [];
    for (const item of raw) {
      const record = asRecord(item);
      if (!record) continue;
      const data = asRecord(record.data) ?? {};
      segments.push({ type: str(record.type) || 'unknown', data });
    }
    return segments;
  }
  if (typeof raw === 'string' && raw) return parseCqString(raw);
  const rawMessage = str(message.raw_message);
  return rawMessage ? parseCqString(rawMessage) : [];
}

function mediaKindOf(segmentType: string): ImMediaRef['kind'] | null {
  if (segmentType === 'image') return 'image';
  if (segmentType === 'file') return 'file';
  if (segmentType === 'video') return 'video';
  if (segmentType === 'record') return 'audio';
  return null;
}

function localPathOf(file: string): string | null {
  const value = file.startsWith('file://') ? file.slice('file://'.length) : file;
  if (!isAbsolute(value)) return null;
  return existsSync(value) ? value : null;
}

async function fetchBuffer(url: string, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function readLocal(path: string): Promise<Buffer> {
  return readFile(path);
}

/**
 * 构造媒体引用：
 * - 优先 url 直接下载；
 * - 其次本地绝对路径（协议端与 MOSS 同机）；
 * - 最后调用 get_image / get_file 让协议端解析出 url/file。
 */
function createMediaRef(
  segmentType: string,
  data: Record<string, unknown>,
  call: OneBotActionClient,
): ImMediaRef | null {
  const kind = mediaKindOf(segmentType);
  if (!kind) return null;
  const url = str(data.url);
  const file = str(data.file);
  const name = str(data.name) || str(data.file_name) || file.split(/[/\\]/).pop() || undefined;
  const sizeNum = typeof data.file_size === 'number' ? data.file_size : Number(str(data.file_size));
  const size = Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : undefined;
  const mimeType = str(data.mime_type) || undefined;

  return {
    kind,
    name,
    size,
    mimeType,
    async load(signal?: AbortSignal): Promise<Buffer> {
      if (url) return fetchBuffer(url, signal);
      const local = file ? localPathOf(file) : null;
      if (local) return readLocal(local);
      if (kind === 'image' && file) {
        const result = await call.call('get_image', { file });
        const record = asRecord(result.data);
        const resolvedUrl = str(record?.url);
        if (resolvedUrl) return fetchBuffer(resolvedUrl, signal);
        const resolvedFile = str(record?.file);
        const resolvedPath = resolvedFile ? localPathOf(resolvedFile) : null;
        if (resolvedPath) return readLocal(resolvedPath);
        throw new Error('协议端未能解析图片地址');
      }
      if (file) {
        const result = await call.call('get_file', { file });
        const record = asRecord(result.data);
        const resolvedUrl = str(record?.url);
        if (resolvedUrl) return fetchBuffer(resolvedUrl, signal);
        const resolvedFile = str(record?.file);
        const resolvedPath = resolvedFile ? localPathOf(resolvedFile) : null;
        if (resolvedPath) return readLocal(resolvedPath);
        const base64 = str(record?.base64);
        if (base64) return Buffer.from(base64, 'base64');
        throw new Error('协议端未能解析文件内容');
      }
      throw new Error('消息段缺少可下载地址');
    },
  };
}

/** 原始段 → 统一段（媒体闭包由调用方注入 action client） */
export function toImSegments(raw: OneBotRawSegment[], call: OneBotActionClient): ImSegment[] {
  const segments: ImSegment[] = [];
  for (const segment of raw) {
    const data = segment.data;
    switch (segment.type) {
      case 'text': {
        const text = str(data.text);
        if (text) segments.push({ type: 'text', text });
        break;
      }
      case 'at': {
        const userId = idText(data.qq);
        if (userId) segments.push({ type: 'at', userId, displayName: str(data.name) || undefined });
        break;
      }
      case 'reply': {
        const messageId = idText(data.id);
        if (messageId) segments.push({ type: 'reply', messageId });
        break;
      }
      case 'face': {
        const id = idText(data.id);
        if (id) segments.push({ type: 'face', id });
        break;
      }
      case 'image':
      case 'video':
      case 'record': {
        const media = createMediaRef(segment.type, data, call);
        if (!media) break;
        if (segment.type === 'image') segments.push({ type: 'image', media });
        else if (segment.type === 'video') segments.push({ type: 'video', media });
        else segments.push({ type: 'audio', media });
        break;
      }
      case 'file': {
        const media = createMediaRef('file', data, call);
        if (media) {
          segments.push({
            type: 'file',
            media,
            name: str(data.name) || str(data.file_name) || media.name || '文件',
            ...(typeof data.file_size === 'number' ? { size: data.file_size } : {}),
          });
        }
        break;
      }
      case 'forward':
      case 'node': {
        const content = data.content;
        const nodes: ImSegment[][] = [];
        if (Array.isArray(content)) {
          for (const node of content) {
            const record = asRecord(node);
            const nodeContent = record?.content;
            if (Array.isArray(nodeContent)) {
              nodes.push(toImSegments(rawSegmentsOf({ message: nodeContent }), call));
            } else if (typeof nodeContent === 'string') {
              nodes.push(toImSegments(parseCqString(nodeContent), call));
            }
          }
        }
        segments.push({
          type: 'forward',
          title: str(data.title) || undefined,
          nodes,
        });
        break;
      }
      default:
        segments.push({ type: 'unknown', raw: segment });
    }
  }
  return segments;
}

/** 事件 → 统一入站消息（不是消息事件返回 null） */
export function toInboundMessage(
  event: OneBotEventBase,
  botId: string,
  channel: 'qq-onebot' | 'qq-official',
  selfId: string,
  call: OneBotActionClient,
): ImInboundMessage | null {
  if (str(event.post_type) !== 'message') return null;
  const messageType = str(event.message_type);
  if (messageType !== 'private' && messageType !== 'group') return null;
  const messageId = idText(event.message_id);
  const senderId = idText(event.user_id);
  if (!messageId || !senderId) return null;
  if (senderId === selfId) return null;

  const isGroup = messageType === 'group';
  const groupId = idText(event.group_id);
  if (isGroup && !groupId) return null;

  const sender = asRecord(event.sender);
  const senderName = str(sender?.card) || str(sender?.nickname) || senderId.slice(-6);
  const raw = rawSegmentsOf(event);
  const parsed = toImSegments(raw, call);
  const addressed = isGroup
    ? raw.some(segment => segment.type === 'at' && idText(segment.data.qq) === selfId)
    : true;
  // 群聊里 @机器人 属于路由信息，不进入 agent prompt；@其他人保留
  const segments = isGroup && selfId
    ? parsed.filter(segment => !(segment.type === 'at' && segment.userId === selfId))
    : parsed;
  const replySegment = segments.find(segment => segment.type === 'reply');

  return {
    botId,
    channel,
    messageId,
    conversationKey: isGroup ? `group:${groupId}` : `direct:${senderId}`,
    kind: isGroup ? 'group' : 'direct',
    senderId,
    senderName,
    segments,
    text: segmentsToText(segments),
    addressed,
    ...(replySegment && replySegment.type === 'reply'
      ? { replyTo: { messageId: replySegment.messageId } }
      : {}),
    replyTarget: {
      channel,
      kind: isGroup ? 'group' : 'direct',
      groupId: isGroup ? groupId : undefined,
      userId: senderId,
    },
    receivedAt: new Date().toISOString(),
  };
}

/** 文本消息 → OneBot 消息段（出站） */
export function textToOneBotSegments(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  return [{ type: 'text', data: { text } }];
}
