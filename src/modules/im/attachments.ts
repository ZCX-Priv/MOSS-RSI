// src/modules/im/attachments.ts
// 入站附件暂存：按消息批次落盘、限额、命名、过期清理，并生成给 agent 的文件清单。

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from '../../core/types';
import type { ImChannelId, ImMediaRef } from './types';

/** 单条消息最多处理的媒体数量 */
export const MAX_ATTACHMENTS = 8;
/** 单文件上限 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 单条消息合计上限 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 64 * 1024 * 1024;
/** 暂存目录保留天数 */
export const ATTACHMENT_RETENTION_DAYS = 7;

const DOWNLOAD_TIMEOUT_MS = 20_000;

export interface StagedAttachment {
  kind: 'image' | 'file' | 'video' | 'audio';
  /** 绝对路径 */
  path: string;
  name: string;
  mimeType?: string;
  size: number;
}

export interface SkippedAttachment {
  name: string;
  reason: string;
}

export interface StageResult {
  staged: StagedAttachment[];
  skipped: SkippedAttachment[];
  /** 本次批次目录（无附件时为 null） */
  directory: string | null;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function batchDirectoryName(now = new Date()): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** 安全文件名：去路径与控制字符，保留 Unicode 字母数字与 ._- 空格 */
export function safeFileName(value: string | undefined, fallback: string): string {
  const raw = (value ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = raw
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

/** 推断 mime：优先媒体声明，其次扩展名 */
export function guessMimeType(media: ImMediaRef, name: string): string | undefined {
  const declared = media.mimeType?.trim();
  if (declared) return declared;
  return MIME_BY_EXT[extensionOf(name)];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function downloadWithTimeout(media: ImMediaRef, signal: AbortSignal): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('附件下载超时')), DOWNLOAD_TIMEOUT_MS);
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await media.load(controller.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** 清理超过保留期的批次目录（只匹配时间戳命名的目录） */
export async function sweepInboundDirectories(dataDir: string, botId: string, logger: Logger): Promise<void> {
  const root = join(dataDir, 'im', 'inbound', botId);
  if (!existsSync(root)) return;
  const deadline = Date.now() - ATTACHMENT_RETENTION_DAYS * 24 * 3600 * 1000;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{8}-\d{6}-[0-9a-f]{6}$/.test(entry.name)) continue;
      const dir = join(root, entry.name);
      try {
        const info = await stat(dir);
        if (info.mtimeMs < deadline) await rm(dir, { recursive: true, force: true });
      } catch {
        // 单个目录清理失败不影响其他
      }
    }
  } catch (error) {
    logger.warn('im: 清理过期附件目录失败', {
      botId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 把一条消息里的媒体全部落盘。
 * 超限/下载失败只跳过该文件，不阻断整条消息。
 */
export async function stageAttachments(
  dataDir: string,
  botId: string,
  media: ImMediaRef[],
  signal: AbortSignal,
  logger: Logger,
): Promise<StageResult> {
  if (media.length === 0) return { staged: [], skipped: [], directory: null };

  await sweepInboundDirectories(dataDir, botId, logger);

  const botRoot = resolve(dataDir, 'im', 'inbound', botId);
  const directory = join(botRoot, batchDirectoryName());
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const staged: StagedAttachment[] = [];
  const skipped: SkippedAttachment[] = [];
  let totalBytes = 0;

  for (const [index, item] of media.entries()) {
    if (index >= MAX_ATTACHMENTS) {
      skipped.push({ name: item.name ?? `附件${index + 1}`, reason: `超过单条消息 ${MAX_ATTACHMENTS} 个附件限制` });
      continue;
    }
    if (signal.aborted) break;
    const fallback = `${item.kind}-${index + 1}`;
    const baseName = safeFileName(item.name, fallback);
    try {
      const bytes = await downloadWithTimeout(item, signal);
      if (bytes.length === 0) {
        skipped.push({ name: baseName, reason: '文件内容为空' });
        continue;
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        skipped.push({ name: baseName, reason: `超过单文件 ${formatBytes(MAX_ATTACHMENT_BYTES)} 限制` });
        continue;
      }
      if (totalBytes + bytes.length > MAX_TOTAL_ATTACHMENT_BYTES) {
        skipped.push({ name: baseName, reason: `超过单条消息 ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} 限制` });
        continue;
      }
      totalBytes += bytes.length;
      const name = `${String(index + 1).padStart(2, '0')}-${baseName}`;
      const path = join(directory, name);
      await writeFile(path, bytes, { mode: 0o600 });
      staged.push({
        kind: item.kind,
        path,
        name: baseName,
        size: bytes.length,
        mimeType: guessMimeType(item, baseName),
      });
    } catch (error) {
      skipped.push({
        name: baseName,
        reason: error instanceof Error ? error.message : String(error),
      });
      logger.warn('im: 附件下载失败', {
        botId,
        name: baseName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (staged.length === 0 && skipped.length === 0) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return { staged: [], skipped: [], directory: null };
  }
  return { staged, skipped, directory };
}

/** 生成给 agent 的附件清单文本（非图片文件靠它被工具读取） */
export function buildAttachmentList(staged: StagedAttachment[], skipped: SkippedAttachment[]): string {
  const lines: string[] = [];
  staged.forEach((item, index) => {
    const meta = [item.mimeType, formatBytes(item.size)].filter(Boolean).join(', ');
    lines.push(`${index + 1}. ${item.path}${meta ? ` (${meta})` : ''}`);
  });
  if (skipped.length > 0) {
    lines.push('未接收：');
    for (const item of skipped) lines.push(`- ${item.name}：${item.reason}`);
  }
  return lines.join('\n');
}

/** 把用户文本与附件清单拼成最终 userMessage */
export function buildPromptWithAttachments(
  text: string,
  staged: StagedAttachment[],
  skipped: SkippedAttachment[],
  channel: ImChannelId,
): string {
  const body = text.trim();
  if (staged.length === 0 && skipped.length === 0) return body;
  const list = buildAttachmentList(staged, skipped);
  const header = `[IM 附件 · ${channel}]`;
  if (!body) {
    return `请查看并处理下面的附件。\n\n${header}\n${list}`;
  }
  return `${body}\n\n${header}\n${list}`;
}
