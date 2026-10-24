// webui/src/components/shared/ComputerPanel.tsx
// 「Computer」侧栏标签：cua-driver 实时画面 / 窗口选择 / 动作时间线 / 暂停与安装。
// - 画面通过 /api/computer/screenshot（带 Authorization 的 fetch → objectURL），避免 <img> 丢 token
// - status 每 5s、截图每 2s 轮询；面板隐藏/页面不可见时停止
// - WS computer.activity / computer.status 到达时立即刷新
// - 未安装时显示安装按钮 + 官方命令；安装仅 Windows 生效（后端返回明确错误）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleAlert,
  Download,
  Loader2,
  Monitor,
  Pause,
  Play,
  PlugZap,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/http';
import { wsClient } from '../../api/ws';
import { cn } from '@/lib/utils';
import type {
  ComputerActivity,
  ComputerStatus,
  ComputerWindowInfo,
  WSMessage,
} from '../../types/api';

interface ComputerPanelProps {
  /** 会话 id（= taskId）；用于过滤动作时间线 */
  sessionId: string;
  /** 面板当前是否展示（隐藏时停止轮询） */
  active: boolean;
}

const STATUS_POLL_MS = 5000;
const SCREENSHOT_POLL_MS = 2000;

/** 目标选择值：desktop 或 window:<pid>:<window_id> */
const DESKTOP_TARGET = 'desktop';

function windowTargetKey(pid: number, windowId: number): string {
  return `window:${pid}:${windowId}`;
}

function parseTargetKey(key: string): { target: 'desktop' | 'window'; pid?: number; windowId?: number } {
  if (key === DESKTOP_TARGET) return { target: 'desktop' };
  const parts = key.split(':');
  if (parts.length !== 3 || parts[0] !== 'window') return { target: 'desktop' };
  const pid = Number(parts[1]);
  const windowId = Number(parts[2]);
  if (!Number.isFinite(pid) || !Number.isFinite(windowId)) return { target: 'desktop' };
  return { target: 'window', pid, windowId };
}

/** 从 activity.target（如 "window pid=1 id=2"）解析跟随目标 */
function parseActivityTarget(target: string): string | null {
  const match = /pid=(\d+)\s+id=(\d+)/.exec(target);
  if (!match) return null;
  return windowTargetKey(Number(match[1]), Number(match[2]));
}

function windowLabel(w: ComputerWindowInfo, fallback: string): string {
  const title = (w.title ?? '').trim();
  const app = (w.app_name ?? '').trim();
  const name = title || app || fallback;
  return `${name} · pid ${w.pid} · #${w.window_id}`;
}

function formatClock(ts: number | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '—';
  }
}

export function ComputerPanel({ sessionId, active }: ComputerPanelProps) {
  const { t } = useTranslation();

  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [windows, setWindows] = useState<ComputerWindowInfo[]>([]);
  const [activities, setActivities] = useState<ComputerActivity[]>([]);
  const [targetKey, setTargetKey] = useState<string>(DESKTOP_TARGET);
  const [followAgent, setFollowAgent] = useState(true);
  const [onScreenOnly, setOnScreenOnly] = useState(true);
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const [shotAt, setShotAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string | null>(null);

  // 轮询闭包读取最新值，避免依赖变化重建定时器
  const statusRef = useRef<ComputerStatus | null>(null);
  statusRef.current = status;
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;
  const followRef = useRef(followAgent);
  followRef.current = followAgent;
  const activeRef = useRef(active);
  activeRef.current = active;
  const shotUrlRef = useRef<string | null>(null);
  const shotSeqRef = useRef(0);

  const connected = status?.installed === true && status.connection === 'connected';

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api.getComputerStatus(sessionId);
      setStatus(next);
      setActivities(next.activities ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  const loadWindows = useCallback(async () => {
    if (!connected) return;
    try {
      const res = await api.listComputerWindows(onScreenOnly);
      setWindows(res.windows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [connected, onScreenOnly]);

  const refreshShot = useCallback(async () => {
    if (!activeRef.current) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const current = statusRef.current;
    if (!current?.installed || current.connection !== 'connected') return;

    const target = parseTargetKey(targetRef.current);
    const seq = ++shotSeqRef.current;
    try {
      const blob = await api.fetchComputerScreenshot({
        ...target,
        maxDimension: current.config.maxImageDimension,
      });
      // 丢弃过期响应（用户已切换目标/连续刷新）
      if (seq !== shotSeqRef.current) return;
      const url = URL.createObjectURL(blob);
      if (shotUrlRef.current) URL.revokeObjectURL(shotUrlRef.current);
      shotUrlRef.current = url;
      setShotUrl(url);
      setShotAt(Date.now());
      setError(null);
    } catch (err) {
      if (seq !== shotSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 状态轮询（仅面板 active）
  useEffect(() => {
    if (!active) return;
    void refreshStatus();
    const timer = setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [active, refreshStatus]);

  // 连接后加载窗口列表（仅在屏幕可见范围变化时重新拉取）
  useEffect(() => {
    if (!active || !connected) return;
    void loadWindows();
  }, [active, connected, loadWindows]);

  // 实时画面轮询（连接后启动；隐藏时停止）
  useEffect(() => {
    if (!active || !connected) return;
    void refreshShot();
    const timer = setInterval(() => {
      void refreshShot();
    }, SCREENSHOT_POLL_MS);
    return () => clearInterval(timer);
  }, [active, connected, refreshShot]);

  // 目标切换立即刷新
  useEffect(() => {
    if (!active || !connected) return;
    void refreshShot();
  }, [targetKey, active, connected, refreshShot]);

  // WS：活动/状态即时刷新
  useEffect(() => {
    const unsub = wsClient.onMessage((msg: WSMessage) => {
      if (msg.type === 'computer.status') {
        void refreshStatus();
        return;
      }
      if (msg.type !== 'computer.activity') return;
      const payload = msg.payload as ComputerActivity | undefined;
      if (!payload) return;
      if (payload.sessionId && payload.sessionId !== sessionId) return;

      setActivities((prev) => {
        const rest = prev.filter((item) => item.id !== payload.id);
        return [payload, ...rest].slice(0, 20);
      });

      if (followRef.current) {
        const nextTarget = parseActivityTarget(payload.target ?? '');
        if (nextTarget && nextTarget !== targetRef.current) {
          setTargetKey(nextTarget);
        }
      }
      // Agent 动作后立即刷新画面
      void refreshShot();
    });
    return unsub;
  }, [sessionId, refreshStatus, refreshShot]);

  // 卸载：释放 objectURL
  useEffect(() => {
    return () => {
      if (shotUrlRef.current) {
        URL.revokeObjectURL(shotUrlRef.current);
        shotUrlRef.current = null;
      }
    };
  }, []);

  const sortedWindows = useMemo(() => {
    return [...windows]
      .filter((w) => w.window_id > 0)
      .sort((a, b) => (a.is_on_screen === b.is_on_screen ? 0 : a.is_on_screen ? -1 : 1));
  }, [windows]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setError(null);
    setInstallOutput(null);
    try {
      const result = await api.installComputerDriver();
      setInstallOutput(result.output);
      if (!result.ok) setError(result.output);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }, [refreshStatus]);

  const handleControl = useCallback(
    async (action: 'pause' | 'resume' | 'reconnect') => {
      setError(null);
      try {
        const next = await api.controlComputer(action);
        setStatus({ ...next, activities });
        if (action === 'reconnect') {
          void loadWindows();
          void refreshShot();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activities, loadWindows, refreshShot],
  );

  const handleRefreshAll = useCallback(async () => {
    setLoading(true);
    try {
      await refreshStatus();
      await loadWindows();
      await refreshShot();
    } finally {
      setLoading(false);
    }
  }, [refreshStatus, loadWindows, refreshShot]);

  const statusLabel = (() => {
    if (!status) return t('computer.status.loading');
    if (status.connection === 'installing') return t('computer.status.installing');
    if (!status.installed) return t('computer.status.notInstalled');
    if (status.connection === 'connecting') return t('computer.status.connecting');
    if (status.connection === 'error') return t('computer.status.error');
    if (status.connection === 'connected') return t('computer.status.connected');
    return t('computer.status.disconnected');
  })();

  const badgeVariant =
    status?.connection === 'connected'
      ? 'outline'
      : status?.connection === 'error'
        ? 'destructive'
        : 'secondary';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 头部：状态 / 版本 / 安装 / 刷新 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Monitor className="size-4 shrink-0 text-primary-strong" />
        <span className="text-xs font-medium text-foreground">{t('computer.title')}</span>
        <Badge variant={badgeVariant} className="gap-1">
          <span
            className={cn(
              'size-1.5 rounded-full',
              status?.connection === 'connected'
                ? 'bg-emerald-500'
                : status?.connection === 'error'
                  ? 'bg-destructive'
                  : 'bg-muted-foreground/60',
            )}
          />
          {statusLabel}
        </Badge>
        {status?.version && (
          <span className="text-[11px] text-muted-foreground">{status.version}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {status && !status.installed && (
            <Button size="sm" onClick={handleInstall} disabled={installing}>
              {installing ? <Loader2 className="animate-spin" /> : <Download />}
              {t('computer.installDriver')}
            </Button>
          )}
          {status?.installed && status.connection !== 'connected' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleControl('reconnect')}
              disabled={status.connection === 'connecting'}
            >
              <PlugZap />
              {t('computer.reconnect')}
            </Button>
          )}
          {status?.paused ? (
            <Button size="sm" variant="outline" onClick={() => void handleControl('resume')}>
              <Play />
              {t('computer.resume')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleControl('pause')}
              disabled={!connected}
            >
              <Pause />
              {t('computer.pause')}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void handleRefreshAll()}
            disabled={loading}
            title={t('computer.refresh')}
          >
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* 暂停横幅 */}
      {status?.paused && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <Pause className="size-3.5 shrink-0" />
          {t('computer.pausedBanner')}
        </div>
      )}

      {/* 未安装：安装引导；状态读取中先显示加载 */}
      {!status ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : !status.installed ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-5">
          <div className="flex w-full max-w-md flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Download className="size-4" />
              {t('computer.installTitle')}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('computer.installHint')}
            </p>
            <Button onClick={handleInstall} disabled={installing} className="self-start">
              {installing ? <Loader2 className="animate-spin" /> : <Download />}
              {installing ? t('computer.installing') : t('computer.installDriver')}
            </Button>
            <div className="rounded-lg border border-border bg-muted/30 p-2.5">
              <div className="mb-1 text-[11px] text-muted-foreground">
                {t('computer.manualInstall')}
              </div>
              <code className="mono block break-all text-[11px] text-foreground">
                irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex
              </code>
            </div>
            <a
              className="text-[11px] text-primary-strong underline-offset-4 hover:underline"
              href="https://cua.ai/docs/cua-driver"
              target="_blank"
              rel="noreferrer"
            >
              {t('computer.docs')}
            </a>
            {error && (
              <div className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-all">{error}</span>
              </div>
            )}
            {installOutput && (
              <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/30 p-2 text-[10px] text-muted-foreground">
                {installOutput}
              </pre>
            )}
          </div>
        </div>
      ) : !connected ? (
        // 已安装但未连接：错误/连接中
        <div className="flex min-h-0 flex-1 items-center justify-center p-5">
          <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
            {status.connection === 'connecting' || status.connection === 'installing' ? (
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            ) : (
              <CircleAlert className="size-6 text-destructive" />
            )}
            <p className="text-xs text-muted-foreground">
              {status.connection === 'connecting' ? t('computer.status.connecting') : (status.error ?? statusLabel)}
            </p>
            <Button size="sm" variant="outline" onClick={() => void handleControl('reconnect')}>
              <PlugZap />
              {t('computer.reconnect')}
            </Button>
          </div>
        </div>
      ) : (
        // 已连接：目标选择 + 画面 + 时间线
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
            <Select value={targetKey} onValueChange={setTargetKey}>
              <SelectTrigger size="sm" className="max-w-[260px]">
                <SelectValue placeholder={t('computer.target')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DESKTOP_TARGET}>{t('computer.desktop')}</SelectItem>
                {sortedWindows.map((w) => (
                  <SelectItem
                    key={`${w.pid}:${w.window_id}`}
                    value={windowTargetKey(w.pid, w.window_id)}
                  >
                    {windowLabel(w, t('computer.unknownWindow'))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
              <Switch size="sm" checked={followAgent} onCheckedChange={setFollowAgent} />
              {t('computer.followAgent')}
            </label>

            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
              <Switch
                size="sm"
                checked={!onScreenOnly}
                onCheckedChange={(v) => setOnScreenOnly(!v)}
              />
              {t('computer.showAllWindows')}
            </label>

            <span className="ml-auto text-[11px] text-muted-foreground">
              {t('computer.captureAt', { time: formatClock(shotAt) })}
            </span>
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden bg-black/85">
            {shotUrl ? (
              <img
                src={shotUrl}
                alt={t('computer.title')}
                className="size-full object-contain"
                draggable={false}
              />
            ) : (
              <div className="flex size-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-white/50" />
              </div>
            )}
            {error && (
              <div className="absolute inset-x-2 bottom-2 flex items-start gap-1.5 rounded-md bg-destructive/90 px-2 py-1.5 text-[11px] text-white">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-all">{error}</span>
              </div>
            )}
          </div>

          {/* 动作时间线 */}
          <div className="flex h-40 shrink-0 flex-col border-t border-border">
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[11px] font-medium text-foreground">
                {t('computer.activity')}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t('computer.activityCount', { count: activities.length })}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-3 pb-2">
              {activities.length === 0 ? (
                <div className="py-4 text-center text-[11px] text-muted-foreground">
                  {t('computer.noActivity')}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {activities.map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        'flex items-center gap-2 rounded-md border border-border/60 px-2 py-1 text-[11px]',
                        item.isError && 'border-destructive/30 bg-destructive/5',
                      )}
                    >
                      <span className="shrink-0 text-muted-foreground">
                        {formatClock(item.ts)}
                      </span>
                      <span className="shrink-0 font-medium text-foreground">{item.action}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {item.summary}
                        {item.target && item.target !== '—' ? ` · ${item.target}` : ''}
                      </span>
                      {item.effect && (
                        <span
                          className={cn(
                            'shrink-0 rounded px-1 py-px text-[10px]',
                            item.effect === 'confirmed'
                              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : item.effect === 'refused'
                                ? 'bg-destructive/10 text-destructive'
                                : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {item.effect}
                        </span>
                      )}
                      {item.verified === true && (
                        <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">
                          {t('computer.verified')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
