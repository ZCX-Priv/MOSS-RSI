// src/modules/im/segments.ts
// 统一消息段工具：段 → 文本、媒体收集、计数。
// 适配器只负责产出段；如何变文本/附件由这里和 gateway 统一决定。

import type { ImMediaRef, ImSegment } from './types';

/** 把消息段拍平成可读文本（命令解析、无附件时的 prompt） */
export function segmentsToText(segments: ImSegment[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        parts.push(segment.text);
        break;
      case 'at':
        parts.push(`@${segment.displayName || segment.userId}`);
        break;
      case 'face':
        parts.push('[表情]');
        break;
      case 'reply':
        parts.push(`[回复 ${segment.messageId}]`);
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'file':
        parts.push(`[文件: ${segment.name}]`);
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'audio':
        parts.push(segment.transcript ? `[语音] ${segment.transcript}` : '[语音]');
        break;
      case 'forward':
        parts.push(`[合并转发${segment.title ? `: ${segment.title}` : ''}]`);
        break;
      default:
        parts.push('[消息]');
    }
  }
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** 按出现顺序收集媒体引用 */
export function takeMedia(segments: ImSegment[]): ImMediaRef[] {
  const media: ImMediaRef[] = [];
  const walk = (list: ImSegment[]): void => {
    for (const segment of list) {
      if (segment.type === 'image' || segment.type === 'file' || segment.type === 'video' || segment.type === 'audio') {
        media.push(segment.media);
      }
      if (segment.type === 'forward') {
        for (const node of segment.nodes) walk(node);
      }
    }
  };
  walk(segments);
  return media;
}

export function hasMedia(segments: ImSegment[]): boolean {
  return takeMedia(segments).length > 0;
}

export function countSegments(segments: ImSegment[]): number {
  let count = 0;
  const walk = (list: ImSegment[]): void => {
    for (const segment of list) {
      count += 1;
      if (segment.type === 'forward') {
        for (const node of segment.nodes) walk(node);
      }
    }
  };
  walk(segments);
  return count;
}

/** 构造单个文本段的便捷函数（适配器常用） */
export function textSegments(text: string): ImSegment[] {
  const trimmed = text.trim();
  return trimmed ? [{ type: 'text', text: trimmed }] : [];
}
