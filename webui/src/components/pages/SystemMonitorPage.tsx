// webui/src/components/pages/SystemMonitorPage.tsx
// 资源管理器：系统总量 + MOSS 自身占用（概览 / CPU 与内存 / 磁盘 / 网络）。
// 数据源：GET /api/system-monitor/snapshot（轮询）；AI 解读：WS 流式诊断（insight.diagnose kind=resource）。
// 桌面 + 移动自适应：卡片栅格断点、Tab 横向可滚、移动端操作常显。

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  RefreshCw,
  Sparkles,
  Wifi,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { InsightDialog } from '@/components/insight/InsightDialog';
import { api } from '@/api/http';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { MossProcessInfo, ResourceSnapshot } from '@/types/api';

const POLL_MS = 2500;

/** 分类图例配色（对齐图3 的多色分段条；键与后端 disk.categories 一致） */
const CATEGORY_COLORS: Record<string, string> = {
  logs: '#38bdf8',
  'file-index': '#a78bfa',
  memory: '#f472b6',
  live: '#facc15',
  tasks: '#34d399',
  todo: '#fb923c',
  terminals: '#22d3ee',
  other: '#94a3b8',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function pct(n: number): string {
  return `${(Math.round(n * 10) / 10).toFixed(1)}%`;
}

/** 资源占用横幅级别 */
function bannerLevel(s: ResourceSnapshot): 'ok' | 'warn' | 'high' {
  const { cpu, memory, disk } = s;
  if (cpu.usagePercent >= 85 || memory.usedPercent >= 90 || disk.usedPercent >= 90) return 'high';
  if (cpu.usagePercent >= 70 || memory.usedPercent >= 80 || disk.usedPercent >= 80) return 'warn';
  return 'ok';
}

/** 环形/条形进度条 */
function Bar({ percent, color }: { percent: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%`, backgroundColor: color }}
      />
    </div>
  );
}

/** 多色分段条（磁盘分类占比） */
function SegmentedBar({ items }: { items: Array<{ key: string; bytes: number }> }) {
  const total = items.reduce((s, i) => s + i.bytes, 0);
  if (total <= 0) return <div className="h-2 w-full rounded-full bg-muted" />;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      {items.map((i) => (
        <div
          key={i.key}
          title={`${i.key}: ${formatBytes(i.bytes)}`}
          style={{ width: `${(i.bytes / total) * 100}%`, backgroundColor: CATEGORY_COLORS[i.key] ?? '#94a3b8' }}
        />
      ))}
    </div>
  );
}

/** 分类图例 */
function CategoryLegend({ items }: { items: Array<{ key: string; bytes: number }> }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {items.map((i) => (
        <div key={i.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[i.key] ?? '#94a3b8' }} />
          <span>{t(`resourceMonitor.category.${i.key}`, { defaultValue: i.key })}</span>
          <span className="tabular-nums text-foreground/80">{formatBytes(i.bytes)}</span>
        </div>
      ))}
    </div>
  );
}

/** 资源总览卡（大号百分比 + MOSS 占用明细） */
function StatCard({
  icon: Icon,
  title,
  percent,
  color,
  detail,
}: {
  icon: typeof Cpu;
  title: string;
  percent: number;
  color: string;
  detail: string;
}) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4" />
        <span>{title}</span>
      </div>
      <div className="text-3xl font-semibold tabular-nums text-foreground">{pct(percent)}</div>
      <Bar percent={percent} color={color} />
      <div className="text-xs text-muted-foreground">{detail}</div>
    </Card>
  );
}

/** 进程表 */
function ProcessTable({
  processes,
  onlyHigh,
  onToggleHigh,
}: {
  processes: MossProcessInfo[];
  onlyHigh: boolean;
  onToggleHigh: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const sorted = [...processes].sort((a, b) => b.rssBytes - a.rssBytes);
    return onlyHigh ? sorted.filter((p) => p.cpuPercent >= 5 || p.rssBytes >= 200 * 1024 * 1024) : sorted;
  }, [processes, onlyHigh]);

  const groupLabel = (g: MossProcessInfo['group']): string => t(`resourceMonitor.group.${g}`);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(t('resourceMonitor.copied')),
      () => toast.error(t('resourceMonitor.copyFailed')),
    );
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{t('resourceMonitor.processList')}</span>
          <Badge variant="secondary">{rows.length}</Badge>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={onlyHigh} onCheckedChange={(v) => onToggleHigh(v === true)} />
            {t('resourceMonitor.onlyHighUsage')}
          </label>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1"
            onClick={() =>
              copy(
                rows
                  .map((p) => `${p.pid}\t${p.name}\t${p.cpuPercent}%\t${formatBytes(p.rssBytes)}`)
                  .join('\n'),
              )
            }
          >
            {t('resourceMonitor.copyAll')}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">{t('resourceMonitor.processName')}</th>
              <th className="px-2 py-1.5 text-left font-medium">PID</th>
              <th className="px-2 py-1.5 text-right font-medium">{t('resourceMonitor.cpuPercent')}</th>
              <th className="px-2 py-1.5 text-right font-medium">{t('resourceMonitor.rssMemory')}</th>
              <th className="px-2 py-1.5 text-left font-medium">{t('resourceMonitor.processGroup')}</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.pid} className={cn('border-t border-border/60', p.isMoss && 'bg-primary/5')}>
                <td className="max-w-[220px] truncate px-2 py-1 text-foreground" title={p.name}>
                  {p.name}
                </td>
                <td className="px-2 py-1 tabular-nums text-muted-foreground">{p.pid}</td>
                <td className="px-2 py-1 text-right tabular-nums text-foreground">{p.cpuPercent.toFixed(1)}%</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{formatBytes(p.rssBytes)}</td>
                <td className="px-2 py-1">
                  {p.isMoss ? (
                    <Badge variant={p.group === 'server' ? 'default' : 'secondary'} className="text-[10px]">
                      {groupLabel(p.group)}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => copy(`${p.name} (pid=${p.pid})`)}
                  >
                    {t('resourceMonitor.copy')}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
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

export function SystemMonitorPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('overview');
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyHigh, setOnlyHigh] = useState(false);
  // AI 解读：链路式流式弹窗（打开即发起，取证步骤 + 流式报告）
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const s = await api.getResourceSnapshot();
        if (!alive) return;
        setSnapshot(s);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    const onVis = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const level = snapshot ? bannerLevel(snapshot) : 'ok';
  const levelClass =
    level === 'high'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : level === 'warn'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  const levelText =
    level === 'high'
      ? t('resourceMonitor.statusHigh')
      : level === 'warn'
        ? t('resourceMonitor.statusWarn')
        : t('resourceMonitor.statusOk');

  const mossGroupCount = useMemo(() => {
    const p = snapshot?.moss.processes.filter((x) => x.isMoss) ?? [];
    return p.length;
  }, [snapshot]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header（桌面显示；移动端由全局顶栏承载标题） */}
      <div className="hidden items-center justify-between gap-4 px-6 py-4 md:flex">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{t('resourceMonitor.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('resourceMonitor.subtitle')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1"
          onClick={async () => {
            try {
              const s = await api.getResourceSnapshot();
              setSnapshot(s);
              setError(null);
            } catch {
              /* 轮询会重试 */
            }
          }}
        >
          <RefreshCw className="size-3.5" />
          {t('common.refresh')}
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <div className="overflow-x-auto px-6 pb-2">
          <TabsList>
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
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {!snapshot ? (
            <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {error ?? t('resourceMonitor.loading')}
            </div>
          ) : (
            <>
              {/* 概览 */}
              <TabsContent value="overview" className="mt-0 flex flex-col gap-4">
                <div className={cn('rounded-lg border px-3 py-2 text-sm', levelClass)}>{levelText}</div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <StatCard
                    icon={Cpu}
                    title={`${t('resourceMonitor.cpu')} · ${snapshot.cpu.cores}${t('resourceMonitor.coresSuffix')}`}
                    percent={snapshot.cpu.usagePercent}
                    color="#38bdf8"
                    detail={`${t('resourceMonitor.mossUsage')} ${pct(snapshot.cpu.mossPercent)}（${snapshot.cpu.model}）`}
                  />
                  <StatCard
                    icon={MemoryStick}
                    title={t('resourceMonitor.memory')}
                    percent={snapshot.memory.usedPercent}
                    color="#a78bfa"
                    detail={`${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)} · ${t('resourceMonitor.mossUsage')} ${formatBytes(snapshot.memory.mossBytes)}`}
                  />
                  <StatCard
                    icon={HardDrive}
                    title={`${t('resourceMonitor.disk')} ${snapshot.disk.drive}`}
                    percent={snapshot.disk.usedPercent}
                    color="#f472b6"
                    detail={`${formatBytes(snapshot.disk.totalBytes - snapshot.disk.freeBytes)} / ${formatBytes(snapshot.disk.totalBytes)}`}
                  />
                </div>
                <div className="flex justify-center">
                  <Button size="sm" className="gap-1.5" onClick={() => setReportOpen(true)}>
                    <Sparkles className="size-3.5" />
                    {t('resourceMonitor.aiRead')}
                  </Button>
                </div>
              </TabsContent>

              {/* CPU 与内存 */}
              <TabsContent value="cpu-memory" className="mt-0 grid grid-cols-1 gap-4 xl:grid-cols-2">
                <div className="flex flex-col gap-3">
                  <Card className="flex flex-col gap-2 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Cpu className="size-4" />
                      <span>{t('resourceMonitor.cpu')}</span>
                    </div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-3xl font-semibold tabular-nums text-foreground">
                        {pct(snapshot.cpu.usagePercent)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t('resourceMonitor.mossUsage')} {pct(snapshot.cpu.mossPercent)}
                      </span>
                    </div>
                    <Bar percent={snapshot.cpu.usagePercent} color="#38bdf8" />
                    <div className="text-xs text-muted-foreground">
                      {snapshot.cpu.cores}
                      {t('resourceMonitor.coresSuffix')} · {snapshot.cpu.model}
                    </div>
                  </Card>
                  <Card className="flex flex-col gap-2 p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <MemoryStick className="size-4" />
                        <span>{t('resourceMonitor.memory')}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {t('resourceMonitor.mossUsage')} {formatBytes(snapshot.memory.mossBytes)}
                      </span>
                    </div>
                    <div className="text-3xl font-semibold tabular-nums text-foreground">
                      {pct(snapshot.memory.usedPercent)}
                    </div>
                    <SegmentedBar
                      items={[
                        { key: 'live', bytes: snapshot.memory.mossBytes },
                        { key: 'other', bytes: Math.max(0, snapshot.memory.usedBytes - snapshot.memory.mossBytes) },
                        { key: 'file-index', bytes: Math.max(0, snapshot.memory.totalBytes - snapshot.memory.usedBytes) },
                      ]}
                    />
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {t('resourceMonitor.memory')}：{formatBytes(snapshot.memory.usedBytes)} /{' '}
                        {formatBytes(snapshot.memory.totalBytes)}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ backgroundColor: CATEGORY_COLORS.memory }} />
                        {t('resourceMonitor.mossUsage')} {formatBytes(snapshot.memory.mossBytes)}
                      </span>
                    </div>
                  </Card>
                </div>
                <Card className="flex min-h-[320px] flex-col p-4">
                  <ProcessTable processes={snapshot.moss.processes} onlyHigh={onlyHigh} onToggleHigh={setOnlyHigh} />
                  <div className="mt-2 text-xs text-muted-foreground">
                    {t('resourceMonitor.mossProcesses', { count: mossGroupCount })}
                  </div>
                </Card>
              </TabsContent>

              {/* 磁盘 */}
              <TabsContent value="disk" className="mt-0 grid grid-cols-1 gap-4 xl:grid-cols-2">
                <Card className="flex flex-col gap-3 p-4">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <HardDrive className="size-4" />
                    <span>
                      {t('resourceMonitor.disk')} {snapshot.disk.drive}
                    </span>
                  </div>
                  <div className="text-3xl font-semibold tabular-nums text-foreground">
                    {pct(snapshot.disk.usedPercent)}
                  </div>
                  <Bar percent={snapshot.disk.usedPercent} color="#f472b6" />
                  <div className="text-xs text-muted-foreground">
                    {t('resourceMonitor.free')} {formatBytes(snapshot.disk.freeBytes)} /{' '}
                    {formatBytes(snapshot.disk.totalBytes)}
                  </div>
                  <div className="mt-1 border-t border-border pt-3">
                    <div className="mb-2 text-xs text-muted-foreground">{t('resourceMonitor.mossDataUsage')}</div>
                    <SegmentedBar items={snapshot.disk.categories} />
                    <div className="mt-2">
                      <CategoryLegend items={snapshot.disk.categories} />
                    </div>
                  </div>
                </Card>
                <div className="flex flex-col gap-2">
                  {snapshot.disk.categories.map((c) => {
                    const total = Math.max(1, snapshot.disk.totalBytes);
                    return (
                      <Card key={c.key} className="flex items-center gap-3 p-3">
                        <span
                          className="size-8 shrink-0 rounded-md"
                          style={{ backgroundColor: CATEGORY_COLORS[c.key] ?? '#94a3b8' }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between text-sm text-foreground">
                            <span>{t(`resourceMonitor.category.${c.key}`, { defaultValue: c.key })}</span>
                            <span className="tabular-nums text-muted-foreground">{formatBytes(c.bytes)}</span>
                          </div>
                          <div className="mt-1.5">
                            <Bar percent={(c.bytes / total) * 100} color={CATEGORY_COLORS[c.key] ?? '#94a3b8'} />
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </TabsContent>

              {/* 网络 */}
              <TabsContent value="network" className="mt-0">
                <Card className="overflow-hidden p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">{t('resourceMonitor.netName')}</th>
                          <th className="px-3 py-2 text-left font-medium">{t('resourceMonitor.netAddress')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('resourceMonitor.netRxTotal')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('resourceMonitor.netTxTotal')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('resourceMonitor.netRxRate')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('resourceMonitor.netTxRate')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.network.interfaces.map((n) => (
                          <tr key={n.name} className="border-t border-border/60">
                            <td className="px-3 py-2 text-foreground">{n.name}</td>
                            <td className="px-3 py-2 text-muted-foreground">{n.address ?? '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {formatBytes(n.rxBytes)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {formatBytes(n.txBytes)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-emerald-500">
                              ↓ {formatRate(n.rxRate)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-sky-500">↑ {formatRate(n.txRate)}</td>
                          </tr>
                        ))}
                        {snapshot.network.interfaces.length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                              {t('resourceMonitor.noData')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>

      {/* AI 解读：链路式流式弹窗（取证步骤 + 流式报告；固定高度） */}
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
