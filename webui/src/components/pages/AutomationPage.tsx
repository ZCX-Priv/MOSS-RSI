// UI/src/components/pages/AutomationPage.tsx
// 自动化任务页面：两 tab 路由化（/automation/configured | /automation/history）。
// 新建/编辑走 AutomationFormDialog（store 状态驱动，key=automationFormSeq 每次打开重置）。
// 图标为 skill 风格（bg-muted 方块，无图标回退标题首字符）；
// 调度信息展示自然语言（describeCron，全站不显示 cron 表达式）；
// 执行历史按自动化任务分组默认折叠，记录可跳转对应真实任务会话。

import { useMemo } from 'react';
import {
  Plus,
  Play,
  Pause,
  Pencil,
  Trash2,
  Clock,
  CalendarClock,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronRight,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useAutomations } from '../../hooks/useAutomations';
import { useStore } from '../../store';
import { getLucideIcon } from '../../lib/icons';
import { describeCron } from '../../lib/cron-describe';
import { AutomationFormDialog } from './automation/AutomationFormDialog';
import { toast } from 'sonner';
import type { AutomationItem, AutomationRun } from '../../types/api';

function formatTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function RunStatusIcon({ status }: { status: string }) {
  if (status === 'running') return <Loader2 className="size-3.5 animate-spin text-primary" />;
  if (status === 'success') return <CheckCircle2 className="size-3.5 text-success" />;
  if (status === 'failed' || status === 'timeout') return <XCircle className="size-3.5 text-danger" />;
  return <Clock className="size-3.5 text-muted-foreground" />;
}

/** 任务卡片图标：skill 风格方块（bg-muted）；有 lucide 图标用图标，否则标题首字符 */
function AutomationIcon({ item }: { item: AutomationItem }) {
  const Icon = item.icon ? getLucideIcon(item.icon) : undefined;
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
      {Icon ? (
        <Icon className="size-5" />
      ) : (
        <span className="text-sm font-medium">{item.title.slice(0, 1)}</span>
      )}
    </div>
  );
}

/** 调度信息：周期任务显示自然语言描述，一次性任务显示执行时间 */
function ScheduleText({ item }: { item: AutomationItem }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language.startsWith('zh') ? 'zh' : 'en';
  if (item.scheduleType === 'once') {
    return (
      <span className="flex items-center gap-1">
        <CalendarClock className="size-3" />
        {t('automation.onceLabel')}: {formatTime(item.runAt)}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <Clock className="size-3" />
      {item.cron ? describeCron(item.cron, locale) : '—'}
    </span>
  );
}

// 从 pathname 派生当前 tab（configured/history）
function useCurrentAutomationTab(): string {
  const { pathname } = useLocation();
  const seg = pathname.split('/').pop() ?? '';
  return ['configured', 'history'].includes(seg) ? seg : 'configured';
}

export function AutomationPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tab = useCurrentAutomationTab();
  const openAutomationForm = useStore((s) => s.openAutomationForm);
  const automationFormSeq = useStore((s) => s.automationFormSeq);
  // Badge 计数需要两个 tab 的数据，在布局层拉取
  const { automations, automationHistory } = useAutomations();
  const allHistoryCount = Object.values(automationHistory).flat().length;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 页面头部 */}
      <div className="hidden items-center justify-between gap-4 px-6 py-4 md:flex">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{t('automation.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('automation.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button className="gap-1.5" onClick={() => openAutomationForm()}>
            <Plus />
            <span>{t('automation.manualCreate')}</span>
          </Button>
        </div>
      </div>

      {/* Tab 栏（路由驱动） */}
      <Tabs
        value={tab}
        onValueChange={(v) => navigate(`/automation/${v}`)}
      >
        <div className="px-6 py-3">
          <TabsList>
            <TabsTrigger value="configured" className="gap-1.5">
              {t('automation.configured')}
              <Badge variant="secondary">{automations.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="history" className="gap-1.5">
              {t('automation.history')}
              <Badge variant="secondary">{allHistoryCount}</Badge>
            </TabsTrigger>
          </TabsList>
        </div>
      </Tabs>

      {/* 子路由内容 */}
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>

      {/* 新建/编辑表单（seq 作为 key：每次打开全新挂载，状态独立不继承上次输入） */}
      <AutomationFormDialog key={automationFormSeq} />
    </div>
  );
}

/* ===== 已配置 tab ===== */
export function ConfiguredTab() {
  const { t } = useTranslation();
  const openAutomationForm = useStore((s) => s.openAutomationForm);
  const {
    automations,
    triggerAutomation,
    pauseAutomation,
    resumeAutomation,
    deleteAutomation,
  } = useAutomations();

  const handleTrigger = async (id: string) => {
    try {
      await triggerAutomation(id);
      toast.success(t('automation.triggeredToast'));
    } catch {
      /* hook 已 toast */
    }
  };

  const handleTogglePause = async (id: string, paused: boolean) => {
    try {
      if (paused) {
        await resumeAutomation(id);
      } else {
        await pauseAutomation(id);
      }
    } catch {
      /* hook 已 toast */
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteAutomation(id);
      toast.success(t('automation.deletedToast'));
    } catch {
      /* hook 已 toast */
    }
  };

  return (
    <div className="p-6">
      <div className="flex flex-col gap-2">
        {automations.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('automation.noConfigured')}
          </div>
        )}
        {automations.map((a) => {
          const completed = a.scheduleType === 'once' && a.completed;
          return (
            <Card key={a.id} className="flex flex-row items-center gap-3 p-3">
              <AutomationIcon item={a} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-foreground">{a.title}</h3>
                  {completed && (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      <CheckCircle2 className="size-3" />
                      {t('automation.completedBadge')}
                    </Badge>
                  )}
                  {!completed && a.paused && (
                    <Badge variant="outline" className="font-normal">
                      {t('automation.pausedBadge')}
                    </Badge>
                  )}
                  {!a.enabled && (
                    <Badge variant="outline" className="font-normal">
                      {t('automation.disabledBadge')}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <ScheduleText item={a} />
                  <span>
                    {t('automation.lastRunAt')}: {formatTime(a.lastRunAt)}
                  </span>
                  {!completed && (
                    <span>
                      {t('automation.nextRunAt')}: {formatTime(a.nextRunAt)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => openAutomationForm(a.id)}
                  title={t('automation.editBtn')}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => void handleTrigger(a.id)}
                  title={t('automation.triggerBtn')}
                >
                  <Play className="size-3.5" />
                </Button>
                {!completed && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => void handleTogglePause(a.id, a.paused)}
                    title={a.paused ? t('automation.resumeBtn') : t('automation.pauseBtn')}
                  >
                    {a.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-destructive hover:text-destructive"
                  onClick={() => void handleDelete(a.id)}
                  title={t('automation.deleteBtn')}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ===== 历史 tab：按自动化任务分组，默认折叠 ===== */

/** 单条运行记录卡片：有 taskId 时整卡可点击跳转对应任务会话 */
function RunRecordCard({
  run,
  fallbackTitle,
}: {
  run: AutomationRun;
  fallbackTitle?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const clickable = Boolean(run.taskId);
  return (
    <Card
      className={`flex flex-row items-center gap-3 p-3 ${clickable ? 'cursor-pointer transition-colors hover:bg-accent' : ''}`}
      onClick={clickable ? () => navigate(`/task/${run.taskId}`) : undefined}
      title={clickable ? t('automation.viewTask') : undefined}
    >
      <RunStatusIcon status={({ running: t('automation.statusRunning'), success: t('automation.statusSuccess'), failed: t('automation.statusFailed'), timeout: t('automation.statusTimeout') }[run.status] ?? run.status)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">
            {fallbackTitle ?? run.automationId}
          </h3>
          <Badge variant="secondary" className="font-normal">
            {run.status}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            {t('automation.startedAt')}: {formatTime(run.startedAt)}
          </span>
          <span>
            {t('automation.finishedAt')}: {formatTime(run.finishedAt)}
          </span>
        </div>
        {run.error && (
          <p className="truncate text-xs text-destructive">{run.error}</p>
        )}
        {run.finalText && !run.error && (
          <p className="truncate text-xs text-muted-foreground">{run.finalText}</p>
        )}
      </div>
    </Card>
  );
}

/** 分组折叠头：标题 + 运行次数 + 最近一次状态 */
function HistoryGroup({
  title,
  runs,
}: {
  title: string;
  runs: AutomationRun[];
}) {
  const { t } = useTranslation();
  const latest = runs[0];
  return (
    <Collapsible defaultOpen={false}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </span>
        <Badge variant="secondary" className="shrink-0 font-normal">
          {t('automation.runCount', { count: runs.length })}
        </Badge>
        {latest && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <RunStatusIcon status={latest.status} />
            {formatTime(latest.startedAt)}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 py-1 pl-6">
          {runs.map((run) => (
            <RunRecordCard key={run.id} run={run} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function HistoryTab() {
  const { t } = useTranslation();
  const { automations, automationHistory } = useAutomations();

  // 已知自动化分组（按配置顺序） + 已删除任务残留历史（"其他"组）
  const { knownGroups, otherRuns } = useMemo(() => {
    const knownGroups = automations
      .map((a) => ({ id: a.id, title: a.title, runs: sortRuns(automationHistory[a.id] ?? []) }))
      .filter((g) => g.runs.length > 0);
    const knownIds = new Set(automations.map((a) => a.id));
    const otherRuns = sortRuns(
      Object.entries(automationHistory)
        .filter(([id]) => !knownIds.has(id))
        .flatMap(([, runs]) => runs),
    );
    return { knownGroups, otherRuns };
  }, [automations, automationHistory]);

  const total = knownGroups.reduce((n, g) => n + g.runs.length, 0) + otherRuns.length;

  if (total === 0) {
    return (
      <div className="p-6">
        <div className="py-12 text-center text-sm text-muted-foreground">
          {t('automation.noHistory')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-6">
      {knownGroups.map((g) => (
        <HistoryGroup key={g.id} title={g.title} runs={g.runs} />
      ))}
      {otherRuns.length > 0 && (
        <HistoryGroup title={t('automation.historyGroupOther')} runs={otherRuns} />
      )}
    </div>
  );
}

/** 按 startedAt 倒序 */
function sortRuns(runs: AutomationRun[]): AutomationRun[] {
  return [...runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}
