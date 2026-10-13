// components/shared/FileBrowserPanel.tsx
// 文件浏览器面板（右侧面板「文件」标签）。
// 两种模式：
//  - 普通模式（工作目录为具体目录）：以当前工作目录为「导航根」，可逐级进入子目录、返回上级；
//    不能上溯越过根，也不能回到磁盘根。地址栏 = 灰色只读的根前缀 + 可编辑的子路径后缀。
//  - 本机模式（工作目录为 __system__/空）：显示「本机」驱动器视图（盘符 + 容量），
//    点击磁盘进入其根目录，可跨盘自由浏览；「上级」到盘根后返回驱动器视图。
// 点击文件经 openFileTab 在右侧面板新建「文件预览」标签（复用 file 类型 + FilePreviewPane）。
// 数据源 GET /api/filesystem/list 与 GET /api/filesystem/drives（root 边界由服务端强制，越界返回 403）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ArrowUp, Folder, HardDrive, Loader2, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FileTypeIcon } from './FileTypeIcon';
import { useStore, SYSTEM_WORKING_DIRECTORY } from '../../store';
import { api } from '../../api/http';
import { wsClient } from '../../api/ws';
import type { DirectoryListing, DriveInfo, WSMessage } from '../../types/api';

export interface FileBrowserPanelProps {
  /** 会话 id（= taskId）；用于打开文件标签与会话级面板控制 */
  sessionId: string;
}

/** 当前视图：驱动器列表 / 目录列表 */
type BrowserView = 'drives' | 'dir';

/** 平台路径分隔符（与后端 DirectoryListing.sep 对齐） */
type Sep = '\\' | '/';

/**
 * 每会话浏览位置记忆（模块级内存）。
 * 面板随标签激活状态挂载/卸载：点文件打开预览标签会卸载本面板，切回时若无记忆会被
 * 拉回根、丢失所在子目录 → 按会话记住位置用于恢复（含驱动器视图/所在目录）。
 * 同时记录当时的 workingDirectory：工作目录变了则记忆失效（旧路径可能已越界到新根之外）。
 */
const lastBySession = new Map<
  string,
  { wd: string; root: string; path: string; view: BrowserView }
>();

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

/** 根 → 目标目录的相对路径（统一 / 显示；目标即根时返回空串） */
function relPath(root: string, full: string): string {
  const r = root.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const f = full.replace(/\\/g, '/');
  if (!r || !f || f === r) return '';
  return f.startsWith(`${r}/`) ? f.slice(r.length + 1) : '';
}

/** 根显示形式：末尾用平台分隔符闭合（根自身即完整闭合路径，避免空尾） */
function rootDisplay(root: string, sep: Sep = '\\'): string {
  if (!root) return '';
  return /[\\/]$/.test(root) ? root : `${root}${sep}`;
}

/** 后缀显示形式：平台分隔符分隔且末尾闭合（根时为空串，闭合由根前缀负责） */
function toSuffixDisplay(root: string, full: string, sep: Sep = '\\'): string {
  const rel = relPath(root, full); // 'a/b' 或 ''
  if (!rel) return '';
  return `${rel.replace(/\//g, sep)}${sep}`;
}

/** 拼接根 + 后缀（去首尾分隔符后按平台分隔符拼接；空后缀 = 根；盘符根回补分隔符） */
function joinPath(root: string, suffix: string, sep: Sep = '\\'): string {
  const base = root.replace(/[\\/]+$/, '');
  const tail = suffix.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  if (!tail) return base.endsWith(':') ? `${base}${sep}` : base;
  return `${base}${sep}${tail}`;
}

/** 路径等价比较（忽略大小写、分隔符差异与末尾斜杠） */
function samePathLoose(a: string, b: string): boolean {
  const key = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  return key(a) === key(b);
}

/** 取路径的父目录（统一 / 分隔、去末尾分隔符；无分隔符时返回空串） */
function parentDirOf(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

/** 是否为驱动器根 / 文件系统根（C:\、D:\ 或 /） */
function isDriveRoot(p: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(p) || p === '/';
}

export function FileBrowserPanel({ sessionId }: FileBrowserPanelProps) {
  const { t } = useTranslation();
  const workingDirectory = useStore((s) => s.workingDirectory);
  const openFileTab = useStore((s) => s.openFileTab);
  const setRightPanelOpen = useStore((s) => s.setRightPanelOpen);

  /** 本机模式：工作目录为空或 __system__（全盘访问，显示「本机」驱动器视图） */
  const systemMode = !workingDirectory || workingDirectory === SYSTEM_WORKING_DIRECTORY;

  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 地址栏输入：普通模式 = 相对根的子路径后缀；本机模式 = 可编辑的绝对路径 */
  const [subPath, setSubPath] = useState('');
  /** 当前视图（本机模式可在驱动器/目录间切换；普通模式恒为 dir） */
  const [view, setView] = useState<BrowserView>('dir');
  /** 驱动器列表（本机模式） */
  const [drives, setDrives] = useState<DriveInfo[] | null>(null);
  const [drivesLoading, setDrivesLoading] = useState(false);
  const [drivesError, setDrivesError] = useState<string | null>(null);

  /** 最新目录列表（WS 事件回调读取，避免闭包过期） */
  const listingRef = useRef<DirectoryListing | null>(null);
  /** 最新视图（定时回调读取，避免闭包过期） */
  const viewRef = useRef<BrowserView>(view);
  viewRef.current = view;
  /** 静默刷新防抖定时器 */
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remember = useCallback(
    (rec: { root: string; path: string; view: BrowserView }) => {
      lastBySession.set(sessionId, { wd: workingDirectory, ...rec });
    },
    [sessionId, workingDirectory],
  );

  const load = useCallback(
    async (target: string | null, root: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const resp = await api.listDirectory(
          target ?? undefined,
          workingDirectory || undefined,
          root ?? undefined,
        );
        listingRef.current = resp;
        setListing(resp);
        setView('dir');
        setSubPath(systemMode ? resp.path : toSuffixDisplay(resp.root, resp.path, resp.sep));
        remember({ root: resp.root, path: resp.path, view: 'dir' });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        // 失败也要把地址栏推进到「正在尝试进入」的目标路径：
        // 否则地址栏停留在上一级，与实际访问的目录不一致，用户无从得知报错的是哪个目录。
        // 不写位置记忆（remember），重新打开标签仍回到上次有效位置。
        if (target) {
          if (systemMode) {
            setSubPath(target);
          } else {
            const baseRoot = root ?? listingRef.current?.root ?? '';
            if (baseRoot) {
              const sep: Sep = listingRef.current?.sep ?? (target.includes('\\') ? '\\' : '/');
              setSubPath(toSuffixDisplay(baseRoot, target, sep));
            }
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [workingDirectory, systemMode, remember],
  );

  /** 加载驱动器列表（本机模式「本机」视图） */
  const loadDrives = useCallback(async () => {
    setDrivesLoading(true);
    setDrivesError(null);
    try {
      const resp = await api.listDrives();
      setDrives(resp.drives);
    } catch (err) {
      setDrivesError(err instanceof Error ? err.message : String(err));
    } finally {
      setDrivesLoading(false);
    }
  }, []);

  /** 回到「本机」驱动器视图（本机模式） */
  const goDrives = useCallback(() => {
    listingRef.current = null;
    setListing(null);
    setError(null);
    setView('drives');
    setSubPath('');
    remember({ root: '', path: '', view: 'drives' });
    void loadDrives();
  }, [loadDrives, remember]);

  /**
   * 静默刷新：拉取当前展示目录并更新列表，但**不重设地址栏输入**（避免打断正在输入的路径）。
   * 失败静默忽略，不覆盖现有错误态；驱动器视图下不适用。
   */
  const silentRefresh = useCallback(async () => {
    const cur = listingRef.current;
    if (!cur || viewRef.current !== 'dir') return;
    try {
      const resp = await api.listDirectory(cur.path, workingDirectory || undefined, systemMode ? undefined : cur.root);
      listingRef.current = resp;
      setListing(resp);
      remember({ root: resp.root, path: resp.path, view: 'dir' });
    } catch {
      // 静默刷新失败：保持当前列表
    }
  }, [workingDirectory, systemMode, remember]);

  // 实时刷新：订阅本会话的文件变更 WS 事件；变更落在当前目录时防抖静默刷新。
  // 事件源见后端 engine.onFilesysChange（file-created/edited/deleted/moved/terminal-changed）。
  useEffect(() => {
    const schedule = (): void => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void silentRefresh();
      }, 250);
    };
    const affectsCurrentDir = (paths: string[]): boolean => {
      const cur = listingRef.current;
      if (!cur) return false;
      return paths.some((p) => p.length > 0 && samePathLoose(parentDirOf(p), cur.path));
    };
    const handle = (msg: WSMessage): void => {
      if (msg.sessionId !== sessionId) return;
      const payload = (msg.payload ?? {}) as {
        path?: string;
        destPath?: string;
        report?: { created?: string[]; modified?: string[]; deleted?: string[] };
      };
      let paths: string[];
      switch (msg.type) {
        case 'file-created':
        case 'file-edited':
        case 'file-deleted':
          paths = payload.path ? [payload.path] : [];
          break;
        case 'file-moved':
          paths = [payload.path, payload.destPath].filter((x): x is string => typeof x === 'string');
          break;
        case 'terminal-changed':
          paths = [
            ...(payload.report?.created ?? []),
            ...(payload.report?.modified ?? []),
            ...(payload.report?.deleted ?? []),
          ];
          break;
        default:
          return;
      }
      if (affectsCurrentDir(paths)) schedule();
    };
    const unsub = wsClient.onMessage(handle);
    // 兜底：页面重新可见时补一次（WS 断连期可能丢事件）
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void silentRefresh();
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
  }, [sessionId, silentRefresh]);

  // 进入标签：恢复该会话上次位置；否则按模式首次定位
  // （本机模式 → 驱动器视图；普通模式 → 以工作目录为根）
  useEffect(() => {
    const rec = lastBySession.get(sessionId);
    const valid = rec && rec.wd === workingDirectory;
    if (systemMode) {
      if (valid && rec.view === 'dir' && rec.path) void load(rec.path, null);
      else goDrives();
    } else if (valid && rec.view === 'dir' && rec.path) {
      void load(rec.path, rec.root);
    } else {
      void load(null, null);
    }
  }, [load, goDrives, sessionId, workingDirectory, systemMode]);

  const handleOpenFile = useCallback(
    (path: string) => {
      openFileTab(sessionId, path);
      setRightPanelOpen(sessionId, true);
    },
    [openFileTab, setRightPanelOpen, sessionId],
  );

  /** 点击驱动器：进入其根目录（本机模式，跨盘自由浏览） */
  const openDrive = useCallback(
    (drive: DriveInfo) => {
      void load(drive.path, null);
    },
    [load],
  );

  /** 提交地址栏：本机模式按绝对路径跳转；普通模式仅在根范围内跳转（越界由后端 403 拦下） */
  const submitSubPath = useCallback(() => {
    if (systemMode) {
      const typed = subPath.trim();
      if (!typed) return;
      void load(typed, null);
      return;
    }
    if (!listing) return;
    void load(joinPath(listing.root, subPath.trim(), listing.sep), listing.root);
  }, [systemMode, listing, subPath, load]);

  // ── 上级 / 根状态 ──
  /** 普通模式：已在导航根（上级按钮禁用；后端在根时 parent 为 null，双保险） */
  const atRoot = !!listing && relPath(listing.root, listing.path) === '';
  /** 本机模式：当前目录已是某盘/卷根（再上级应回到「本机」视图） */
  const atDriveRoot =
    systemMode &&
    view === 'dir' &&
    !!listing &&
    (!listing.parent ||
      isDriveRoot(listing.path) ||
      (drives?.some((d) => samePathLoose(d.path, listing.path)) ?? false));

  const handleUp = useCallback(() => {
    if (view === 'drives') return;
    if (systemMode) {
      if (atDriveRoot || !listing?.parent) {
        goDrives();
        return;
      }
      void load(listing.parent, null);
      return;
    }
    void load(listing?.parent ?? null, listing?.root ?? null);
  }, [view, systemMode, atDriveRoot, listing, goDrives, load]);

  const upDisabled =
    view === 'drives'
      ? true
      : loading || !listing
        ? true
        : systemMode
          ? false
          : atRoot || !listing.parent;

  // 地址栏内容 ≠ 当前所在目录 → 视为有未提交的新地址（右侧按钮变为「前进」）
  const typedTarget = systemMode
    ? subPath.trim()
    : listing
      ? joinPath(listing.root, subPath.trim(), listing.sep)
      : '';
  const jumpPending =
    view === 'dir' && !!listing && !!typedTarget && !samePathLoose(typedTarget, listing.path);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 工具条：上级 / 地址（灰显根 + 可编辑路径）/ 刷新（有未提交地址时变为前进） */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border p-2">
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('fileBrowser.parent')}
          aria-label={t('fileBrowser.parent')}
          disabled={upDisabled}
          onClick={handleUp}
        >
          <ArrowUp className="size-4" />
        </Button>
        {/* 地址栏：本机视图显示「本机」；进入磁盘/目录后只显示绝对路径；普通模式显示灰显根前缀 + 可编辑后缀 */}
        <div className="flex h-8 min-w-0 flex-1 items-center overflow-hidden rounded-lg border border-input bg-muted/40 px-2">
          {view === 'drives' ? (
            <span className="max-w-[50%] shrink-0 truncate font-mono text-xs text-muted-foreground">
              {t('fileBrowser.localMachine')}
            </span>
          ) : systemMode ? null : (
            <span
              className="max-w-[50%] shrink-0 truncate font-mono text-xs text-muted-foreground"
              title={listing ? rootDisplay(listing.root, listing.sep) : ''}
            >
              {listing ? rootDisplay(listing.root, listing.sep) : ''}
            </span>
          )}
          <input
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none disabled:cursor-not-allowed"
            value={subPath}
            disabled={view === 'drives'}
            placeholder={view === 'drives' ? '' : undefined}
            onChange={(e) => setSubPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSubPath();
            }}
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          title={view === 'drives' ? t('fileBrowser.refresh') : jumpPending ? t('fileBrowser.go') : t('fileBrowser.refresh')}
          aria-label={view === 'drives' ? t('fileBrowser.refresh') : jumpPending ? t('fileBrowser.go') : t('fileBrowser.refresh')}
          disabled={view === 'drives' ? drivesLoading : loading}
          onClick={() => {
            if (view === 'drives') {
              void loadDrives();
            } else if (jumpPending) {
              submitSubPath();
            } else if (listing) {
              void load(listing.path, systemMode ? null : listing.root);
            }
          }}
        >
          {(view === 'drives' ? drivesLoading : loading) ? (
            <Loader2 className="size-4 animate-spin" />
          ) : view === 'dir' && jumpPending ? (
            <ArrowRight className="size-4" />
          ) : (
            <RotateCw className="size-4" />
          )}
        </Button>
      </div>

      {/* 条目数超上限截断提示 */}
      {view === 'dir' && listing?.truncated && (
        <div className="shrink-0 border-b border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
          {t('fileBrowser.truncated')}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        {view === 'drives' ? (
          drivesError ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-destructive">
              <TriangleAlert className="size-5" />
              <span className="break-all text-xs">{drivesError}</span>
            </div>
          ) : !drives && drivesLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span className="text-xs">{t('fileBrowser.loading')}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2 p-3">
              {(drives ?? []).map((drive) => {
                const used = Math.max(0, drive.totalBytes - drive.freeBytes);
                const pct = drive.totalBytes > 0 ? Math.min(100, (used / drive.totalBytes) * 100) : 0;
                const label =
                  drive.kind === 'drive'
                    ? t('fileBrowser.driveLabel', { letter: drive.letter })
                    : drive.kind === 'root'
                      ? t('fileBrowser.filesystemRoot')
                      : drive.kind === 'home'
                        ? t('fileBrowser.homeDir')
                        : drive.letter;
                return (
                  <button
                    key={drive.path}
                    type="button"
                    title={drive.path}
                    onClick={() => openDrive(drive)}
                    className="flex w-full cursor-pointer items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
                  >
                    <HardDrive className="mt-0.5 size-5 shrink-0 text-primary-strong" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate text-xs text-foreground">{label}</span>
                      {drive.totalBytes > 0 && (
                        <>
                          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="tabular-nums text-[10px] text-muted-foreground">
                            {t('fileBrowser.driveFree', {
                              free: formatSize(drive.freeBytes),
                              total: formatSize(drive.totalBytes),
                            })}
                          </span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )
        ) : error ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-destructive">
            <TriangleAlert className="size-5" />
            <span className="break-all text-xs">{error}</span>
          </div>
        ) : !listing && loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-xs">{t('fileBrowser.loading')}</span>
          </div>
        ) : listing && listing.entries.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            {t('fileBrowser.empty')}
          </div>
        ) : listing ? (
          <div className="flex flex-col gap-0.5 p-1.5">
            {listing.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                title={entry.path}
                onClick={() => {
                  if (entry.kind === 'directory') void load(entry.path, systemMode ? null : listing.root);
                  else handleOpenFile(entry.path);
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
              >
                {entry.kind === 'directory' ? (
                  <Folder className="size-4 shrink-0 text-primary-strong" />
                ) : (
                  <FileTypeIcon fileName={entry.name} size={16} className="shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{entry.name}</span>
                {entry.kind === 'file' && (
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {formatSize(entry.size)}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}
