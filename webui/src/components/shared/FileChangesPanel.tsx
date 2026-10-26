// components/shared/FileChangesPanel.tsx
// 文件变更面板（右侧面板「文件变更」标签）。
// 主视图 = 按文件聚合的「净差异」（会话第一条变更前 → 当前磁盘内容），视觉对齐 VS Code/Cursor：
//   - 顶部：目录名 + 文件数 + 总增删；
//   - 每个文件一张卡片：图标 + 文件名 + 目录 + +N -N；
//   - 卡片内 inline diff（双行号 / 红绿背景 / 「N 行已隐藏」折叠条）；
//   - 卡片底部可展开逐条历史（时间线）。
// 数据源 GET /api/file-history/:sessionId（entries + files）；实时刷新订阅文件/撤回 WS 事件。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  History,
  Loader2,
  RotateCw,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FileTypeIcon } from './FileTypeIcon';
import { DiffView } from './DiffView';
import { cn } from '@/lib/utils';
import { api } from '../../api/http';
import { wsClient } from '../../api/ws';
import { SYSTEM_WORKING_DIRECTORY } from '../../store';
import type { FileHistoryEntry, NetDiffReason, NetFileChange, WSMessage } from '../../types/api';

export interface FileChangesPanelProps {
  sessionId: string;
  /** 任务工作目录（顶部显示目录名；缺省显示「文件变更」） */
  workingDirectory?: string;
}

/** 文件名（跨平台分隔符） */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 父目录（跨平台分隔符）；无分隔符时返回空串 */
function dirName(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : '';
}

/** 历史条目操作类型 → i18n key（terminal-change / shell-change → 驼峰） */
function opKey(op: FileHistoryEntry['operation']): string {
  return `fileChanges.op.${op === 'terminal-change' || op === 'shell-change' ? 'terminalChange' : op}`;
}

/** 操作徽章配色 */
function opBadgeClass(op: FileHistoryEntry['operation'] | NetFileChange['operation']): string {
  if (op === 'create') return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
  if (op === 'delete') return 'bg-red-500/15 text-red-600 dark:text-red-400';
  if (op === 'move') return 'bg-sky-500/15 text-sky-600 dark:text-sky-400';
  return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
}

/** 无 diff 原因 → i18n key */
function reasonKey(reason: NetDiffReason | undefined): string {
  switch (reason) {
    case 'before-unavailable':
      return 'fileChanges.noDiffReason.beforeUnavailable';
    case 'after-unavailable':
      return 'fileChanges.noDiffReason.afterUnavailable';
    case 'binary':
      return 'fileChanges.noDiffReason.binary';
    case 'too-large':
      return 'fileChanges.noDiffReason.tooLarge';
    case 'directory':
      return 'fileChanges.noDiffReason.directory';
    case 'moved':
      return 'fileChanges.noDiffReason.moved';
    default:
      return 'fileChanges.noDiff';
  }
}

interface FileChangeCardProps {
  file: NetFileChange;
  /** 该文件的全部生效条目（已按时间倒序） */
  entries: FileHistoryEntry[];
  collapsed: boolean;
  historyOpen: boolean;
  onToggleCollapse: () => void;
  onToggleHistory: () => void;
}

function FileChangeCard({
  file,
  entries,
  collapsed,
  historyOpen,
  onToggleCollapse,
  onToggleHistory,
}: FileChangeCardProps) {
  const { t } = useTranslation();
  const name = baseName(file.absPath);
  const dir = dirName(file.absPath);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/50">
      {/* 卡片头：图标 + 文件名/目录 + 操作徽章 + 统计 */}
      <button
        type="button"
        title={file.absPath}
        onClick={onToggleCollapse}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            !collapsed && 'rotate-90',
          )}
        />
        <FileTypeIcon fileName={name} size={18} className="shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground">{name}</span>
            <span
              className={cn(
                'shrink-0 rounded px-1 py-px text-[10px] font-normal',
                opBadgeClass(file.operation),
              )}
            >
              {t(`fileChanges.op.${file.operation}`)}
            </span>
          </div>
          {dir && (
            <span className="truncate text-[10px] text-muted-foreground" title={dir}>
              {dir}
            </span>
          )}
        </div>
        <span className="shrink-0 text-[11px] tabular-nums">
          {file.added > 0 && <span className="text-emerald-500">+{file.added}</span>}
          {file.added > 0 && file.removed > 0 && ' '}
          {file.removed > 0 && <span className="text-destructive">-{file.removed}</span>}
        </span>
      </button>

      {/* 卡片体：inline diff / 无法生成原因 + 历史入口 */}
      {!collapsed && (
        <div className="border-t border-border/60">
          {file.diff ? (
            <DiffView diff={file.diff} maxHeight={420} />
          ) : (
            <div className="px-3 py-2 text-[10px] text-muted-foreground">
              {t(reasonKey(file.reason))}
            </div>
          )}

          {entries.length > 0 && (
            <div className="border-t border-border/60">
              <button
                type="button"
                onClick={onToggleHistory}
                className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/40"
              >
                <History className="size-3 shrink-0" />
                <span className="flex-1 text-left">
                  {t('fileChanges.historyCount', { count: file.entryCount })}
                </span>
                <ChevronDown
                  className={cn(
                    'size-3 shrink-0 transition-transform',
                    historyOpen && 'rotate-180',
                  )}
                />
              </button>
              {historyOpen && (
                <div className="flex flex-col gap-1 px-2.5 pb-2">
                  {entries.map((e) => (
                    <div key={e.id} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className={cn('shrink-0 rounded px-1 py-px', opBadgeClass(e.operation))}>
                        {t(opKey(e.operation))}
                      </span>
                      {e.toolName === 'watch' && (
                        <span className="shrink-0 text-sky-500">{t('fileChanges.op.watch')}</span>
                      )}
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={e.destPath ? `${e.absPath} → ${e.destPath}` : e.absPath}
                      >
                        {e.destPath ? `${e.absPath} → ${e.destPath}` : e.absPath}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {new Date(e.timestamp).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileChangesPanel({ sessionId, workingDirectory }: FileChangesPanelProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<FileHistoryEntry[] | null>(null);
  const [files, setFiles] = useState<NetFileChange[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 折叠的卡片路径（默认全部展开，与参考图一致） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** 展开历史时间线的卡片路径 */
  const [historyOpen, setHistoryOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    // 空白页（无任务 id）不发请求：/api/file-history/ 无有效段，会被路由判为 404
    if (!sessionId) {
      setEntries([]);
      setFiles([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await api.listFileHistory(sessionId);
      setEntries(resp.entries);
      setFiles(resp.files ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 实时刷新：文件变更 / 终端变更 / 消息撤回与恢复 → 250ms 防抖重新拉取
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
    // 兜底：页面重新可见时补一次（WS 断连期间可能丢事件）
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsub();
      document.removeEventListener('visibilitychange', onVisible);
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [sessionId, load]);

  /** 文件 → 生效条目（排除 R 条目与已回滚），按时间倒序 */
  const entriesByPath = useMemo(() => {
    const map = new Map<string, FileHistoryEntry[]>();
    for (const e of entries ?? []) {
      if (e.toolName === 'rollback' || e.rolledBackAt) continue;
      const list = map.get(e.absPath);
      if (list) list.push(e);
      else map.set(e.absPath, [e]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    }
    return map;
  }, [entries]);

  const totalAdded = useMemo(() => (files ?? []).reduce((sum, f) => sum + f.added, 0), [files]);
  const totalRemoved = useMemo(() => (files ?? []).reduce((sum, f) => sum + f.removed, 0), [files]);

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleHistory = useCallback((path: string) => {
    setHistoryOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const dirLabel =
    workingDirectory && workingDirectory !== SYSTEM_WORKING_DIRECTORY
      ? baseName(workingDirectory)
      : t('fileChanges.title');

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 顶部：目录名 + 文件数 + 总增删 + 刷新 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium text-foreground" title={workingDirectory}>
            {dirLabel}
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {t('fileChanges.changedCount', { count: files?.length ?? 0 })}
            <span className="ml-2 text-emerald-500">+{totalAdded}</span>
            <span className="ml-1.5 text-destructive">-{totalRemoved}</span>
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('fileChanges.refresh')}
          aria-label={t('fileChanges.refresh')}
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {!sessionId ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            {t('fileChanges.noSession')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-destructive">
            <TriangleAlert className="size-5" />
            <span className="break-all text-xs">{error}</span>
          </div>
        ) : !files && loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-xs">{t('fileChanges.loading')}</span>
          </div>
        ) : (files?.length ?? 0) === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center text-xs text-muted-foreground">
            <FolderGit2 className="size-6 opacity-50" />
            <span>{t('fileChanges.empty')}</span>
            <span className="text-[10px] opacity-80">{t('fileChanges.emptyHint')}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-2">
            {files!.map((file) => (
              <FileChangeCard
                key={file.absPath}
                file={file}
                entries={entriesByPath.get(file.absPath) ?? []}
                collapsed={collapsed.has(file.absPath)}
                historyOpen={historyOpen.has(file.absPath)}
                onToggleCollapse={() => toggleCollapse(file.absPath)}
                onToggleHistory={() => toggleHistory(file.absPath)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
