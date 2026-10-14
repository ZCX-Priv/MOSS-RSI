import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  Settings,
  Bot,
  Server,
  Activity,
  Globe,
  Notebook,
  Palette,
  ClipboardList,
  Webhook,
  Info,
  ChevronDown,
  ChevronRight,
  Check,
  Sun,
  Moon,
  Monitor,
  Plus,
  Book,
  ExternalLink,
  Terminal,
  Layers,
  Trash2,
  Loader2,
  Search,
  Wrench,
  Pencil,
  ShieldCheck,
  ScrollText,
  RefreshCw,
  Eye,
  Sparkles,
  X,
  Smartphone,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { SettingsSection } from '../../types';
import { useTheme } from '../../contexts/ThemeContext';
import { useI18n } from '../../contexts/I18nContext';
import type { Locale } from '../../i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
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
import { useAgents } from '../../hooks/useAgents';
import { useTools } from '../../hooks/useTools';
import { useCommands } from '../../hooks/useCommands';
import { useConfig } from '../../hooks/useConfig';
import { useFileIndex } from '../../hooks/useFileIndex';
import { useReducedMotion } from '../../hooks/useAnimationClass';
import { useStore, RIGHT_PANEL_PRESETS, rightPanelPresetOf, type RightPanelPreset } from '../../store';
import { eventToShortcut, formatShortcutLabel } from '../../utils/shortcut';
import { api } from '../../api/http';
import { TOOL_ICON_MAP } from '../../lib/tool-icons';
import { SKILL_ICON_CHOICES, resolveSkillIcon } from '../../lib/skill-icons';
import type { SafetyConfig, LogLevel, LogsConfig, LogFileInfo, ContextEngineConfig, FileIndexConfig, ToolItem, AgentDetail } from '../../types/api';
import { ToolEditDialog } from './settings/ToolEditDialog';
import { CreateAgentDialog } from '../settings/CreateAgentDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// 服务商设置页（App.tsx 从本模块导入）
export { ProviderSettings } from './ProviderSettings';
// 规则 / 钩子 / 记忆引擎设置分区（App.tsx 从本模块导入）
export { RulesSettingsSection } from './settings/RulesSettingsSection';
export { HooksSettingsSection } from './settings/HooksSettingsSection';
export { MemorySettingsSection } from './settings/MemorySettingsSection';
// 远程控制设置分区（App.tsx 从本模块导入）
export { RemoteSettingsSection } from './settings/RemoteSettingsSection';

export interface NavItem {
  id: SettingsSection;
  labelKey: string;
  Icon: LucideIcon;
}

export const settingsNavItems: NavItem[] = [
  { id: 'general', labelKey: 'settings.nav.general', Icon: Settings },
  { id: 'appearance', labelKey: 'settings.nav.appearance', Icon: Palette },
  { id: 'agent', labelKey: 'settings.nav.agent', Icon: Bot },
  { id: 'provider', labelKey: 'settings.nav.provider', Icon: Server },
  { id: 'context', labelKey: 'settings.nav.context', Icon: Layers },
  { id: 'tools', labelKey: 'settings.nav.tools', Icon: Wrench },
  { id: 'safety', labelKey: 'settings.nav.safety', Icon: ShieldCheck },
  { id: 'remote', labelKey: 'settings.nav.remote', Icon: Smartphone },
  { id: 'logs', labelKey: 'settings.nav.logs', Icon: ScrollText },
  { id: 'commands', labelKey: 'settings.nav.commands', Icon: Terminal },
  { id: 'hooks', labelKey: 'settings.nav.hooks', Icon: Webhook },
  { id: 'about', labelKey: 'settings.nav.about', Icon: Info },
];

export interface SearchableSetting {
  labelKey: string;
  descriptionKey?: string;
  section: SettingsSection;
}

export const settingsSearchIndex: SearchableSetting[] = [
  // 页面级（导航项 + placeholder 页面描述）
  { labelKey: 'settings.nav.general', section: 'general' },
  { labelKey: 'settings.nav.appearance', section: 'appearance' },
  { labelKey: 'settings.nav.render', section: 'render' },
  { labelKey: 'settings.render.markdown', descriptionKey: 'settings.render.markdownDesc', section: 'render' },
  { labelKey: 'settings.render.math', descriptionKey: 'settings.render.mathDesc', section: 'render' },
  { labelKey: 'settings.render.mathFallback', descriptionKey: 'settings.render.mathFallbackDesc', section: 'render' },
  { labelKey: 'settings.render.mermaid', descriptionKey: 'settings.render.mermaidDesc', section: 'render' },
  { labelKey: 'settings.render.codeHighlight', descriptionKey: 'settings.render.codeHighlightDesc', section: 'render' },
  { labelKey: 'settings.render.filePreview', descriptionKey: 'settings.render.filePreviewDesc', section: 'render' },
  { labelKey: 'settings.nav.anim', section: 'anim' },
  { labelKey: 'settings.anim.master', descriptionKey: 'settings.anim.masterDesc', section: 'anim' },
  { labelKey: 'settings.anim.route', descriptionKey: 'settings.anim.routeDesc', section: 'anim' },
  { labelKey: 'settings.anim.message', descriptionKey: 'settings.anim.messageDesc', section: 'anim' },
  { labelKey: 'settings.anim.list', descriptionKey: 'settings.anim.listDesc', section: 'anim' },
  { labelKey: 'settings.anim.stat', descriptionKey: 'settings.anim.statDesc', section: 'anim' },
  { labelKey: 'settings.anim.hub', descriptionKey: 'settings.anim.hubDesc', section: 'anim' },
  { labelKey: 'settings.anim.panel', descriptionKey: 'settings.anim.panelDesc', section: 'anim' },
  { labelKey: 'settings.nav.agent', section: 'agent' },
  { labelKey: 'settings.nav.provider', section: 'provider' },
  { labelKey: 'settings.nav.context', section: 'context' },
  { labelKey: 'settings.context.compactionTitle', descriptionKey: 'settings.context.compactionDesc', section: 'context' },
  { labelKey: 'settings.context.summaryModel', descriptionKey: 'settings.context.summaryModelDesc', section: 'context' },
  { labelKey: 'settings.context.healerTitle', descriptionKey: 'settings.context.healerDesc', section: 'context' },
  { labelKey: 'settings.nav.tools', section: 'tools' },
  { labelKey: 'settings.tools.maxTurnsLabel', descriptionKey: 'settings.tools.maxTurnsDesc', section: 'tools' },
  { labelKey: 'settings.nav.safety', section: 'safety' },
  { labelKey: 'settings.nav.remote', section: 'remote' },
  { labelKey: 'settings.remote.title', descriptionKey: 'settings.remote.desc', section: 'remote' },
  { labelKey: 'settings.remote.lan.title', descriptionKey: 'settings.remote.lan.desc', section: 'remote' },
  { labelKey: 'settings.remote.tunnel.title', descriptionKey: 'settings.remote.tunnel.desc', section: 'remote' },
  { labelKey: 'settings.nav.logs', section: 'logs' },
  { labelKey: 'settings.safety.defaultMode', descriptionKey: 'settings.safety.defaultModeDesc', section: 'safety' },
  { labelKey: 'settings.safety.confirmTimeout', descriptionKey: 'settings.safety.confirmTimeoutDesc', section: 'safety' },
  { labelKey: 'settings.safety.sandboxTitle', descriptionKey: 'settings.safety.sandboxDesc', section: 'safety' },
  { labelKey: 'settings.safety.rulesTitle', descriptionKey: 'settings.safety.rulesDesc', section: 'safety' },
  { labelKey: 'settings.placeholder.indexTitle', descriptionKey: 'settings.placeholder.indexDesc', section: 'index' },
  { labelKey: 'settings.commands.title', descriptionKey: 'settings.commands.subtitle', section: 'commands' },
  { labelKey: 'settings.commands.createCommand', section: 'commands' },
  { labelKey: 'settings.placeholder.rulesTitle', descriptionKey: 'settings.placeholder.rulesDesc', section: 'rules' },
  { labelKey: 'settings.placeholder.memoryTitle', descriptionKey: 'settings.placeholder.memoryDesc', section: 'memory' },
  { labelKey: 'settings.placeholder.hooksTitle', descriptionKey: 'settings.placeholder.hooksDesc', section: 'hooks' },
  { labelKey: 'settings.nav.about', section: 'about' },

  // 通用设置详细项
  { labelKey: 'settings.general.theme', descriptionKey: 'settings.general.selectTheme', section: 'general' },
  { labelKey: 'settings.general.language', descriptionKey: 'settings.general.languageDesc', section: 'general' },
  { labelKey: 'settings.general.sendShortcut', descriptionKey: 'settings.general.sendShortcutDesc', section: 'general' },
  { labelKey: 'settings.general.followUpBehavior', descriptionKey: 'settings.general.followUpBehaviorDesc', section: 'general' },

  // 外观设置详细项
  { labelKey: 'settings.appearance.accentColor', descriptionKey: 'settings.appearance.accentColorDesc', section: 'appearance' },
  { labelKey: 'settings.appearance.fontSize', descriptionKey: 'settings.appearance.fontSizeDesc', section: 'appearance' },
  { labelKey: 'settings.appearance.uiDensity', descriptionKey: 'settings.appearance.uiDensityDesc', section: 'appearance' },
  { labelKey: 'settings.appearance.cornerRadius', descriptionKey: 'settings.appearance.cornerRadiusDesc', section: 'appearance' },
  { labelKey: 'settings.appearance.rightPanel', descriptionKey: 'settings.appearance.rightPanelDesc', section: 'appearance' },

  // 智能体设置详细项
  { labelKey: 'settings.agent.builtIn', section: 'agent' },
  { labelKey: 'settings.agent.custom', section: 'agent' },
  { labelKey: 'settings.agent.createAgent', section: 'agent' },

  // 服务商设置详细项
  { labelKey: 'settings.provider.addProvider', section: 'provider' },
  { labelKey: 'settings.provider.providerName', section: 'provider' },
  { labelKey: 'settings.provider.modelName', section: 'provider' },
  { labelKey: 'settings.provider.apiFormat', section: 'provider' },
  { labelKey: 'settings.provider.endpoint', section: 'provider' },
  { labelKey: 'settings.provider.apiKey', section: 'provider' },
  { labelKey: 'settings.provider.balanceUrl', section: 'provider' },
  { labelKey: 'settings.provider.modelsUrl', section: 'provider' },
  { labelKey: 'settings.provider.thinkingLevel', descriptionKey: 'settings.provider.thinkingModeDesc', section: 'provider' },

  // 关于设置详细项
  { labelKey: 'settings.about.relatedLinks', section: 'about' },
  { labelKey: 'settings.about.docs', section: 'about' },
];

export function SettingsPage() {
  const { pathname } = useLocation();
  return (
    <section
      key={pathname}
      className="anim-route animate-in fade-in slide-in-from-bottom-1 duration-200 flex-1 overflow-auto"
    >
      <Outlet />
    </section>
  );
}

/** 外观设置：Tab 容器（外观/渲染/动画；路由驱动） */
export function AppearanceSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const tab = pathname.startsWith('/settings/appearance/render')
    ? 'render'
    : pathname.startsWith('/settings/appearance/anim')
      ? 'anim'
      : 'appearance';
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="px-6 py-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{t('settings.nav.appearance')}</h1>
          <p className="text-sm text-muted-foreground">{t('settings.appearance.subtitle')}</p>
        </div>
      </div>
      <Tabs
        value={tab}
        onValueChange={(v) =>
          navigate(
            v === 'appearance'
              ? '/settings/appearance'
              : v === 'render'
                ? '/settings/appearance/render'
                : '/settings/appearance/anim',
          )
        }
      >
        <div className="px-6 py-3">
          <TabsList>
            <TabsTrigger value="appearance" className="gap-1.5">
              <Palette className="size-3.5" />
              {t('settings.nav.appearance')}
            </TabsTrigger>
            <TabsTrigger value="render" className="gap-1.5">
              <Eye className="size-3.5" />
              {t('settings.nav.render')}
            </TabsTrigger>
            <TabsTrigger value="anim" className="gap-1.5">
              <Sparkles className="size-3.5" />
              {t('settings.nav.anim')}
            </TabsTrigger>
          </TabsList>
        </div>
      </Tabs>
      {/* 分区切换入场动画（key=pathname：Tab 切换时重播） */}
      <div
        key={pathname}
        className="anim-route animate-in fade-in slide-in-from-bottom-1 duration-200 flex-1 overflow-auto"
      >
        <Outlet />
      </div>
    </div>
  );
}

/* ===== 渲染设置（render 模块：markdown/公式/图表/高亮/文件预览） ===== */

/** 通用设置行（与 GeneralSettings 行结构对齐：divide-y 分隔 + py-3；children 渲染在描述下方） */
function SettingRow({
  title,
  desc,
  checked,
  disabled,
  onCheckedChange,
  children,
}: {
  title: string;
  desc?: string;
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (v: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-foreground">{title}</span>
        {desc && <span className="text-xs text-muted-foreground">{desc}</span>}
        {children}
      </div>
      {onCheckedChange && (
        <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
      )}
    </div>
  );
}

export function RenderSettingsSection() {
  const { t } = useTranslation();
  const renderSettings = useStore((s) => s.renderSettings);
  const setRenderSetting = useStore((s) => s.setRenderSetting);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.render.contentTitle')}</div>
        <div className="flex flex-col divide-y divide-border">
          <SettingRow
            title={t('settings.render.markdown')}
            desc={t('settings.render.markdownDesc')}
            checked={renderSettings.markdownEnabled}
            onCheckedChange={(v) => setRenderSetting('markdownEnabled', v)}
          />
          <SettingRow
            title={t('settings.render.math')}
            desc={t('settings.render.mathDesc')}
            checked={renderSettings.mathEnabled}
            onCheckedChange={(v) => setRenderSetting('mathEnabled', v)}
          />
          <SettingRow
            title={t('settings.render.mathFallback')}
            desc={t('settings.render.mathFallbackDesc')}
            checked={renderSettings.mathFallback}
            disabled={!renderSettings.mathEnabled}
            onCheckedChange={(v) => setRenderSetting('mathFallback', v)}
          />
          <SettingRow
            title={t('settings.render.mermaid')}
            desc={t('settings.render.mermaidDesc')}
            checked={renderSettings.mermaidEnabled}
            onCheckedChange={(v) => setRenderSetting('mermaidEnabled', v)}
          />
          <SettingRow
            title={t('settings.render.codeHighlight')}
            desc={t('settings.render.codeHighlightDesc')}
            checked={renderSettings.codeHighlightEnabled}
            onCheckedChange={(v) => setRenderSetting('codeHighlightEnabled', v)}
          />
          <SettingRow
            title={t('settings.render.filePreview')}
            desc={t('settings.render.filePreviewDesc')}
            checked={renderSettings.filePreviewEnabled}
            onCheckedChange={(v) => setRenderSetting('filePreviewEnabled', v)}
          />
        </div>
      </div>
    </div>
  );
}

/* ===== 动画设置（外观页「动画」Tab：总开关 + 分开关 + 系统减弱动态联动） ===== */

export function AnimSettingsSection() {
  const { t } = useTranslation();
  const animationSettings = useStore((s) => s.animationSettings);
  const setAnimationSetting = useStore((s) => s.setAnimationSetting);
  // 系统开启"减弱动态效果"：全部动画强制停用，开关禁用并显示为关（实时生效）
  const reduced = useReducedMotion();
  const masterOff = !animationSettings.enabled;
  const catDisabled = reduced || masterOff;
  const catChecked = (v: boolean) => v && !catDisabled;

  return (
    <div className="flex flex-col gap-6 p-6">
      {reduced && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t('settings.anim.reducedMotionNotice')}
        </div>
      )}
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.anim.groupTitle')}</div>
        <div className="flex flex-col divide-y divide-border">
          <SettingRow
            title={t('settings.anim.master')}
            desc={t('settings.anim.masterDesc')}
            checked={animationSettings.enabled && !reduced}
            disabled={reduced}
            onCheckedChange={(v) => setAnimationSetting('enabled', v)}
          />
          <SettingRow
            title={t('settings.anim.route')}
            desc={t('settings.anim.routeDesc')}
            checked={catChecked(animationSettings.route)}
            disabled={catDisabled}
            onCheckedChange={(v) => setAnimationSetting('route', v)}
          />
          <SettingRow
            title={t('settings.anim.message')}
            desc={t('settings.anim.messageDesc')}
            checked={catChecked(animationSettings.message)}
            disabled={catDisabled}
            onCheckedChange={(v) => setAnimationSetting('message', v)}
          />
          <SettingRow
            title={t('settings.anim.list')}
            desc={t('settings.anim.listDesc')}
            checked={catChecked(animationSettings.list)}
            disabled={catDisabled}
            onCheckedChange={(v) => setAnimationSetting('list', v)}
          />
          <SettingRow
            title={t('settings.anim.stat')}
            desc={t('settings.anim.statDesc')}
            checked={catChecked(animationSettings.stat)}
            disabled={catDisabled}
            onCheckedChange={(v) => setAnimationSetting('stat', v)}
          />
          <SettingRow
            title={t('settings.anim.hub')}
            desc={t('settings.anim.hubDesc')}
            checked={catChecked(animationSettings.hub)}
            disabled={catDisabled}
            onCheckedChange={(v) => setAnimationSetting('hub', v)}
          />
          <SettingRow
            title={t('settings.anim.panel')}
            desc={t('settings.anim.panelDesc')}
            checked={catChecked(animationSettings.panel)}
            disabled={catDisabled}
            onCheckedChange={(v) => setAnimationSetting('panel', v)}
          />
        </div>
      </div>
    </div>
  );
}

/* ===== 安全设置（safety 统一权限系统） ===== */

/** 安全设置默认值（后端 config 缺 safety 段时的展示兜底） */
const SAFETY_FALLBACK: SafetyConfig = {
  defaultMode: 'ask',
  confirmTimeoutMinutes: 5,
  blockDangerousCommands: true,
  cautionPolicy: 'ask',
  rules: { allow: [], deny: [], ask: [] },
  protectedPaths: ['~/.ssh', '~/.gnupg', '~/.aws'],
};

/** 规则列表编辑器（allow/deny/ask 同构） */
function SafetyRuleList({
  titleKey,
  descKey,
  rules,
  onAdd,
  onRemove,
  accentClass,
}: {
  titleKey: string;
  descKey: string;
  rules: string[];
  onAdd: (rule: string) => void;
  onRemove: (rule: string) => void;
  accentClass: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');

  const add = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (rules.includes(trimmed)) {
      toast.error(t('settings.safety.ruleDuplicate'));
      return;
    }
    onAdd(trimmed);
    setDraft('');
  };

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2">
        <span className={cn('size-2 shrink-0 rounded-full', accentClass)} />
        <span className="text-sm font-medium text-foreground">{t(titleKey)}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground">
          {rules.length}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{t(descKey)}</p>
      {rules.length > 0 && (
        <div className="flex flex-col gap-1">
          {rules.map((rule) => (
            <div
              key={rule}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2 py-1"
            >
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{rule}</code>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(rule)}
                title={t('common.delete')}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="terminal(git *)"
          className="h-8 flex-1 font-mono text-xs"
        />
        <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1" onClick={add} disabled={!draft.trim()}>
          <Plus className="size-3.5" />
          <span className="hidden sm:inline">{t('settings.safety.addRule')}</span>
        </Button>
      </div>
    </div>
  );
}

export function SafetySettings() {
  const { t } = useTranslation();
  const { appConfig, updateAppConfig } = useConfig();
  const [pathDraft, setPathDraft] = useState('');
  const safety = appConfig?.safety ?? SAFETY_FALLBACK;

  const patchSafety = async (patch: Partial<typeof SAFETY_FALLBACK>) => {
    try {
      await updateAppConfig({ safety: { ...safety, ...patch } });
    } catch {
      // toast 已在 useConfig 内处理
    }
  };

  const patchRules = (list: 'allow' | 'deny' | 'ask', mutate: (rules: string[]) => string[]) => {
    void patchSafety({ rules: { ...safety.rules, [list]: mutate([...safety.rules[list]]) } });
  };

  const addProtectedPath = () => {
    const trimmed = pathDraft.trim();
    if (!trimmed) return;
    if (safety.protectedPaths.includes(trimmed)) return;
    void patchSafety({ protectedPaths: [...safety.protectedPaths, trimmed] });
    setPathDraft('');
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{t('settings.safety.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.safety.subtitle')}</p>
      </div>

      {/* 权限模式 */}
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.safety.modeTitle')}</div>
        <div className="flex flex-col divide-y divide-border">
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.safety.defaultMode')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.safety.defaultModeDesc')}</span>
            </div>
            <Select
              value={safety.defaultMode}
              onValueChange={(v) => void patchSafety({ defaultMode: v as typeof safety.defaultMode })}
            >
              <SelectTrigger className="h-8 w-40 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value="ask">{t('permissionMode.ask.label')}</SelectItem>
                <SelectItem value="auto">{t('permissionMode.auto.label')}</SelectItem>
                <SelectItem value="skip">{t('permissionMode.skip.label')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.safety.confirmTimeout')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.safety.confirmTimeoutDesc')}</span>
            </div>
            <Input
              type="number"
              min={0}
              max={1440}
              value={safety.confirmTimeoutMinutes}
              onChange={(e) => {
                const v = Math.max(0, Math.min(1440, Number(e.target.value) || 0));
                void patchSafety({ confirmTimeoutMinutes: v });
              }}
              className="h-8 w-24 shrink-0 text-right"
            />
          </div>
        </div>
      </div>

      {/* 沙箱（智能拦截） */}
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.safety.sandboxTitle')}</div>
        <p className="text-xs text-muted-foreground">{t('settings.safety.sandboxDesc')}</p>
        <div className="flex flex-col divide-y divide-border">
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.safety.blockDangerous')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.safety.blockDangerousDesc')}</span>
            </div>
            <Switch
              checked={safety.blockDangerousCommands}
              onCheckedChange={(v) => void patchSafety({ blockDangerousCommands: v })}
            />
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.safety.cautionPolicy')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.safety.cautionPolicyDesc')}</span>
            </div>
            <Select
              value={safety.cautionPolicy}
              onValueChange={(v) => void patchSafety({ cautionPolicy: v as typeof safety.cautionPolicy })}
            >
              <SelectTrigger className="h-8 w-32 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value="ask">{t('settings.safety.cautionAsk')}</SelectItem>
                <SelectItem value="deny">{t('settings.safety.cautionDeny')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2 py-3">
            <span className="text-sm text-foreground">{t('settings.safety.protectedPaths')}</span>
            <span className="text-xs text-muted-foreground">{t('settings.safety.protectedPathsDesc')}</span>
            {safety.protectedPaths.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {safety.protectedPaths.map((p) => (
                  <Badge key={p} variant="secondary" className="gap-1 py-0.5 pl-2 pr-1 font-mono text-[11px]">
                    {p}
                    <button
                      className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                      onClick={() =>
                        void patchSafety({ protectedPaths: safety.protectedPaths.filter((x) => x !== p) })
                      }
                      title={t('common.delete')}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input
                value={pathDraft}
                onChange={(e) => setPathDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addProtectedPath();
                  }
                }}
                placeholder="~/.ssh"
                className="h-8 flex-1 font-mono text-xs"
              />
              <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1" onClick={addProtectedPath} disabled={!pathDraft.trim()}>
                <Plus className="size-3.5" />
              </Button>
            </div>
            {/* 硬保护只读展示 */}
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2 py-1">
              <ShieldCheck className="size-3 shrink-0 text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">
                {t('settings.safety.hardProtected')}
                <code className="mx-1 font-mono">~/.moss/config</code>
                {t('settings.safety.hardProtectedDesc')}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 规则表 */}
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.safety.rulesTitle')}</div>
        <p className="text-xs text-muted-foreground">{t('settings.safety.rulesDesc')}</p>
        <details className="rounded-md border border-border bg-muted/20 px-2 py-1.5">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">
            {t('settings.safety.syntaxHelp')}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
            {t('settings.safety.syntaxExamples')}
          </pre>
        </details>
        <div className="flex flex-col divide-y divide-border">
          <SafetyRuleList
            titleKey="settings.safety.denyRules"
            descKey="settings.safety.denyRulesDesc"
            rules={safety.rules.deny}
            onAdd={(rule) => patchRules('deny', (r) => [...r, rule])}
            onRemove={(rule) => patchRules('deny', (r) => r.filter((x) => x !== rule))}
            accentClass="bg-red-500"
          />
          <SafetyRuleList
            titleKey="settings.safety.askRules"
            descKey="settings.safety.askRulesDesc"
            rules={safety.rules.ask}
            onAdd={(rule) => patchRules('ask', (r) => [...r, rule])}
            onRemove={(rule) => patchRules('ask', (r) => r.filter((x) => x !== rule))}
            accentClass="bg-amber-500"
          />
          <SafetyRuleList
            titleKey="settings.safety.allowRules"
            descKey="settings.safety.allowRulesDesc"
            rules={safety.rules.allow}
            onAdd={(rule) => patchRules('allow', (r) => [...r, rule])}
            onRemove={(rule) => patchRules('allow', (r) => r.filter((x) => x !== rule))}
            accentClass="bg-emerald-500"
          />
        </div>
      </div>
    </div>
  );
}

/* ===== 上下文引擎设置（压缩 / 摘要模型 / 工具结果修剪 / 自愈） ===== */

const CONTEXT_FALLBACK: ContextEngineConfig = {
  compaction: {
    enabled: true,
    compactRatio: 0.8,
    tailKeepRatio: 0.16,
    summaryMaxTokens: 8192,
    minFoldTokens: 400,
    summaryModel: 'inherit',
  },
  toolPruning: { enabled: true, thresholdChars: 8192, keepHeadChars: 4096, keepTailChars: 1024 },
  healer: { enabled: true, toolNameFuzzy: true, schemaFix: true },
  telemetry: { enabled: true },
};

/** 上下文引擎设置行（标题 + 描述 + 控件；复用 safety/render 的行样式） */
function ContextSettingRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border/60 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {desc ? <span className="text-xs text-muted-foreground">{desc}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** 上下文设置：Tab 容器（引擎/索引/规则/记忆；路由驱动） */
export function ContextSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const suffix = pathname.startsWith('/settings/context/')
    ? pathname.slice('/settings/context/'.length)
    : '';
  const tab = ['index', 'rules', 'memory'].includes(suffix)
    ? suffix
    : 'engine';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 标题区：左标题右操作 */}
      <div className="flex flex-col gap-4 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{t('settings.nav.context')}</h1>
          <p className="text-sm text-muted-foreground">{t('settings.context.subtitle')}</p>
        </div>
      </div>
      <Tabs
        value={tab}
        onValueChange={(v) =>
          navigate(v === 'engine' ? '/settings/context' : `/settings/context/${v}`)
        }
      >
        <div className="px-6 py-3">
          <TabsList>
            <TabsTrigger value="engine" className="gap-1.5">
              <Activity className="size-3.5" />
              {t('settings.context.tabEngine')}
            </TabsTrigger>
            <TabsTrigger value="index" className="gap-1.5">
              <Globe className="size-3.5" />
              {t('settings.nav.index')}
            </TabsTrigger>
            <TabsTrigger value="rules" className="gap-1.5">
              <ClipboardList className="size-3.5" />
              {t('settings.nav.rules')}
            </TabsTrigger>
            <TabsTrigger value="memory" className="gap-1.5">
              <Notebook className="size-3.5" />
              {t('settings.nav.memory')}
            </TabsTrigger>
          </TabsList>
        </div>
      </Tabs>
      {/* 分区切换入场动画（key=pathname：Tab 切换时重播） */}
      <div
        key={pathname}
        className="anim-route animate-in fade-in slide-in-from-bottom-1 duration-200 flex-1 overflow-auto"
      >
        <Outlet />
      </div>
    </div>
  );
}

/** 引擎设置（上下文压缩 / 摘要模型 / 工具结果修剪 / 自愈） */
export function ContextEngineSettings() {
  const { t } = useTranslation();
  const { appConfig, apiConfig, updateAppConfig } = useConfig();
  const context = appConfig?.context ?? CONTEXT_FALLBACK;
  const models = apiConfig?.providers.flatMap((p) => p.models) ?? [];

  const patchContext = (patch: Partial<ContextEngineConfig>) => {
    void updateAppConfig({ context: { ...context, ...patch } }).catch(() => {
      // toast 已在 useConfig 内处理
    });
  };
  const patchCompaction = (patch: Partial<ContextEngineConfig['compaction']>) => {
    patchContext({ compaction: { ...context.compaction, ...patch } });
  };

  return (
    <div className="flex flex-col gap-6 p-6">

      {/* 上下文压缩 */}
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-foreground">{t('settings.context.compactionTitle')}</div>
        <div className="text-xs text-muted-foreground">{t('settings.context.compactionDesc')}</div>
        <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
          <ContextSettingRow
            title={t('settings.context.compactionEnabled')}
            desc={t('settings.context.compactionEnabledDesc')}
          >
            <Switch
              checked={context.compaction.enabled}
              onCheckedChange={(v) => patchCompaction({ enabled: v })}
            />
          </ContextSettingRow>
          <ContextSettingRow
            title={t('settings.context.compactRatio')}
            desc={t('settings.context.compactRatioDesc')}
          >
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0.5}
                max={0.95}
                step={0.05}
                value={context.compaction.compactRatio}
                onChange={(e) => patchCompaction({ compactRatio: Number(e.target.value) })}
                className="w-32"
                disabled={!context.compaction.enabled}
              />
              <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                {Math.round(context.compaction.compactRatio * 100)}%
              </span>
            </div>
          </ContextSettingRow>
          <ContextSettingRow
            title={t('settings.context.tailKeepRatio')}
            desc={t('settings.context.tailKeepRatioDesc')}
          >
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0.05}
                max={0.5}
                step={0.01}
                value={context.compaction.tailKeepRatio}
                onChange={(e) => patchCompaction({ tailKeepRatio: Number(e.target.value) })}
                className="w-32"
                disabled={!context.compaction.enabled}
              />
              <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                {Math.round(context.compaction.tailKeepRatio * 100)}%
              </span>
            </div>
          </ContextSettingRow>
          <ContextSettingRow
            title={t('settings.context.summaryMaxTokens')}
            desc={t('settings.context.summaryMaxTokensDesc')}
          >
            <Input
              type="number"
              min={512}
              max={32768}
              value={context.compaction.summaryMaxTokens}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 512 && v <= 32768) {
                  patchCompaction({ summaryMaxTokens: Math.round(v) });
                }
              }}
              className="w-28"
              disabled={!context.compaction.enabled}
            />
          </ContextSettingRow>
          <ContextSettingRow
            title={t('settings.context.summaryModel')}
            desc={t('settings.context.summaryModelDesc')}
          >
            <Select
              value={context.compaction.summaryModel}
              onValueChange={(v) => patchCompaction({ summaryModel: v })}
              disabled={!context.compaction.enabled}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">{t('settings.context.summaryModelInherit')}</SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ContextSettingRow>
        </div>
      </div>

      {/* 工具结果修剪 */}
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-foreground">{t('settings.context.toolPruningTitle')}</div>
        <div className="text-xs text-muted-foreground">{t('settings.context.toolPruningDesc')}</div>
        <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
          <ContextSettingRow
            title={t('settings.context.toolPruningEnabled')}
            desc={t('settings.context.toolPruningEnabledDesc')}
          >
            <Switch
              checked={context.toolPruning.enabled}
              onCheckedChange={(v) => patchContext({ toolPruning: { ...context.toolPruning, enabled: v } })}
            />
          </ContextSettingRow>
        </div>
      </div>

      {/* 工具调用自愈 */}
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-foreground">{t('settings.context.healerTitle')}</div>
        <div className="text-xs text-muted-foreground">{t('settings.context.healerDesc')}</div>
        <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
          <ContextSettingRow
            title={t('settings.context.healerEnabled')}
            desc={t('settings.context.healerEnabledDesc')}
          >
            <Switch
              checked={context.healer.enabled}
              onCheckedChange={(v) => patchContext({ healer: { ...context.healer, enabled: v } })}
            />
          </ContextSettingRow>
          <ContextSettingRow
            title={t('settings.context.toolNameFuzzy')}
            desc={t('settings.context.toolNameFuzzyDesc')}
          >
            <Switch
              checked={context.healer.toolNameFuzzy}
              disabled={!context.healer.enabled}
              onCheckedChange={(v) => patchContext({ healer: { ...context.healer, toolNameFuzzy: v } })}
            />
          </ContextSettingRow>
          <ContextSettingRow
            title={t('settings.context.schemaFix')}
            desc={t('settings.context.schemaFixDesc')}
          >
            <Switch
              checked={context.healer.schemaFix}
              disabled={!context.healer.enabled}
              onCheckedChange={(v) => patchContext({ healer: { ...context.healer, schemaFix: v } })}
            />
          </ContextSettingRow>
        </div>
      </div>
    </div>
  );
}

/* ===== 文件索引设置（上下文>索引 Tab：三引擎开关 + 状态 + 重建） ===== */

const FILE_INDEX_FALLBACK: FileIndexConfig = {
  indexing: { enabled: false },
  graph: { enabled: false },
  sag: { enabled: false, llmModel: 'inherit', llmMaxChunks: 2000 },
  ignore: [],
};

/** 字节数格式化（KB/MB） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 引擎状态徽章 */
function EngineStateBadge({ state, enabled }: { state: string; enabled: boolean }) {
  const { t } = useTranslation();
  if (!enabled) return <Badge variant="secondary">{t('settings.fileIndex.stateDisabled')}</Badge>;
  if (state === 'scanning')
    return <Badge className="bg-blue-600/15 text-blue-600">{t('settings.fileIndex.stateScanning')}</Badge>;
  if (state === 'ready')
    return <Badge className="bg-emerald-600/15 text-emerald-600">{t('settings.fileIndex.stateReady')}</Badge>;
  if (state === 'error')
    return <Badge className="bg-red-500/15 text-red-600">{t('settings.fileIndex.stateError')}</Badge>;
  return <Badge variant="secondary">{t('settings.fileIndex.stateDisabled')}</Badge>;
}

/** 单引擎状态卡（统计行 + 进度条） */
function EngineStatusCard({
  title,
  state,
  enabled,
  progress,
  storeBytes,
  error,
  stats,
}: {
  title: string;
  state: string;
  enabled: boolean;
  progress: { phase: string; percent: number } | null;
  storeBytes: number;
  error: string | null;
  stats: string[];
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <EngineStateBadge state={state} enabled={enabled} />
      </div>
      {state === 'scanning' && progress ? (
        <div className="flex flex-col gap-1">
          <Progress value={progress.percent} className="h-1.5" />
          <span className="text-xs text-muted-foreground">
            {t('settings.fileIndex.building', { percent: progress.percent })}
          </span>
        </div>
      ) : null}
      {stats.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {stats.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      ) : null}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t('settings.fileIndex.storeSize', { size: formatBytes(storeBytes) })}</span>
      </div>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}

export function FileIndexSettings() {
  const { t } = useTranslation();
  const { appConfig, updateAppConfig } = useConfig();
  const fileIndex = appConfig?.context?.fileIndex ?? FILE_INDEX_FALLBACK;
  const cwd = appConfig?.agent?.workingDirectory || undefined;
  const { status, rebuild } = useFileIndex(cwd);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const patchFileIndex = (patch: Partial<FileIndexConfig>) => {
    void updateAppConfig({ context: { ...(appConfig?.context ?? CONTEXT_FALLBACK), fileIndex: { ...fileIndex, ...patch } } }).catch(() => {
      // toast 已在 useConfig 内处理
    });
  };

  // 开关联动：graph/sag 开启 → indexing 强制开启；indexing 关闭 → graph/sag 一并关闭
  const setIndexing = (v: boolean) => {
    if (v) {
      patchFileIndex({ indexing: { enabled: true } });
    } else {
      patchFileIndex({
        indexing: { enabled: false },
        graph: { enabled: false },
        sag: { ...fileIndex.sag, enabled: false },
      });
    }
  };
  const setGraph = (v: boolean) => {
    if (v) {
      patchFileIndex({ indexing: { enabled: true }, graph: { enabled: true } });
      toast.info(t('settings.fileIndex.linkedOn'));
    } else {
      patchFileIndex({ graph: { enabled: false } });
    }
  };
  const setSag = (v: boolean) => {
    if (v) {
      patchFileIndex({ indexing: { enabled: true }, sag: { ...fileIndex.sag, enabled: true } });
      toast.info(t('settings.fileIndex.linkedOn'));
    } else {
      patchFileIndex({ sag: { ...fileIndex.sag, enabled: false } });
    }
  };

  const doRebuild = async () => {
    setRebuilding(true);
    try {
      await rebuild();
      toast.success(t('settings.fileIndex.rebuildStarted'));
      setRebuildOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* 索引引擎 */}
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-foreground">{t('settings.fileIndex.indexingTitle')}</div>
        <div className="text-xs text-muted-foreground">{t('settings.fileIndex.indexingDesc')}</div>
        <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
          <ContextSettingRow
            title={t('settings.fileIndex.indexingEnabled')}
            desc={t('settings.fileIndex.indexingEnabledDesc')}
          >
            <Switch checked={fileIndex.indexing.enabled} onCheckedChange={setIndexing} />
          </ContextSettingRow>
        </div>
        {status ? (
          <div className="mt-2">
            <EngineStatusCard
              title={t('settings.fileIndex.indexingTitle')}
              state={status.indexing.state}
              enabled={status.indexing.enabled}
              progress={status.indexing.progress}
              storeBytes={status.indexing.storeBytes}
              error={status.indexing.error}
              stats={[
                t('settings.fileIndex.statFiles', { count: status.indexing.fileCount }),
                t('settings.fileIndex.statDirs', { count: status.indexing.dirCount }),
              ]}
            />
          </div>
        ) : null}
      </div>

      {/* 图谱引擎 */}
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-foreground">{t('settings.fileIndex.graphTitle')}</div>
        <div className="text-xs text-muted-foreground">{t('settings.fileIndex.graphDesc')}</div>
        <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
          <ContextSettingRow
            title={t('settings.fileIndex.graphEnabled')}
            desc={t('settings.fileIndex.graphEnabledDesc')}
          >
            <Switch checked={fileIndex.graph.enabled} onCheckedChange={setGraph} />
          </ContextSettingRow>
        </div>
        {status ? (
          <div className="mt-2">
            <EngineStatusCard
              title={t('settings.fileIndex.graphTitle')}
              state={status.graph.state}
              enabled={status.graph.enabled}
              progress={status.graph.progress}
              storeBytes={status.graph.storeBytes}
              error={status.graph.error}
              stats={[
                t('settings.fileIndex.statFiles', { count: status.graph.fileCount }),
                t('settings.fileIndex.statSymbols', { count: status.graph.symbolCount }),
                t('settings.fileIndex.statEdges', { count: status.graph.edgeCount }),
              ]}
            />
          </div>
        ) : null}
      </div>

      {/* SAG 引擎 */}
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-foreground">{t('settings.fileIndex.sagTitle')}</div>
        <div className="text-xs text-muted-foreground">{t('settings.fileIndex.sagDesc')}</div>
        <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
          <ContextSettingRow
            title={t('settings.fileIndex.sagEnabled')}
            desc={t('settings.fileIndex.sagEnabledDesc')}
          >
            <Switch checked={fileIndex.sag.enabled} onCheckedChange={setSag} />
          </ContextSettingRow>
          <ContextSettingRow
            title={t('settings.fileIndex.sagBudget')}
            desc={t('settings.fileIndex.sagBudgetDesc')}
          >
            <Input
              type="number"
              min={0}
              max={100000}
              className="w-28"
              value={fileIndex.sag.llmMaxChunks}
              disabled={!fileIndex.sag.enabled}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) {
                  patchFileIndex({ sag: { ...fileIndex.sag, llmMaxChunks: Math.max(0, Math.min(100000, Math.floor(v))) } });
                }
              }}
            />
          </ContextSettingRow>
        </div>
        {status ? (
          <div className="mt-2">
            <EngineStatusCard
              title={t('settings.fileIndex.sagTitle')}
              state={status.sag.state}
              enabled={status.sag.enabled}
              progress={status.sag.progress}
              storeBytes={status.sag.storeBytes}
              error={status.sag.error}
              stats={[
                t('settings.fileIndex.statChunks', { count: status.sag.chunkCount }),
                t('settings.fileIndex.statEvents', { count: status.sag.eventCount }),
                t('settings.fileIndex.statEntities', { count: status.sag.entityCount }),
                t('settings.fileIndex.statLlm', { done: status.sag.llmExtracted, total: status.sag.llmBudget }),
              ]}
            />
          </div>
        ) : null}
      </div>

      {/* 重建 */}
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium text-foreground">{t('settings.fileIndex.rebuildTitle')}</div>
        <div className="text-xs text-muted-foreground">{t('settings.fileIndex.rebuildDesc')}</div>
        <Button
          variant="outline"
          className="w-fit gap-1.5"
          disabled={!fileIndex.indexing.enabled}
          onClick={() => setRebuildOpen(true)}
        >
          <RefreshCw className="size-3.5" />
          {t('settings.fileIndex.rebuildButton')}
        </Button>
      </div>

      {/* 重建确认弹窗 */}
      <Dialog open={rebuildOpen} onOpenChange={(o) => !rebuilding && setRebuildOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.fileIndex.rebuildTitle')}</DialogTitle>
            <DialogDescription>{t('settings.fileIndex.rebuildConfirmDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRebuildOpen(false)} disabled={rebuilding}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void doRebuild()} disabled={rebuilding}>
              {rebuilding ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('settings.fileIndex.rebuildButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ===== 日志设置 ===== */
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];
const LOGS_FALLBACK: LogsConfig = { level: 'info', retentionDays: 14, maxFileMb: 10 };
const LOG_LINE_RE = /^(\S+)\s+(DEBUG|INFO|WARN|ERROR|FATAL)\s*\[([^\]]*)\]\s?(.*)$/;
const LEVEL_BADGE_CLASS: Record<string, string> = {
  DEBUG: 'bg-muted text-muted-foreground',
  INFO: 'bg-blue-600/15 text-blue-600',
  WARN: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  ERROR: 'bg-red-500/15 text-red-600 dark:text-red-400',
  FATAL: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
};

export function LogsSettings() {
  const { t } = useTranslation();
  const { appConfig, updateAppConfig } = useConfig();
  const logs = appConfig?.logs ?? LOGS_FALLBACK;

  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [file, setFile] = useState('');
  const [minLevel, setMinLevel] = useState<'all' | LogLevel>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const PAGE = 200;

  const patchLogs = (p: Partial<LogsConfig>) => {
    void updateAppConfig({ logs: { ...logs, ...p } }).catch(() => {
      // toast 已在 useConfig 内处理
    });
  };

  const loadFiles = useCallback(async (autoPick: boolean) => {
    try {
      const resp = await api.listLogFiles();
      setFiles(resp.files);
      if (autoPick) {
        setFile((prev) =>
          prev && resp.files.some((f) => f.name === prev) ? prev : (resp.files[0]?.name ?? ''),
        );
      }
    } catch {
      // 后端未就绪静默
    }
  }, []);

  const query = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const resp = await api.queryLogs({
          file: file || undefined,
          minLevel: minLevel === 'all' ? undefined : minLevel,
          search: search || undefined,
          limit: PAGE,
          offset,
        });
        setLines((prev) => (offset === 0 ? resp.lines : [...prev, ...resp.lines]));
        setTotal(resp.total);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [file, minLevel, search],
  );

  useEffect(() => {
    void loadFiles(true);
  }, [loadFiles]);

  // 实时搜索：输入防抖 300ms 后自动应用查询（无需回车）
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // file / minLevel / search 变化时自动重查（offset=0）
  useEffect(() => {
    void query(0);
  }, [query]);

  const handleCleanup = async () => {
    try {
      const resp = await api.cleanupLogs();
      if (resp.removed > 0) {
        toast.success(t('settings.logs.cleanupDone', { count: resp.removed }));
      } else {
        toast.info(t('settings.logs.cleanupNone'));
      }
      void loadFiles(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const fmtSize = (n: number): string =>
    n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{t('settings.logs.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.logs.subtitle')}</p>
      </div>

      {/* 日志配置 */}
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.logs.configTitle')}</div>
        <div className="flex flex-col divide-y divide-border">
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.logs.level')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.logs.levelDesc')}</span>
            </div>
            <Select value={logs.level} onValueChange={(v) => patchLogs({ level: v as LogLevel })}>
              <SelectTrigger className="h-8 w-36 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {LOG_LEVELS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.logs.retentionDays')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.logs.retentionDaysDesc')}</span>
            </div>
            <Input
              type="number"
              min={1}
              max={365}
              value={logs.retentionDays}
              onChange={(e) => {
                const v = Math.max(1, Math.min(365, Number(e.target.value) || 1));
                patchLogs({ retentionDays: v });
              }}
              className="h-8 w-24 shrink-0 text-right"
            />
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.logs.maxFileMb')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.logs.maxFileMbDesc')}</span>
            </div>
            <Input
              type="number"
              min={1}
              max={100}
              value={logs.maxFileMb}
              onChange={(e) => {
                const v = Math.max(1, Math.min(100, Number(e.target.value) || 1));
                patchLogs({ maxFileMb: v });
              }}
              className="h-8 w-24 shrink-0 text-right"
            />
          </div>
        </div>
      </div>

      {/* 日志查看 */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-foreground">{t('settings.logs.viewerTitle')}</div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={() => { void loadFiles(true); void query(0); }}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              {t('settings.logs.refresh')}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={() => void handleCleanup()}>
              <Trash2 className="h-3.5 w-3.5" />
              {t('settings.logs.cleanup')}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={file} onValueChange={setFile}>
            <SelectTrigger className="h-8 w-64 shrink-0">
              <SelectValue placeholder={t('settings.logs.file')} />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {files.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  {f.name}（{fmtSize(f.size)}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={minLevel} onValueChange={(v) => setMinLevel(v as 'all' | LogLevel)}>
            <SelectTrigger className="h-8 w-32 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value="all">{t('settings.logs.allLevels')}</SelectItem>
              {LOG_LEVELS.map((l) => (
                <SelectItem key={l} value={l}>
                  {l.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative w-full sm:w-64 sm:shrink-0">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t('settings.logs.searchPlaceholder')}
              className="pl-8"
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {t('settings.logs.totalLines', { total })} · {t('settings.logs.newestFirst')}
          </span>
        </div>

        <div className="max-h-[480px] overflow-auto rounded-md border border-border bg-muted/30 p-3">
          {lines.length === 0 && !loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{t('settings.logs.noLogs')}</div>
          ) : (
            <div className="flex flex-col gap-1 font-mono text-xs leading-relaxed">
              {lines.map((l, i) => {
                const m = LOG_LINE_RE.exec(l);
                if (!m) {
                  return (
                    <div key={i} className="whitespace-pre-wrap break-all text-foreground/80">
                      {l}
                    </div>
                  );
                }
                const [, ts, level, scope, rest] = m;
                return (
                  <div key={i} className="flex items-start gap-2 whitespace-pre-wrap break-all">
                    <span className="shrink-0 text-muted-foreground">{ts}</span>
                    <Badge variant="secondary" className={cn('shrink-0 px-1.5 font-mono text-[10px] font-semibold', LEVEL_BADGE_CLASS[level])}>
                      {level}
                    </Badge>
                    {scope && <span className="shrink-0 text-muted-foreground/70">[{scope}]</span>}
                    <span className="min-w-0 text-foreground/90">{rest}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {lines.length < total && (
          <Button variant="outline" size="sm" className="self-center" disabled={loading} onClick={() => void query(lines.length)}>
            {t('settings.logs.loadMore')}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ===== 通用设置 ===== */
export function GeneralSettings() {
  const { t } = useTranslation();
  const { mode, setMode } = useTheme();
  const { locale, setLocale } = useI18n();
  const sendShortcut = useStore((s) => s.sendShortcut);
  const setSendShortcut = useStore((s) => s.setSendShortcut);
  const followUpBehavior = useStore((s) => s.followUpBehavior);
  const setFollowUpBehavior = useStore((s) => s.setFollowUpBehavior);
  // 自定义快捷键录制态：true 时捕获全局 keydown 录制组合键
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const isPresetShortcut = sendShortcut === 'enter' || sendShortcut === 'mod+enter';
  const shortcutSelectValue =
    sendShortcut === 'enter' ? 'enter' : sendShortcut === 'mod+enter' ? 'ctrl-enter' : 'custom';

  // 录制模式：捕获任意按键组合（Esc 取消；纯修饰键忽略等待主键）
  useEffect(() => {
    if (!recordingShortcut) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecordingShortcut(false);
        return;
      }
      const shortcut = eventToShortcut(e);
      if (shortcut) {
        setSendShortcut(shortcut);
        setRecordingShortcut(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [recordingShortcut, setSendShortcut]);
  // 主题切换动画的扩散圆心：记录最后一次点击选项的坐标
  const themeOriginRef = useRef<{ x: number; y: number } | undefined>(undefined);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{t('settings.general.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.general.subtitle')}</p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.general.basicSettings')}</div>
        <div className="flex flex-col divide-y divide-border">
          {/* 主题 */}
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex flex-col gap-0.5">
              <div className="text-sm text-foreground">{t('settings.general.theme')}</div>
              <div className="text-xs text-muted-foreground">{t('settings.general.selectTheme')}</div>
            </div>
            <Select
              value={mode}
              onValueChange={(v) =>
                setMode(v as 'system' | 'light' | 'dark', themeOriginRef.current)
              }
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                onPointerDownCapture={(e) => {
                  themeOriginRef.current = { x: e.clientX, y: e.clientY };
                }}
              >
                <SelectItem value="system">
                  <Monitor className="size-3.5" />
                  {t('settings.general.system')}
                </SelectItem>
                <SelectItem value="light">
                  <Sun className="size-3.5" />
                  {t('settings.general.light')}
                </SelectItem>
                <SelectItem value="dark">
                  <Moon className="size-3.5" />
                  {t('settings.general.dark')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* 语言 */}
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex flex-col gap-0.5">
              <div className="text-sm text-foreground">{t('settings.general.language')}</div>
              <div className="text-xs text-muted-foreground">{t('settings.general.languageDesc')}</div>
            </div>
            <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  <Globe className="size-3.5" />
                  {t('settings.general.autoDetect')}
                </SelectItem>
                <SelectItem value="zh">
                  <Globe className="size-3.5" />
                  {t('settings.general.simplifiedChinese')}
                </SelectItem>
                <SelectItem value="en">
                  <Globe className="size-3.5" />
                  {t('settings.general.english')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.general.preferences')}</div>
        <div className="flex flex-col divide-y divide-border">
          {/* 发送消息快捷键（预设 + 自定义录制） */}
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex flex-col gap-0.5">
              <div className="text-sm text-foreground">{t('settings.general.sendShortcut')}</div>
              <div className="text-xs text-muted-foreground">{t('settings.general.sendShortcutDesc')}</div>
            </div>
            <div className="flex items-center gap-2">
              {/* 自定义快捷键：显示当前组合，点击进入录制；录制中显示提示 */}
              {(!isPresetShortcut || recordingShortcut) && (
                <button
                  type="button"
                  onClick={() => setRecordingShortcut(true)}
                  disabled={recordingShortcut}
                  className={cn(
                    'inline-flex h-8 min-w-28 items-center justify-center rounded-md border border-border',
                    'px-2.5 font-mono text-xs transition-colors',
                    recordingShortcut
                      ? 'border-ring bg-muted/60 text-muted-foreground'
                      : 'bg-muted/40 text-foreground hover:border-ring',
                  )}
                >
                  {recordingShortcut
                    ? t('settings.general.sendShortcutRecording')
                    : formatShortcutLabel(sendShortcut)}
                </button>
              )}
              <Select
                value={shortcutSelectValue}
                onValueChange={(v) => {
                  if (v === 'enter') {
                    setSendShortcut('enter');
                  } else if (v === 'ctrl-enter') {
                    setSendShortcut('mod+enter');
                  } else {
                    // 自定义：进入录制模式，捕获到有效组合后保存
                    setRecordingShortcut(true);
                  }
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="enter">{t('settings.general.sendWithEnter')}</SelectItem>
                  <SelectItem value="ctrl-enter">{t('settings.general.sendWithCtrlEnter')}</SelectItem>
                  <SelectItem value="custom">
                    {t('settings.general.sendWithCustom')}
                    {!isPresetShortcut && ` (${formatShortcutLabel(sendShortcut)})`}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {/* 跟进行为（任务进行时发送消息的处理方式） */}
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex flex-col gap-0.5">
              <div className="text-sm text-foreground">{t('settings.general.followUpBehavior')}</div>
              <div className="text-xs text-muted-foreground">{t('settings.general.followUpBehaviorDesc')}</div>
            </div>
            <Select
              value={followUpBehavior}
              onValueChange={(v) => setFollowUpBehavior(v as 'queue' | 'guide')}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="queue">{t('settings.general.followUpQueue')}</SelectItem>
                <SelectItem value="guide">{t('settings.general.followUpGuide')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===== 智能体设置 ===== */
export function AgentSettings() {
  const { t } = useTranslation();
  const { agents, setDefaultAgent, deleteAgent, reload } = useAgents();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AgentDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const builtInAgents = agents.filter((a) => a.builtIn);
  const customAgents = agents.filter((a) => !a.builtIn);

  const handleEdit = async (id: string) => {
    try {
      const detail = await api.getAgent(id);
      setEditing(detail);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget);
    try {
      await deleteAgent(deleteTarget);
      toast.success(t('settings.agent.deleted'));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleSetDefault = async (id: string) => {
    setBusyId(id);
    try {
      await setDefaultAgent(id);
      toast.success(t('settings.agent.defaultSet'));
    } finally {
      setBusyId(null);
    }
  };

  const renderAgentCard = (agent: (typeof agents)[number]) => {
    const isDefault = !!agent.default;
    const isBusy = busyId === agent.id;
    return (
      <Card
        key={agent.id}
        className={cn(
          'flex flex-row items-center gap-3 p-3',
          isDefault && 'border-primary-strong ring-2 ring-primary-strong/20',
        )}
      >
        <div
          className={cn(
            'flex size-9 items-center justify-center rounded-lg',
            isDefault ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          <Bot className="size-4" />
        </div>
        <div className="flex flex-1 flex-col gap-0.5 min-w-0">
          <span className="text-sm font-medium text-foreground truncate">{agent.name}</span>
          {agent.description && (
            <span className="text-xs text-muted-foreground truncate">{agent.description}</span>
          )}
        </div>
        {isDefault && (
          <>
            <Check className="size-4 text-primary-strong" />
            <Badge>{t('settings.agent.defaultBadge')}</Badge>
          </>
        )}
        {!isDefault && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isBusy}
            onClick={() => void handleSetDefault(agent.id)}
          >
            {isBusy ? <Loader2 className="size-4 animate-spin" /> : t('common.default')}
          </Button>
        )}
        {!agent.builtIn && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              title={t('common.edit')}
              disabled={isBusy}
              onClick={() => void handleEdit(agent.id)}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-red-500 hover:text-red-600"
              title={t('common.delete')}
              disabled={isBusy}
              onClick={() => setDeleteTarget(agent.id)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </>
        )}
      </Card>
    );
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{t('settings.agent.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.agent.subtitle')}</p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.agent.builtIn')}</div>
        <div className="flex flex-col gap-2">
          {builtInAgents.length === 0 ? (
            <div className="text-xs text-muted-foreground">—</div>
          ) : (
            builtInAgents.map(renderAgentCard)
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.agent.custom')}</div>
        <div className="flex flex-col gap-2">
          {customAgents.length === 0 ? (
            <div className="text-xs text-muted-foreground">—</div>
          ) : (
            customAgents.map(renderAgentCard)
          )}
        </div>
      </div>

      <Button
        variant="outline"
        className="gap-1.5 self-start"
        onClick={() => {
          setEditing(null);
          setCreateOpen(true);
        }}
      >
        <Plus />
        <span>{t('settings.agent.createAgent')}</span>
      </Button>

      {/* 创建/编辑对话框 */}
      <CreateAgentDialog
        open={createOpen || editing !== null}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setCreateOpen(false);
            setEditing(null);
          }
        }}
        editing={editing}
        onSaved={() => void reload()}
      />

      {/* 删除确认 */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.agent.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.agent.deleteBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-red-500 text-white hover:bg-red-600" onClick={() => void handleDelete()}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ===== 关于页面 ===== */
export function AboutSettings() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{t('settings.about.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.about.subtitle')}</p>
      </div>

      <div className="flex flex-col items-center gap-2 py-6">
        <div className="size-16 overflow-hidden rounded-2xl">
          <img src="/MOSS.png" alt="MOSS" className="size-full object-cover" />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.about.relatedLinks')}</div>
        <div className="flex flex-col gap-1">
          <Button
            variant="outline"
            className="justify-start gap-2"
            onClick={() => window.open('https://github.com/ZCX-Priv/MOSS-OS', '_blank')}
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span className="flex-1 text-left">GitHub</span>
            <ExternalLink className="size-3.5 text-muted-foreground" />
          </Button>
          <Button variant="outline" className="justify-start gap-2">
            <Book className="size-4" />
            <span className="flex-1 text-left">{t('settings.about.docs')}</span>
            <ExternalLink className="size-3.5 text-muted-foreground" />
          </Button>
        </div>
      </div>

      <div className="text-xs text-muted-foreground">{t('settings.about.copyright')}</div>
    </div>
  );
}

/* ===== 工具设置（内置/自定义工具启停 + 执行策略 + 参数自定义） ===== */
export function ToolsSettings() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const { tools, toggleTool, saveToolConfig } = useTools();
  const [editingTool, setEditingTool] = useState<ToolItem | null>(null);
  const { appConfig, updateAppConfig } = useConfig();
  const [maxTurnsDraft, setMaxTurnsDraft] = useState('');

  /** 编辑对话框保存：写配置成功后 toast 并关闭 */
  const handleSaveToolConfig = async (name: string, config: Record<string, unknown>) => {
    await saveToolConfig(name, config);
    toast.success(t('settings.tools.saved'));
    setEditingTool(null);
  };

  const agentCfg = appConfig?.agent;
  const maxTurns = agentCfg?.maxTurns ?? 0;
  const unlimited = maxTurns === 0;

  // config 外部变更（含 WS 热更新）时回填输入框草稿
  useEffect(() => {
    setMaxTurnsDraft(maxTurns === 0 ? '' : String(maxTurns));
  }, [maxTurns]);

  const patchMaxTurns = async (v: number) => {
    if (!agentCfg || v === maxTurns) return;
    try {
      await updateAppConfig({ agent: { ...agentCfg, maxTurns: v } });
    } catch {
      // toast 已在 useConfig 内处理
    }
  };

  /** 失焦/回车提交：clamp 到 [200, 100000]；未变化或非法则回退显示原值 */
  const commitMaxTurnsDraft = () => {
    if (unlimited) return;
    const raw = maxTurnsDraft.trim();
    if (raw === '' || raw === String(maxTurns)) {
      setMaxTurnsDraft(String(maxTurns));
      return;
    }
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0) {
      setMaxTurnsDraft(String(maxTurns));
      return;
    }
    const clamped = Math.max(200, Math.min(100000, n));
    setMaxTurnsDraft(String(clamped));
    void patchMaxTurns(clamped);
  };

  const q = query.trim().toLowerCase();
  const filteredTools = q
    ? tools.filter(
        (tool) =>
          tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q),
      )
    : tools;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* 页头：说明与搜索同一行（移动端换行堆叠） */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{t('settings.nav.tools')}</h1>
          <p className="text-sm text-muted-foreground">{t('settings.tools.subtitle')}</p>
        </div>
        <div className="relative w-full sm:w-64 sm:shrink-0">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t('settings.tools.searchPlaceholder')}
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {/* 执行策略：工具调用最大轮数（面向小时级长程任务） */}
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.tools.execPolicyTitle')}</div>
        <div className="flex flex-col divide-y divide-border">
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.tools.maxTurnsLabel')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.tools.maxTurnsDesc')}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {unlimited ? (
                <span className="text-sm tabular-nums text-muted-foreground">
                  {t('settings.tools.maxTurnsUnlimited')}
                </span>
              ) : (
                <Input
                  type="number"
                  min={200}
                  max={100000}
                  value={maxTurnsDraft}
                  onChange={(e) => setMaxTurnsDraft(e.target.value)}
                  onBlur={commitMaxTurnsDraft}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  className="h-8 w-24 text-right"
                  aria-label={t('settings.tools.maxTurnsLabel')}
                />
              )}
              <Switch
                checked={unlimited}
                onCheckedChange={(v) => void patchMaxTurns(v ? 0 : 200)}
                aria-label={t('settings.tools.maxTurnsUnlimited')}
              />
            </div>
          </div>
          {!unlimited && (
            <div className="py-3 text-xs text-muted-foreground">{t('settings.tools.maxTurnsMinHint')}</div>
          )}
        </div>
      </div>

      {/* 工具列表：小标题 + 卡片列表 */}
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.tools.listTitle')}</div>
        <div className="flex flex-col gap-2">
          {filteredTools.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {t('settings.tools.noTools')}
            </div>
          )}
          {filteredTools.map((tool) => {
            const Icon = TOOL_ICON_MAP[tool.icon ?? ''] ?? Wrench;
            return (
              <Card key={tool.name} className="flex flex-row items-center gap-3 p-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="size-5" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-foreground">{tool.name}</h3>
                    <Badge variant="outline" className="font-normal">
                      {tool.source === 'builtin' ? t('settings.tools.builtin') : t('settings.tools.custom')}
                    </Badge>
                    {tool.annotations?.destructiveHint && (
                      <Badge variant="secondary" className="font-normal text-amber-600">
                        {t('settings.tools.destructive')}
                      </Badge>
                    )}
                    {/* 编辑：自定义工具参数与行为 */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto size-6 text-muted-foreground hover:text-foreground"
                      onClick={() => setEditingTool(tool)}
                      aria-label={t('settings.tools.editTool')}
                      title={t('settings.tools.editTool')}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{tool.description}</p>
                </div>
                <Switch
                  checked={tool.enabled}
                  onCheckedChange={(checked) => void toggleTool(tool.name, checked)}
                  aria-label={tool.enabled ? t('common.close') : t('common.open')}
                />
              </Card>
            );
          })}
        </div>
      </div>

      {/* 工具编辑对话框：自定义参数与行为（保存写入 config.tools[name]，热生效） */}
      <ToolEditDialog
        tool={editingTool}
        open={editingTool !== null}
        onOpenChange={(open) => !open && setEditingTool(null)}
        onSave={handleSaveToolConfig}
      />
    </div>
  );
}

/* ===== 命令设置（自定义斜杠命令 CRUD；底层 = ~/.moss/commands/<name>.md） ===== */

/** 命令名规则：与后端 use_command/registry 一致 */
const COMMAND_NAME_RE = /^[a-z][a-z0-9-]*$/;

interface CommandFormState {
  name: string;
  description: string;
  icon: string;
  argumentHint: string;
  prompt: string;
}

const EMPTY_COMMAND_FORM: CommandFormState = {
  name: '',
  description: '',
  icon: 'sparkles',
  argumentHint: '',
  prompt: '',
};

export function CommandsSettings() {
  const { t } = useTranslation();
  const { commands, toggleCommand, createCommand, updateCommand, removeCommand } = useCommands();

  // 表单弹窗：null=关闭；{mode:'create'}=新建；{mode:'edit', name}=编辑
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; name: string } | null>(null);
  const [formState, setFormState] = useState<CommandFormState>(EMPTY_COMMAND_FORM);
  const [formLoading, setFormLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 删除确认弹窗
  const [deleting, setDeleting] = useState<string | null>(null);

  const openCreate = () => {
    setFormState(EMPTY_COMMAND_FORM);
    setForm({ mode: 'create' });
  };

  const openEdit = (name: string) => {
    const cmd = commands.find((c) => c.name === name);
    if (!cmd) return;
    setForm({ mode: 'edit', name });
    setFormState({
      name: cmd.name,
      description: cmd.description ?? '',
      icon: cmd.icon ?? 'sparkles',
      argumentHint: cmd.argumentHint ?? '',
      prompt: cmd.prompt ?? '',
    });
  };

  const nameError =
    form?.mode === 'create' && formState.name && !COMMAND_NAME_RE.test(formState.name)
      ? t('settings.commands.nameInvalid')
      : form?.mode === 'create' &&
          formState.name &&
          commands.some((c) => c.name === formState.name)
        ? t('settings.commands.nameExists')
        : null;
  const promptError = !formState.prompt.trim() ? t('settings.commands.promptRequired') : null;
  const canSubmit =
    !saving && !formLoading && !nameError && !promptError && formState.name.trim().length > 0;

  const submit = async () => {
    if (!canSubmit || !form) return;
    setSaving(true);
    const body = {
      ...(form.mode === 'create' ? { name: formState.name.trim() } : {}),
      description: formState.description.trim(),
      icon: formState.icon || 'sparkles',
      argumentHint: formState.argumentHint.trim(),
      prompt: formState.prompt,
    };
    try {
      if (form.mode === 'create') {
        await createCommand(body);
        toast.success(t('settings.commands.created'));
      } else {
        await updateCommand(form.name, body);
        toast.success(t('settings.commands.updated'));
      }
      setForm(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const name = deleting;
    setDeleting(null);
    try {
      await removeCommand(name);
      toast.success(t('settings.commands.deleted'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* 页头：说明与新建按钮 */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{t('settings.commands.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('settings.commands.subtitle')}</p>
        </div>
        <Button variant="outline" className="gap-1.5 self-start" onClick={openCreate}>
          <Plus className="size-4" />
          <span>{t('settings.commands.createCommand')}</span>
        </Button>
      </div>

      {/* 命令列表 */}
      <div className="flex flex-col gap-2">
        {commands.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('settings.commands.noCommands')}
          </div>
        )}
        {commands.map((cmd) => {
          const Icon = resolveSkillIcon(cmd.icon);
          return (
            <Card key={cmd.name} className="flex flex-row items-center gap-3 p-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Icon className="size-5" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <h3 className="font-mono text-sm font-medium text-foreground">/{cmd.name}</h3>
                  {cmd.argumentHint && (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {cmd.argumentHint}
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {cmd.description || '—'}
                </p>
              </div>
              <Switch
                checked={cmd.enabled !== false}
                onCheckedChange={(checked) => void toggleCommand(cmd.name, checked).catch(() => toast.error(t('settings.commands.updated')))}
                aria-label={cmd.enabled !== false ? t('common.close') : t('common.open')}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                onClick={() => openEdit(cmd.name)}
                title={t('settings.commands.editCommand')}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => setDeleting(cmd.name)}
                title={t('common.delete')}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </Card>
          );
        })}
      </div>

      {/* 新建/编辑表单弹窗 */}
      <Dialog open={form !== null} onOpenChange={(o) => !o && !saving && setForm(null)}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>
              {form?.mode === 'edit'
                ? t('settings.commands.editCommand')
                : t('settings.commands.createCommand')}
            </DialogTitle>
            <DialogDescription>{t('settings.commands.subtitle')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {formLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {/* 命令名 */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cmd-name">{t('settings.commands.name')}</Label>
                  <Input
                    id="cmd-name"
                    value={formState.name}
                    disabled={form?.mode === 'edit'}
                    onChange={(e) => setFormState((s) => ({ ...s, name: e.target.value }))}
                    placeholder="my-command"
                    className="font-mono"
                  />
                  {nameError ? (
                    <span className="text-xs text-destructive">{nameError}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {form?.mode === 'edit'
                        ? t('settings.commands.nameLocked')
                        : t('settings.commands.nameDesc')}
                    </span>
                  )}
                </div>
                {/* 描述 */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cmd-desc">{t('settings.commands.description')}</Label>
                  <Input
                    id="cmd-desc"
                    value={formState.description}
                    onChange={(e) => setFormState((s) => ({ ...s, description: e.target.value }))}
                  />
                </div>
                {/* 图标 + 参数提示（两列） */}
                <div className="flex flex-col gap-4 sm:flex-row">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label>{t('settings.commands.icon')}</Label>
                    <Select
                      value={formState.icon}
                      onValueChange={(v) => setFormState((s) => ({ ...s, icon: v }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        {SKILL_ICON_CHOICES.map((choice) => {
                          const ChoiceIcon = resolveSkillIcon(choice);
                          return (
                            <SelectItem key={choice} value={choice}>
                              <ChoiceIcon className="size-3.5" />
                              <span className="font-mono text-xs">{choice}</span>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="cmd-arg">{t('settings.commands.argumentHint')}</Label>
                    <Input
                      id="cmd-arg"
                      value={formState.argumentHint}
                      onChange={(e) => setFormState((s) => ({ ...s, argumentHint: e.target.value }))}
                      placeholder="[issue 编号]"
                      className="font-mono"
                    />
                    <span className="text-xs text-muted-foreground">
                      {t('settings.commands.argumentHintDesc')}
                    </span>
                  </div>
                </div>
                {/* Prompt */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cmd-prompt">{t('settings.commands.prompt')}</Label>
                  <Textarea
                    id="cmd-prompt"
                    value={formState.prompt}
                    onChange={(e) => setFormState((s) => ({ ...s, prompt: e.target.value }))}
                    className="min-h-[200px] font-mono text-xs"
                    placeholder={t('settings.commands.promptDesc')}
                  />
                  {promptError && (
                    <span className="text-xs text-destructive">{promptError}</span>
                  )}
                </div>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setForm(null)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={!canSubmit}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('common.delete')}</DialogTitle>
            <DialogDescription>
              {t('settings.commands.deleteConfirm', { name: deleting ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleting(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmDelete()}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ===== 外观设置（主题色 / 字号 / 密度 / 圆角 / 侧边栏） ===== */
export function AppearanceSettingsSection() {
  const { t } = useTranslation();
  const accentColor = useStore((s) => s.accentColor);
  const setAccentColor = useStore((s) => s.setAccentColor);
  const fontSize = useStore((s) => s.fontSize);
  const setFontSize = useStore((s) => s.setFontSize);
  const uiDensity = useStore((s) => s.uiDensity);
  const setUiDensity = useStore((s) => s.setUiDensity);
  const cornerRadius = useStore((s) => s.cornerRadius);
  const setCornerRadius = useStore((s) => s.setCornerRadius);
  const rightPanelRatio = useStore((s) => s.rightPanelRatio);
  const rightPanelCustom = useStore((s) => s.rightPanelCustom);
  const setRightPanelRatio = useStore((s) => s.setRightPanelRatio);
  // 手动拖拽过 → 一律显示「自定义」；否则按当前比例命中三档预设
  const rightPanelPreset = rightPanelCustom ? 'custom' : rightPanelPresetOf(rightPanelRatio);

  const ACCENT_PRESETS = [
    { id: 'blue', color: 'oklch(0.546 0.245 263.4)' },
    { id: 'green', color: 'oklch(0.627 0.194 149.2)' },
    { id: 'purple', color: 'oklch(0.541 0.281 293.0)' },
    { id: 'orange', color: 'oklch(0.646 0.222 41.0)' },
    { id: 'rose', color: 'oklch(0.586 0.225 16.5)' },
    { id: 'teal', color: 'oklch(0.6 0.118 184.5)' },
  ];

  const isCustom = accentColor.startsWith('#');

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* 主题色 */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="text-sm font-medium text-foreground">{t('settings.appearance.accentColor')}</div>
          <div className="text-xs text-muted-foreground">{t('settings.appearance.accentColorDesc')}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => setAccentColor(preset.id)}
              className={cn(
                'flex size-8 items-center justify-center rounded-full border-2 transition-all',
                accentColor === preset.id
                  ? 'border-foreground scale-110'
                  : 'border-transparent hover:scale-105',
              )}
              style={{ backgroundColor: preset.color }}
            >
              {accentColor === preset.id && <Check className="size-4 text-white" />}
            </button>
          ))}
          {/* 自定义颜色：label 包裹隐藏 input[type=color]，点击弹出系统调色盘 */}
          <label
            className={cn(
              'flex size-8 cursor-pointer items-center justify-center rounded-full border-2 transition-all',
              isCustom
                ? 'border-foreground scale-110'
                : 'border-border hover:scale-105',
            )}
            title={t('settings.appearance.customColor')}
            style={{ backgroundColor: isCustom ? accentColor : undefined }}
          >
            {!isCustom && <Palette className="size-4 text-muted-foreground" />}
            {isCustom && <Check className="size-4 text-white" />}
            <input
              type="color"
              value={isCustom ? accentColor : '#2563eb'}
              onChange={(e) => setAccentColor(e.target.value)}
              className="sr-only"
            />
          </label>
        </div>
      </div>

      {/* 其他外观设置项 */}
      <div className="flex flex-col divide-y divide-border">
        {/* 字号 */}
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex flex-col gap-0.5">
            <div className="text-sm text-foreground">{t('settings.appearance.fontSize')}</div>
            <div className="text-xs text-muted-foreground">{t('settings.appearance.fontSizeDesc')}</div>
          </div>
          <Select value={fontSize} onValueChange={(v) => setFontSize(v as 'small' | 'medium' | 'large')}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">{t('settings.appearance.fontSizeSmall')}</SelectItem>
              <SelectItem value="medium">{t('settings.appearance.fontSizeMedium')}</SelectItem>
              <SelectItem value="large">{t('settings.appearance.fontSizeLarge')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* 界面密度 */}
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex flex-col gap-0.5">
            <div className="text-sm text-foreground">{t('settings.appearance.uiDensity')}</div>
            <div className="text-xs text-muted-foreground">{t('settings.appearance.uiDensityDesc')}</div>
          </div>
          <Select value={uiDensity} onValueChange={(v) => setUiDensity(v as 'compact' | 'standard' | 'comfortable')}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="compact">{t('settings.appearance.densityCompact')}</SelectItem>
              <SelectItem value="standard">{t('settings.appearance.densityStandard')}</SelectItem>
              <SelectItem value="comfortable">{t('settings.appearance.densityComfortable')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* 圆角 */}
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex flex-col gap-0.5">
            <div className="text-sm text-foreground">{t('settings.appearance.cornerRadius')}</div>
            <div className="text-xs text-muted-foreground">{t('settings.appearance.cornerRadiusDesc')}</div>
          </div>
          <Select value={cornerRadius} onValueChange={(v) => setCornerRadius(v as 'small' | 'standard' | 'large')}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">{t('settings.appearance.radiusSmall')}</SelectItem>
              <SelectItem value="standard">{t('settings.appearance.radiusStandard')}</SelectItem>
              <SelectItem value="large">{t('settings.appearance.radiusLarge')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* 右侧面板（宽度占整窗比例：窄 / 标准 / 宽；拖拽微调后显示「自定义」） */}
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="text-sm text-foreground">{t('settings.appearance.rightPanel')}</div>
            <div className="text-xs text-muted-foreground">{t('settings.appearance.rightPanelDesc')}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs tabular-nums text-muted-foreground">
              {Math.round(rightPanelRatio * 1000) / 10}%
            </span>
            <Select
              value={rightPanelPreset}
              onValueChange={(v) => {
                if (v !== 'custom') setRightPanelRatio(RIGHT_PANEL_PRESETS[v as RightPanelPreset]);
              }}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="narrow">{t('settings.appearance.rightPanelNarrow')}</SelectItem>
                <SelectItem value="standard">{t('settings.appearance.rightPanelStandard')}</SelectItem>
                <SelectItem value="wide">{t('settings.appearance.rightPanelWide')}</SelectItem>
                <SelectItem value="custom" disabled>
                  {t('settings.appearance.rightPanelCustom')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===== 占位 section 路由组件（按 section 查表渲染 PlaceholderSettings） ===== */
const PLACEHOLDER_SECTION_KEYS: Record<string, { titleKey: string; descKey: string }> = {
  index: { titleKey: 'settings.placeholder.indexTitle', descKey: 'settings.placeholder.indexDesc' },
  rules: { titleKey: 'settings.placeholder.rulesTitle', descKey: 'settings.placeholder.rulesDesc' },
  memory: { titleKey: 'settings.placeholder.memoryTitle', descKey: 'settings.placeholder.memoryDesc' },
  hooks: { titleKey: 'settings.placeholder.hooksTitle', descKey: 'settings.placeholder.hooksDesc' },
};

export function PlaceholderSection({ section, embedded }: { section: string; embedded?: boolean }) {
  const { t } = useTranslation();
  const keys = PLACEHOLDER_SECTION_KEYS[section] ?? PLACEHOLDER_SECTION_KEYS.hooks;
  return <PlaceholderSettings title={t(keys.titleKey)} description={t(keys.descKey)} embedded={embedded} />;
}

/* ===== 占位页面（用于未详细设计的设置子页面） ===== */
function PlaceholderSettings({
  title,
  description,
  embedded,
}: {
  title: string;
  description: string;
  /** Tab 内嵌模式：不渲染 h1（标题由外层 Tab 示名） */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean>(true);

  return (
    <div className="flex flex-col gap-6 p-6">
      {!embedded && (
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.placeholder.baseSettings')}</div>
        <div className="flex flex-col divide-y divide-border">
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex flex-col gap-0.5">
              <div className="text-sm text-foreground">{title}{t('settings.placeholder.configSuffix')}</div>
              <div className="text-xs text-muted-foreground">{description}</div>
            </div>
            <Button variant="outline" className="gap-1.5">
              <span>{t('common.default')}</span>
              <ChevronDown className="size-3.5 opacity-70" />
            </Button>
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex flex-col gap-0.5">
              <div className="text-sm text-foreground">{t('common.enable')}</div>
              <div className="text-xs text-muted-foreground">{t('settings.placeholder.enableDesc')}</div>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={enabled ? t('common.close') : t('common.open')}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
