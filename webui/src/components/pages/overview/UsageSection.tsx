// webui/src/components/pages/overview/UsageSection.tsx
// 设置-概览「用量」：跨会话 tokens / 工具 / 技能 / 命令 / 活跃度统计（参考 dsh-context Context Insights）。
// 数据源：GET /api/usage/overview（后端扫描 ~/.moss/tasks 聚合；5s 缓存）。
// 交互：日期范围走请求；搜索/分组/排序/名称筛选/分页全部前端本地完成。

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Clock,
  Database,
  Loader2,
  RefreshCw,
  Search,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { UsageRange, UsageSessionRow, UsageTallyStat } from '@/types/api';
import { useUsageOverview } from './useUsage';
import {
  Donut,
  DonutLegend,
  Heatmap,
  StackedTokenBars,
  StatTile,
  TIMING_COLORS,
  TOKEN_COLORS,
  TrendAreaChart,
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
  nameColor,
  relativeTime,
} from './charts';

const PAGE_SIZE = 9;
const TALLY_ROWS = 16;

type SortKey = 'recent' | 'tokens' | 'tools';
type PickField = 'tools' | 'skills' | 'commands';

const RANGE_OPTIONS: UsageRange[] = ['today', '7d', '30d', 'all'];

export function UsageSection() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [range, setRange] = useState<UsageRange>('7d');
  const { data, loading, error, refresh } = useUsageOverview(range);

  const [metric, setMetric] = useState<'tokens' | 'sessions'>('tokens');
  const [day, setDay] = useState<string | null>(null);
  const [pick, setPick] = useState<{ field: PickField; name: string } | null>(null);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('recent');
  const [page, setPage] = useState(0);
  const [tokenHover, setTokenHover] = useState<string | null>(null);
  const [timingHover, setTimingHover] = useState<string | null>(null);

  // 范围切换：重置页内筛选
  useEffect(() => {
    setDay(null);
    setPick(null);
    setGroup(null);
    setPage(0);
  }, [range]);

  useEffect(() => {
    setPage(0);
  }, [query, group, sort, day, pick]);

  const totals = data?.totals;
  const sessionRows = useMemo(() => data?.sessions ?? [], [data]);

  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of sessionRows) {
      counts.set(row.groupName, (counts.get(row.groupName) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
  }, [sessionRows]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = sessionRows.filter((row) => {
      if (group !== null && row.groupName !== group) return false;
      if (day !== null && !row.activeDays.includes(day)) return false;
      if (pick !== null && !row[pick.field].includes(pick.name)) return false;
      if (q !== '') {
        const haystack = `${row.title} ${row.cwd} ${row.lastUser}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    const sorted = [...rows];
    if (sort === 'tokens') sorted.sort((a, b) => b.tokens.total - a.tokens.total);
    else if (sort === 'tools') sorted.sort((a, b) => b.toolCalls - a.toolCalls);
    else sorted.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return sorted;
  }, [sessionRows, group, day, pick, query, sort]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pageIndex = Math.min(page, pageCount - 1);
  const pageRows = filteredRows.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE);

  const heatValues = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of data?.days ?? []) {
      map.set(entry.day, metric === 'tokens' ? entry.tokens : entry.sessions);
    }
    return map;
  }, [data, metric]);

  const dayMap = useMemo(() => {
    const map = new Map<string, { tokens: number; sessions: number; toolCalls: number }>();
    for (const entry of data?.days ?? []) map.set(entry.day, entry);
    return map;
  }, [data]);

  const todayKey = data?.days[data.days.length - 1]?.day ?? '';
  const series = useMemo(() => data?.series ?? [], [data]);
  const seriesRequests = useMemo(
    () => series.reduce((sum, point) => sum + point.requests, 0),
    [series],
  );
  const seriesTokens = useMemo(
    () =>
      series.reduce(
        (sum, point) => sum + point.cachedTokens + point.promptTokens + point.completionTokens,
        0,
      ),
    [series],
  );

  const tokenSegments = useMemo(() => {
    const tokens = totals?.tokens;
    if (!tokens) return [];
    return [
      { key: 'cached', color: TOKEN_COLORS.cached, value: tokens.cached },
      { key: 'prompt', color: TOKEN_COLORS.prompt, value: Math.max(0, tokens.prompt - tokens.cached) },
      { key: 'completion', color: TOKEN_COLORS.completion, value: tokens.completion },
    ];
  }, [totals]);

  const tokenTotal = tokenSegments.reduce((sum, s) => sum + s.value, 0);
  const tokenLegend = [
    {
      key: 'cached',
      color: TOKEN_COLORS.cached,
      label: t('usage.token.cached'),
      value: formatTokens(totals?.tokens.cached ?? 0),
      sub: tokenTotal > 0 ? formatPercent((totals?.tokens.cached ?? 0) / tokenTotal) : '—',
    },
    {
      key: 'prompt',
      color: TOKEN_COLORS.prompt,
      label: t('usage.token.prompt'),
      value: formatTokens(Math.max(0, (totals?.tokens.prompt ?? 0) - (totals?.tokens.cached ?? 0))),
      sub:
        tokenTotal > 0
          ? formatPercent(Math.max(0, (totals?.tokens.prompt ?? 0) - (totals?.tokens.cached ?? 0)) / tokenTotal)
          : '—',
    },
    {
      key: 'completion',
      color: TOKEN_COLORS.completion,
      label: t('usage.token.output'),
      value: formatTokens(totals?.tokens.completion ?? 0),
      sub: tokenTotal > 0 ? formatPercent((totals?.tokens.completion ?? 0) / tokenTotal) : '—',
    },
  ];

  const timingSegments = [
    { key: 'llm', color: TIMING_COLORS.llm, value: totals?.llmMs ?? 0 },
    { key: 'tool', color: TIMING_COLORS.tool, value: totals?.toolMs ?? 0 },
  ];
  const timingTotal = (totals?.llmMs ?? 0) + (totals?.toolMs ?? 0);
  const timingLegend = [
    {
      key: 'llm',
      color: TIMING_COLORS.llm,
      label: t('usage.timing.model'),
      value: formatDuration(totals?.llmMs ?? 0),
      sub: timingTotal > 0 ? formatPercent((totals?.llmMs ?? 0) / timingTotal) : '—',
    },
    {
      key: 'tool',
      color: TIMING_COLORS.tool,
      label: t('usage.timing.tool'),
      value: formatDuration(totals?.toolMs ?? 0),
      sub: timingTotal > 0 ? formatPercent((totals?.toolMs ?? 0) / timingTotal) : '—',
    },
  ];

  const tallyCards: Array<{
    field: PickField;
    title: string;
    icon: typeof Wrench;
    stats: UsageTallyStat[];
    unit: string;
  }> = [
    { field: 'skills', title: t('usage.tally.skills'), icon: Database, stats: data?.skills ?? [], unit: 'loads' },
    { field: 'tools', title: t('usage.tally.tools'), icon: Wrench, stats: data?.tools ?? [], unit: 'calls' },
    { field: 'commands', title: t('usage.tally.commands'), icon: Activity, stats: data?.commands ?? [], unit: 'runs' },
  ];

  const empty = (data?.sessions.length ?? 0) === 0;
  const ready = data !== null;

  return (
    <div className="flex flex-col gap-4 px-6 pb-8">
      {/* 工具条：范围 + 刷新 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={range}
          onValueChange={(next) => setRange(next as UsageRange)}
        >
          <TabsList aria-label={t('usage.range.label')}>
            {RANGE_OPTIONS.map((r) => (
              <TabsTrigger key={r} value={r}>
                {t(`usage.range.${r}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">{t('usage.note')}</span>
          <Button variant="outline" size="sm" className="h-7 gap-1" onClick={refresh} disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t('usage.refresh')}
          </Button>
        </div>
      </div>

      {error !== null && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* KPI 带 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label={t('usage.kpi.sessions')}
          value={ready ? (totals?.sessions ?? 0) : '—'}
          sub={t('usage.kpi.sessionsSub', { n: totals?.sessionsTotal ?? 0 })}
        />
        <StatTile
          label={t('usage.kpi.tokens')}
          value={ready ? formatTokens(totals?.tokens.total ?? 0) : '—'}
          sub={t('usage.kpi.tokensSub', { n: totals?.turns ?? 0 })}
        />
        <StatTile
          label={t('usage.kpi.input')}
          value={ready ? formatTokens(totals?.tokens.prompt ?? 0) : '—'}
          sub={t('usage.kpi.inputSub', { n: formatTokens(totals?.tokens.cached ?? 0) })}
        />
        <StatTile
          label={t('usage.kpi.output')}
          value={ready ? formatTokens(totals?.tokens.completion ?? 0) : '—'}
          sub={
            totals?.outputTps !== null && totals?.outputTps !== undefined
              ? t('usage.kpi.outputSub', { n: Math.round(totals.outputTps) })
              : '—'
          }
        />
        <StatTile
          label={t('usage.kpi.cacheHit')}
          value={ready ? formatPercent(totals?.cacheHitRate ?? null) : '—'}
          sub={t('usage.kpi.cacheHitSub')}
        />
        <StatTile
          label={t('usage.kpi.toolCalls')}
          value={ready ? formatTokens(totals?.toolCalls ?? 0) : '—'}
          sub={t('usage.kpi.toolSub', { skills: totals?.skillLoads ?? 0, cmds: totals?.commandRuns ?? 0 })}
        />
      </div>

      {/* 图表行 1：API 请求次数 + Tokens（范围随切换变化） */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <section className="flex flex-col rounded-xl border border-border/60 bg-card">
          <header className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <BarChart3 className="size-4 text-muted-foreground" />
              {t('usage.chart.api')}
            </span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {ready ? formatCount(seriesRequests, i18n.language) : '—'}
            </span>
          </header>
          <div className="px-4 pb-3 pt-2">
            {series.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">{t('usage.chart.empty')}</div>
            ) : (
              <TrendAreaChart
                points={series.map((point) => ({ day: point.day, value: point.requests }))}
                color={TOKEN_COLORS.completion}
                label={t('usage.chart.requests')}
              />
            )}
          </div>
        </section>

        <section className="flex flex-col rounded-xl border border-border/60 bg-card">
          <header className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Database className="size-4 text-muted-foreground" />
              {t('usage.chart.tokens')}
            </span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {ready ? formatCount(seriesTokens, i18n.language) : '—'}
            </span>
          </header>
          <div className="px-4 pb-3 pt-2">
            {series.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">{t('usage.chart.empty')}</div>
            ) : (
              <StackedTokenBars points={series} />
            )}
          </div>
        </section>
      </div>

      {/* 图表行 2：Token 构成 + 耗时构成 + 活跃度 */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <section className="flex flex-col rounded-xl border border-border/60 bg-card">
          <header className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-sm font-medium text-foreground">
            <Database className="size-4 text-muted-foreground" />
            {t('usage.token.title')}
          </header>
          <div className="flex items-center gap-4 px-4 pb-4 pt-2">
            {tokenTotal <= 0 ? (
              <div className="w-full py-8 text-center text-sm text-muted-foreground">{t('usage.chart.empty')}</div>
            ) : (
              <>
                <Donut
                  segments={tokenSegments}
                  size={104}
                  centerTop={formatTokens(tokenTotal)}
                  centerSub={t('usage.token.total')}
                  hoverKey={tokenHover}
                  onHoverKey={setTokenHover}
                />
                <DonutLegend rows={tokenLegend} hoverKey={tokenHover} onHoverKey={setTokenHover} />
              </>
            )}
          </div>
        </section>

        <section className="flex flex-col rounded-xl border border-border/60 bg-card">
          <header className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Clock className="size-4 text-muted-foreground" />
              {t('usage.timing.title')}
            </span>
            {totals?.outputTps !== null && totals?.outputTps !== undefined && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                {t('usage.timing.tps', { n: Math.round(totals.outputTps) })}
              </span>
            )}
          </header>
          <div className="flex flex-1 items-center gap-4 px-4 pb-3 pt-2">
            {timingTotal <= 0 ? (
              <div className="w-full py-8 text-center text-sm text-muted-foreground">{t('usage.timing.empty')}</div>
            ) : (
              <>
                <Donut
                  segments={timingSegments}
                  size={96}
                  centerTop={formatDuration(timingTotal)}
                  centerSub={t('usage.timing.total')}
                  hoverKey={timingHover}
                  onHoverKey={setTimingHover}
                />
                <DonutLegend rows={timingLegend} hoverKey={timingHover} onHoverKey={setTimingHover} />
              </>
            )}
          </div>
        </section>

        <section className="flex flex-col rounded-xl border border-border/60 bg-card">
          <header className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Activity className="size-4 text-muted-foreground" />
              {t('usage.heat.title')}
            </span>
            <Tabs value={metric} onValueChange={(next) => setMetric(next as 'tokens' | 'sessions')}>
              <TabsList>
                <TabsTrigger value="tokens">{t('usage.heat.metric.tokens')}</TabsTrigger>
                <TabsTrigger value="sessions">{t('usage.heat.metric.sessions')}</TabsTrigger>
              </TabsList>
            </Tabs>
          </header>
          <div className="px-4 pb-3 pt-2">
            {todayKey === '' ? (
              <div className="py-8 text-center text-sm text-muted-foreground">{t('usage.heat.empty')}</div>
            ) : (
              <Heatmap
                values={heatValues}
                today={todayKey}
                selected={day}
                onSelect={setDay}
                weekdayLabels={[t('usage.heat.wd.mon'), t('usage.heat.wd.wed'), t('usage.heat.wd.fri')]}
                lessLabel={t('usage.heat.less')}
                moreLabel={t('usage.heat.more')}
                label={(key) => {
                  const entry = dayMap.get(key);
                  return t('usage.heat.tip', {
                    day: key,
                    sessions: entry?.sessions ?? 0,
                    tokens: formatTokens(entry?.tokens ?? 0),
                  });
                }}
              />
            )}
          </div>
        </section>
      </div>

      {/* Tally 三卡：技能 / 工具 / 命令 */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {tallyCards.map((card) => {
          const Icon = card.icon;
          const total = card.stats.reduce((sum, s) => sum + s.count, 0);
          const max = Math.max(1, ...card.stats.map((s) => s.count));
          const selectedName = pick?.field === card.field ? pick.name : null;
          return (
            <section key={card.field} className="flex min-w-0 flex-col rounded-xl border border-border/60 bg-card">
              <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-1 pt-3">
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Icon className="size-4 text-muted-foreground" />
                  {card.title}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t('usage.tally.summary', { n: card.stats.length, runs: total })}
                </span>
                {selectedName !== null && (
                  <button
                    type="button"
                    onClick={() => setPick(null)}
                    className="ml-auto inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary"
                  >
                    {selectedName}
                    <X className="size-3" />
                  </button>
                )}
              </header>
              <div className="flex flex-col gap-0.5 px-2 pb-3 pt-1">
                {card.stats.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    {t(`usage.tally.${card.unit}Empty`)}
                  </div>
                ) : (
                  card.stats.slice(0, TALLY_ROWS).map((stat) => {
                    const selected = selectedName === stat.name;
                    return (
                      <button
                        key={stat.name}
                        type="button"
                        onClick={() => setPick(selected ? null : { field: card.field, name: stat.name })}
                        className={cn(
                          'group relative flex items-center gap-2 overflow-hidden rounded-md px-2 py-1 text-left transition-colors',
                          selected ? 'bg-primary/10' : 'hover:bg-muted/60',
                        )}
                        title={t('usage.tally.rowTip', { n: stat.count, sessions: stat.sessions })}
                      >
                        <span
                          aria-hidden="true"
                          className="absolute inset-y-0 left-0"
                          style={{
                            width: `${Math.max(4, Math.round((stat.count / max) * 100))}%`,
                            backgroundColor: nameColor(stat.name),
                            opacity: 0.08,
                          }}
                        />
                        <span className="relative size-2 shrink-0 rounded-full" style={{ backgroundColor: nameColor(stat.name) }} />
                        <span className="relative min-w-0 flex-1 truncate text-xs text-foreground">{stat.name}</span>
                        <span className="relative shrink-0 text-[11px] tabular-nums text-muted-foreground">×{stat.count}</span>
                      </button>
                    );
                  })
                )}
                {card.stats.length > TALLY_ROWS && (
                  <span className="px-2 pt-1 text-[11px] text-muted-foreground">
                    {t('usage.tally.more', { n: card.stats.length - TALLY_ROWS })}
                  </span>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {/* 会话列表 */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{t('usage.list.title')}</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {filteredRows.length}
          </span>
          {day !== null && (
            <button
              type="button"
              onClick={() => setDay(null)}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary"
            >
              {day}
              <X className="size-3" />
            </button>
          )}
          <div className="relative ml-auto w-full max-w-[240px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('usage.list.search')}
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Tabs value={sort} onValueChange={(next) => setSort(next as SortKey)}>
            <TabsList aria-label={t('usage.list.sortLabel')}>
              <TabsTrigger value="recent">{t('usage.list.sort.recent')}</TabsTrigger>
              <TabsTrigger value="tokens">{t('usage.list.sort.tokens')}</TabsTrigger>
              <TabsTrigger value="tools">{t('usage.list.sort.tools')}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {groups.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setGroup(null)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
                group === null
                  ? 'border-transparent bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t('usage.list.groupAll')}
              <span className="tabular-nums opacity-70">{sessionRows.length}</span>
            </button>
            {groups.map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={() => setGroup(group === item.name ? null : item.name)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
                  group === item.name
                    ? 'border-transparent bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="max-w-[140px] truncate">{item.name}</span>
                <span className="tabular-nums opacity-70">{item.count}</span>
              </button>
            ))}
          </div>
        )}

        {filteredRows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
            {empty ? t('usage.list.empty') : t('usage.list.noMatch')}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {pageRows.map((row) => (
              <SessionCard
                key={row.id}
                row={row}
                locale={i18n.language}
                onOpen={() => navigate(`/task/${row.id}`)}
              />
            ))}
          </div>
        )}

        {pageCount > 1 && (
          <div className="flex items-center justify-center gap-3 pt-1">
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              disabled={pageIndex === 0}
              onClick={() => setPage(pageIndex - 1)}
              aria-label={t('usage.list.prev')}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">
              {t('usage.list.page', { n: pageIndex + 1, total: pageCount })}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              disabled={pageIndex >= pageCount - 1}
              onClick={() => setPage(pageIndex + 1)}
              aria-label={t('usage.list.next')}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        )}

        <p className="pt-1 text-center text-[11px] text-muted-foreground">{t('usage.metricNote')}</p>
      </section>
    </div>
  );
}

/** 会话卡片：环形构成 + 三项指标 + 最后消息预览 */
function SessionCard({ row, locale, onOpen }: { row: UsageSessionRow; locale: string; onOpen: () => void }) {
  const { t } = useTranslation();
  const parts = row.parts.filter((part) => part.value > 0).map((part) => ({
    key: part.key,
    color: TOKEN_COLORS[part.key],
    value: part.value,
  }));
  const hasData = parts.length > 0;
  const dirLabel = row.cwd !== '' ? row.cwd.split(/[\\/]/).filter(Boolean).pop() : row.groupName;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col gap-2 rounded-xl border border-border/60 bg-card p-3 text-left transition-all hover:border-border hover:shadow-sm"
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={row.title}>
          {row.title}
        </span>
        {row.hidden && (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {t('usage.list.subagent')}
          </span>
        )}
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {relativeTime(row.updatedAt, locale)}
        </span>
      </div>

      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="truncate">{row.groupName}</span>
        {dirLabel !== row.groupName && (
          <>
            <span className="opacity-50">/</span>
            <span className="truncate" title={row.cwd}>{dirLabel}</span>
          </>
        )}
      </div>

      {hasData ? (
        <div className="flex items-center gap-3">
          <Donut
            segments={parts}
            size={64}
            centerTop={formatTokens(row.tokens.total)}
            centerSub={formatPercent(row.cacheHitRate)}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-muted-foreground">{t('usage.list.turns')}</span>
              <span className="tabular-nums text-foreground">{row.turns}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-muted-foreground">{t('usage.list.tokens')}</span>
              <span className="tabular-nums text-foreground">{formatTokens(row.tokens.total)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-muted-foreground">{t('usage.list.cache')}</span>
              <span className="tabular-nums text-foreground">{formatPercent(row.cacheHitRate)}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="py-3 text-center text-[11px] text-muted-foreground">{t('usage.list.noData')}</div>
      )}

      {row.lastUser !== '' && (
        <div className="truncate border-t border-border/50 pt-2 text-[11px] text-muted-foreground" title={row.lastUser}>
          <span className="mr-1 opacity-70">{t('usage.list.lastUser')}</span>
          {row.lastUser}
        </div>
      )}
    </button>
  );
}
