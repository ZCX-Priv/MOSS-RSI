// webui/src/components/shared/SessionArtifacts.tsx
// 会话末尾产物入口：
//   - 本轮文件变更汇总卡（文件数 + 增删行数），点击打开右侧「文件变更」面板；
//   - 本轮产出的文档卡片（pdf/office/markdown/图片等），点击打开文件预览。
// 数据源：GET /api/file-history/:sessionId（按时间过滤最后一个用户消息之后的条目）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, FileDiff } from 'lucide-react';
import { api } from '../../api/http';
import { wsClient } from '../../api/ws';
import { detectFileKind, fileNameOf } from '../../render/file/detector';
import { FileTypeIcon } from './FileTypeIcon';
import type { FileHistoryEntry, WSMessage } from '../../types/api';

export interface SessionArtifactsProps {
  sessionId: string;
  /** 本轮起点（最后一个用户消息的 ISO 时间戳） */
  sinceIso: string;
  onOpenChanges: () => void;
  onOpenFile: (path: string) => void;
}

/** 以文档/预览价值为主的文件类型（代码文件由 diff 汇总卡代表） */
const DOC_KINDS = new Set([
  'pdf',
  'office-docx',
  'office-xlsx',
  'office-pptx',
  'office-odf',
  'office-legacy',
  'ebook',
  'markdown',
  'text',
  'html',
  'data',
  'image',
  'latex',
]);

const MAX_DOC_CARDS = 4;

interface CountedFile {
  path: string;
  added: number;
  removed: number;
}

/** unified diff 行数统计（跳过文件头 ---/+++） */
function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

export function SessionArtifacts({
  sessionId,
  sinceIso,
  onOpenChanges,
  onOpenFile,
}: SessionArtifactsProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<FileHistoryEntry[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const resp = await api.listFileHistory(sessionId);
      setEntries(resp.entries);
    } catch {
      // 文件历史不可用：保持空列表，不打扰会话
    }
  }, [sessionId]);

  useEffect(() => {
    setEntries([]);
    void load();
  }, [load]);

  // 文件变更/撤回恢复 → 250ms 防抖刷新（与 FileChangesPanel 同口径）
  useEffect(() => {
    if (!sessionId) return;
    const schedule = (): void => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void load();
      }, 250);
    };
    const handle = (msg: WSMessage): void => {
      if (msg.sessionId !== sessionId) return;
      switch (msg.type) {
        case 'file-created':
        case 'file-edited':
        case 'file-deleted':
        case 'file-moved':
        case 'terminal-changed':
        case 'session-truncated':
        case 'session-restored':
          schedule();
          break;
        default:
          break;
      }
    };
    const unsub = wsClient.onMessage(handle);
    return () => {
      unsub();
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [sessionId, load]);

  const summary = useMemo(() => {
    const since = Date.parse(sinceIso);
    const from = Number.isFinite(since) ? since : 0;
    const byPath = new Map<string, CountedFile>();
    for (const entry of entries) {
      if (entry.toolName === 'rollback' || entry.rolledBackAt) continue;
      const ts = Date.parse(entry.timestamp);
      if (!Number.isFinite(ts) || ts < from) continue;
      const current = byPath.get(entry.absPath) ?? { path: entry.absPath, added: 0, removed: 0 };
      const counts = countDiff(entry.diff ?? '');
      current.added += counts.added;
      current.removed += counts.removed;
      byPath.set(entry.absPath, current);
    }
    const files = [...byPath.values()];
    const docs = files
      .filter((file) => DOC_KINDS.has(detectFileKind(file.path)))
      .slice(0, MAX_DOC_CARDS);
    return {
      files,
      docs,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
    };
  }, [entries, sinceIso]);

  if (summary.files.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-2">
      <button
        type="button"
        onClick={onOpenChanges}
        title={t('task.artifacts.openChanges')}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-card/40 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          <FileDiff className="size-4 text-primary-strong" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {t('task.artifacts.filesChanged', { count: summary.files.length })}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-success">
          +{summary.added}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-danger">
          -{summary.removed}
        </span>
        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {summary.docs.length > 0 && (
        <div className="flex max-w-full flex-wrap gap-2">
          {summary.docs.map((file) => {
            const name = fileNameOf(file.path);
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => onOpenFile(file.path)}
                title={file.path}
                className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-border bg-muted/40 px-2 py-1.5 text-left transition-colors hover:bg-muted"
              >
                <FileTypeIcon fileName={name} size={18} />
                <span className="max-w-[180px] truncate text-xs font-medium text-foreground">{name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
