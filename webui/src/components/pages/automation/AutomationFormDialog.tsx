// webui/src/components/pages/automation/AutomationFormDialog.tsx
// 新建/编辑自动化任务表单（Dialog）。
// 支持两种调度：周期（预设 每小时/每天/每周/每月 + 自定义 cron，含下次执行预览）
// 与 定时（一次性，datetime-local 选择未来时间）。
// 可选 lucide 图标（IconPicker 复用组件）与执行 Agent。
// 打开状态由 store（automationFormOpen/automationFormEditingId/automationFormSeq）驱动，
// 父级用 key={automationFormSeq} 重挂载：每次打开均为全新表单（新建空白/编辑预填），不继承上次输入。

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CronExpressionParser } from 'cron-parser';
import { ChevronDown, FolderInput, FolderOpen, Monitor } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconPicker } from '../../common/IconPicker';
import { DirectoryBrowserDialog } from '../../overlays/DirectoryBrowserDialog';
import { useStore, SYSTEM_WORKING_DIRECTORY } from '../../../store';
import { useAutomations } from '../../../hooks/useAutomations';
import { api } from '../../../api/http';
import { describeCron } from '../../../lib/cron-describe';
import type { AgentItem } from '../../../types/api';

/** 周期预设 */
type CronPreset = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

interface FormState {
  title: string;
  description: string;
  icon?: string;
  /** 工作目录（必填，绝对路径） */
  cwd: string;
  scheduleType: 'cron' | 'once';
  preset: CronPreset;
  time: string; // HH:mm
  weekday: string; // cron 周字段 0-6（0=周日）
  dayOfMonth: string; // 1-31
  customCron: string;
  runAtLocal: string; // datetime-local 值
  prompt: string;
  agentId: string; // '' = 默认
}

/** 由预设参数生成 5 字段 cron 表达式 */
function buildCron(preset: CronPreset, s: Pick<FormState, 'time' | 'weekday' | 'dayOfMonth' | 'customCron'>): string {
  const [h = '0', m = '0'] = s.time.split(':');
  switch (preset) {
    case 'hourly':
      return `${m} * * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly':
      return `${m} ${h} * * ${s.weekday || '1'}`;
    case 'monthly':
      return `${m} ${h} ${s.dayOfMonth || '1'} * *`;
    case 'custom':
      return s.customCron.trim();
  }
}

/** 尝试从既有 cron 反推预设（匹配预设模式则返回预设与参数，否则 custom） */
function detectPreset(cron?: string): { preset: CronPreset; time?: string; weekday?: string; dayOfMonth?: string } {
  if (!cron) return { preset: 'daily' };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { preset: 'custom' };
  const [m, h, dom, mon, dow] = parts;
  if (dom === '*' && mon === '*' && dow === '*') {
    if (h === '*') return { preset: 'hourly', time: `00:${m.padStart(2, '0')}` };
    return { preset: 'daily', time: `${h.padStart(2, '0')}:${m.padStart(2, '0')}` };
  }
  if (dom === '*' && mon === '*' && /^\d+$/.test(dow)) {
    return { preset: 'weekly', time: `${h.padStart(2, '0')}:${m.padStart(2, '0')}`, weekday: dow };
  }
  if (dow === '*' && mon === '*' && /^\d+$/.test(dom)) {
    return { preset: 'monthly', time: `${h.padStart(2, '0')}:${m.padStart(2, '0')}`, dayOfMonth: dom };
  }
  return { preset: 'custom' };
}

/** ISO 时间 → datetime-local 值（本地时区，分钟精度） */
function isoToLocalInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 路径 → 目录名（D:\test → test；与 TaskInput 的 dirName 同规则） */
function dirName(path: string): string {
  const seg = path.split(/[\\/]/).filter(Boolean).pop();
  return seg ?? path;
}

export function AutomationFormDialog() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language.startsWith('zh') ? 'zh' : 'en';
  const open = useStore((s) => s.automationFormOpen);
  const editingId = useStore((s) => s.automationFormEditingId);
  const closeAutomationForm = useStore((s) => s.closeAutomationForm);
  const automations = useStore((s) => s.automations);
  const recentDirectories = useStore((s) => s.recentDirectories);
  const addRecentDirectory = useStore((s) => s.addRecentDirectory);
  const editing = useMemo(
    () => automations.find((a) => a.id === editingId) ?? null,
    [automations, editingId],
  );

  const { createAutomation, updateAutomation } = useAutomations();
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [saving, setSaving] = useState(false);
  /** 前端文件夹选择器弹窗开关 */
  const [browseCwdOpen, setBrowseCwdOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(() => {
    if (editing) {
      const detected = detectPreset(editing.cron);
      return {
        title: editing.title,
        description: editing.description ?? '',
        icon: editing.icon,
        cwd: editing.cwd || SYSTEM_WORKING_DIRECTORY,
        scheduleType: editing.scheduleType,
        preset: detected.preset,
        time: detected.time ?? '09:00',
        weekday: detected.weekday ?? '1',
        dayOfMonth: detected.dayOfMonth ?? '1',
        customCron: detected.preset === 'custom' ? (editing.cron ?? '') : '',
        runAtLocal: isoToLocalInput(editing.runAt),
        prompt: editing.prompt,
        agentId: editing.agentId ?? '',
      };
    }
    return {
      title: '',
      description: '',
      icon: undefined,
      cwd: SYSTEM_WORKING_DIRECTORY,
      scheduleType: 'cron',
      preset: 'daily',
      time: '09:00',
      weekday: '1',
      dayOfMonth: '1',
      customCron: '',
      runAtLocal: '',
      prompt: '',
      agentId: '',
    };
  });

  // Agent 列表（拉取失败仅显示默认项，不阻断）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .listAgents()
      .then(({ agents: list }) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => {
        /* 默认 agent 兜底 */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  };

  /** 选择工作目录：打开前端文件夹选择器（默认磁盘页） */
  const handlePickCwd = () => {
    setBrowseCwdOpen(true);
  };

  /** 当前周期配置生成的 cron（custom 预设时为原始输入） */
  const builtCron = useMemo(
    () => (form.scheduleType === 'cron' ? buildCron(form.preset, form) : ''),
    [form],
  );

  /** 下次执行时间预览（仅周期模式且表达式有效时） */
  const nextRunPreview = useMemo(() => {
    if (form.scheduleType !== 'cron' || !builtCron) return null;
    try {
      return CronExpressionParser.parse(builtCron).next().toDate().toLocaleString();
    } catch {
      return null;
    }
  }, [form.scheduleType, builtCron]);

  const handleSubmit = async () => {
    if (!form.title.trim()) {
      setError(t('automation.form.titleRequired'));
      return;
    }
    if (!form.prompt.trim()) {
      setError(t('automation.form.promptRequired'));
      return;
    }
    if (!form.cwd.trim()) {
      setError(t('automation.form.cwdRequired'));
      return;
    }
    let cron: string | undefined;
    let runAt: string | undefined;
    if (form.scheduleType === 'cron') {
      cron = builtCron;
      try {
        CronExpressionParser.parse(cron);
      } catch {
        setError(t('automation.form.cronInvalid'));
        return;
      }
    } else {
      if (!form.runAtLocal) {
        setError(t('automation.form.runAtRequired'));
        return;
      }
      const ts = new Date(form.runAtLocal).getTime();
      if (Number.isNaN(ts)) {
        setError(t('automation.form.runAtRequired'));
        return;
      }
      if (ts <= Date.now()) {
        setError(t('automation.form.runAtPast'));
        return;
      }
      runAt = new Date(ts).toISOString();
    }

    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        icon: form.icon || undefined,
        cwd: form.cwd.trim(),
        prompt: form.prompt.trim(),
        agentId: form.agentId || undefined,
        scheduleType: form.scheduleType,
        cron,
        runAt,
      };
      if (editing) {
        await updateAutomation(editing.id, payload);
        toast.success(t('automation.form.updatedToast'));
      } else {
        await createAutomation(payload);
        toast.success(t('automation.form.createdToast'));
      }
      closeAutomationForm();
    } catch {
      /* hook 已 toast，此处保留表单供修改 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => !o && closeAutomationForm()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? t('automation.form.editTitle') : t('automation.form.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('automation.form.description')}</DialogDescription>
        </DialogHeader>

        <DialogBody className="gap-4">
          {/* 标题 */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-title">{t('automation.form.titleLabel')}</Label>
            <Input
              id="automation-title"
              value={form.title}
              onChange={(e) => setField('title', e.target.value)}
              placeholder={t('automation.form.titlePlaceholder')}
              maxLength={100}
            />
          </div>

          {/* 描述 */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-description">{t('automation.form.descriptionLabel')}</Label>
            <Input
              id="automation-description"
              value={form.description}
              onChange={(e) => setField('description', e.target.value)}
              placeholder={t('automation.form.descriptionPlaceholder')}
              maxLength={200}
            />
          </div>

          {/* 图标 */}
          <div className="flex flex-col gap-1.5">
            <Label>{t('automation.form.iconLabel')}</Label>
            <IconPicker value={form.icon} onChange={(name) => setField('icon', name)} />
          </div>

          {/* 工作目录（必填，下拉：本机默认 + 最近目录 + 选择文件夹） */}
          <div className="flex flex-col gap-1.5">
            <Label>{t('automation.form.cwdLabel')}</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="w-full justify-start gap-2 font-normal">
                  {form.cwd === SYSTEM_WORKING_DIRECTORY ? (
                    <Monitor className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-left">
                    {form.cwd === SYSTEM_WORKING_DIRECTORY
                      ? t('directoryPicker.system')
                      : dirName(form.cwd)}
                  </span>
                  <ChevronDown className="size-4 shrink-0 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" collisionPadding={8} className="min-w-[18rem]">
                <div className="px-2 py-1 text-[11px] text-muted-foreground">
                  {t('directoryPicker.recent')}
                </div>
                <DropdownMenuItem
                  onSelect={() => setField('cwd', SYSTEM_WORKING_DIRECTORY)}
                  className="gap-2 py-1.5"
                >
                  <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">
                      {t('directoryPicker.system')}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {t('directoryPicker.systemDesc')}
                    </span>
                  </div>
                </DropdownMenuItem>
                {recentDirectories.length > 0 && (
                  <div className="max-h-[10.5rem] overflow-y-auto pr-1">
                    {recentDirectories.map((dir) => (
                      <DropdownMenuItem
                        key={dir}
                        onSelect={() => setField('cwd', dir)}
                        className="gap-2 py-1.5"
                        title={dir}
                      >
                        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-medium">{dirName(dir)}</span>
                          <span className="truncate font-mono text-xs text-muted-foreground">
                            {dir}
                          </span>
                        </div>
                      </DropdownMenuItem>
                    ))}
                  </div>
                )}
                <DropdownMenuSeparator className="mx-2" />
                <DropdownMenuItem
                  onSelect={handlePickCwd}
                  className="gap-1.5"
                >
                  <FolderInput className="size-3.5" />
                  <span>{t('directoryPicker.pickFolder')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* 调度方式 */}
          <div className="flex flex-col gap-2">
            <Label>{t('automation.form.scheduleLabel')}</Label>
            <Tabs
              value={form.scheduleType}
              onValueChange={(v) => setField('scheduleType', v as 'cron' | 'once')}
            >
              <TabsList className="w-full">
                <TabsTrigger value="cron" className="flex-1">
                  {t('automation.form.scheduleCron')}
                </TabsTrigger>
                <TabsTrigger value="once" className="flex-1">
                  {t('automation.form.scheduleOnce')}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {form.scheduleType === 'cron' ? (
              <div className="flex flex-col gap-3 rounded-lg border p-3">
                {/* 预设 */}
                <div className="flex flex-col gap-1.5">
                  <Label>{t('automation.form.presetLabel')}</Label>
                  <Select
                    value={form.preset}
                    onValueChange={(v) => setField('preset', v as CronPreset)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hourly">{t('automation.form.presetHourly')}</SelectItem>
                      <SelectItem value="daily">{t('automation.form.presetDaily')}</SelectItem>
                      <SelectItem value="weekly">{t('automation.form.presetWeekly')}</SelectItem>
                      <SelectItem value="monthly">{t('automation.form.presetMonthly')}</SelectItem>
                      <SelectItem value="custom">{t('automation.form.presetCustom')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* 每小时：仅分钟 */}
                {form.preset === 'hourly' && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="automation-minute">
                      {t('automation.form.minuteLabel')}
                    </Label>
                    <Input
                      id="automation-minute"
                      type="number"
                      min={0}
                      max={59}
                      value={form.time.split(':')[1] ?? '0'}
                      onChange={(e) => {
                        const mm = String(Math.min(59, Math.max(0, Number(e.target.value) || 0))).padStart(2, '0');
                        setField('time', `00:${mm}`);
                      }}
                    />
                  </div>
                )}

                {/* 每天/每周/每月：时间 + 条件字段 */}
                {(form.preset === 'daily' || form.preset === 'weekly' || form.preset === 'monthly') && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="automation-time">{t('automation.form.timeLabel')}</Label>
                    <Input
                      id="automation-time"
                      type="time"
                      value={form.time}
                      onChange={(e) => setField('time', e.target.value)}
                    />
                  </div>
                )}
                {form.preset === 'weekly' && (
                  <div className="flex flex-col gap-1.5">
                    <Label>{t('automation.form.weekdayLabel')}</Label>
                    <Select value={form.weekday} onValueChange={(v) => setField('weekday', v)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">{t('automation.form.weekdayMon')}</SelectItem>
                        <SelectItem value="2">{t('automation.form.weekdayTue')}</SelectItem>
                        <SelectItem value="3">{t('automation.form.weekdayWed')}</SelectItem>
                        <SelectItem value="4">{t('automation.form.weekdayThu')}</SelectItem>
                        <SelectItem value="5">{t('automation.form.weekdayFri')}</SelectItem>
                        <SelectItem value="6">{t('automation.form.weekdaySat')}</SelectItem>
                        <SelectItem value="0">{t('automation.form.weekdaySun')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {form.preset === 'monthly' && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="automation-dom">{t('automation.form.dayOfMonthLabel')}</Label>
                    <Input
                      id="automation-dom"
                      type="number"
                      min={1}
                      max={31}
                      value={form.dayOfMonth}
                      onChange={(e) =>
                        setField(
                          'dayOfMonth',
                          String(Math.min(31, Math.max(1, Number(e.target.value) || 1))),
                        )
                      }
                    />
                  </div>
                )}

                {/* 自定义 cron */}
                {form.preset === 'custom' && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="automation-cron">{t('automation.form.customRuleLabel')}</Label>
                    <Input
                      id="automation-cron"
                      value={form.customCron}
                      onChange={(e) => setField('customCron', e.target.value)}
                      placeholder="0 9 * * *"
                      className="font-mono"
                    />
                  </div>
                )}

                {/* 自然语言描述 + 下次执行（不展示原始表达式） */}
                {builtCron && nextRunPreview && (
                  <div className="flex flex-col gap-1 rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {describeCron(builtCron, locale)}
                    </span>
                    <span>
                      {t('automation.form.nextRunPreview')}: {nextRunPreview}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-3 rounded-lg border p-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="automation-runat">{t('automation.form.runAtLabel')}</Label>
                  <Input
                    id="automation-runat"
                    type="datetime-local"
                    value={form.runAtLocal}
                    min={isoToLocalInput(new Date().toISOString())}
                    onChange={(e) => setField('runAtLocal', e.target.value)}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('automation.form.onceHint')}
                </p>
              </div>
            )}
          </div>

          {/* 执行指令 */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-prompt">{t('automation.form.promptLabel')}</Label>
            <Textarea
              id="automation-prompt"
              value={form.prompt}
              onChange={(e) => setField('prompt', e.target.value)}
              placeholder={t('automation.form.promptPlaceholder')}
              rows={4}
            />
          </div>

          {/* Agent */}
          <div className="flex flex-col gap-1.5">
            <Label>{t('automation.form.agentLabel')}</Label>
            <Select value={form.agentId || '__default__'} onValueChange={(v) => setField('agentId', v === '__default__' ? '' : v)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{t('automation.form.agentDefault')}</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={closeAutomationForm} disabled={saving}>
            {t('automation.form.cancel')}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={saving}>
            {saving ? t('automation.form.saving') : t('automation.form.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <DirectoryBrowserDialog
      open={browseCwdOpen}
      onSelect={(path) => {
        setField('cwd', path);
        addRecentDirectory(path);
        setBrowseCwdOpen(false);
      }}
      onClose={() => setBrowseCwdOpen(false)}
    />
    </>
  );
}
