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
  SquareMousePointer,
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
import { usePlatform } from '../../hooks/usePlatform';
import { cn } from '@/lib/utils';
import type {
  ComputerActivity,
  ComputerCaptureMeta,
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
/** 自动目标轮询：800ms + 单飞（窗口截图比整屏轻，画面更连续） */
const SCREENSHOT_POLL_AUTO_MS = 800;
/** 手动目标轮询：1200ms */
const SCREENSHOT_POLL_MANUAL_MS = 1200;
/** 窗口列表刷新间隔（手动选择时） */
const WINDOW_LIST_POLL_MS = 10_000;

/** 目标选择值：auto / desktop / window:<pid>:<window_id> */
const AUTO_TARGET = 'auto';
const DESKTOP_TARGET = 'desktop';

interface ScreenshotFrame {
  url: string;
  meta: ComputerCaptureMeta;
  at: number;
}

function windowTargetKey(pid: number, windowId: number): string {
  return `window:${pid}:${windowId}`;
}

function parseTargetKey(
  key: string,
): { target: 'auto' | 'desktop' | 'window'; pid?: number; windowId?: number } {
  if (key === AUTO_TARGET) return { target: 'auto' };
  if (key === DESKTOP_TARGET) return { target: 'desktop' };
  const parts = key.split(':');
  if (parts.length !== 3 || parts[0] !== 'window') return { target: 'auto' };
  const pid = Number(parts[1]);
  const windowId = Number(parts[2]);
  if (!Number.isFinite(pid) || !Number.isFinite(windowId)) return { target: 'auto' };
  return { target: 'window', pid, windowId };
}

/** 预解码 objectURL：解码成功后再切换画面，避免闪白/跳变 */
function preloadImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = url;
  });
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
  // 后端平台为准：Android 上电脑控制整体置灰
  const { platform } = usePlatform();
  const mobileUnavailable = platform.isAndroid;
  /** 真正启用的轮询：标签可见且平台支持 */
  const enabled = active && !mobileUnavailable;

  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [windows, setWindows] = useState<ComputerWindowInfo[]>([]);
  const [activities, setActivities] = useState<ComputerActivity[]>([]);
  const [targetKey, setTargetKey] = useState<string>(AUTO_TARGET);
  const [followAgent, setFollowAgent] = useState(true);
  const [onScreenOnly, setOnScreenOnly] = useState(true);
  const [frame, setFrame] = useState<ScreenshotFrame | null>(null);
  const [prevFrame, setPrevFrame] = useState<ScreenshotFrame | null>(null);
  const [frameVisible, setFrameVisible] = useState(false);
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
  const activeRef = useRef(active);
  activeRef.current = enabled;
  const frameRef = useRef<ScreenshotFrame | null>(null);
  frameRef.current = frame;
  const prevFrameRef = useRef<ScreenshotFrame | null>(null);
  prevFrameRef.current = prevFrame;
  const shotSeqRef = useRef(0);
  /** 单飞：上一次截图未返回时跳过本次轮询，避免请求堆积 */
  const shotBusyRef = useRef(false);

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
    if (shotBusyRef.current) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const current = statusRef.current;
    if (!current?.installed || current.connection !== 'connected') return;

    const target = parseTargetKey(targetRef.current);
    const seq = ++shotSeqRef.current;
    shotBusyRef.current = true;
    try {
      const { blob, meta } = await api.fetchComputerScreenshot({
        ...target,
        sessionId,
        maxDimension: current.config.maxImageDimension,
      });
      // 丢弃过期响应（用户已切换目标/连续刷新）
      if (seq !== shotSeqRef.current) return;
      const url = URL.createObjectURL(blob);
      try {
        await preloadImage(url);
      } catch {
        URL.revokeObjectURL(url);
        throw new Error('image decode failed');
      }
      if (seq !== shotSeqRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      const now = Date.now();
      const previous = frameRef.current;
      const next: ScreenshotFrame = { url, meta, at: now };
      // 先隐藏新帧，再在下一帧淡入；旧帧保留在底层，避免闪白/跳变
      setFrameVisible(false);
      setPrevFrame(previous);
      setFrame(next);
      frameRef.current = next;
      requestAnimationFrame(() => setFrameVisible(true));
      setShotAt(now);
      setError(null);
      if (previous) {
        window.setTimeout(() => {
          URL.revokeObjectURL(previous.url);
          setPrevFrame(prev => (prev?.url === previous.url ? null : prev));
        }, 260);
      }
    } catch (err) {
      if (seq !== shotSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      shotBusyRef.current = false;
    }
  }, [sessionId, t]);

  // 状态轮询（仅面板 active 且平台支持）
  useEffect(() => {
    if (!enabled) return;
    void refreshStatus();
    const timer = setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, refreshStatus]);

  // 连接后加载窗口列表（仅在屏幕可见范围变化时重新拉取）
  useEffect(() => {
    if (!enabled || !connected) return;
    void loadWindows();
  }, [enabled, connected, loadWindows]);

  // 手动选择目标时定期刷新窗口列表（新窗口/关闭窗口及时可见）
  useEffect(() => {
    if (!enabled || !connected) return;
    if (followAgent || targetKey === AUTO_TARGET) return;
    const timer = setInterval(() => {
      void loadWindows();
    }, WINDOW_LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, connected, followAgent, targetKey, loadWindows]);

  // 实时画面轮询（连接后启动；隐藏时停止；自动目标更频繁以保持画面连续）
  useEffect(() => {
    if (!enabled || !connected) return;
    void refreshShot();
    const interval =
      followAgent || targetKey === AUTO_TARGET ? SCREENSHOT_POLL_AUTO_MS : SCREENSHOT_POLL_MANUAL_MS;
    const timer = setInterval(() => {
      void refreshShot();
    }, interval);
    return () => clearInterval(timer);
  }, [enabled, connected, followAgent, targetKey, refreshShot]);

  // 目标切换立即刷新
  useEffect(() => {
    if (!enabled || !connected) return;
    void refreshShot();
  }, [targetKey, enabled, connected, refreshShot]);

  // 自动跟随 = 目标固定 auto（Agent 操作窗优先，空闲跟前台）
  useEffect(() => {
    if (followAgent && targetKey !== AUTO_TARGET) setTargetKey(AUTO_TARGET);
  }, [followAgent, targetKey]);

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
      // 严格按会话隔离：新建对话（sessionId 为空）不接收任何会话的活动
      if (!sessionId || payload.sessionId !== sessionId) return;

      setActivities((prev) => {
        const rest = prev.filter((item) => item.id !== payload.id);
        return [payload, ...rest].slice(0, 20);
      });

      // Agent 动作后立即刷新画面（目标由后端 resolvePreviewTarget 决定）
      void refreshShot();
    });
    return unsub;
  }, [sessionId, refreshStatus, refreshShot]);

  // 卸载：释放 objectURL
  useEffect(() => {
    return () => {
      const current = frameRef.current;
      if (current) URL.revokeObjectURL(current.url);
      const previous = prevFrameRef.current;
      if (previous) URL.revokeObjectURL(previous.url);
      frameRef.current = null;
      prevFrameRef.current = null;
    };
  }, []);

  const sortedWindows = useMemo(() => {
    return [...windows]
      .filter((w) => w.window_id > 0)
      .sort((a, b) => (a.is_on_screen === b.is_on_screen ? 0 : a.is_on_screen ? -1 : 1));
  }, [windows]);

  /** 当前画面目标标签（来自响应头） */
  const targetLabel = useMemo(() => {
    const meta = frame?.meta;
    if (!meta) return t('computer.target');
    const title = (meta.title ?? '').trim();
    const fallbackName = `#${meta.windowId ?? '?'}`;
    if (meta.source === 'agent') {
      return `${t('computer.sourceAgent')} · ${title || fallbackName}`;
    }
    if (meta.source === 'desktop') return t('computer.fallbackDesktop');
    return title || t('computer.unknownWindow');
  }, [frame, t]);

  const isWindowTarget = parseTargetKey(targetKey).target === 'window';

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

  // 移动端（Android 后端）：整体不可用，不请求任何驱动接口
  if (mobileUnavailable) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-muted/30 px-4 py-6 text-center">
          <SquareMousePointer className="size-6 text-muted-foreground/60" />
          <span className="text-xs text-muted-foreground">{t('common.mobileUnavailableDesc')}</span>
        </div>
      </div>
    );
  }

  const failedChecks = (status?.health?.checks ?? []).filter((item) => item.status === 'fail');

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 头部：状态 / 版本 / 安装 / 刷新 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <SquareMousePointer className="size-4 shrink-0 text-primary-strong" />
        <span className="text-xs font-medium text-foreground">{t('computer.title')}</span>
        <Badge variant={badgeVariant} className="gap-1">
          <span
            className={cn(
              'size-1.5 rounded-full',
              status?.connection === 'connected'
                ? 'bg-success'
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
        <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          <Pause className="size-3.5 shrink-0" />
          {t('computer.pausedBanner')}
        </div>
      )}

      {/* 健康检查失败项（macOS 权限等）：给出可操作提示 */}
      {failedChecks.length > 0 && (
        <div className="flex flex-col gap-1 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          <div className="flex items-center gap-1.5 font-medium">
            <CircleAlert className="size-3.5 shrink-0" />
            {t('computer.healthFailed')}
          </div>
          {failedChecks.slice(0, 4).map((item) => (
            <div key={item.name} className="break-all pl-5">
              {item.name}: {item.message}
              {item.hint ? ` · ${item.hint}` : ''}
            </div>
          ))}
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
                {status.platform === 'win32'
                  ? t('computer.manualInstall')
                  : t('computer.manualInstallShell')}
              </div>
              <code className="mono block break-all text-[11px] text-foreground">
                {status.platform === 'win32'
                  ? 'irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex'
                  : 'curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh | bash -s -- --no-modify-path'}
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
            <Select
              value={targetKey}
              onValueChange={(value) => {
                setTargetKey(value);
                if (value !== AUTO_TARGET) setFollowAgent(false);
              }}
            >
              <SelectTrigger size="sm" className="max-w-[260px]">
                <SelectValue placeholder={t('computer.target')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_TARGET}>{t('computer.auto')}</SelectItem>
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
              <Switch
                size="sm"
                checked={followAgent}
                onCheckedChange={(v) => {
                  setFollowAgent(v);
                  setTargetKey(v ? AUTO_TARGET : DESKTOP_TARGET);
                }}
              />
              {t('computer.autoFollow')}
            </label>

            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
              <Switch
                size="sm"
                checked={!onScreenOnly}
                onCheckedChange={(v) => setOnScreenOnly(!v)}
              />
              {t('computer.showAllWindows')}
            </label>

            <span className="ml-auto flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
              <span className="max-w-[240px] truncate" title={targetLabel}>
                {targetLabel}
              </span>
              <span className="shrink-0">{t('computer.captureAt', { time: formatClock(shotAt) })}</span>
            </span>
          </div>
          {isWindowTarget && (
            <div className="border-b border-warning/30 bg-warning/10 px-3 py-1 text-[11px] text-warning">
              {t('computer.windowOverlayWarning')}
            </div>
          )}
          {targetKey === AUTO_TARGET && frame?.meta.source === 'desktop' && (
            <div className="border-b border-warning/30 bg-warning/10 px-3 py-1 text-[11px] text-warning">
              {t('computer.fallbackDesktop')}
            </div>
          )}

          <div className="relative min-h-0 flex-1 overflow-hidden bg-black/85">
            {prevFrame && (
              <img
                src={prevFrame.url}
                alt=""
                className="absolute inset-0 size-full object-contain"
                draggable={false}
              />
            )}
            {frame ? (
              <img
                key={frame.url}
                src={frame.url}
                alt={t('computer.title')}
                className="absolute inset-0 size-full object-contain"
                style={{ opacity: frameVisible ? 1 : 0, transition: 'opacity 180ms ease-out' }}
                draggable={false}
              />
            ) : error ? (
              // 截图失败：不再空转，直接给出错误与重试入口（轮询仍会自动恢复）
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
                <CircleAlert className="size-6 text-destructive" />
                <span className="break-all text-[11px] text-white/80">{error}</span>
                <Button size="sm" variant="outline" onClick={() => void refreshShot()}>
                  <RefreshCw />
                  {t('computer.retryCapture')}
                </Button>
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="size-5 animate-spin text-white/50" />
              </div>
            )}
            {frame && error && (
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
                              ? 'bg-success/10 text-success'
                              : item.effect === 'refused'
                                ? 'bg-destructive/10 text-destructive'
                                : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {item.effect}
                        </span>
                      )}
                      {item.verified === true && (
                        <span className="shrink-0 text-[10px] text-success">
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
