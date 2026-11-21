// src/modules/context/refs.ts
// 稳定消息引用（mNNNNN）：
// - 每条 session 消息在第一次被上下文引擎看见时分配 ref，并随 session 落盘；
// - ref 游标单调递增，物理折叠后绝不回退，保证编号永不复用（模型可以安全引用历史编号）；
// - 发送视图按 ref 渲染 <acp tokens type>ref</acp> 标签，让模型能指定压缩区间；
// - 工具调用参数绝不加标签（字节保真），只给消息正文加前缀。

import type { ContextMessage, ContextSessionLike } from './types';
import { estimateMessageTokens } from './budgeter/estimator';

const REF_PATTERN = /^m0*(\d{1,7})$/i;

export function formatRef(n: number): string {
  return `m${String(Math.max(1, Math.floor(n))).padStart(5, '0')}`;
}

export function parseRef(ref: string): number | null {
  const m = REF_PATTERN.exec(ref.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * 为会话中尚无 ref 的消息分配编号。幂等；返回是否有变更。
 * 会扫描已有 ref 的最大编号，避免恢复旧会话时游标回退导致编号复用。
 */
export function ensureSessionRefs(session: ContextSessionLike): boolean {
  let cursor = session.refCursor ?? 0;
  // 首次（无游标）扫描旧会话已有编号；之后游标即权威，避免每轮 O(n) 全量扫描
  if (cursor === 0) {
    for (const m of session.messages) {
      if (!m.ref) continue;
      const n = parseRef(m.ref);
      if (n !== null && n > cursor) cursor = n;
    }
  }
  let changed = false;
  for (const m of session.messages) {
    if (!m.ref) {
      cursor += 1;
      m.ref = formatRef(cursor);
      changed = true;
    }
  }
  if (session.refCursor !== cursor) {
    session.refCursor = cursor;
    changed = true;
  }
  return changed;
}

/** 消息类型（标签展示用） */
export function refMessageType(m: ContextMessage): string {
  if (m.role === 'tool') return `tool:${m.name || 'tool'}`;
  if (m.name) return m.name;
  return m.role;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${Math.round(tokens / 1000)}K`;
}

/**
 * 渲染消息的 ACP 标签行（带尾部换行）。没有 ref 的消息返回空串。
 * 标签是系统元数据，不落盘、不进入工具调用参数。
 */
export function renderRefTag(m: ContextMessage): string {
  if (!m.ref) return '';
  // 用剥掉旧标签后的正文计数，避免模型回声的标签被反复计入 tag token
  const clean: ContextMessage = { ...m, content: stripOwnRefTag(m.content, m.ref) };
  const tokens = estimateMessageTokens(clean);
  return `<acp tokens="${formatTokenCount(tokens)}" type="${refMessageType(m)}">${m.ref}</acp>\n`;
}

/** 去掉消息正文开头自己的旧标签（模型回声/重复渲染时保持幂等）。 */
export function stripOwnRefTag(content: string, ref: string | undefined): string {
  if (!ref) return content;
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^<acp\\b[^>]*>${escaped}</acp>\\n?`);
  return content.replace(re, '');
}

/** 查找 ref 在 session.messages 中的下标（不存在返回 -1）。 */
export function indexOfRef(session: ContextSessionLike, ref: string): number {
  const normalized = ref.trim().toLowerCase();
  return session.messages.findIndex(m => m.ref?.toLowerCase() === normalized);
}
