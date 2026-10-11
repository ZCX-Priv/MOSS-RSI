// components/shared/FileChangesPanel.tsx
// 文件变更面板（右侧面板「文件变更」标签）。
// 展示当前会话（任务）内的文件变更总览：按文件聚合 ± 行数，展开查看 unified diff。
// 数据源 GET /api/file-history/:sessionId；仅统计「生效中」条目（排除已回滚与 R 条目）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Loader2, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FileTypeIcon } from './FileTypeIcon';
import { cn } from '@/lib/utils';
import { api } from '../../api/http';
import type { FileHistoryEntry } from '../../types/api';

export interface FileChangesPanelProps {
  sessionId: string;
}

/** 单文件聚合结果 */
interface FileChangeGroup {
  absPath: string;
  added: number;
  removed: number;
  /** 该文件全部生效中条目（按时间升序） */
  entries: FileHistoryEntry[];
  /** 末次变更时间戳（ms；排序用；无有效时间则 0） */
  lastTs: number;
}

/** 解析 unified diff 统计行级增删（跳过 @@ / +++ / --- 头与空行） */
function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (!line) continue;
    if (line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** 按 absPath 聚合生效中条目（排除 R 条目与已回滚条目 → 当前净变更） */
function groupChanges(entries: FileHistoryEntry[]): FileChangeGroup[] {
  const map = new Map<string, FileChangeGroup>();
  for (const e of entries) {
    if (e.toolName === 'rollback' || e.rolledBackAt) continue;
    let g = map.get(e.absPath);
    if (!g) {
      g = { absPath: e.absPath, added: 0, removed: 0, entries: [], lastTs: 0 };
      map.set(e.absPath, g);
    }
    if (e.diff) {
      const { added, removed } = countDiffLines(e.diff);
      g.added += added;
      g.removed += removed;
    }
    g.entries.push(e);
    const ts = Date.parse(e.timestamp);
    if (!Number.isNaN(ts) && ts > g.lastTs) g.lastTs = ts;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }
  // 末次变更时间倒序（最近的在前）
  groups.sort((a, b) => b.lastTs - a.lastTs);
  return groups;
}

/** 文件名（跨平台分隔符） */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 操作类型 → i18n key（terminal-change / 旧值 shell-change 走驼峰键） */
function opKey(op: FileHistoryEntry['operation']): string {
  return `fileChanges.op.${op === 'terminal-change' || op === 'shell-change' ? 'terminalChange' : op}`;
}

/** diff 行着色 */
function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-sky-500';
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted-foreground';
  if (line.startsWith('+')) return 'text-emerald-500';
  if (line.startsWith('-')) return 'text-destructive';
  return 'text-foreground';
}

export function FileChangesPanel({ sessionId }: FileChangesPanelProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<FileHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    // 空白页（无任务 id）不发请求：/api/file-history/ 无有效段，会被路由判为 404
    if (!sessionId) {
      setEntries([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await api.listFileHistory(sessionId);
      setEntries(resp.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupChanges(entries ?? []), [entries]);
  const totalAdded = useMemo(() => groups.reduce((sum, g) => sum + g.added, 0), [groups]);
  const totalRemoved = useMemo(() => groups.reduce((sum, g) => sum + g.removed, 0), [groups]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 汇总头：文件数 + 总增删 + 刷新 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium text-foreground">
            {t('fileChanges.changedCount', { count: groups.length })}
          </span>
          <span className="text-[11px] tabular-nums">
            <span className="text-emerald-500">+{totalAdded}</span>{' '}
            <span className="text-destructive">-{totalRemoved}</span>
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
        ) : !entries && loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-xs">{t('fileChanges.loading')}</span>
          </div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            {t('fileChanges.empty')}
          </div>
        ) : (
          <div className="flex flex-col p-1.5">
            {groups.map((g) => {
              const open = expanded.has(g.absPath);
              return (
                <div key={g.absPath} className="flex flex-col">
                  {/* 文件行：展开箭头 + 图标 + 文件名 + ± 行数 */}
                  <button
                    type="button"
                    title={g.absPath}
                    onClick={() => toggle(g.absPath)}
                    className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted"
                  >
                    <ChevronRight
                      className={cn(
                        'size-3.5 shrink-0 text-muted-foreground transition-transform',
                        open && 'rotate-90',
                      )}
                    />
                    <FileTypeIcon fileName={baseName(g.absPath)} size={16} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {baseName(g.absPath)}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums">
                      {g.added > 0 && <span className="text-emerald-500">+{g.added}</span>}
                      {g.added > 0 && g.removed > 0 && ' '}
                      {g.removed > 0 && <span className="text-destructive">-{g.removed}</span>}
                    </span>
                  </button>
                  {/* 完整路径 + 操作徽章 */}
                  <div className="flex items-center gap-1.5 pb-1 pl-8 pr-1.5">
                    <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={g.absPath}>
                      {g.absPath}
                    </span>
                    {[...new Set(g.entries.map((e) => e.operation))].map((op) => (
                      <span
                        key={op}
                        className="shrink-0 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground"
                      >
                        {t(opKey(op))}
                      </span>
                    ))}
                  </div>
                  {/* 展开：逐条变更（操作 + 时间 + diff） */}
                  {open && (
                    <div className="mb-2 ml-6 flex flex-col gap-1.5">
                      {g.entries.map((e) => (
                        <div key={e.id} className="overflow-hidden rounded-md border border-border">
                          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1 text-[10px] text-muted-foreground">
                            <span className="shrink-0 rounded bg-muted px-1 py-px">{t(opKey(e.operation))}</span>
                            <span className="min-w-0 flex-1 truncate" title={e.destPath ? `${e.absPath} → ${e.destPath}` : e.absPath}>
                              {e.destPath ? `${e.absPath} → ${e.destPath}` : e.absPath}
                            </span>
                            <span className="shrink-0 tabular-nums">
                              {new Date(e.timestamp).toLocaleString()}
                            </span>
                          </div>
                          {e.diff ? (
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-[10px] leading-relaxed">
                              {e.diff.split('\n').map((line, i) => (
                                <div key={i} className={diffLineClass(line)}>
                                  {line || ' '}
                                </div>
                              ))}
                            </pre>
                          ) : (
                            <div className="px-2 py-1.5 text-[10px] text-muted-foreground">
                              {t('fileChanges.noDiff')}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}