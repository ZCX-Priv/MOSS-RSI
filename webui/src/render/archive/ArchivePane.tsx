// render/archive/ArchivePane.tsx
// 压缩包预览（全格式）：libarchive.js（WASM + Worker，按需加载）解码
// zip / tar / gz / bz2 / xz / 7z / rar / cab 等 → 文件管理器（面包屑 + 进入目录 + 返回上级）。
//
// 内层文件打开方式（需求）：点击内层文件 → **一律新建标签页**由渲染器打开（可持久化：仅记录
// 外层 archivePath + 内层 innerPath，刷新后自动重新提取），不再在压缩包内嵌渲染。
// 仅当无外层路径的内存源（压缩包套压缩包，无法持久化标签页）时才退回「内嵌预览」兜底。
// 本组件经 React.lazy 懒加载（FilePreviewPane 分发）。

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, ChevronLeft, Download, Folder, Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { FileTypeIcon } from '../../components/shared/FileTypeIcon';
import { detectFileKind } from '../file/detector';
import { memorySource } from '../core/source';
import { useStore } from '../../store';
import {
  openArchiveReader,
  toEntryInfos,
  type ArchiveEntryInfo,
  type ArchiveReaderLike,
} from './libarchive';

/** 嵌套 FilePreviewPane（lazy 打破与 pane 的静态循环依赖） */
const FilePreviewPane = lazy(() =>
  import('../file/FilePreviewPane').then((m) => ({ default: m.FilePreviewPane })),
);

/** 单条目提取上限（防超大内层文件拖垮内存） */
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
/** 允许继续嵌套预览（内存源回退路径）的最大深度（压缩包套压缩包） */
const MAX_NEST_DEPTH = 2;

/**
 * 每个压缩包标签最近浏览的内层目录（模块级内存）。
 * 点击内层文件会新开预览标签并卸载本组件；返回 ZIP 标签时据此恢复目录，
 * 而不是回到压缩包根目录。键 = sessionId + 外层路径（内存源无外层路径，不缓存）。
 */
const archiveDirMemory = new Map<string, string>();

export interface ArchivePaneProps {
  buffer: ArrayBuffer;
  ext: string;
  fileName: string;
  /** 递归深度（防套娃） */
  depth?: number;
  /** 外层压缩包绝对路径（磁盘源才有；有它 + sessionId 时内层文件开新标签页） */
  archivePath?: string;
  /** 所属会话 id（开新标签页所需） */
  sessionId?: string;
}

export function ArchivePane({ buffer, ext, fileName, depth = 0, archivePath, sessionId }: ArchivePaneProps) {
  const { t } = useTranslation();
  const openArchiveEntryTab = useStore((s) => s.openArchiveEntryTab);
  const setRightPanelOpen = useStore((s) => s.setRightPanelOpen);
  const activeSessionId = useStore((s) => s.activeSessionId);
  // 会话解析：优先显式传入（空串是合法会话 key——空白页 taskId=''），缺省回退全局活动会话。
  // 不能用真值判断：否则空白页 sessionId='' 会落入「内嵌预览」分支。
  const tabSession = sessionId !== undefined ? sessionId : (activeSessionId ?? undefined);
  const [entries, setEntries] = useState<ArchiveEntryInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 目录记忆键：仅磁盘源（有外层路径）可恢复 */
  const dirKey = archivePath ? `${sessionId ?? ''}::${archivePath}` : null;
  const [currentDir, setCurrentDir] = useState(() =>
    dirKey ? (archiveDirMemory.get(dirKey) ?? '') : '',
  );
  const [selected, setSelected] = useState<{ name: string; buffer: ArrayBuffer } | null>(null);
  const [extracting, setExtracting] = useState(false);
  const readerRef = useRef<ArchiveReaderLike | null>(null);

  /** 更新目录并同步写入目录记忆（组件卸载/切标签后返回仍能恢复） */
  const updateDir = useCallback(
    (next: string) => {
      setCurrentDir(next);
      if (dirKey) archiveDirMemory.set(dirKey, next);
    },
    [dirKey],
  );

  // 下载整包
  const downloadUrl = useMemo(() => URL.createObjectURL(new Blob([buffer])), [buffer]);
  useEffect(() => () => URL.revokeObjectURL(downloadUrl), [downloadUrl]);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    setSelected(null);
    // 重新打开同一压缩包时恢复上次目录；首次打开则从根开始
    setCurrentDir(dirKey ? (archiveDirMemory.get(dirKey) ?? '') : '');
    void (async () => {
      try {
        const reader = await openArchiveReader(buffer, fileName);
        if (cancelled) {
          void reader.close();
          return;
        }
        readerRef.current = reader;
        const list = await reader.getFilesArray();
        if (cancelled) return;
        setEntries(toEntryInfos(list));
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      void readerRef.current?.close().catch(() => undefined);
      readerRef.current = null;
    };
  }, [buffer, fileName, dirKey]);

  /** 从条目推导全部目录（含祖先，均以 '/' 结尾，'' 为根） */
  const dirs = useMemo(() => {
    const set = new Set<string>(['']);
    for (const e of entries ?? []) {
      const segments = e.dir.split('/').filter(Boolean);
      let acc = '';
      for (const s of segments) {
        acc += `${s}/`;
        set.add(acc);
      }
    }
    return set;
  }, [entries]);

  // 记忆目录在压缩包内容变化后可能已不存在：回退到根，避免展示空目录
  useEffect(() => {
    if (!entries) return;
    if (currentDir !== '' && !dirs.has(currentDir)) updateDir('');
  }, [entries, dirs, currentDir, updateDir]);

  /** 当前目录的直接子目录 */
  const subDirs = useMemo(() => {
    const out: string[] = [];
    for (const d of dirs) {
      if (d === '' || d === currentDir) continue;
      if (!d.startsWith(currentDir)) continue;
      const rest = d.slice(currentDir.length).replace(/\/$/, '');
      if (rest && !rest.includes('/')) out.push(d);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [dirs, currentDir]);

  /** 当前目录的直接子文件 */
  const subFiles = useMemo(
    () => (entries ?? []).filter((e) => e.dir === currentDir).sort((a, b) => a.name.localeCompare(b.name)),
    [entries, currentDir],
  );

  const openEntry = async (entry: ArchiveEntryInfo) => {
    // 磁盘源（有外层路径）：一律新建标签页，绝不在压缩包内嵌渲染。
    // 空串会话（空白页 taskId=''）同样合法，故用 !== undefined 判定而非真值。
    // 注意：此处不做 size 拦截——标签页按路径懒提取（外层包 ≤100MB 已由后端 /raw 保证），
    // 50MB 仅对下方「内嵌预览把字节留在内存」有意义。
    if (archivePath && tabSession !== undefined) {
      setRightPanelOpen(tabSession, true);
      openArchiveEntryTab(tabSession, { archivePath, innerPath: entry.innerPath, name: entry.name });
      return;
    }
    // 兜底：仅内存源（压缩包套压缩包，无外层路径、无法持久化标签页）保留内嵌预览 + 嵌套深度限制
    if (entry.size > MAX_ENTRY_BYTES) {
      setError(t('preview.archiveEntryTooLarge', { size: Math.round(entry.size / 1024 / 1024) }));
      return;
    }
    if (detectFileKind(entry.name) === 'archive' && depth + 1 > MAX_NEST_DEPTH) {
      setError(t('preview.archiveNestLimit'));
      return;
    }
    setExtracting(true);
    setError(null);
    try {
      const file = await entry.cf.extract();
      setSelected({ name: entry.name, buffer: await file.arrayBuffer() });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  };

  const downloadLink = (
    <a
      href={downloadUrl}
      download={fileName}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-muted"
    >
      <Download className="size-3.5" />
      {t('preview.download')}
    </a>
  );

  if (error !== null && selected === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-destructive">
        <TriangleAlert className="size-6" />
        <div className="max-w-md text-center text-sm">{error}</div>
        {downloadLink}
      </div>
    );
  }

  if (entries === null) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" />
        <span className="text-sm">{t('preview.loading')}</span>
      </div>
    );
  }

  // ── 内层文件内嵌预览态（仅内存源兜底路径会进入） ──
  if (selected !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="flex shrink-0 items-center justify-between gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setSelected(null)}>
            <ChevronLeft className="size-3.5" />
            {t('preview.archiveBackToList')}
          </Button>
          <span className="truncate font-mono text-xs text-muted-foreground" title={selected.name}>
            {selected.name}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 size-5 animate-spin" />
              </div>
            }
          >
            <FilePreviewPane
              source={memorySource({ name: selected.name, buffer: selected.buffer })}
              active
              depth={depth + 1}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  // ── 文件管理器态 ──
  const breadcrumbSegments = currentDir.split('/').filter(Boolean);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Archive className="size-3.5 shrink-0" />
          {currentDir !== '' && (
            <button
              type="button"
              onClick={() => updateDir(currentDir.replace(/[^/]+\/$/, ''))}
              className="rounded px-1 hover:bg-muted"
            >
              <ChevronLeft className="size-3.5" />
            </button>
          )}
          <button type="button" onClick={() => updateDir('')} className="rounded px-1 hover:bg-muted">
            /
          </button>
          {breadcrumbSegments.map((seg, i) => (
            <span key={i} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => updateDir(`${breadcrumbSegments.slice(0, i + 1).join('/')}/`)}
                className="max-w-32 truncate rounded px-1 hover:bg-muted"
              >
                {seg}
              </button>
              <span>/</span>
            </span>
          ))}
          <span className="ml-1 tabular-nums">{t('preview.archiveEntries', { count: subDirs.length + subFiles.length })}</span>
        </div>
        {downloadLink}
      </div>

      {extracting && (
        <div className="flex shrink-0 items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t('preview.loading')}
        </div>
      )}
      {error !== null && (
        <div className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded border border-border p-1">
        {subDirs.length === 0 && subFiles.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('preview.archiveEmpty')}
          </div>
        ) : (
          <>
            {subDirs.map((d) => {
              const name = d.slice(currentDir.length).replace(/\/$/, '');
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => updateDir(d)}
                  className="flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left font-mono text-xs text-foreground hover:bg-muted"
                >
                  <Folder className="size-3.5 shrink-0 text-primary-strong" />
                  <span className="truncate">{name}</span>
                </button>
              );
            })}
            {subFiles.map((f) => (
              <button
                key={`f:${f.innerPath}`}
                type="button"
                onClick={() => void openEntry(f)}
                className="flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left font-mono text-xs text-foreground hover:bg-muted"
                title={`${f.name} (${f.size} B)`}
              >
                <FileTypeIcon fileName={f.name} size={16} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{f.size} B</span>
              </button>
            ))}
          </>
        )}
      </div>
      <div className="shrink-0 text-[10px] text-muted-foreground">{ext.toUpperCase()}</div>
    </div>
  );
}