// webui/src/components/overlays/DirectoryBrowserDialog.tsx
// 前端文件夹选择器（Windows 资源管理器式布局）：
// - 顶栏：后退/前进/上级 + 面包屑地址栏 + 刷新 + 搜索
// - 左栏：快速访问（最近使用）/ 此电脑（磁盘）/ 常用位置（主目录/桌面/文档/下载/图片/音乐/视频）
// - 主区：默认「此电脑」磁盘页；进入目录后为 名称/修改日期/类型/大小 四列可排序列表
// - 底栏：文件名输入框 + 选择/取消
// 数据源 GET /api/filesystem/{drives,list,suggest-paths}（不带 cwd → __system__ 全盘浏览，越界由后端 403 兜底）。
// 图标与侧边栏「文件」标签页同款：驱动器 HardDrive / 目录 Folder / 文件 FileTypeIcon。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  Folder,
  HardDrive,
  Home,
  Image as ImageIcon,
  Loader2,
  Monitor,
  Music,
  RotateCw,
  Search,
  TriangleAlert,
  Video,
  FileText,
  Download,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  PencilLine,
  Trash2,
  PanelLeft,
} from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { FileTypeIcon } from '@/components/shared/FileTypeIcon';
import { useStore } from '@/store';
import { api } from '@/api/http';
import type { DirectoryEntry, DirectoryListing, DriveInfo, SuggestPath, SuggestPathKind } from '@/types/api';

interface DirectoryBrowserDialogProps {
  open: boolean;
  onSelect: (path: string) => void;
  onClose: () => void;
}

type BrowserView = 'drives' | 'dir';
type Sep = '\\' | '/';
type SortKey = 'name' | 'mtime' | 'type' | 'size';

/** 文件大小人性化（1024 进制，保留 1 位小数） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 修改时间格式化（本地化） */
function formatMtime(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** 拼接路径（去首尾分隔符后按平台分隔符拼接；盘符根回补分隔符） */
function joinPath(base: string, tail: string, sep: Sep): string {
  const b = base.replace(/[\\/]+$/, '');
  const t = tail.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  if (!t) return b.endsWith(':') ? `${b}${sep}` : b;
  return `${b}${sep}${t}`;
}

/** 路径末尾名（无分隔符时返回原串） */
function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 面包屑分段：累计路径 + 显示名 */
function buildSegments(p: string, sep: Sep): Array<{ label: string; path: string }> {
  const norm = p.replace(/[\\/]+$/, '');
  const parts = norm.split(/[\\/]+/).filter(Boolean);
  const out: Array<{ label: string; path: string }> = [];
  if (sep === '\\' && /^[A-Za-z]:$/.test(parts[0] ?? '')) {
    out.push({ label: parts[0], path: `${parts[0]}\\` });
    let acc = `${parts[0]}\\`;
    for (const seg of parts.slice(1)) {
      acc = acc.endsWith('\\') ? `${acc}${seg}` : `${acc}\\${seg}`;
      out.push({ label: seg, path: acc });
    }
  } else {
    out.push({ label: '/', path: '/' });
    let acc = '';
    for (const seg of parts) {
      acc = `${acc}/${seg}`;
      out.push({ label: seg, path: acc });
    }
  }
  return out;
}

/** 常用位置 kind → lucide 图标 */
function suggestIcon(kind: SuggestPathKind) {
  switch (kind) {
    case 'home': return Home;
    case 'desktop': return Monitor;
    case 'documents': return FileText;
    case 'downloads': return Download;
    case 'pictures': return ImageIcon;
    case 'music': return Music;
    case 'videos': return Video;
    default: return FolderOpen;
  }
}

export function DirectoryBrowserDialog({ open, onSelect, onClose }: DirectoryBrowserDialogProps) {
  const { t } = useTranslation();
  const recentDirectories = useStore((s) => s.recentDirectories);
  const recentDirectoryAliases = useStore((s) => s.recentDirectoryAliases);
  const renameRecentDirectory = useStore((s) => s.renameRecentDirectory);
  const updateRecentDirectoryPath = useStore((s) => s.updateRecentDirectoryPath);
  const removeRecentDirectory = useStore((s) => s.removeRecentDirectory);

  /** 最近使用的管理弹窗（重命名别名 / 修改路径 / 删除） */
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [editPathTarget, setEditPathTarget] = useState<string | null>(null);
  const [editPathValue, setEditPathValue] = useState('');
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const [view, setView] = useState<BrowserView>('drives');
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestPath[]>([]);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  /** 目录侧栏展开态：移动端默认收起（抽屉覆盖），桌面端默认展开 */
  const [sidebarOpen, setSidebarOpen] = useState(true);
  /** 移动端判定（抽屉覆盖模式） */
  const isMobile = useIsMobile();

  const sep: Sep = listing?.sep ?? (navigator.userAgent.includes('Windows') ? '\\' : '/');

  const driveLabelOf = useCallback(
    (drive: DriveInfo): string => {
      switch (drive.kind) {
        case 'drive': return t('fileBrowser.driveLabel', { letter: drive.letter });
        case 'root': return t('fileBrowser.filesystemRoot');
        case 'home': return t('fileBrowser.homeDir');
        default: return drive.letter;
      }
    },
    [t],
  );

  const loadDrives = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.listDrives();
      setDrives(resp.drives);
      setListing(null);
      setSelectedPath(null);
      setNameInput('');
      setSearch('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 加载目录（不再维护前进/后退历史栈） */
  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.listDirectory(path);
      setListing(resp);
      setView('dir');
      setSelectedPath(null);
      setNameInput(baseName(resp.path));
      setSearch('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时重置到「此电脑」并载入磁盘 + 常用位置
  useEffect(() => {
    if (!open) return;
    // 每次打开按断点重置侧栏默认态（移动端收起 / 桌面端展开）
    setSidebarOpen(!isMobile);
    void loadDrives();
    setView('drives');
    api.suggestPaths()
      .then((r) => setSuggestions(r.paths))
      .catch(() => setSuggestions([]));
  }, [open, isMobile, loadDrives]);

  const goDrives = useCallback(() => {
    setView('drives');
    setListing(null);
    setSelectedPath(null);
    setNameInput('');
    setSearch('');
    setError(null);
  }, []);

  const goUp = useCallback(() => {
    if (view === 'drives' || !listing) return;
    if (listing.parent) void loadDirectory(listing.parent);
    else goDrives();
  }, [view, listing, loadDirectory, goDrives]);

  const canUp = view === 'dir' && !!listing && !loading;

  /** 排序 + 搜索过滤后的条目 */
  const rows = useMemo<DirectoryEntry[]>(() => {
    const arr = [...(listing?.entries ?? [])];
    const cmp = (a: DirectoryEntry, b: DirectoryEntry): number => {
      let r = 0;
      switch (sortKey) {
        case 'mtime': r = a.mtimeMs - b.mtimeMs; break;
        case 'size': r = a.size - b.size; break;
        case 'type': r = a.ext.localeCompare(b.ext) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }); break;
        default: r = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      }
      return sortAsc ? r : -r;
    };
    arr.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return cmp(a, b);
    });
    const q = search.trim().toLowerCase();
    return q ? arr.filter((e) => e.name.toLowerCase().includes(q)) : arr;
  }, [listing, sortKey, sortAsc, search]);

  const selectedEntry = useMemo(
    () => rows.find((e) => e.path === selectedPath) ?? null,
    [rows, selectedPath],
  );

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const selectRow = (entry: DirectoryEntry) => {
    setSelectedPath(entry.path);
    setNameInput(entry.kind === 'directory' ? entry.name : baseName(listing?.path ?? ''));
  };

  const enterRow = (entry: DirectoryEntry) => {
    if (entry.kind === 'directory') void loadDirectory(entry.path);
  };

  /** 底栏确认：优先选中目录；否则按输入名尝试进入，最后落到当前目录 */
  const confirm = () => {
    if (view !== 'dir' || !listing) return;
    if (selectedEntry?.kind === 'directory') {
      onSelect(selectedEntry.path);
      return;
    }
    const typed = nameInput.trim();
    const cur = baseName(listing.path);
    if (typed && typed !== cur) {
      void loadDirectory(joinPath(listing.path, typed, sep));
      return;
    }
    onSelect(listing.path);
  };

  const canSelect = view === 'dir' && !!listing && !loading;

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '';

  return (
    <>
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        // 移动端：全屏铺满（无圆角、无最大宽度）；桌面端：固定高度居中卡片
        className="h-[100dvh] max-h-[100dvh] w-full max-w-none rounded-none sm:h-[72dvh] sm:max-h-[72dvh] sm:max-w-5xl sm:rounded-xl"
      >
        <DialogHeader>
          <DialogTitle>{t('directoryPicker.browseTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="relative flex-row gap-0 overflow-hidden p-0">
          {/* 移动端遮罩：点击后收起目录抽屉 */}
          {sidebarOpen && (
            <div
              className="absolute inset-0 z-20 bg-black/40 sm:hidden"
              aria-hidden="true"
              onClick={() => setSidebarOpen(false)}
            />
          )}
          {/* 位置栏：桌面端为可收起左列；移动端为内嵌左滑抽屉。
              纯 div 实现（不用 Sheet），避免与主页面侧边栏抽屉冲突。 */}
          <aside
            className={cn(
              'flex-col gap-3 overflow-y-auto border-border p-2',
              'max-sm:absolute max-sm:inset-y-0 max-sm:left-0 max-sm:z-30 max-sm:w-64 max-sm:max-w-[80%] max-sm:border-r max-sm:bg-card max-sm:shadow-lg',
              'sm:w-56 sm:shrink-0 sm:border-r',
              sidebarOpen ? 'flex' : 'hidden',
            )}
          >
            <NavGroup title={t('directoryPicker.quickAccess')}>
              {recentDirectories.length === 0 ? (
                <div className="px-2 py-1 text-[11px] text-muted-foreground">{t('directoryPicker.noRecent')}</div>
              ) : (
                recentDirectories.map((dir) => {
                  const alias = recentDirectoryAliases[dir]?.trim();
                  return (
                    <div key={dir} className="group flex items-center gap-0.5">
                      <button
                        type="button"
                        title={dir}
                        onClick={() => void loadDirectory(dir)}
                        className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
                      >
                        <Folder className="size-4 shrink-0 text-primary-strong" />
                        <span className="min-w-0 flex-1 truncate">{alias || baseName(dir)}</span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            title={t('directoryPicker.recentManage')}
                            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
                          >
                            <MoreHorizontal className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" sideOffset={4} collisionPadding={8}>
                          <DropdownMenuItem
                            onSelect={() => {
                              setRenameValue(alias ?? '');
                              setRenameTarget(dir);
                            }}
                            className="gap-2 text-xs"
                          >
                            <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
                            {t('directoryPicker.recentRename')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              setEditPathValue(dir);
                              setEditPathTarget(dir);
                            }}
                            className="gap-2 text-xs"
                          >
                            <PencilLine className="size-3.5 shrink-0 text-muted-foreground" />
                            {t('directoryPicker.recentEditPath')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setRemoveTarget(dir)} className="gap-2 text-xs text-destructive">
                            <Trash2 className="size-3.5 shrink-0" />
                            {t('directoryPicker.recentRemove')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })
              )}
            </NavGroup>

            <NavGroup title={t('directoryPicker.thisPc')}>
              <NavItem
                icon={<Monitor className="size-4 shrink-0 text-primary-strong" />}
                label={t('fileBrowser.localMachine')}
                active={view === 'drives'}
                onClick={goDrives}
              />
              {drives.map((d) => (
                <NavItem
                  key={d.path}
                  icon={<HardDrive className="size-4 shrink-0 text-primary-strong" />}
                  label={driveLabelOf(d)}
                  title={d.path}
                  onClick={() => void loadDirectory(d.path)}
                />
              ))}
            </NavGroup>

            {suggestions.length > 0 && (
              <NavGroup title={t('directoryPicker.commonLocations')}>
                {suggestions.map((s) => {
                  const Icon = suggestIcon(s.kind);
                  return (
                    <NavItem
                      key={s.path}
                      icon={<Icon className="size-4 shrink-0 text-muted-foreground" />}
                      label={t(`directoryPicker.kind.${s.kind}`)}
                      title={s.path}
                      onClick={() => void loadDirectory(s.path)}
                    />
                  );
                })}
              </NavGroup>
            )}
          </aside>

          {/* 右区 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* 工具条 */}
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2">
              {/* 目录侧栏展开/收起（位于「上一级」左侧） */}
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('directoryPicker.toggleSidebar')}
                aria-pressed={sidebarOpen}
                onClick={() => setSidebarOpen((v) => !v)}
              >
                <PanelLeft className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" title={t('directoryPicker.up')} disabled={!canUp} onClick={goUp}>
                <ArrowUp className="size-4" />
              </Button>
              {/* 面包屑地址栏 */}
              <div className="flex h-8 min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-lg border border-input bg-muted/40 px-2">
                {view === 'drives' || !listing ? (
                  <span className="truncate font-mono text-xs text-muted-foreground">{t('fileBrowser.localMachine')}</span>
                ) : (
                  buildSegments(listing.path, sep).map((seg, i) => (
                    <span key={seg.path} className="flex shrink-0 items-center">
                      {i > 0 && <span className="px-1 text-muted-foreground">›</span>}
                      <button
                        type="button"
                        onClick={() => void loadDirectory(seg.path)}
                        className="max-w-[180px] truncate rounded px-1 font-mono text-xs text-foreground hover:bg-muted"
                        title={seg.path}
                      >
                        {seg.label}
                      </button>
                    </span>
                  ))
                )}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('fileBrowser.refresh')}
                disabled={loading}
                onClick={() => (view === 'drives' ? void loadDrives() : listing && void loadDirectory(listing.path))}
              >
                {loading ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
              </Button>
              <div className="relative hidden w-40 shrink-0 sm:block">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="h-8 w-full rounded-lg border border-input bg-muted/40 pl-7 pr-2 text-xs text-foreground outline-none"
                  value={search}
                  placeholder={t('directoryPicker.searchPlaceholder')}
                  disabled={view === 'drives'}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            {/* 主区 */}
            {error ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-destructive">
                <TriangleAlert className="size-5" />
                <span className="break-all text-xs">{error}</span>
              </div>
            ) : loading && view === 'drives' && drives.length === 0 ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span className="text-xs">{t('fileBrowser.loading')}</span>
              </div>
            ) : view === 'drives' ? (
              <div className="flex-1 overflow-y-auto p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {drives.map((d) => {
                    const used = Math.max(0, d.totalBytes - d.freeBytes);
                    const pct = d.totalBytes > 0 ? Math.min(100, (used / d.totalBytes) * 100) : 0;
                    return (
                      <button
                        key={d.path}
                        type="button"
                        title={d.path}
                        onClick={() => void loadDirectory(d.path)}
                        className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-muted"
                      >
                        <HardDrive className="mt-0.5 size-5 shrink-0 text-primary-strong" />
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="truncate text-xs text-foreground">{driveLabelOf(d)}</span>
                          {d.totalBytes > 0 && (
                            <>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="tabular-nums text-[10px] text-muted-foreground">
                                {t('fileBrowser.driveFree', { free: formatSize(d.freeBytes), total: formatSize(d.totalBytes) })}
                              </span>
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                {/* 列头 */}
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                  <button type="button" onClick={() => toggleSort('name')} className="min-w-0 flex-1 text-left hover:text-foreground">
                    {t('directoryPicker.colName')}{sortIndicator('name')}
                  </button>
                  <button type="button" onClick={() => toggleSort('mtime')} className="hidden w-40 shrink-0 text-left hover:text-foreground sm:block">
                    {t('directoryPicker.colMtime')}{sortIndicator('mtime')}
                  </button>
                  <button type="button" onClick={() => toggleSort('type')} className="hidden w-24 shrink-0 text-left hover:text-foreground md:block">
                    {t('directoryPicker.colType')}{sortIndicator('type')}
                  </button>
                  <button type="button" onClick={() => toggleSort('size')} className="w-20 shrink-0 text-right hover:text-foreground">
                    {t('directoryPicker.colSize')}{sortIndicator('size')}
                  </button>
                </div>
                {/* 列表 */}
                <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                  {rows.length === 0 ? (
                    <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                      {search.trim() ? t('directoryPicker.noMatch') : t('fileBrowser.empty')}
                    </div>
                  ) : (
                    rows.map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        title={entry.path}
                        onClick={() => selectRow(entry)}
                        onDoubleClick={() => enterRow(entry)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                          entry.path === selectedPath ? 'bg-primary/10' : 'hover:bg-muted'
                        } ${entry.kind === 'file' ? 'opacity-70' : ''}`}
                      >
                        {entry.kind === 'directory' ? (
                          <Folder className="size-4 shrink-0 text-primary-strong" />
                        ) : (
                          <FileTypeIcon fileName={entry.name} size={16} className="shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{entry.name}</span>
                        <span className="hidden w-40 shrink-0 truncate text-[10px] tabular-nums text-muted-foreground sm:block">
                          {formatMtime(entry.mtimeMs)}
                        </span>
                        <span className="hidden w-24 shrink-0 truncate text-[10px] text-muted-foreground md:block">
                          {entry.kind === 'directory' ? t('directoryPicker.folderType') : entry.ext ? `${entry.ext.toUpperCase()}` : '—'}
                        </span>
                        <span className="w-20 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                          {entry.kind === 'file' ? formatSize(entry.size) : ''}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 text-xs text-muted-foreground">{t('directoryPicker.filename')}</span>
            <input
              className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-muted/40 px-2 font-mono text-xs text-foreground outline-none"
              value={nameInput}
              disabled={view === 'drives'}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm();
              }}
            />
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('directoryPicker.cancel')}</Button>
            <Button disabled={!canSelect} onClick={confirm}>{t('directoryPicker.selectFolderBtn')}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* 「最近使用」管理：重命名（自定义别名） */}
    <Dialog open={renameTarget !== null} onOpenChange={(v) => !v && setRenameTarget(null)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('directoryPicker.recentRename')}</DialogTitle>
          <DialogDescription>{t('directoryPicker.recentRenameDesc')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Input
            value={renameValue}
            autoFocus
            placeholder={t('directoryPicker.recentRenamePlaceholder')}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              if (renameTarget) renameRecentDirectory(renameTarget, renameValue);
              setRenameTarget(null);
            }}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setRenameTarget(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              if (renameTarget) renameRecentDirectory(renameTarget, renameValue);
              setRenameTarget(null);
            }}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* 「最近使用」管理：修改路径 */}
    <Dialog open={editPathTarget !== null} onOpenChange={(v) => !v && setEditPathTarget(null)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('directoryPicker.recentEditPath')}</DialogTitle>
          <DialogDescription>{t('directoryPicker.recentEditPathDesc')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Input
            value={editPathValue}
            autoFocus
            className="font-mono"
            placeholder={t('directoryPicker.recentPathPlaceholder')}
            onChange={(e) => setEditPathValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              if (editPathTarget) updateRecentDirectoryPath(editPathTarget, editPathValue);
              setEditPathTarget(null);
            }}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setEditPathTarget(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              if (editPathTarget) updateRecentDirectoryPath(editPathTarget, editPathValue);
              setEditPathTarget(null);
            }}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* 「最近使用」管理：删除（仅移出列表，不动磁盘目录） */}
    <ConfirmDialog
      open={removeTarget !== null}
      title={t('directoryPicker.recentRemove')}
      description={t('directoryPicker.recentRemoveConfirm', { path: removeTarget ?? '' })}
      destructive
      confirmText={t('common.delete')}
      onConfirm={() => {
        if (removeTarget) removeRecentDirectory(removeTarget);
        setRemoveTarget(null);
      }}
      onOpenChange={(o) => !o && setRemoveTarget(null)}
    />
    </>
  );
}

/** 位置分组（竖排：标题在上、项在下；抽屉与左列共用） */
function NavGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

/** 左栏导航项 */
function NavItem({
  icon,
  label,
  title,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
        active ? 'bg-primary/10 text-foreground' : 'hover:bg-muted'
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}