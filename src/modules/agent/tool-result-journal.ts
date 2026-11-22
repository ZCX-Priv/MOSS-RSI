// src/modules/agent/tool-result-journal.ts
// 工具结果 append-only 恢复日志（per session，NDJSON）。
//
// 目的：会话文件走防抖/原子写，工具结果在「产生 → 会话文件落盘」之间存在窗口。
// 进程崩溃、跨进程覆盖或误操作都会让结果永久消失（历史上被 heal 用错误占位覆盖）。
// 这里在工具返回的那一刻同步追加一条记录；启动加载会话时若发现结果缺失，
// 优先用 journal 里的真实结果恢复，只有 journal 也没有时才写错误占位。
//
// 清理时机：persistSession 同步落盘成功后截断（单实例锁保证不会被其他进程覆盖）；
// 进程崩溃/强杀时保留，供下次启动恢复。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ToolJournalRecord {
  v: 1;
  toolCallId: string;
  name?: string;
  content: string;
  isError?: boolean;
  images?: string[];
  metadata?: Record<string, unknown>;
  ts: string;
}

/** 工具结果的恢复所需最小消息结构（与 AgentMessage 兼容，不引入循环依赖） */
export interface JournalMessageLike {
  role: string;
  content: string;
  toolCallId?: string;
  name?: string;
  isError?: boolean;
  images?: string[];
  metadata?: Record<string, unknown>;
  timestamp?: string;
  toolCalls?: Array<{ id: string }>;
}

/** session.json → session.tools.ndjson（同目录，随任务移动） */
export function toolJournalPath(sessionFilePath: string): string {
  return sessionFilePath.endsWith('.json')
    ? `${sessionFilePath.slice(0, -'.json'.length)}.tools.ndjson`
    : `${sessionFilePath}.tools.ndjson`;
}

/** 同步追加一条工具结果；失败抛出由调用方记录日志 */
export function appendToolResultJournal(filePath: string, record: ToolJournalRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * 读取 journal：坏行/空行跳过，同一 toolCallId 后写覆盖前写。
 * 文件不存在返回空 Map。
 */
export function readToolResultJournal(filePath: string): {
  records: Map<string, ToolJournalRecord>;
  badLines: number;
} {
  const records = new Map<string, ToolJournalRecord>();
  let badLines = 0;
  if (!existsSync(filePath)) return { records, badLines };
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return { records, badLines: 1 };
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<ToolJournalRecord>;
      if (
        parsed &&
        parsed.v === 1 &&
        typeof parsed.toolCallId === 'string' &&
        parsed.toolCallId !== '' &&
        typeof parsed.content === 'string'
      ) {
        records.set(parsed.toolCallId, {
          v: 1,
          toolCallId: parsed.toolCallId,
          content: parsed.content,
          ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
          ...(parsed.isError === true ? { isError: true } : {}),
          ...(Array.isArray(parsed.images) ? { images: parsed.images.filter(v => typeof v === 'string') } : {}),
          ...(parsed.metadata && typeof parsed.metadata === 'object'
            ? { metadata: parsed.metadata as Record<string, unknown> }
            : {}),
          ts: typeof parsed.ts === 'string' ? parsed.ts : new Date(0).toISOString(),
        });
      } else {
        badLines++;
      }
    } catch {
      badLines++;
    }
  }
  return { records, badLines };
}

/** 截断 journal（会话已安全落盘） */
export function clearToolResultJournal(filePath: string): void {
  try {
    if (existsSync(filePath)) writeFileSync(filePath, '', 'utf8');
  } catch {
    // 清理失败不影响正确性：下次 persistSession 会再次尝试
  }
}

/** 会话文件移动时同步搬 journal */
export function moveToolResultJournal(fromSessionFilePath: string, toSessionFilePath: string): void {
  const from = toolJournalPath(fromSessionFilePath);
  if (!existsSync(from)) return;
  const to = toolJournalPath(toSessionFilePath);
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  } catch {
    // 跨盘/目标被占用：保留旧路径，恢复能力不因移动而丢失
  }
}

/** 会话删除时删除 journal */
export function removeToolResultJournal(sessionFilePath: string): void {
  const filePath = toolJournalPath(sessionFilePath);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // 删除失败留下孤儿文件，不影响会话
  }
}

/**
 * 用 journal 恢复缺失的工具结果（就地修改 messages）。
 * 插入位置与 addToolMessage 一致：所属 assistant 之后的连续 tool 结果末尾。
 * @returns 恢复的条数
 */
export function recoverDanglingFromJournal(
  messages: JournalMessageLike[],
  records: Map<string, ToolJournalRecord>,
): number {
  if (records.size === 0) return 0;
  const existing = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && typeof m.toolCallId === 'string') existing.add(m.toolCallId);
  }

  let recovered = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.toolCalls || m.toolCalls.length === 0) continue;
    for (const tc of m.toolCalls) {
      if (existing.has(tc.id)) continue;
      const record = records.get(tc.id);
      if (!record) continue;
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') j++;
      messages.splice(j, 0, {
        role: 'tool',
        content: record.content,
        toolCallId: tc.id,
        ...(record.name ? { name: record.name } : {}),
        ...(record.isError ? { isError: true } : {}),
        ...(record.images && record.images.length > 0 ? { images: record.images } : {}),
        metadata: {
          ...(record.metadata ?? {}),
          recoveredFromJournal: true,
          originalTimestamp: record.ts,
        },
        timestamp: new Date().toISOString(),
      });
      existing.add(tc.id);
      recovered++;
    }
  }
  return recovered;
}
