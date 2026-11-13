// webui/src/components/pages/settings/RulesSettingsSection.tsx
// 规则引擎设置分区（嵌入 /settings/context/rules Tab）：
// 配置区（启停/预算）+ 双作用域规则列表 + 新建/编辑/删除/启停。

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, RefreshCw, Pencil, Trash2, Loader2, Settings2, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { useConfig } from '@/hooks/useConfig';
import { api } from '@/api/http';
import { useStore, SYSTEM_WORKING_DIRECTORY } from '@/store';
import type { RuleItem, RuleUpsertBody, RuleScope } from '@/types/api';

/** 规则编辑表单状态 */
interface RuleForm {
  name: string;
  description: string;
  content: string;
  pathsText: string;
  scope: RuleScope;
}

const EMPTY_FORM: RuleForm = { name: '', description: '', content: '', pathsText: '', scope: 'global' };

export function RulesSettingsSection() {
  const { t } = useTranslation();
  const { appConfig, updateAppConfig } = useConfig();
  const context = appConfig?.context;
  const rulesConfig = context?.rules ?? { enabled: true, maxAlwaysTokens: 4000, maxInjectPerSession: 20 };
  // 当前工作目录：项目规则必须按会话 cwd 读取/写入；系统作用域无项目根
  const workingDirectory = useStore(s => s.workingDirectory);
  const rulesCwd =
    workingDirectory && workingDirectory !== SYSTEM_WORKING_DIRECTORY ? workingDirectory : undefined;

  const [loading, setLoading] = useState(true);
  const [projectRules, setProjectRules] = useState<RuleItem[]>([]);
  const [globalRules, setGlobalRules] = useState<RuleItem[]>([]);
  const [scopeTab, setScopeTab] = useState<RuleScope>(() => (rulesCwd ? 'project' : 'global'));

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [clearScope, setClearScope] = useState<'all' | RuleScope | null>(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listRules(rulesCwd);
      setProjectRules(result.project);
      setGlobalRules(result.global);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.rules.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t, rulesCwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchRules = (patch: Partial<typeof rulesConfig>) => {
    if (!context) return;
    void updateAppConfig({ context: { ...context, rules: { ...rulesConfig, ...patch } } }).catch(() => {
      // toast 已在 useConfig 内处理
    });
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, scope: scopeTab });
    setDialogOpen(true);
  };

  const openEdit = (rule: RuleItem) => {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      description: rule.description,
      content: rule.content,
      pathsText: rule.paths.join('\n'),
      scope: rule.scope,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.content.trim() || saving) return;
    setSaving(true);
    try {
      const paths = form.pathsText
        .split('\n')
        .map(p => p.trim())
        .filter(p => p !== '');
      const body: RuleUpsertBody = {
        name: form.name.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        content: form.content,
        paths,
        scope: form.scope,
      };
      if (editingId) {
        await api.updateRule(editingId, body, rulesCwd);
        toast.success(t('settings.rules.updated'));
      } else {
        await api.createRule(body, rulesCwd);
        toast.success(t('settings.rules.created'));
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.rules.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (rule: RuleItem) => {
    if (deleting) return;
    if (!window.confirm(t('settings.rules.deleteConfirm', { name: rule.name }))) return;
    setDeleting(rule.id);
    try {
      await api.deleteRule(rule.id, rulesCwd);
      toast.success(t('settings.rules.deleted'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.rules.deleteFailed'));
    } finally {
      setDeleting(null);
    }
  };

  /** 批量清空（全局 / 项目 / 全部），带确认弹窗 */
  const doClear = async () => {
    if (!clearScope || clearing) return;
    setClearing(true);
    try {
      const res = await api.clearRules(clearScope, rulesCwd);
      toast.success(t('settings.rules.cleared', { count: res.removed }));
      setClearScope(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.rules.clearFailed'));
      setClearScope(null);
    } finally {
      setClearing(false);
    }
  };

  const toggleEnabled = async (rule: RuleItem, enabled: boolean) => {
    try {
      await api.updateRule(rule.id, {
        name: rule.name,
        description: rule.description,
        content: rule.content,
        paths: rule.paths,
        scope: rule.scope,
        enabled,
      }, rulesCwd);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.rules.saveFailed'));
    }
  };

  const renderRuleList = (items: RuleItem[], scope: RuleScope) => {
    if (items.length === 0) {
      return (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          {t(scope === 'project' ? 'settings.rules.emptyProject' : 'settings.rules.emptyGlobal')}
        </div>
      );
    }
    return (
      <div className="flex flex-col divide-y divide-border">
        {items.map(rule => (
          <div key={rule.id} className="flex items-center gap-3 px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium text-foreground">{rule.name}</span>
                <Badge variant={rule.paths.length > 0 ? 'secondary' : 'default'} className="text-[10px]">
                  {rule.paths.length > 0 ? t('settings.rules.modePaths') : t('settings.rules.modeAlways')}
                </Badge>
                {!rule.enabled && (
                  <Badge variant="outline" className="text-[10px]">{t('common.disabled')}</Badge>
                )}
              </div>
              {rule.description ? (
                <span className="truncate text-xs text-muted-foreground">{rule.description}</span>
              ) : null}
              {rule.paths.length > 0 ? (
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {rule.paths.join(' · ')}
                </span>
              ) : null}
            </div>
            <Switch
              checked={rule.enabled}
              onCheckedChange={(v) => void toggleEnabled(rule, v)}
              aria-label={t('common.enable')}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              title={t('common.edit')}
              onClick={() => openEdit(rule)}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title={t('common.delete')}
              disabled={deleting === rule.id}
              onClick={() => void remove(rule)}
            >
              {deleting === rule.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
            </Button>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* 引擎配置 */}
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-foreground">{t('settings.rules.engineTitle')}</div>
        <div className="text-xs text-muted-foreground">{t('settings.rules.engineDesc')}</div>
        <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
          <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('common.enable')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.rules.enabledDesc')}</span>
            </div>
            <Switch checked={rulesConfig.enabled} onCheckedChange={(v) => patchRules({ enabled: v })} />
          </div>
          <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.rules.maxAlwaysTokens')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.rules.maxAlwaysTokensDesc')}</span>
            </div>
            <Input
              type="number"
              min={500}
              max={50000}
              className="w-28"
              value={rulesConfig.maxAlwaysTokens}
              onChange={(e) => patchRules({ maxAlwaysTokens: Number(e.target.value) || 4000 })}
            />
          </div>
          <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.rules.maxInjectPerSession')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.rules.maxInjectPerSessionDesc')}</span>
            </div>
            <Input
              type="number"
              min={1}
              max={100}
              className="w-28"
              value={rulesConfig.maxInjectPerSession}
              onChange={(e) => patchRules({ maxInjectPerSession: Number(e.target.value) || 20 })}
            />
          </div>
        </div>
      </div>

      {/* 规则列表 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-foreground">{t('settings.rules.listTitle')}</div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon-sm" title={t('common.refresh')} onClick={() => void load()}>
              <RefreshCw className="size-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="gap-1.5">
                  <Settings2 className="size-3.5" />
                  {t('common.manage')}
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4} collisionPadding={8} className="min-w-44">
                <DropdownMenuItem onSelect={openCreate}>
                  <Plus className="size-3.5" />
                  {t('settings.rules.create')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={globalRules.length === 0 || clearing}
                  onSelect={() => setClearScope('global')}
                >
                  {t('settings.rules.clearGlobal')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={!rulesCwd || projectRules.length === 0 || clearing}
                  onSelect={() => setClearScope('project')}
                >
                  {t('settings.rules.clearProject')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={!rulesCwd || (globalRules.length + projectRules.length === 0) || clearing}
                  onSelect={() => setClearScope('all')}
                >
                  {t('settings.rules.clearAll')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* 作用域胶囊导航：全局 / 项目 */}
        <Tabs value={scopeTab} onValueChange={(v) => setScopeTab(v as RuleScope)}>
          <TabsList aria-label={t('settings.rules.listTitle')}>
            <TabsTrigger value="global">{t('settings.rules.tabGlobal')}</TabsTrigger>
            <TabsTrigger value="project">{t('settings.rules.tabProject')}</TabsTrigger>
          </TabsList>
        </Tabs>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col rounded-lg border border-border">
            {renderRuleList(scopeTab === 'project' ? projectRules : globalRules, scopeTab)}
          </div>
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !saving && setDialogOpen(o)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingId ? t('settings.rules.editTitle') : t('settings.rules.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('settings.rules.formDesc')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="rule-name">{t('settings.rules.nameLabel')}</Label>
                  <Input
                    id="rule-name"
                    value={form.name}
                    onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder={t('settings.rules.namePlaceholder')}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="rule-scope">{t('settings.rules.scopeLabel')}</Label>
                  <Select
                    value={form.scope}
                    onValueChange={(v) => setForm(f => ({ ...f, scope: v as RuleScope }))}
                  >
                    <SelectTrigger id="rule-scope">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="global">{t('settings.rules.scopeGlobal')}</SelectItem>
                      <SelectItem value="project">{t('settings.rules.scopeProject')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="rule-desc">{t('settings.rules.descLabel')}</Label>
                <Input
                  id="rule-desc"
                  value={form.description}
                  onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder={t('settings.rules.descPlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="rule-content">{t('settings.rules.contentLabel')}</Label>
                <Textarea
                  id="rule-content"
                  rows={8}
                  value={form.content}
                  onChange={(e) => setForm(f => ({ ...f, content: e.target.value }))}
                  placeholder={t('settings.rules.contentPlaceholder')}
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="rule-paths">{t('settings.rules.pathsLabel')}</Label>
                <Textarea
                  id="rule-paths"
                  rows={3}
                  value={form.pathsText}
                  onChange={(e) => setForm(f => ({ ...f, pathsText: e.target.value }))}
                  placeholder={t('settings.rules.pathsPlaceholder')}
                  className="font-mono text-xs"
                />
                <span className="text-xs text-muted-foreground">{t('settings.rules.pathsHint')}</span>
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void save()}
              disabled={saving || !form.name.trim() || !form.content.trim()}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {editingId ? t('common.save') : t('settings.rules.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 清空规则确认（全局 / 项目 / 全部） */}
      <ConfirmDialog
        open={clearScope !== null}
        title={t('settings.rules.clearTitle')}
        description={
          clearScope === 'global'
            ? t('settings.rules.clearGlobalConfirm')
            : clearScope === 'project'
              ? t('settings.rules.clearProjectConfirm')
              : t('settings.rules.clearAllConfirm')
        }
        destructive
        loading={clearing}
        confirmText={t('settings.rules.clearConfirmAction')}
        onConfirm={() => void doClear()}
        onOpenChange={(o) => !o && !clearing && setClearScope(null)}
      />
    </div>
  );
}
