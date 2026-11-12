// webui/src/components/pages/overview/ResourcesSection.tsx
// 设置-概览「资源」：系统总量 + MOSS 自身占用（概览 / CPU 与内存 / 磁盘 / 网络）。
// 数据源：GET /api/system-monitor/snapshot——CPU/内存走 ?light=1 轻量实时（1s），
// 进程/网络/磁盘走全量快照（概览 15s、CPU/网络标签页 5s，切标签立即刷新）；
// AI 解读：WS 流式诊断（insight.diagnose kind=resource）。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  RefreshCw,
  Search,
  Sparkles,
  Wifi,
} from 'lucide-react';
import { api } from '@/api/http';
import { copyText } from '@/lib/clipboard';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InsightDialog } from '@/components/insight/InsightDialog';
import type { MossProcessInfo, ResourceLive, ResourceSnapshot } from '@/types/api';
import {
  Donut,
  RESOURCE_COLORS,
  TASK_MANAGER_WINDOW_MS,
  TaskManagerChart,
  type TaskManagerPoint,
  formatBytes,
  formatRate,
} from './charts';

/** 轻量实时轮询间隔（ms）：CPU/内存 1 秒一点，与任务管理器一致 */
const LIVE_POLL_MS = 1000;
/** 全量快照轮询间隔（ms）：概览/磁盘低频，避免频繁拉起 PowerShell/CIM 采样 */
const HEAVY_POLL_MS_DEFAULT = 15_000;
/** 全量快照轮询间隔（ms）：CPU 与内存 / 网络标签页更实时 */
const HEAVY_POLL_MS_DETAIL = 5_000;
/** 历史安全上限（60 秒窗口 + 余量；正常约 60~62 条） */
const HISTORY_MAX = 120;
/** 折线时间窗（ms）：左端 60 秒前，右端当前 */
const WINDOW_MS = TASK_MANAGER_WINDOW_MS;

/** 首帧占位：真实快照到达前渲染骨架，避免整页 loading 遮罩 */
const EMPTY_SNAPSHOT: ResourceSnapshot = {
  cpu: { usagePercent: 0, cores: 0, model: '—', mossPercent: 0 },
  memory: { totalBytes: 0, usedBytes: 0, usedPercent: 0, mossBytes: 0 },
  disk: { drive: '', totalBytes: 0, freeBytes: 0, usedPercent: 0, categories: [] },
  network: { interfaces: [] },
  moss: { pid: 0, processes: [] },
  sampledAt: '',
};

/** 磁盘分类（MOSS 数据目录）配色：项目级色卡同色系阶梯 */
const CATEGORY_COLORS: Record<string, string> = {
  logs: 'var(--palette-chart-cat-logs)',
  memory: 'var(--palette-chart-cat-memory)',
  live: 'var(--palette-chart-cat-live)',
  tasks: 'var(--palette-chart-cat-tasks)',
  todo: 'var(--palette-chart-cat-todo)',
  terminals: 'var(--palette-chart-cat-terminals)',
  free: 'var(--palette-chart-cat-free)',
  other: 'var(--palette-chart-cat-other)',
};

type ResourceTab = 'overview' | 'cpu-memory' | 'disk' | 'network';
type ProcessSort = 'memory' | 'cpu';

interface Sample {
  /** 采样时刻（毫秒时间戳）：折线按真实时间定位（右边缘=当前） */
  at: number;
  cpu: number;
  mem: number;
  rx: number;
  tx: number;
}

function pct(n: number): string {
  return `${(Math.round(n * 10) / 10).toFixed(1)}%`;
}

/** 资源健康级别 */
function bannerLevel(s: ResourceSnapshot): 'ok' | 'warn' | 'high' {
  const { cpu, memory, disk } = s;
  if (cpu.usagePercent >= 85 || memory.usedPercent >= 90 || disk.usedPercent >= 90) return 'high';
  if (cpu.usagePercent >= 70 || memory.usedPercent >= 80 || disk.usedPercent >= 80) return 'warn';
  return 'ok';
}

/** 多色分段条（占比） */
function SegmentedBar({ items }: { items: Array<{ key: string; bytes: number; color?: string }> }) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.bytes), 0);
  if (total <= 0) return <div className="h-2 w-full rounded-full bg-muted" />;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      {items.map((item) => (
        <div
          key={item.key}
          title={`${item.key}: ${formatBytes(item.bytes)}`}
          style={{
            width: `${(Math.max(0, item.bytes) / total) * 100}%`,
            backgroundColor: item.color ?? CATEGORY_COLORS[item.key] ?? 'var(--palette-chart-cat-other)',
          }}
        />
      ))}
    </div>
  );
}

/** 资源主卡：环形进度 + 数值 + 迷你实时趋势 */
function RingCard({
  icon: Icon,
  title,
  percent,
  color,
  main,
  badge,
  sub1,
  sub2,
  history,
}: {
  icon: typeof Cpu;
  title: string;
  percent: number;
  color: string;
  main: string;
  /** 标题行右侧次要信息 */
  badge?: string;
  sub1: string;
  sub2?: string;
  /** 任务管理器式迷你趋势点（60 秒窗口，右端=当前） */
  history?: TaskManagerPoint[];
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-border">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        <span className="truncate">{title}</span>
        {badge !== undefined && <span className="ml-auto shrink-0 tabular-nums">{badge}</span>}
      </div>
      <div className="flex items-center gap-3">
        <Donut
          segments={[{ key: 'used', color, value: Math.max(0.01, percent) }, { key: 'free', color: 'transparent', value: Math.max(0.01, 100 - percent) }]}
          size={76}
          centerTop={main}
          centerSub={undefined}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[11px] text-muted-foreground" title={sub1}>{sub1}</span>
          {sub2 !== undefined && (
            <span className="truncate text-[11px] text-muted-foreground/80" title={sub2}>{sub2}</span>
          )}
        </div>
      </div>
      {history !== undefined && history.length > 0 && (
        <div className="pt-0.5 opacity-80">
          <TaskManagerChart points={history} color={color} variant="compact" height={26} />
        </div>
      )}
    </div>
  );
}

/** 网络卡：总速率 + 上下行条 + 迷你趋势（速率无「总量百分比」语义，不用环形） */
function NetworkCard({
  rx,
  tx,
  count,
  history,
  ready = true,
}: {
  rx: number;
  tx: number;
  count: number;
  /** 任务管理器式迷你趋势点（60 秒窗口，右端=当前） */
  history: TaskManagerPoint[];
  ready?: boolean;
}) {
  const { t } = useTranslation();
  const total = rx + tx;
  const peak = Math.max(1, rx, tx);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-border">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Wifi className="size-3.5" />
        <span className="truncate">{t('resourceMonitor.network')}</span>
        <span className="ml-auto shrink-0 tabular-nums">{count} {t('resourceMonitor.netCount')}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums text-foreground">{ready ? formatRate(total) : '—'}</span>
        <span className="text-[11px] text-muted-foreground">{t('resourceMonitor.netTotal')}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 whitespace-nowrap text-[11px] text-success">↓ {ready ? formatRate(rx) : '—'}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-success transition-[width] duration-500" style={{ width: `${(rx / peak) * 100}%` }} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 whitespace-nowrap text-[11px] text-info">↑ {ready ? formatRate(tx) : '—'}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-info transition-[width] duration-500" style={{ width: `${(tx / peak) * 100}%` }} />
          </div>
        </div>
      </div>
      {history.length > 0 && (
        <div className="opacity-80">
          <TaskManagerChart
            points={history}
            color={RESOURCE_COLORS.network}
            variant="compact"
            height={26}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 进程表（memo）：页面 1s 轮询只为刷新 CPU/内存折线；
 * 进程数组在两次全量采样之间引用不变（后端复用 latestSnapshot.moss），
 * memo 可避免每秒重排/重渲最多 200 行进程。
 */
const ProcessTable = memo(function ProcessTable({
  processes,
  onlyHigh,
  onToggleHigh,
  query,
  onQueryChange,
  sort,
  onSortChange,
}: {
  processes: MossProcessInfo[];
  onlyHigh: boolean;
  onToggleHigh: (value: boolean) => void;
  query: string;
  onQueryChange: (value: string) => void;
  sort: ProcessSort;
  onSortChange: (value: ProcessSort) => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = processes.filter((proc) => {
      if (onlyHigh && proc.cpuPercent < 5 && proc.rssBytes < 200 * 1024 * 1024) return false;
      if (q !== '' && !proc.name.toLowerCase().includes(q) && !String(proc.pid).includes(q)) return false;
      return true;
    });
    return filtered.sort((a, b) => (sort === 'cpu' ? b.cpuPercent - a.cpuPercent : b.rssBytes - a.rssBytes));
  }, [processes, onlyHigh, query, sort]);

  const copy = (text: string): void => {
    void copyText(text).then((ok) => {
      if (ok) toast.success(t('resourceMonitor.copied'));
      else toast.error(t('resourceMonitor.copyFailed'));
    });
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{t('resourceMonitor.processList')}</span>
          <Badge variant="secondary" className="tabular-nums">{rows.length}</Badge>
        </div>
        <div className="relative ml-auto w-40">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('resourceMonitor.processSearch')}
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Tabs value={sort} onValueChange={(next) => onSortChange(next as ProcessSort)}>
          <TabsList>
            <TabsTrigger value="memory">{t('resourceMonitor.sortMemory')}</TabsTrigger>
            <TabsTrigger value="cpu">{t('resourceMonitor.sortCpu')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={onlyHigh} onCheckedChange={(v) => onToggleHigh(v === true)} />
          {t('resourceMonitor.onlyHighUsage')}
        </label>
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() =>
            copy(rows.map((proc) => `${proc.pid}\t${proc.name}\t${proc.cpuPercent}%\t${formatBytes(proc.rssBytes)}`).join('\n'))
          }
        >
          {t('resourceMonitor.copyAll')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
            <tr className="text-left text-muted-foreground">
              <th className="px-2 py-1.5 font-medium">{t('resourceMonitor.processName')}</th>
              <th className="px-2 py-1.5 font-medium">PID</th>
              <th className="px-2 py-1.5 text-right font-medium">{t('resourceMonitor.cpuPercent')}</th>
              <th className="px-2 py-1.5 text-right font-medium">{t('resourceMonitor.rssMemory')}</th>
              <th className="px-2 py-1.5 font-medium">{t('resourceMonitor.processGroup')}</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((proc) => (
              <tr
                key={proc.pid}
                className={cn(
                  'border-t border-border/50 transition-colors hover:bg-muted/40',
                  proc.isMoss && 'bg-primary/[0.04]',
                )}
              >
                <td className="max-w-[220px] truncate px-2 py-1.5 text-foreground" title={proc.name}>
                  {proc.isMoss && <span className="mr-1.5 inline-block h-3 w-0.5 rounded-full bg-primary align-middle" />}
                  {proc.name}
                </td>
                <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{proc.pid}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{proc.cpuPercent.toFixed(1)}%</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatBytes(proc.rssBytes)}</td>
                <td className="px-2 py-1.5">
                  {proc.isMoss ? (
                    <Badge variant={proc.group === 'server' ? 'default' : 'secondary'} className="text-[10px]">
                      {t(`resourceMonitor.group.${proc.group}`)}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground/50">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => copy(`${proc.name} (pid=${proc.pid})`)}
                  >
                    {t('resourceMonitor.copy')}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-8 text-center text-muted-foreground">
                  {t('resourceMonitor.noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
});

export function ResourcesSection() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ResourceTab>('overview');
  /** 全量快照（进程/网络/磁盘/MOSS）：低频刷新 */
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  /** 轻量实时快照（CPU/内存）：1s 刷新 */
  const [live, setLive] = useState<ResourceLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const [onlyHigh, setOnlyHigh] = useState(false);
  const [procQuery, setProcQuery] = useState('');
  const [procSort, setProcSort] = useState<ProcessSort>('memory');
  const [reportOpen, setReportOpen] = useState(false);

  /** 当前标签（轮询定时器内读取；变化时不重建定时器） */
  const tabRef = useRef<ResourceTab>(tab);
  tabRef.current = tab;
  /** 暂停轮询：页面隐藏或窗口失焦（可见但不在前台也没有观看价值） */
  const pausedRef = useRef(false);
  /** 最近一次全量快照的网络合计：轻量 tick 追加历史时复用，避免额外拉起网卡采样 */
  const netRef = useRef({ rx: 0, tx: 0 });
  const liveInFlightRef = useRef(false);
  const heavyInFlightRef = useRef(false);

  /** 写入全量快照并缓存网络合计 */
  const applyHeavy = useCallback((next: ResourceSnapshot) => {
    setSnapshot(next);
    netRef.current = {
      rx: next.network.interfaces.reduce((sum, iface) => sum + iface.rxRate, 0),
      tx: next.network.interfaces.reduce((sum, iface) => sum + iface.txRate, 0),
    };
  }, []);

  /** 全量采样（force=1 请求后端立即刷新；后端有最小间隔兜底，不会连续拉起 PowerShell） */
  const refreshHeavy = useCallback(
    async (force = false): Promise<void> => {
      if (heavyInFlightRef.current) return;
      heavyInFlightRef.current = true;
      try {
        const next = await api.getResourceSnapshot(force ? { force: true } : undefined);
        applyHeavy(next);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        heavyInFlightRef.current = false;
      }
    },
    [applyHeavy],
  );

  /** 轻量采样：CPU/内存 1s 一点 + 历史落点（网络值沿用最近一次全量快照） */
  const fetchLive = useCallback(async (): Promise<void> => {
    if (liveInFlightRef.current) return;
    liveInFlightRef.current = true;
    try {
      const next = await api.getResourceLive();
      setLive(next);
      setError(null);
      const parsed = Date.parse(next.sampledAt);
      const at = Number.isFinite(parsed) ? parsed : Date.now();
      const { rx, tx } = netRef.current;
      setHistory((prev) => {
        // 同一采样重复返回（缓存命中）不重复落点
        if (prev.length > 0 && prev[prev.length - 1].at === at) return prev;
        const appended = [
          ...prev,
          { at, cpu: next.cpu.usagePercent, mem: next.memory.usedPercent, rx, tx },
        ];
        // 时间窗裁剪（保留 2s 余量给左边缘），再套条数安全上限
        const cutoff = at - WINDOW_MS - 2000;
        const kept = appended.filter((sample) => sample.at >= cutoff);
        return kept.length > HISTORY_MAX ? kept.slice(kept.length - HISTORY_MAX) : kept;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      liveInFlightRef.current = false;
    }
  }, []);

  // 主轮询：1s 轻量；按当前标签每 5s / 15s 触发一次全量。
  // 页面隐藏或窗口失焦时完全暂停；恢复前台时立即补采（轻量 + 强制全量）。
  useEffect(() => {
    pausedRef.current = document.hidden;
    let tickCount = 0;
    const tick = (): void => {
      if (pausedRef.current) return;
      void fetchLive();
      const detailTab = tabRef.current === 'cpu-memory' || tabRef.current === 'network';
      const heavyEvery = Math.max(
        1,
        Math.round((detailTab ? HEAVY_POLL_MS_DETAIL : HEAVY_POLL_MS_DEFAULT) / LIVE_POLL_MS),
      );
      tickCount += 1;
      if (tickCount % heavyEvery === 0) void refreshHeavy(false);
    };
    const resume = (): void => {
      pausedRef.current = false;
      void fetchLive();
      void refreshHeavy(true);
    };
    const onVisibility = (): void => {
      if (document.hidden) pausedRef.current = true;
      else resume();
    };
    const onFocus = (): void => resume();
    const onBlur = (): void => {
      pausedRef.current = true;
    };
    void fetchLive();
    void refreshHeavy(false);
    const timer = window.setInterval(tick, LIVE_POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [fetchLive, refreshHeavy]);

  // 切到需要明细数据的标签：立即拉一次全量，避免等周期
  useEffect(() => {
    if (tab === 'cpu-memory' || tab === 'network' || tab === 'disk') {
      void refreshHeavy(true);
    }
  }, [tab, refreshHeavy]);

  /** 合并视图：CPU/内存取 1s 实时值，其余取全量快照 */
  const view = useMemo<ResourceSnapshot>(() => {
    const base = snapshot ?? EMPTY_SNAPSHOT;
    return live ? { ...base, cpu: live.cpu, memory: live.memory } : base;
  }, [snapshot, live]);
  const ready = snapshot !== null || live !== null;
  /** 状态条时间：优先实时采样时间 */
  const sampledAt = live?.sampledAt ?? snapshot?.sampledAt ?? '';
  const level = ready ? bannerLevel(view) : 'ok';
  const levelClass =
    level === 'high'
      ? 'border-danger/40 bg-danger/10 text-danger'
      : level === 'warn'
        ? 'border-warning/40 bg-warning/10 text-warning'
        : 'border-success/40 bg-success/10 text-success';
  const levelText =
    level === 'high'
      ? t('resourceMonitor.statusHigh')
      : level === 'warn'
        ? t('resourceMonitor.statusWarn')
        : t('resourceMonitor.statusOk');

  const mossProcessCount = useMemo(
    () => snapshot?.moss.processes.filter((proc) => proc.isMoss).length ?? 0,
    [snapshot],
  );
  const netRx = snapshot?.network.interfaces.reduce((sum, n) => sum + n.rxRate, 0) ?? 0;
  const netTx = snapshot?.network.interfaces.reduce((sum, n) => sum + n.txRate, 0) ?? 0;
  const netRxBytes = view.network.interfaces.reduce((sum, n) => sum + n.rxBytes, 0);
  const netTxBytes = view.network.interfaces.reduce((sum, n) => sum + n.txBytes, 0);
  const diskUsedBytes = snapshot ? view.disk.totalBytes - view.disk.freeBytes : 0;

  const refreshNow = async (): Promise<void> => {
    // 手动刷新 = 立即全量（force 受后端最小间隔兜底）
    await refreshHeavy(true);
  };

  return (
    <div className="flex flex-col gap-3 px-6 pb-8">
      {/* 状态条 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs', levelClass)}>
          <span className={cn('size-1.5 rounded-full', level === 'high' ? 'bg-danger' : level === 'warn' ? 'bg-warning' : 'bg-success', level !== 'ok' && 'animate-pulse')} />
          {levelText}
        </div>
        {ready ? (
          <span className="text-[11px] text-muted-foreground">
            {t('resourceMonitor.sampleAt', { time: new Date(sampledAt).toLocaleTimeString() })}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {error ?? t('resourceMonitor.loading')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1" onClick={() => void refreshNow()}>
            <RefreshCw className="size-3.5" />
            {t('common.refresh')}
          </Button>
          <Button size="sm" className="h-7 gap-1" onClick={() => setReportOpen(true)}>
            <Sparkles className="size-3.5" />
            {t('resourceMonitor.aiRead')}
          </Button>
        </div>
      </div>

      {/* 二级胶囊导航 */}
      <Tabs value={tab} onValueChange={(next) => setTab(next as ResourceTab)}>
        <TabsList aria-label={t('settings.overview.tabs.resources')}>
          <TabsTrigger value="overview" className="gap-1.5">
            <Activity className="size-3.5" />
            {t('resourceMonitor.tabOverview')}
          </TabsTrigger>
          <TabsTrigger value="cpu-memory" className="gap-1.5">
            <Cpu className="size-3.5" />
            {t('resourceMonitor.tabCpuMemory')}
          </TabsTrigger>
          <TabsTrigger value="disk" className="gap-1.5">
            <HardDrive className="size-3.5" />
            {t('resourceMonitor.tabDisk')}
          </TabsTrigger>
          <TabsTrigger value="network" className="gap-1.5">
            <Wifi className="size-3.5" />
            {t('resourceMonitor.tabNetwork')}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'overview' && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <RingCard
              icon={Cpu}
              title={t('resourceMonitor.cpu')}
              percent={ready ? view.cpu.usagePercent : 0}
              color={RESOURCE_COLORS.cpu}
              main={ready ? pct(view.cpu.usagePercent) : '—'}
              badge={`${view.cpu.cores}${t('resourceMonitor.coresSuffix')}`}
              sub1={view.cpu.model}
              sub2={`${t('resourceMonitor.mossUsage')} ${pct(view.cpu.mossPercent)}`}
              history={history.map((sample) => ({ at: sample.at, value: sample.cpu }))}
            />
            <RingCard
              icon={MemoryStick}
              title={t('resourceMonitor.memory')}
              percent={ready ? view.memory.usedPercent : 0}
              color={RESOURCE_COLORS.memory}
              main={ready ? formatBytes(view.memory.usedBytes) : '—'}
              badge={`${t('resourceMonitor.total')} ${formatBytes(view.memory.totalBytes)}`}
              sub1={`${t('resourceMonitor.mossUsage')} ${formatBytes(view.memory.mossBytes)}`}
              sub2={`${t('resourceMonitor.available')} ${formatBytes(Math.max(0, view.memory.totalBytes - view.memory.usedBytes))}`}
              history={history.map((sample) => ({ at: sample.at, value: sample.mem }))}
            />
            <RingCard
              icon={HardDrive}
              title={t('resourceMonitor.disk')}
              percent={ready ? view.disk.usedPercent : 0}
              color={RESOURCE_COLORS.disk}
              main={ready ? formatBytes(diskUsedBytes) : '—'}
              badge={view.disk.drive}
              sub1={`${t('resourceMonitor.free')} ${formatBytes(view.disk.freeBytes)}`}
              sub2={`${t('resourceMonitor.total')} ${formatBytes(view.disk.totalBytes)}`}
            />
            <NetworkCard
              rx={netRx}
              tx={netTx}
              count={view.network.interfaces.length}
              history={history.map((sample) => ({ at: sample.at, value: sample.rx + sample.tx }))}
              ready={ready}
            />
          </div>

          {/* 详情：全宽上下堆叠（取消两列式） */}
          <div className="flex flex-col gap-3">
            {/* MOSS 自身占用 */}
            <section className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4">
              <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Activity className="size-4 text-muted-foreground" />
                {t('resourceMonitor.mossUsage')}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-3 py-2">
                  <span className="text-[11px] text-muted-foreground">{t('resourceMonitor.processCount')}</span>
                  <span className="text-lg font-semibold tabular-nums text-foreground">{mossProcessCount}</span>
                </div>
                <div className="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-3 py-2">
                  <span className="text-[11px] text-muted-foreground">CPU</span>
                  <span className="text-lg font-semibold tabular-nums text-foreground">{pct(view.cpu.mossPercent)}</span>
                </div>
                <div className="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-3 py-2">
                  <span className="text-[11px] text-muted-foreground">{t('resourceMonitor.memory')}</span>
                  <span className="text-lg font-semibold tabular-nums text-foreground">{formatBytes(view.memory.mossBytes)}</span>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border/50 pt-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t('resourceMonitor.mossDataUsage')}</span>
                  <span className="tabular-nums">{formatBytes(view.disk.categories.reduce((sum, c) => sum + c.bytes, 0))}</span>
                </div>
                <SegmentedBar items={view.disk.categories} />
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {view.disk.categories.map((category) => (
                    <span key={category.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: CATEGORY_COLORS[category.key] ?? 'var(--palette-chart-cat-other)' }}
                      />
                      {t(`resourceMonitor.category.${category.key}`, { defaultValue: category.key })}
                      <span className="tabular-nums text-foreground/80">{formatBytes(category.bytes)}</span>
                    </span>
                  ))}
                </div>
              </div>
            </section>

            {/* 最近 60 秒（任务管理器式：右边缘=当前，从右向左实时打印） */}
            <section className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4">
              <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Activity className="size-4 text-muted-foreground" />
                {t('resourceMonitor.trendTitle')}
              </div>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className="size-2 rounded-full" style={{ backgroundColor: RESOURCE_COLORS.cpu }} />
                      CPU
                    </span>
                    <span className="tabular-nums">{ready ? pct(view.cpu.usagePercent) : '—'}</span>
                  </div>
                  <TaskManagerChart
                    points={history.map((sample) => ({ at: sample.at, value: sample.cpu }))}
                    color={RESOURCE_COLORS.cpu}
                    leftLabel={t('resourceMonitor.trendCpuAxis')}
                    rightLabel={t('resourceMonitor.trendScaleMax')}
                    footerLeft={t('resourceMonitor.trendWindowLeft')}
                    footerRight={t('resourceMonitor.trendNow')}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className="size-2 rounded-full" style={{ backgroundColor: RESOURCE_COLORS.memory }} />
                      {t('resourceMonitor.memory')}
                    </span>
                    <span className="tabular-nums">{ready ? pct(view.memory.usedPercent) : '—'}</span>
                  </div>
                  <TaskManagerChart
                    points={history.map((sample) => ({ at: sample.at, value: sample.mem }))}
                    color={RESOURCE_COLORS.memory}
                    leftLabel={t('resourceMonitor.trendMemAxis')}
                    rightLabel={t('resourceMonitor.trendScaleMax')}
                    footerLeft={t('resourceMonitor.trendWindowLeft')}
                    footerRight={t('resourceMonitor.trendNow')}
                  />
                </div>
              </div>
            </section>
          </div>
        </>
      )}

      {tab === 'cpu-memory' && (
        <div className="flex flex-col gap-3">
          {/* 上排数据卡：CPU / 内存 / MOSS 占用摘要 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <section className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Cpu className="size-3.5" />
                {t('resourceMonitor.cpu')}
              </div>
              <div className="flex items-center gap-4">
                <Donut
                  segments={[
                    { key: 'used', color: RESOURCE_COLORS.cpu, value: Math.max(0.01, view.cpu.usagePercent) },
                    { key: 'free', color: 'transparent', value: Math.max(0.01, 100 - view.cpu.usagePercent) },
                  ]}
                  size={108}
                  centerTop={ready ? pct(view.cpu.usagePercent) : '—'}
                  centerSub={`${t('resourceMonitor.mossUsage')} ${pct(view.cpu.mossPercent)}`}
                />
                <div className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground">
                  <span>{view.cpu.cores}{t('resourceMonitor.coresSuffix')}</span>
                  <span className="truncate" title={view.cpu.model}>{view.cpu.model}</span>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card p-4">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <MemoryStick className="size-3.5" />
                  {t('resourceMonitor.memory')}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t('resourceMonitor.mossUsage')} {formatBytes(view.memory.mossBytes)}
                </span>
              </div>
              <div className="text-2xl font-semibold tabular-nums text-foreground">{ready ? pct(view.memory.usedPercent) : '—'}</div>
              <SegmentedBar
                items={[
                  { key: 'live', bytes: view.memory.mossBytes, color: CATEGORY_COLORS.live },
                  { key: 'other', bytes: Math.max(0, view.memory.usedBytes - view.memory.mossBytes), color: CATEGORY_COLORS.other },
                  { key: 'free', bytes: Math.max(0, view.memory.totalBytes - view.memory.usedBytes), color: CATEGORY_COLORS.free },
                ]}
              />
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>{formatBytes(view.memory.usedBytes)} / {formatBytes(view.memory.totalBytes)}</span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ backgroundColor: CATEGORY_COLORS.live }} />
                  MOSS {formatBytes(view.memory.mossBytes)}
                </span>
              </div>
            </section>

            <section className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Activity className="size-3.5" />
                {t('resourceMonitor.mossUsage')}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-2 py-2">
                  <span className="text-[11px] text-muted-foreground">{t('resourceMonitor.processCount')}</span>
                  <span className="text-lg font-semibold tabular-nums text-foreground">{ready ? mossProcessCount : '—'}</span>
                </div>
                <div className="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-2 py-2">
                  <span className="text-[11px] text-muted-foreground">CPU</span>
                  <span className="text-lg font-semibold tabular-nums text-foreground">{ready ? pct(view.cpu.mossPercent) : '—'}</span>
                </div>
                <div className="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-2 py-2">
                  <span className="text-[11px] text-muted-foreground">{t('resourceMonitor.memory')}</span>
                  <span className="text-lg font-semibold tabular-nums text-foreground">{ready ? formatBytes(view.memory.mossBytes) : '—'}</span>
                </div>
              </div>
            </section>
          </div>

          {/* 详情：进程列表全宽 */}
          <section className="flex min-h-[360px] flex-col rounded-xl border border-border/60 bg-card p-4">
            <ProcessTable
              processes={view.moss.processes}
              onlyHigh={onlyHigh}
              onToggleHigh={setOnlyHigh}
              query={procQuery}
              onQueryChange={setProcQuery}
              sort={procSort}
              onSortChange={setProcSort}
            />
          </section>
        </div>
      )}

      {tab === 'disk' && (
        <div className="flex flex-col gap-3">
          {/* 上排数据卡：磁盘容量 / MOSS 数据总占用 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <section className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <HardDrive className="size-3.5" />
                {t('resourceMonitor.disk')} {view.disk.drive}
              </div>
              <div className="flex items-center gap-4">
                <Donut
                  segments={[
                    { key: 'used', color: RESOURCE_COLORS.disk, value: Math.max(0.01, view.disk.usedPercent) },
                    { key: 'free', color: 'transparent', value: Math.max(0.01, 100 - view.disk.usedPercent) },
                  ]}
                  size={116}
                  centerTop={ready ? pct(view.disk.usedPercent) : '—'}
                  centerSub={t('resourceMonitor.used')}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{t('resourceMonitor.used')}</span>
                    <span className="tabular-nums text-foreground">{formatBytes(diskUsedBytes)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{t('resourceMonitor.free')}</span>
                    <span className="tabular-nums text-foreground">{formatBytes(view.disk.freeBytes)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{t('resourceMonitor.total')}</span>
                    <span className="tabular-nums text-foreground">{formatBytes(view.disk.totalBytes)}</span>
                  </div>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{t('resourceMonitor.mossDataUsage')}</span>
                <span className="text-lg font-semibold tabular-nums text-foreground">
                  {formatBytes(view.disk.categories.reduce((sum, c) => sum + c.bytes, 0))}
                </span>
              </div>
              <SegmentedBar items={view.disk.categories} />
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {view.disk.categories.map((category) => (
                  <span key={category.key} className="flex items-center gap-1.5">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: CATEGORY_COLORS[category.key] ?? 'var(--palette-chart-cat-other)' }}
                    />
                    {t(`resourceMonitor.category.${category.key}`, { defaultValue: category.key })}
                  </span>
                ))}
              </div>
            </section>
          </div>

          {/* 详情：分类明细全宽 */}
          <section className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{t('resourceMonitor.mossDataUsage')}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {formatBytes(view.disk.categories.reduce((sum, c) => sum + c.bytes, 0))}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {view.disk.categories.map((category) => {
                const total = Math.max(1, view.disk.categories.reduce((sum, c) => sum + c.bytes, 0));
                const color = CATEGORY_COLORS[category.key] ?? 'var(--palette-chart-cat-other)';
                return (
                  <div key={category.key} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/40">
                    <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {t(`resourceMonitor.category.${category.key}`, { defaultValue: category.key })}
                    </span>
                    <span className="w-16 text-right text-[11px] tabular-nums text-muted-foreground">
                      {formatBytes(category.bytes)}
                    </span>
                    <span className="w-10 text-right text-[11px] tabular-nums text-foreground/70">
                      {pct((category.bytes / total) * 100)}
                    </span>
                    <div className="w-24 shrink-0">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full transition-[width] duration-500"
                          style={{ width: `${(category.bytes / total) * 100}%`, backgroundColor: color }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {tab === 'network' && (
        <div className="flex flex-col gap-3">
          {/* 上排数据卡：总下行 / 总上行 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <section className="flex flex-col gap-1 rounded-xl border border-border/60 bg-card p-4">
              <span className="text-xs text-muted-foreground">↓ {t('resourceMonitor.netRxRate')}</span>
              <span className="text-2xl font-semibold tabular-nums text-success">{ready ? formatRate(netRx) : '—'}</span>
              <span className="text-[11px] text-muted-foreground">
                {t('resourceMonitor.netRxTotal')} <span className="tabular-nums text-foreground/80">{formatBytes(netRxBytes)}</span>
              </span>
            </section>
            <section className="flex flex-col gap-1 rounded-xl border border-border/60 bg-card p-4">
              <span className="text-xs text-muted-foreground">↑ {t('resourceMonitor.netTxRate')}</span>
              <span className="text-2xl font-semibold tabular-nums text-info">{ready ? formatRate(netTx) : '—'}</span>
              <span className="text-[11px] text-muted-foreground">
                {t('resourceMonitor.netTxTotal')} <span className="tabular-nums text-foreground/80">{formatBytes(netTxBytes)}</span>
              </span>
            </section>
          </div>

          {/* 详情：每张网卡一张全宽卡片 */}
          <div className="flex flex-col gap-3">
            {view.network.interfaces.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
                {t('resourceMonitor.noData')}
              </div>
            ) : (
              view.network.interfaces.map((nic) => {
                const peak = Math.max(1, nic.rxRate, nic.txRate);
                return (
                  <section key={nic.name} className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4">
                    <div className="flex items-center gap-2">
                      <Wifi className="size-4 text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground">{nic.name}</span>
                      <span className="truncate text-[11px] text-muted-foreground">{nic.address ?? '—'}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-muted-foreground">↓ {t('resourceMonitor.netRxRate')}</span>
                        <span className="text-xl font-semibold tabular-nums text-success">{formatRate(nic.rxRate)}</span>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-success transition-[width] duration-500"
                            style={{ width: `${(nic.rxRate / peak) * 100}%` }}
                          />
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-muted-foreground">↑ {t('resourceMonitor.netTxRate')}</span>
                        <span className="text-xl font-semibold tabular-nums text-info">{formatRate(nic.txRate)}</span>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-info transition-[width] duration-500"
                            style={{ width: `${(nic.txRate / peak) * 100}%` }}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                      <span>{t('resourceMonitor.netRxTotal')} <span className="tabular-nums text-foreground/80">{formatBytes(nic.rxBytes)}</span></span>
                      <span>{t('resourceMonitor.netTxTotal')} <span className="tabular-nums text-foreground/80">{formatBytes(nic.txBytes)}</span></span>
                    </div>
                  </section>
                );
              })
            )}
          </div>
        </div>
      )}

      <InsightDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        title={t('resourceMonitor.aiReadTitle')}
        kind="resource"
        icon={<Sparkles className="size-4 text-primary-strong" />}
      />
    </div>
  );
}
