// src/modules/context/compiler/tool-result-store.ts
// 大工具结果外置（CCR 式）：超过阈值的工具结果原文写入 ~/.moss/context/tools/，
// 发送视图只保留“头尾预览 + ref”，模型需要时用 context action=retrieve 取回。
// 目的：不让一次 20K tokens 的日志/文件读取在后续每一轮重复计费。
// 外置是“替换一次、永不回头”的确定性操作（同一份内容不会反复改写）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from '../../../core/types';
import type { ContextSessionLike, ToolResultStorageConfig } from '../types';
import { estimateTextTokens } from '../budgeter/estimator';
import { ensureSessionRefs } from '../refs';
import { recordExternalized } from '../store/context-store';

/** 外置文件的稳定路径（ref 只含 m+数字，天然安全） */
export function externalizedFilePath(env: Environment, sessionId: string, ref: string): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(env.dataDir, 'context', 'tools', safeSession, `${ref}.txt`);
}

function safeSlice(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start), Math.min(text.length, end));
}

/**
 * 扫描会话，把超过阈值的工具结果外置。返回是否有变更。
 * 只处理 role=tool、未删除、未压缩、尚未外置的消息。
 */
export function externalizeLargeToolResults(
  session: ContextSessionLike,
  env: Environment,
  config: ToolResultStorageConfig,
): boolean {
  if (!config.enabled || config.minTokens <= 0) return false;
  ensureSessionRefs(session);
  let changed = false;
  for (const m of session.messages) {
    if (m.role !== 'tool' || m.deletedAt || m.compacted) continue;
    if (!m.ref) continue;
    if (m.metadata?.externalized === true) continue;
    const tokens = estimateTextTokens(m.content);
    if (tokens < config.minTokens) continue;
    const previewBudget = config.headChars + config.tailChars + 200;
    if (m.content.length <= previewBudget) continue;

    const path = externalizedFilePath(env, session.id, m.ref);
    try {
      mkdirSync(join(env.dataDir, 'context', 'tools', session.id.replace(/[^a-zA-Z0-9._-]/g, '_')), {
        recursive: true,
      });
      writeFileSync(path, m.content, 'utf8');
      recordExternalized(env, {
        ref: m.ref,
        sessionId: session.id,
        path,
        tokens,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // 外置失败：保持原文，不阻断请求（下一次再试）
      continue;
    }

    const head = safeSlice(m.content, 0, config.headChars);
    const tail = safeSlice(m.content, m.content.length - config.tailChars, m.content.length);
    m.content =
      `[工具结果已外置 ref=${m.ref}，约 ${tokens} tokens。` +
      `用 context 工具 action=retrieve ref=${m.ref} 取回全文；本消息只保留头尾预览。]\n` +
      `--- 开头 ---\n${head}\n--- 结尾 ---\n${tail}`;
    m.metadata = {
      ...(m.metadata ?? {}),
      externalized: true,
      externalizedPath: path,
      externalizedTokens: tokens,
    };
    changed = true;
  }
  return changed;
}

/** 读取外置原文（供 context retrieve；按会话隔离） */
export function readExternalizedFile(record: { path: string }, maxChars = 120_000): string {
  const text = readFileSync(record.path, 'utf8');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[已截断，共 ${text.length} 字符]` : text;
}
