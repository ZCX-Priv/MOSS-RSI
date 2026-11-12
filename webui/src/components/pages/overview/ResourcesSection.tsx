// webui/src/components/pages/overview/ResourcesSection.tsx
// 设置-概览「资源」：系统总量 + MOSS 自身占用（概览 / CPU 与内存 / 磁盘 / 网络）。
// 数据源：GET /api/system-monitor/snapshot（2.5s 轮询）；AI 解读：WS 流式诊断（insight.diagnose kind=resource）。

import { useEffect, useMemo, useState } from 'react';
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
import type { MossProcessInfo, ResourceSnapshot } from '@/types/api';
import {
  Donut,
  RESOURCE_COLORS,
  Sparkline,
  formatBytes,
  formatRate,
} from './charts';

const POLL_MS = 2500;
const HISTORY_MAX = 60;

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

/** 资源主卡：环形进度 + 数值 + 迷你趋势 */
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
  sparkId,
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
  history?: number[];
  sparkId?: string;
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
      {history !== undefined && history.length > 1 && (
        <div className="pt-0.5 opacity-80">
          <Sparkline points={history} color={color} width={220} height={26} id={sparkId ?? 'spark'} />
        </div>
      )}
    </div>
  );
}

/** CPU / 内存双线趋势（按数据范围自适应缩放，变化更清晰） */
function TrendChart({ history }: { history: Sample[] }) {
  const width = 560;
  const height = 88;
  if (history.length < 2) return <div className="h-[88px] rounded-md bg-muted/30" aria-hidden="true" />;
  const values = history.flatMap((sample) => [sample.cpu, sample.mem]);
  const lo = Math.max(0, Math.min(...values) - 8);
  const hi = Math.min(100, Math.max(...values) + 8);
  const span = Math.max(1, hi - lo);
  const step = width / (history.length - 1);
  const yOf = (value: number): string => (height - ((Math.min(hi, Math.max(lo, value)) - lo) / span) * height).toFixed(1);
  const lineOf = (pick: (sample: Sample) => number): string =>
    history.map((sample, index) => `${(index * step).toFixed(1)},${yOf(pick(sample))}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-[88px] w-full" aria-hidden="true">
      {[0.25, 0.5, 0.75].map((p) => (
        <line
          key={p}
          x1="0"
          x2={width}
          y1={(height * p).toFixed(1)}
          y2={(height * p).toFixed(1)}
          className="stroke-border/40"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
      ))}
      <polyline points={lineOf((s) => s.cpu)} fill="none" stroke={RESOURCE_COLORS.cpu} strokeWidth="1.6" strokeLinejoin="round" />
      <polyline points={lineOf((s) => s.mem)} fill="none" stroke={RESOURCE_COLORS.memory} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
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
  history: number[];
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
      {history.length > 1 && (
        <div className="opacity-80">
          <Sparkline points={history} color={RESOURCE_COLORS.network} width={220} height={26} id="net" />
        </div>
      )}
    </div>
  );
}

/** 进程表 */
function ProcessTable({
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
}

export function ResourcesSection() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ResourceTab>('overview');
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const [onlyHigh, setOnlyHigh] = useState(false);
  const [procQuery, setProcQuery] = useState('');
  const [procSort, setProcSort] = useState<ProcessSort>('memory');
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      if (document.hidden) return;
      try {
        const next = await api.getResourceSnapshot();
        if (!alive) return;
        setSnapshot(next);
        setError(null);
        const rx = next.network.interfaces.reduce((sum, n) => sum + n.rxRate, 0);
        const tx = next.network.interfaces.reduce((sum, n) => sum + n.txRate, 0);
        setHistory((prev) => {
          const appended = [...prev, { cpu: next.cpu.usagePercent, mem: next.memory.usedPercent, rx, tx }];
          return appended.length > HISTORY_MAX ? appended.slice(appended.length - HISTORY_MAX) : appended;
        });
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    const onVisible = (): void => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const level = snapshot ? bannerLevel(snapshot) : 'ok';
  const view = snapshot ?? EMPTY_SNAPSHOT;
  const ready = snapshot !== null;
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
    try {
      const next = await api.getResourceSnapshot();
      setSnapshot(next);
      setError(null);
    } catch {
      /* 轮询会重试 */
    }
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
            {t('resourceMonitor.sampleAt', { time: new Date(view.sampledAt).toLocaleTimeString() })}
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
              history={history.map((sample) => sample.cpu)}
              sparkId="cpu"
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
              history={history.map((sample) => sample.mem)}
              sparkId="mem"
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
              history={history.map((sample) => sample.rx + sample.tx)}
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

            {/* 近 2 分钟趋势 */}
            <section className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Activity className="size-4 text-muted-foreground" />
                  {t('resourceMonitor.trendTitle')}
                </span>
                <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full" style={{ backgroundColor: RESOURCE_COLORS.cpu }} />
                    CPU
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full" style={{ backgroundColor: RESOURCE_COLORS.memory }} />
                    {t('resourceMonitor.memory')}
                  </span>
                </span>
              </div>
              <TrendChart history={history} />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>{t('resourceMonitor.trendWindow')}</span>
                <span className="tabular-nums">{history.length} / {HISTORY_MAX}</span>
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
