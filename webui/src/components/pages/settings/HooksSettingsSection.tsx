// webui/src/components/pages/settings/HooksSettingsSection.tsx
// 钩子引擎设置分区（独立 /settings/hooks 路由）：
// 配置区（启停/默认超时）+ 按事件分组列表 + 新建/编辑/删除/启停/测试触发 + 执行历史。

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, RefreshCw, Pencil, Trash2, Loader2, Play, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { useConfig } from '@/hooks/useConfig';
import { api } from '@/api/http';
import type { HookEvent, HookItem, RuleScope, HookType, HookUpsertBody, HookHistoryEntry } from '@/types/api';

const HOOK_EVENT_KEYS: Record<HookEvent, string> = {
  SessionStart: 'settings.hooks.eventSessionStart',
  UserPromptSubmit: 'settings.hooks.eventUserPromptSubmit',
  PreToolUse: 'settings.hooks.eventPreToolUse',
  PostToolUse: 'settings.hooks.eventPostToolUse',
  Stop: 'settings.hooks.eventStop',
  SessionEnd: 'settings.hooks.eventSessionEnd',
};

interface HookForm {
  name: string;
  event: HookEvent;
  matcher: string;
  type: HookType;
  command: string;
  modulePath: string;
  timeout: number;
  scope: RuleScope;
}

const EMPTY_FORM: HookForm = {
  name: '',
  event: 'PreToolUse',
  matcher: '',
  type: 'terminal',
  command: '',
  modulePath: '',
  timeout: 0,
  scope: 'global',
};

export function HooksSettingsSection() {
  const { t } = useTranslation();
  const { appConfig, updateAppConfig } = useConfig();
  const context = appConfig?.context;
  const hooksConfig = context?.hooks ?? { enabled: true, defaultTimeout: 10000 };

  const [loading, setLoading] = useState(true);
  const [hooks, setHooks] = useState<HookItem[]>([]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<HookForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [testOpen, setTestOpen] = useState(false);
  const [testHook, setTestHook] = useState<HookItem | null>(null);
  const [testInput, setTestInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HookHistoryEntry[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listHooks();
      setHooks([...result.project, ...result.global]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.hooks.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadHistory = useCallback(async () => {
    try {
      const result = await api.getHookHistory();
      setHistory(result.history);
    } catch {
      setHistory([]);
    }
  }, []);

  const patchHooks = (patch: Partial<typeof hooksConfig>) => {
    if (!context) return;
    void updateAppConfig({ context: { ...context, hooks: { ...hooksConfig, ...patch } } }).catch(() => {
      // toast 已在 useConfig 内处理
    });
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (hook: HookItem) => {
    setEditingId(hook.id);
    setForm({
      name: hook.name,
      event: hook.event,
      matcher: hook.matcher ?? '',
      type: hook.type,
      command: hook.command,
      modulePath: hook.modulePath,
      timeout: hook.timeout,
      scope: hook.scope,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name.trim() || saving) return;
    if (form.type === 'terminal' && !form.command.trim()) return;
    if (form.type === 'module' && !form.modulePath.trim()) return;
    setSaving(true);
    try {
      const body: HookUpsertBody = {
        name: form.name.trim(),
        event: form.event,
        matcher: form.matcher.trim() || null,
        type: form.type,
        ...(form.type === 'terminal' ? { command: form.command } : { modulePath: form.modulePath }),
        timeout: form.timeout,
        scope: form.scope,
      };
      if (editingId) {
        await api.updateHook(editingId, body);
        toast.success(t('settings.hooks.updated'));
      } else {
        await api.createHook(body);
        toast.success(t('settings.hooks.created'));
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.hooks.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (hook: HookItem) => {
    if (deleting) return;
    if (!window.confirm(t('settings.hooks.deleteConfirm', { name: hook.name }))) return;
    setDeleting(hook.id);
    try {
      await api.deleteHook(hook.id);
      toast.success(t('settings.hooks.deleted'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.hooks.deleteFailed'));
    } finally {
      setDeleting(null);
    }
  };

  const toggleEnabled = async (hook: HookItem, enabled: boolean) => {
    try {
      await api.updateHook(hook.id, {
        name: hook.name,
        event: hook.event,
        matcher: hook.matcher,
        type: hook.type,
        ...(hook.type === 'terminal' ? { command: hook.command } : { modulePath: hook.modulePath }),
        timeout: hook.timeout,
        scope: hook.scope,
        enabled,
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.hooks.saveFailed'));
    }
  };

  const openTest = (hook: HookItem) => {
    setTestHook(hook);
    setTestResult(null);
    setTestInput(
      JSON.stringify(
        hook.event === 'PreToolUse' || hook.event === 'PostToolUse'
          ? { toolName: 'terminal', toolInput: { command: 'echo test' } }
          : hook.event === 'UserPromptSubmit'
            ? { prompt: 'hello' }
            : {},
        null,
        2,
      ),
    );
    setTestOpen(true);
  };

  const runTest = async () => {
    if (!testHook || testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(testInput) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const result = await api.testHook(testHook.id, {
        ...(typeof parsed.toolName === 'string' ? { toolName: parsed.toolName } : {}),
        ...(parsed.toolInput && typeof parsed.toolInput === 'object'
          ? { toolInput: parsed.toolInput as Record<string, unknown> }
          : {}),
        ...(typeof parsed.prompt === 'string' ? { prompt: parsed.prompt } : {}),
      });
      setTestResult(JSON.stringify(result, null, 2));
    } catch (err) {
      setTestResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting(false);
    }
  };

  const toggleHistory = async (open: boolean) => {
    setHistoryOpen(open);
    if (open) await loadHistory();
  };

  // 按事件分组
  const grouped = hooks.reduce<Record<string, HookItem[]>>((acc, h) => {
    (acc[h.event] ??= []).push(h);
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* 页头（与其它设置子页统一：h1 + 副标题） */}
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{t('settings.nav.hooks')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.hooks.subtitle')}</p>
      </div>

      {/* 引擎配置 */}
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-foreground">{t('settings.hooks.engineTitle')}</div>
        <div className="text-xs text-muted-foreground">{t('settings.hooks.engineDesc')}</div>
        <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
          <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('common.enable')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.hooks.enabledDesc')}</span>
            </div>
            <Switch checked={hooksConfig.enabled} onCheckedChange={(v) => patchHooks({ enabled: v })} />
          </div>
          <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.hooks.defaultTimeout')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.hooks.defaultTimeoutDesc')}</span>
            </div>
            <Input
              type="number"
              min={1000}
              max={120000}
              className="w-32"
              value={hooksConfig.defaultTimeout}
              onChange={(e) => patchHooks({ defaultTimeout: Number(e.target.value) || 10000 })}
            />
          </div>
        </div>
      </div>

      {/* 钩子列表 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-foreground">{t('settings.hooks.listTitle')}</div>
          <div className="flex items-center gap-1.5">
            <Collapsible open={historyOpen} onOpenChange={(o) => void toggleHistory(o)}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="icon-sm" title={t('settings.hooks.historyTitle')}>
                  <History className="size-3.5" />
                </Button>
              </CollapsibleTrigger>
            </Collapsible>
            <Button variant="ghost" size="icon-sm" title={t('common.refresh')} onClick={() => void load()}>
              <RefreshCw className="size-3.5" />
            </Button>
            <Button className="gap-1.5" onClick={openCreate}>
              <Plus className="size-3.5" />
              <span className="hidden sm:inline">{t('settings.hooks.create')}</span>
            </Button>
          </div>
        </div>

        <Collapsible open={historyOpen} onOpenChange={(o) => void toggleHistory(o)}>
          <CollapsibleContent>
            <div className="mb-3 flex max-h-64 flex-col overflow-y-auto rounded-lg border border-border">
              {history.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  {t('settings.hooks.historyEmpty')}
                </div>
              ) : (
                history.map((h, i) => (
                  <div key={`${h.hookId}-${h.at}-${i}`} className="flex items-center gap-3 px-4 py-2 text-xs">
                    <Badge variant={h.ok ? 'secondary' : 'destructive'} className="text-[10px]">
                      {h.ok ? 'ok' : 'fail'}
                    </Badge>
                    <span className="font-medium text-foreground">{h.hookName}</span>
                    <span className="text-muted-foreground">{HOOK_EVENT_KEYS[h.event] ? t(HOOK_EVENT_KEYS[h.event]) : h.event}</span>
                    {h.decision ? (
                      <Badge variant={h.decision === 'deny' ? 'destructive' : 'secondary'} className="text-[10px]">
                        {h.decision}
                      </Badge>
                    ) : null}
                    <span className="tabular-nums text-muted-foreground">{h.durationMs}ms</span>
                    <span className="ml-auto text-muted-foreground">
                      {new Date(h.at).toLocaleTimeString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : hooks.length === 0 ? (
          <div className="rounded-lg border border-border px-4 py-8 text-center text-xs text-muted-foreground">
            {t('settings.hooks.empty')}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {Object.entries(grouped).map(([event, items]) => (
              <div key={event} className="flex flex-col rounded-lg border border-border">
                <div className="border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
                  {t(HOOK_EVENT_KEYS[event as HookEvent] ?? '') || event}
                </div>
                <div className="flex flex-col divide-y divide-border">
                  {items.map(hook => (
                    <div key={hook.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium text-foreground">{hook.name}</span>
                          <Badge variant="outline" className="text-[10px]">{hook.type}</Badge>
                          {hook.matcher ? (
                            <Badge variant="secondary" className="font-mono text-[10px]">
                              {hook.matcher}
                            </Badge>
                          ) : null}
                          <Badge variant="outline" className="text-[10px]">
                            {hook.scope === 'project'
                              ? t('settings.hooks.scopeProject')
                              : t('settings.hooks.scopeGlobal')}
                          </Badge>
                          {!hook.enabled && (
                            <Badge variant="outline" className="text-[10px]">{t('common.disabled')}</Badge>
                          )}
                        </div>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          {hook.type === 'terminal' ? hook.command : hook.modulePath}
                          {hook.timeout > 0 ? `  (timeout ${hook.timeout}ms)` : ''}
                        </span>
                      </div>
                      <Switch
                        checked={hook.enabled}
                        onCheckedChange={(v) => void toggleEnabled(hook, v)}
                        aria-label={t('common.enable')}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t('settings.hooks.test')}
                        onClick={() => openTest(hook)}
                      >
                        <Play className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t('common.edit')}
                        onClick={() => openEdit(hook)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t('common.delete')}
                        disabled={deleting === hook.id}
                        onClick={() => void remove(hook)}
                      >
                        {deleting === hook.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !saving && setDialogOpen(o)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editingId ? t('settings.hooks.editTitle') : t('settings.hooks.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('settings.hooks.formDesc')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hook-name">{t('settings.hooks.nameLabel')}</Label>
                  <Input
                    id="hook-name"
                    value={form.name}
                    onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder={t('settings.hooks.namePlaceholder')}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hook-event">{t('settings.hooks.eventLabel')}</Label>
                  <Select
                    value={form.event}
                    onValueChange={(v) => setForm(f => ({ ...f, event: v as HookEvent }))}
                  >
                    <SelectTrigger id="hook-event">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(HOOK_EVENT_KEYS) as HookEvent[]).map(ev => (
                        <SelectItem key={ev} value={ev}>
                          {t(HOOK_EVENT_KEYS[ev])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hook-matcher">{t('settings.hooks.matcherLabel')}</Label>
                  <Input
                    id="hook-matcher"
                    value={form.matcher}
                    onChange={(e) => setForm(f => ({ ...f, matcher: e.target.value }))}
                    placeholder={t('settings.hooks.matcherPlaceholder')}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hook-scope">{t('settings.hooks.scopeLabel')}</Label>
                  <Select
                    value={form.scope}
                    onValueChange={(v) => setForm(f => ({ ...f, scope: v as RuleScope }))}
                  >
                    <SelectTrigger id="hook-scope">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="global">{t('settings.hooks.scopeGlobal')}</SelectItem>
                      <SelectItem value="project">{t('settings.hooks.scopeProject')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hook-type">{t('settings.hooks.typeLabel')}</Label>
                  <Select
                    value={form.type}
                    onValueChange={(v) => setForm(f => ({ ...f, type: v as HookType }))}
                  >
                    <SelectTrigger id="hook-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="terminal">{t('settings.hooks.typeTerminal')}</SelectItem>
                      <SelectItem value="module">{t('settings.hooks.typeModule')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hook-timeout">{t('settings.hooks.timeoutLabel')}</Label>
                  <Input
                    id="hook-timeout"
                    type="number"
                    min={0}
                    max={120000}
                    value={form.timeout}
                    onChange={(e) => setForm(f => ({ ...f, timeout: Number(e.target.value) || 0 }))}
                  />
                  <span className="text-xs text-muted-foreground">{t('settings.hooks.timeoutHint')}</span>
                </div>
              </div>
              {form.type === 'terminal' ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hook-command">{t('settings.hooks.commandLabel')}</Label>
                  <Input
                    id="hook-command"
                    value={form.command}
                    onChange={(e) => setForm(f => ({ ...f, command: e.target.value }))}
                    placeholder={t('settings.hooks.commandPlaceholder')}
                    className="font-mono text-xs"
                  />
                  <span className="text-xs text-muted-foreground">{t('settings.hooks.commandHint')}</span>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hook-module">{t('settings.hooks.moduleLabel')}</Label>
                  <Input
                    id="hook-module"
                    value={form.modulePath}
                    onChange={(e) => setForm(f => ({ ...f, modulePath: e.target.value }))}
                    placeholder={t('settings.hooks.modulePlaceholder')}
                    className="font-mono text-xs"
                  />
                  <span className="text-xs text-muted-foreground">{t('settings.hooks.moduleHint')}</span>
                </div>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void save()}
              disabled={
                saving ||
                !form.name.trim() ||
                (form.type === 'terminal' && !form.command.trim()) ||
                (form.type === 'module' && !form.modulePath.trim())
              }
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {editingId ? t('common.save') : t('settings.hooks.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 测试触发弹窗 */}
      <Dialog open={testOpen} onOpenChange={(o) => !testing && setTestOpen(o)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('settings.hooks.testTitle', { name: testHook?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('settings.hooks.testDesc')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="hook-test-input">{t('settings.hooks.testInputLabel')}</Label>
                <Textarea
                  id="hook-test-input"
                  rows={6}
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              {testResult ? (
                <div className="flex flex-col gap-2">
                  <Label>{t('settings.hooks.testResultLabel')}</Label>
                  <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                    {testResult}
                  </pre>
                </div>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTestOpen(false)} disabled={testing}>
              {t('common.close')}
            </Button>
            <Button onClick={() => void runTest()} disabled={testing}>
              {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {t('settings.hooks.testRun')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
