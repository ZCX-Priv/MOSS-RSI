// src/modules/migration/adapters/convert.ts
// 外部会话 → MOSS Session 的统一构造。
// 两条导入链路（外部 Agent / MOSS 备份）最终都产出同一结构，由 engine.importSessions 落盘。

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Session } from '../../agent/session';
import type { ExternalTranscript } from './types';

export interface ConvertedSession {
  session: Session;
  title: string;
  /** 目标分组名（按工作目录 basename；无 cwd 时用「导入 · <来源>」） */
  groupName: string;
}

/** 分组名：cwd 的末级目录名（与 MOSS folder 分组的命名口径一致） */
export function groupNameOf(cwd: string | undefined, fallbackLabel: string): string {
  if (!cwd) return `导入 · ${fallbackLabel}`;
  const name = basename(cwd.replace(/[\\/]+$/, ''));
  // 根目录（如 C:\）basename 为空，退回来源名
  return name || `导入 · ${fallbackLabel}`;
}

/** 构建可直接写入 SessionStore 的会话对象 */
export function convertTranscript(transcript: ExternalTranscript, sourceLabel: string): ConvertedSession {
  const { meta, messages } = transcript;
  const session: Session = {
    id: randomUUID(),
    messages,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    totalTokens: 0,
    contextFiles: [],
    ...(meta.cwd ? { lastCwd: meta.cwd } : {}),
  };
  return {
    session,
    title: meta.title,
    groupName: groupNameOf(meta.cwd, sourceLabel),
  };
}
