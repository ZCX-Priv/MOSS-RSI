// UI/src/components/pages/PluginMarketPage.tsx
// 插件库：两 tab 路由化
//   /plugins/skills（技能，默认）| /plugins/mcp（MCP 服务器）

import { useState, useCallback, useEffect, useMemo, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import {
  Search, WandSparkles, Wrench, Cable,
  Loader2, Plus, RefreshCw, Trash2, PlugZap, Unplug,
  BookOpen, ListChecks, Eye, Lightbulb, Sparkles, ShieldAlert, FlaskConical,
  Server, Copy, FileUp, Terminal,
  ArrowLeft, Check, CheckCheck, GripVertical,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import {
  Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useSkills } from '../../hooks/useSkills';
import { useMcp } from '../../hooks/useMcp';
import { parseMcpJsonInput, type ParsedMcpDef } from '../../lib/mcp-json';
import { useStore } from '../../store';
import { api } from '../../api/http';
import { copyText } from '../../lib/clipboard';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { savePluginOrder, SKILL_ORDER_KEY, MCP_ORDER_KEY } from '../../lib/plugin-order';
import type { McpServer } from '../../types/api';

/** skill.icon（Lucide kebab-case 名）→ 图标组件；未命中回退 WandSparkles */
const SKILL_ICON_MAP: Record<string, typeof WandSparkles> = {
  'book-open': BookOpen,
  'list-checks': ListChecks,
  'eye': Eye,
  'lightbulb': Lightbulb,
  'sparkles': Sparkles,
  'shield-alert': ShieldAlert,
  'flask-conical': FlaskConical,
};

export function PluginMarketPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [query, setQuery] = useState('');

  // 当前 tab：路径后缀映射（技能为默认）
  const tab = pathname === '/plugins/mcp' ? 'mcp' : 'skills';
  // Badge 计数在布局层拉取
  const { skills, reload: reloadSkills } = useSkills();
  const { servers, reload } = useMcp();
  const requestMcpDialog = useStore((s) => s.requestMcpDialog);

  // 技能弹窗：本地开关 + 移动端全局 header 信号
  const [skillsOpen, setSkillsOpen] = useState(false);
  const skillsDialogRequest = useStore((s) => s.skillsDialogRequest);
  const clearSkillsDialogRequest = useStore((s) => s.clearSkillsDialogRequest);
  const skillsRefreshSeq = useStore((s) => s.skillsRefreshSeq);

  // header"添加技能"信号 → 打开技能弹窗
  useEffect(() => {
    if (skillsDialogRequest) {
      clearSkillsDialogRequest();
      setSkillsOpen(true);
    }
  }, [skillsDialogRequest, clearSkillsDialogRequest]);

  // 移动端全局 header 刷新按钮 → 重拉技能列表
  useEffect(() => {
    if (skillsRefreshSeq > 0) void reloadSkills();
  }, [skillsRefreshSeq, reloadSkills]);

  // ---- 管理模式：复选框 + 拖拽排序 + 批量删除 ----
  const [manageMode, setManageMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  // 可选中项：技能页排除内置技能（后端同样拒绝删除）
  const selectableNames = useMemo(
    () =>
      tab === 'skills'
        ? skills.filter((s) => !s.builtin).map((s) => s.name)
        : servers.map((s) => s.name),
    [tab, skills, servers],
  );
  const visibleNames = useMemo(
    () => (tab === 'skills' ? skills.map((s) => s.name) : servers.map((s) => s.name)),
    [tab, skills, servers],
  );
  const allSelected =
    selectableNames.length > 0 && selectableNames.every((name) => selected.has(name));

  // 列表刷新（删除/热重载）后剔除已不存在的选中项
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(Array.from(prev).filter((name) => visibleNames.includes(name)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleNames]);

  // tab 变化（含浏览器前进/后退直接切换路径）时退出管理模式，避免跨类型残留选择
  useEffect(() => {
    setManageMode(false);
    setSelected(new Set());
    setQuery('');
  }, [tab]);

  const enterManage = useCallback(() => {
    setManageMode(true);
    setSelected(new Set());
    setQuery('');
  }, []);

  const exitManage = useCallback(() => {
    setManageMode(false);
    setSelected(new Set());
  }, []);

  const toggleSelect = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      if (selectableNames.length === 0) return new Set();
      const all = selectableNames.every((name) => prev.has(name));
      return all ? new Set() : new Set(selectableNames);
    });
  }, [selectableNames]);

  // tab 切换：退出管理模式并清空选择，避免把一类数据的选择带到另一类
  const handleTabChange = useCallback(
    (v: string) => {
      setManageMode(false);
      setSelected(new Set());
      setQuery('');
      navigate(`/plugins/${v}`);
    },
    [navigate],
  );

  // 批量删除：逐项直调接口 + 汇总失败 + 最后统一刷新
  const handleBatchDelete = useCallback(async () => {
    if (selected.size === 0 || batchDeleting) return;
    const names = Array.from(selected);
    setBatchDeleting(true);
    const results = await Promise.allSettled(
      names.map((name) => (tab === 'skills' ? api.deleteSkill(name) : api.deleteMcpServer(name))),
    );
    const failed = names.filter((_, i) => results[i].status === 'rejected');
    if (failed.length > 0) {
      toast.error(t('plugins.batchDeleteFailed', { count: failed.length }));
    }
    setBatchDeleting(false);
    setBatchDeleteOpen(false);
    setSelected(new Set());
    if (tab === 'skills') void reloadSkills();
    else void reload();
  }, [batchDeleting, reload, reloadSkills, selected, t, tab]);

  const openCreate = tab === 'skills' ? () => setSkillsOpen(true) : requestMcpDialog;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header：返回插件库 + 管理插件标题；右侧按钮随管理模式切换（移动端收纳进全局顶栏） */}
      <div className="hidden items-center justify-between gap-4 px-6 py-4 md:flex">
        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            size="xs"
            className="-ml-1.5 w-fit gap-1 px-1.5 text-xs text-muted-foreground"
            onClick={() => navigate('/plugins')}
          >
            <ArrowLeft className="size-3" />
            {t('plugins.backToMarket')}
          </Button>
          <h1 className="text-xl font-semibold text-foreground">{t('plugins.manageTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('plugins.subtitle')}</p>
        </div>
        {manageMode ? (
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-8 gap-1" onClick={openCreate}>
              <Plus className="size-3.5" />
              {tab === 'skills' ? t('plugins.createSkill') : t('plugins.createMcp')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 gap-1"
              disabled={selected.size === 0}
              onClick={() => setBatchDeleteOpen(true)}
            >
              <Trash2 className="size-3.5" />
              {t('plugins.deleteSelected')}
              {selected.size > 0 ? ` (${selected.size})` : ''}
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1" onClick={exitManage}>
              <Check className="size-3.5" />
              {t('plugins.done')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={() => void (tab === 'skills' ? reloadSkills() : reload())}
            >
              <RefreshCw className="size-3.5" />
              {t('common.refresh')}
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1" onClick={enterManage}>
              <ListChecks className="size-3.5" />
              {t('plugins.manage')}
            </Button>
          </div>
        )}
      </div>

      {/* Tabs（路由驱动） */}
      <Tabs
        value={tab}
        onValueChange={handleTabChange}
      >
        <div className="flex flex-col gap-3 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList>
            <TabsTrigger value="skills" className="gap-1.5">
              <WandSparkles className="size-3.5" />
              {t('plugins.skillsTab')}
              <Badge variant="secondary">{skills.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="mcp" className="gap-1.5">
              <Cable className="size-3.5" />
              {t('plugins.mcpTab')}
              <Badge variant="secondary">{servers.length}</Badge>
            </TabsTrigger>
          </TabsList>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="relative w-full sm:w-64 sm:shrink-0">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder={t('plugins.searchPlaceholder')}
                className="pl-8"
                value={query}
                disabled={manageMode}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {/* 移动端管理模式切换（桌面入口在页面标题区） */}
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 md:hidden"
              title={manageMode ? t('plugins.done') : t('plugins.manage')}
              aria-label={manageMode ? t('plugins.done') : t('plugins.manage')}
              onClick={manageMode ? exitManage : enterManage}
            >
              {manageMode ? <Check /> : <ListChecks />}
            </Button>
          </div>
        </div>
      </Tabs>

      {/* 管理工具条：全选 / 已选数（移动端另含新建与批量删除入口） */}
      {manageMode && (
        <ManageToolbar
          className="px-6"
          selectedCount={selected.size}
          selectableCount={selectableNames.length}
          allSelected={allSelected}
          batchDisabled={selected.size === 0}
          createLabel={tab === 'skills' ? t('plugins.createSkill') : t('plugins.createMcp')}
          onCreate={openCreate}
          onBatchDelete={() => setBatchDeleteOpen(true)}
          onToggleSelectAll={toggleSelectAll}
        />
      )}

      {/* 管理内容（技能 / MCP） */}
      <div className="flex-1 overflow-auto">
        {tab === 'skills' ? (
          <SkillsTab
            query={query}
            managing={manageMode}
            selected={selected}
            onToggleSelect={toggleSelect}
          />
        ) : (
          <McpTab
            query={query}
            managing={manageMode}
            selected={selected}
            onToggleSelect={toggleSelect}
          />
        )}
      </div>

      {/* 添加技能弹窗（新建 / 导入 zip；桌面 header 与移动端全局 header 按钮共用） */}
      <SkillsDialog open={skillsOpen} onOpenChange={setSkillsOpen} onDone={() => void reloadSkills()} />

      {/* 批量删除确认弹窗（技能 / MCP 共用，文案按 tab 区分） */}
      <ConfirmDialog
        open={batchDeleteOpen}
        title={t('plugins.batchDeleteTitle')}
        description={
          tab === 'skills'
            ? t('plugins.batchDeleteSkillsDesc', { count: selected.size })
            : t('plugins.batchDeleteMcpDesc', { count: selected.size })
        }
        destructive
        loading={batchDeleting}
        onConfirm={() => void handleBatchDelete()}
        onOpenChange={(o) => !batchDeleting && setBatchDeleteOpen(o)}
      />
    </div>
  );
}

/* ===== 管理模式工具条（全选 / 已选数 / 移动端操作入口） ===== */
function ManageToolbar({
  className,
  selectedCount,
  selectableCount,
  allSelected,
  batchDisabled,
  createLabel,
  onCreate,
  onBatchDelete,
  onToggleSelectAll,
}: {
  className?: string;
  selectedCount: number;
  selectableCount: number;
  allSelected: boolean;
  batchDisabled: boolean;
  createLabel: string;
  onCreate: () => void;
  onBatchDelete: () => void;
  onToggleSelectAll: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex items-center gap-1 pb-2', className)}>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        disabled={selectableCount === 0}
        onClick={onToggleSelectAll}
      >
        <CheckCheck className="size-3.5" />
        {allSelected ? t('plugins.deselectAll') : t('plugins.selectAll')}
      </Button>
      <span className="text-xs text-muted-foreground">
        {t('plugins.selectedCount', { count: selectedCount })}
      </span>
      {/* 移动端：桌面标题区按钮的替代入口 */}
      <div className="ml-auto flex items-center gap-1 md:hidden">
        <Button variant="outline" size="icon-sm" title={createLabel} aria-label={createLabel} onClick={onCreate}>
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-destructive hover:text-destructive"
          title={t('plugins.deleteSelected')}
          aria-label={t('plugins.deleteSelected')}
          disabled={batchDisabled}
          onClick={onBatchDelete}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

/* ===== 可拖拽列表项（管理模式下显示复选框与手柄） ===== */
function SortableItem({
  id,
  managing,
  selected,
  onToggleSelect,
  selectable = true,
  undeletableHint,
  children,
}: {
  id: string;
  managing: boolean;
  selected: boolean;
  onToggleSelect: (name: string) => void;
  /** false = 禁止勾选（内置技能） */
  selectable?: boolean;
  undeletableHint?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !managing,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && 'rounded-xl outline-2 outline-dashed outline-primary-strong/40')}
    >
      <div className="flex items-center gap-2">
        {managing && (
          <Checkbox
            checked={selected}
            disabled={!selectable}
            title={!selectable ? undeletableHint : undefined}
            aria-label={!selectable ? undeletableHint : undefined}
            onCheckedChange={() => {
              if (selectable) onToggleSelect(id);
            }}
            className="shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">{children}</div>
        {managing && (
          <button
            type="button"
            aria-label={t('plugins.dragHandle')}
            className="flex size-6 shrink-0 cursor-grab items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/* ===== 技能 tab（icon + files + 启停） ===== */
export function SkillsTab({
  query,
  managing,
  selected,
  onToggleSelect,
}: {
  query: string;
  managing: boolean;
  selected: Set<string>;
  onToggleSelect: (name: string) => void;
}) {
  const { t } = useTranslation();
  const { skills, toggleSkill } = useSkills();
  const setSkills = useStore((s) => s.setSkills);
  // 拖拽排序：PointerSensor 距离阈值 5px，避免与复选框/开关点击冲突
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const q = query.trim().toLowerCase();
  // 管理模式下展示全量（搜索框已禁用并清空），保证拖拽顺序与保存的序列一致
  const filteredSkills = managing
    ? skills
    : q
      ? skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
        )
      : skills;

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      const oldIndex = skills.findIndex((s) => s.name === active.id);
      const newIndex = skills.findIndex((s) => s.name === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(skills, oldIndex, newIndex);
      setSkills(next);
      savePluginOrder(SKILL_ORDER_KEY, next.map((s) => s.name));
    },
    [skills, setSkills],
  );

  return (
    <div className="p-6 pt-2">
      <div className="flex flex-col gap-2">
        {filteredSkills.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('plugins.noSkills')}
          </div>
        )}
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={filteredSkills.map((s) => s.name)}
            strategy={verticalListSortingStrategy}
          >
            {filteredSkills.map((skill) => {
              const Icon = SKILL_ICON_MAP[skill.icon ?? ''] ?? WandSparkles;
              const enabled = skill.enabled !== false;
              return (
                <SortableItem
                  key={skill.name}
                  id={skill.name}
                  managing={managing}
                  selected={selected.has(skill.name)}
                  onToggleSelect={onToggleSelect}
                  selectable={skill.builtin !== true}
                  undeletableHint={t('plugins.builtinUndeletable')}
                >
                  <Card className="flex flex-row items-center gap-3 p-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Icon className="size-5" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-medium text-foreground">{skill.name}</h3>
                        {managing && skill.builtin && (
                          <Badge variant="secondary" className="font-normal">
                            {t('plugins.builtinBadge')}
                          </Badge>
                        )}
                        {skill.files && skill.files.length > 0 && (
                          <Badge variant="outline" className="font-normal">
                            {t('plugins.skillFiles', { count: skill.files.length })}
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{skill.description}</p>
                      <p className="truncate text-[11px] text-muted-foreground/70">
                        {t('plugins.skillUsage')}: /{skill.name}
                      </p>
                    </div>
                    <Switch
                      checked={enabled}
                      onCheckedChange={(checked) =>
                        void toggleSkill(skill.name, checked).catch(() => toast.error(t('plugins.skillToggleFailed')))
                      }
                      aria-label={enabled ? t('common.close') : t('common.open')}
                    />
                  </Card>
                </SortableItem>
              );
            })}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

/* ===== 添加技能弹窗（新建 / 从 zip 导入） ===== */

/** 技能名合法字符（与后端 SKILL_NAME_RE 一致） */
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** 文本扩展名白名单：白名单内以 utf8 文本传输，其余走 base64 */
const TEXT_EXT_RE = /\.(md|markdown|txt|json|js|mjs|cjs|ts|tsx|jsx|py|sh|bat|ps1|yml|yaml|toml|csv|html|css|xml|svg)$/i;

/** Uint8Array → base64（分块避免 String.fromCharCode 栈溢出） */
function u8ToBase64(u8: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** zip 待导入状态：JSZip 实例 + SKILL.md 所在前缀（根为 '' 或单一顶层目录） */
interface ZipParsed {
  zip: JSZip;
  prefix: string;
  entryCount: number;
}

/** 解析 zip：识别根 SKILL.md 或单一顶层 <dir>/SKILL.md，提取 frontmatter name/description */
async function parseSkillZip(file: File): Promise<ZipParsed & { name: string; description: string }> {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  let prefix = '';
  if (!entries.includes('SKILL.md')) {
    const tops = new Set(entries.map((p) => p.split('/')[0]));
    if (tops.size !== 1 || !entries.includes(`${[...tops][0]}/SKILL.md`)) {
      throw new Error('SKILL.md not found in zip root or single top-level directory');
    }
    prefix = `${[...tops][0]}/`;
  }
  const md = await zip.files[`${prefix}SKILL.md`].async('text');
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? '';
  const name = fm.match(/^name\s*:\s*(.+)$/m)?.[1].trim() ?? '';
  const description = fm.match(/^description:\s*"?([^"\n]*)"?/m)?.[1].trim() ?? '';
  return { zip, prefix, entryCount: entries.filter((p) => p.startsWith(prefix)).length, name, description };
}

function SkillsDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'create' | 'import'>('create');
  const [busy, setBusy] = useState(false);

  // 新建表单
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [prompt, setPrompt] = useState('');

  // 导入状态
  const [zipFile, setZipFile] = useState('');
  const [importName, setImportName] = useState('');
  const [importDesc, setImportDesc] = useState('');
  const [parsed, setParsed] = useState<ZipParsed | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);

  // 打开时重置
  useEffect(() => {
    if (open) {
      setMode('create');
      setName(''); setDescription(''); setIcon(''); setPrompt('');
      setZipFile(''); setImportName(''); setImportDesc(''); setParsed(null); setZipError(null);
    }
  }, [open]);

  /** 后端错误 → 可读 toast */
  const showSkillError = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('SKILL_ALREADY_EXISTS')) toast.error(t('plugins.skillNameExists'));
    else if (msg.includes('SKILL_NAME_INVALID')) toast.error(t('plugins.skillNameInvalid'));
    else if (msg.includes('SKILL_DESCRIPTION_REQUIRED')) toast.error(t('plugins.skillDescRequired'));
    else toast.error(msg || t('plugins.skillCreateFailed'));
  }, [t]);

  const submitCreate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.createSkill({
        name: name.trim(),
        description: description.trim(),
        prompt: prompt || undefined,
        icon: icon.trim() || undefined,
      });
      toast.success(t('plugins.skillCreated', { name: name.trim() }));
      onOpenChange(false);
      onDone();
    } catch (err) {
      showSkillError(err);
    } finally {
      setBusy(false);
    }
  }, [busy, name, description, prompt, icon, onOpenChange, onDone, showSkillError, t]);

  const onZipChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    setZipError(null);
    setParsed(null);
    setZipFile(file.name);
    try {
      const result = await parseSkillZip(file);
      setParsed({ zip: result.zip, prefix: result.prefix, entryCount: result.entryCount });
      // 名称默认取 frontmatter name，非法时回退 zip 文件名（去扩展名）
      const fallback = file.name.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_-]/g, '-');
      setImportName(SKILL_NAME_RE.test(result.name) ? result.name : fallback);
      setImportDesc(result.description);
    } catch {
      setZipError(t('plugins.skillZipInvalid'));
    }
  }, [t]);

  const submitImport = useCallback(async () => {
    if (busy || !parsed || !SKILL_NAME_RE.test(importName.trim())) return;
    setBusy(true);
    try {
      // 逐文件转传输体：白名单扩展名 utf8 文本，其余 base64
      const entries = Object.keys(parsed.zip.files).filter(
        (p) => !parsed.zip.files[p].dir && p.startsWith(parsed.prefix),
      );
      const files: Array<{ path: string; content?: string; base64?: string }> = [];
      for (const p of entries) {
        const rel = p.slice(parsed.prefix.length);
        if (!rel) continue;
        if (TEXT_EXT_RE.test(rel)) {
          files.push({ path: rel, content: await parsed.zip.files[p].async('text') });
        } else {
          const u8 = await parsed.zip.files[p].async('uint8array');
          files.push({ path: rel, base64: u8ToBase64(u8) });
        }
      }
      await api.importSkill({ name: importName.trim(), files });
      toast.success(t('plugins.skillImported', { name: importName.trim() }));
      onOpenChange(false);
      onDone();
    } catch (err) {
      showSkillError(err);
    } finally {
      setBusy(false);
    }
  }, [busy, parsed, importName, onOpenChange, onDone, showSkillError, t]);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('plugins.skillsAdd')}</DialogTitle>
          <DialogDescription>{t('plugins.skillAddDesc')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Tabs value={mode} onValueChange={(v) => setMode(v as 'create' | 'import')}>
            <TabsList>
              <TabsTrigger value="create">{t('plugins.skillCreateTab')}</TabsTrigger>
              <TabsTrigger value="import">{t('plugins.skillImportTab')}</TabsTrigger>
            </TabsList>
          </Tabs>

          {mode === 'create' ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="skill-name">{t('plugins.skillName')}</Label>
                <Input
                  id="skill-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('plugins.skillNamePlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="skill-desc">{t('plugins.skillDesc')}</Label>
                <Input
                  id="skill-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('plugins.skillDescPlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="skill-icon">{t('plugins.skillIcon')}</Label>
                <Input
                  id="skill-icon"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="sparkles"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="skill-prompt">{t('plugins.skillPrompt')}</Label>
                <Textarea
                  id="skill-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t('plugins.skillPromptPlaceholder')}
                  className="min-h-32"
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <label
                htmlFor="skill-zip"
                className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground transition-colors hover:bg-muted/40"
              >
                <FileUp className="size-5" />
                {zipFile ? (
                  <span className="text-foreground">{zipFile}</span>
                ) : (
                  <span>{t('plugins.skillZipPick')}</span>
                )}
              </label>
              <input
                id="skill-zip"
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => void onZipChange(e)}
              />
              {zipError && <p className="text-sm text-destructive">{zipError}</p>}
              {parsed && (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t('plugins.skillZipDetected', { count: parsed.entryCount })}
                  </p>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="import-skill-name">{t('plugins.skillName')}</Label>
                    <Input
                      id="import-skill-name"
                      value={importName}
                      onChange={(e) => setImportName(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="import-skill-desc">{t('plugins.skillDesc')}</Label>
                    <Input
                      id="import-skill-desc"
                      value={importDesc}
                      onChange={(e) => setImportDesc(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          {mode === 'create' ? (
            <Button
              onClick={() => void submitCreate()}
              disabled={busy || !SKILL_NAME_RE.test(name.trim()) || !description.trim()}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {t('common.create')}
            </Button>
          ) : (
            <Button
              onClick={() => void submitImport()}
              disabled={busy || !parsed || !SKILL_NAME_RE.test(importName.trim())}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {t('plugins.skillImportTab')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== MCP tab ===== */

/** 添加/编辑服务器弹窗的表单状态 */
interface McpServerForm {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  args: string;
  url: string;
  headers: string;
}

const EMPTY_MCP_FORM: McpServerForm = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  headers: '',
};

/**
 * MOSS 自身 MCP 服务器置顶卡片：
 * 开关（PUT /api/config 热更新）+ 端点预览 + 复制配置
 * （HTTP 片段 type:'http' + url；stdio 片段 command:'moss' args:['mcp']）。
 */
function MossServerCard() {
  const { t } = useTranslation();
  const appConfig = useStore((s) => s.appConfig);
  const enabled = appConfig?.mcpServer?.enabled === true;
  const trackSummary = appConfig?.mcpServer?.trackSummary !== false;
  const exposeInternalTools = appConfig?.mcpServer?.exposeInternalTools === true;
  const port = appConfig?.server?.port ?? 7766;
  const host =
    appConfig?.security?.bindLocalhostOnly === false ? window.location.hostname : '127.0.0.1';
  const endpoint = `http://${host}:${port}/mcp`;
  const [toggling, setToggling] = useState(false);
  const [optionBusy, setOptionBusy] = useState(false);

  const toggle = useCallback(
    async (on: boolean): Promise<void> => {
      setToggling(true);
      try {
        await api.updateAppConfig({
          mcpServer: { enabled: on, allowedTools: appConfig?.mcpServer?.allowedTools ?? [] },
        });
        toast.success(on ? t('plugins.mossServerEnabled') : t('plugins.mossServerDisabled'));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('plugins.mcpToggleFailed'));
      } finally {
        setToggling(false);
      }
    },
    [appConfig, t],
  );

  const copyJson = useCallback(async (): Promise<void> => {
    const token = appConfig?.security?.authToken ?? '';
    // 标准格式：{ "mcpServers": { "moss": { type, url, headers? } } }
    // （Claude Desktop / Cursor / Claude Code / VS Code 等 Agent 的通用 mcpServers 片段）
    const snippet = {
      mcpServers: {
        moss: {
          type: 'http',
          url: endpoint,
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        },
      },
    };
    if (await copyText(JSON.stringify(snippet, null, 2))) {
      toast.success(
        token
          ? `${t('plugins.mossServerJsonCopied')}（${t('plugins.mossServerTokenHint')}）`
          : t('plugins.mossServerJsonCopied'),
      );
    } else {
      toast.error(t('common.copyManualHint'));
    }
  }, [appConfig, endpoint, t]);

  /** 改写 mcpServer 的单个开关（显式带上其余字段，避免深合并丢失既有值） */
  const patchOption = useCallback(
    async (patch: { trackSummary?: boolean; exposeInternalTools?: boolean }): Promise<void> => {
      setOptionBusy(true);
      try {
        await api.updateAppConfig({
          mcpServer: {
            enabled,
            allowedTools: appConfig?.mcpServer?.allowedTools ?? [],
            responseMode: appConfig?.mcpServer?.responseMode ?? 'sse',
            exposeInternalTools,
            trackSummary,
            ...patch,
          },
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('plugins.mcpToggleFailed'));
      } finally {
        setOptionBusy(false);
      }
    },
    [appConfig, enabled, exposeInternalTools, t, trackSummary],
  );

  /** 复制 stdio 片段：客户端以 `moss mcp` 子进程方式接入（无需端口与令牌） */
  const copyStdioJson = useCallback(async (): Promise<void> => {
    const snippet = {
      mcpServers: {
        moss: {
          command: 'moss',
          args: ['mcp'],
        },
      },
    };
    if (await copyText(JSON.stringify(snippet, null, 2))) {
      toast.success(`${t('plugins.mossServerStdioCopied')}（${t('plugins.mossServerStdioHint')}）`);
    } else {
      toast.error(t('common.copyManualHint'));
    }
  }, [t]);

  return (
    <Card className="flex flex-col gap-2 border-primary-strong/30 p-3">
      <div className="flex flex-row items-center gap-3">
        <div className="relative flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-strong/10 text-primary-strong">
          <Server className="size-5" />
          <span
            className={enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}
            title={enabled ? t('plugins.mcpStatusConnected') : t('plugins.mcpStatusDisconnected')}
            aria-label={enabled ? t('plugins.mcpStatusConnected') : t('plugins.mcpStatusDisconnected')}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">{t('plugins.mossServerTitle')}</h3>
            <Badge variant="outline" className="font-normal">http</Badge>
            <Badge variant="secondary" className="font-normal">
              {t('plugins.mossServerAgentBadge')}
            </Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground" title={endpoint}>{endpoint}</p>
          <p className="truncate text-xs text-muted-foreground">{t('plugins.mossServerDesc')}</p>
          {!appConfig?.security?.authToken ? (
            <p className="truncate text-xs text-amber-600 dark:text-amber-500">
              {t('plugins.mossServerNoTokenHint')}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost" size="icon-sm" title={t('plugins.mossServerCopyJson')}
            onClick={() => void copyJson()}
          >
            <Copy className="size-4" />
          </Button>
          <Button
            variant="ghost" size="icon-sm" title={t('plugins.mossServerCopyStdio')}
            onClick={() => void copyStdioJson()}
          >
            <Terminal className="size-4" />
          </Button>
          <Switch
            checked={enabled}
            disabled={toggling}
            onCheckedChange={(checked) => void toggle(checked)}
            aria-label={enabled ? t('common.close') : t('common.open')}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={trackSummary}
            disabled={optionBusy || !enabled}
            onCheckedChange={(checked) => void patchOption({ trackSummary: checked })}
            aria-label={t('plugins.mossServerTrackSummary')}
          />
          <span>{t('plugins.mossServerTrackSummary')}</span>
          <span className="text-muted-foreground/70">{t('plugins.mossServerTrackSummaryHint')}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={exposeInternalTools}
            disabled={optionBusy || !enabled}
            onCheckedChange={(checked) => void patchOption({ exposeInternalTools: checked })}
            aria-label={t('plugins.mossServerExposeInternal')}
          />
          <span>{t('plugins.mossServerExposeInternal')}</span>
          <span className="text-amber-600 dark:text-amber-500">{t('plugins.mossServerExposeInternalHint')}</span>
        </div>
      </div>
    </Card>
  );
}

export function McpTab({
  query,
  managing,
  selected,
  onToggleSelect,
}: {
  query: string;
  managing: boolean;
  selected: Set<string>;
  onToggleSelect: (name: string) => void;
}) {
  const { t } = useTranslation();
  const { servers, tools, reload, connect, disconnect, remove, setEnabled } = useMcp();
  const setMcpServers = useStore((s) => s.setMcpServers);
  // 拖拽排序：PointerSensor 距离阈值 5px，避免与按钮/开关点击冲突
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<McpServerForm>(EMPTY_MCP_FORM);
  const [saving, setSaving] = useState(false);
  // 添加模式：表单 / JSON 粘贴
  const [addMode, setAddMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 删除确认弹窗（替代原生 confirm）
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 页面头部/移动端全局 header 按钮信号
  const mcpDialogRequest = useStore((s) => s.mcpDialogRequest);
  const clearMcpDialogRequest = useStore((s) => s.clearMcpDialogRequest);
  const mcpRefreshSeq = useStore((s) => s.mcpRefreshSeq);

  // header"添加服务器"按钮 → 打开添加弹窗
  useEffect(() => {
    if (mcpDialogRequest) {
      clearMcpDialogRequest();
      setAddOpen(true);
    }
  }, [mcpDialogRequest, clearMcpDialogRequest]);

  // 移动端全局 header 刷新按钮
  useEffect(() => {
    if (mcpRefreshSeq > 0) void reload();
  }, [mcpRefreshSeq, reload]);

  const q = query.trim().toLowerCase();
  // 管理模式下展示全量（搜索框已禁用并清空），保证拖拽顺序与保存的序列一致
  const filteredServers = managing
    ? servers
    : q
      ? servers.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            (s.command ?? '').toLowerCase().includes(q) ||
            (s.url ?? '').toLowerCase().includes(q),
        )
      : servers;

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      const oldIndex = servers.findIndex((s) => s.name === active.id);
      const newIndex = servers.findIndex((s) => s.name === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(servers, oldIndex, newIndex);
      setMcpServers(next);
      savePluginOrder(MCP_ORDER_KEY, next.map((s) => s.name));
    },
    [servers, setMcpServers],
  );

  const submitForm = useCallback(async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try {
      const def: Parameters<typeof api.createMcpServer>[0] = {
        name: form.name.trim(),
        transport: form.transport,
        ...(form.transport === 'stdio'
          ? {
              command: form.command.trim(),
              ...(form.args.trim()
                ? { args: form.args.trim().split(/\s+/).filter(Boolean) }
                : {}),
            }
          : { url: form.url.trim() }),
      };
      await api.createMcpServer(def);
      setAddOpen(false);
      setForm(EMPTY_MCP_FORM);
      toast.success(t('plugins.mcpCreated', { name: def.name }));
      void reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('plugins.mcpCreateFailed'));
    } finally {
      setSaving(false);
    }
  }, [form, saving, t, reload]);

  const submitJson = useCallback(async () => {
    if (saving || !jsonText.trim()) return;
    setSaving(true);
    setJsonError(null);
    let defs: ParsedMcpDef[];
    try {
      defs = parseMcpJsonInput(jsonText);
    } catch {
      setJsonError(t('plugins.mcpJsonInvalid'));
      setSaving(false);
      return;
    }
    if (defs.length === 0) {
      setJsonError(t('plugins.mcpJsonInvalid'));
      setSaving(false);
      return;
    }
    let okCount = 0;
    const failures: string[] = [];
    for (const def of defs) {
      try {
        await api.createMcpServer(def);
        okCount++;
      } catch (err) {
        failures.push(`${def.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (okCount > 0) {
      toast.success(t('plugins.mcpCreatedMulti', { count: okCount }));
      setAddOpen(false);
      setJsonText('');
      void reload();
    }
    if (failures.length > 0) {
      toast.error(t('plugins.mcpCreateFailedMulti', { failures: failures.join('; ') }));
    }
    setSaving(false);
  }, [jsonText, saving, t, reload]);

  const submit = useCallback(async () => {
    if (addMode === 'json') {
      await submitJson();
    } else {
      await submitForm();
    }
  }, [addMode, submitForm, submitJson]);

  const statusColor = (s: McpServer['status']): string =>
    s === 'connected' ? 'bg-emerald-500' : s === 'error' ? 'bg-red-500' : 'bg-muted-foreground/40';

  return (
    <div className="p-6 pt-2">
      <div className="flex flex-col gap-2">
        {/* MOSS 自身 MCP 服务器（/mcp 端点）置顶卡片：开关 / 端点预览 / 复制 JSON；不参与选择与排序 */}
        <MossServerCard />
        {filteredServers.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('plugins.noMcpServers')}
          </div>
        )}
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={filteredServers.map((s) => s.name)}
            strategy={verticalListSortingStrategy}
          >
            {filteredServers.map((server) => {
              const serverTools = tools.filter((tl) => tl.server === server.name);
              const enabled = server.enabled !== false;
              return (
                <SortableItem
                  key={server.name}
                  id={server.name}
                  managing={managing}
                  selected={selected.has(server.name)}
                  onToggleSelect={onToggleSelect}
                >
                  <Card className="flex flex-col gap-2 p-3">
                    <div className="flex flex-row items-center gap-3">
                      <div className="relative flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <Cable className="size-5" />
                        <span
                          className={statusColor(server.status)}
                          title={server.status + (server.lastError ? `: ${server.lastError}` : '')}
                          aria-label={server.status}
                        />
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-medium text-foreground">{server.name}</h3>
                          <Badge variant="outline" className="font-normal">{server.transport ?? 'stdio'}</Badge>
                          <Badge variant="secondary" className="font-normal">
                            {t('plugins.mcpToolCount', { count: server.toolCount })}
                          </Badge>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {server.transport === 'http' || server.transport === 'sse'
                            ? server.url
                            : [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}
                        </p>
                        {server.status === 'error' && server.lastError && (
                          <p className="truncate text-xs text-destructive" title={server.lastError}>
                            {server.lastError}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {server.status === 'connected' ? (
                          <Button
                            variant="ghost" size="icon-sm" title={t('plugins.mcpDisconnect')}
                            disabled={busy === server.name}
                            onClick={() => { setBusy(server.name); void disconnect(server.name).finally(() => setBusy(null)); }}
                          >
                            {busy === server.name ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost" size="icon-sm" title={t('plugins.mcpConnect')}
                            disabled={busy === server.name}
                            onClick={() => { setBusy(server.name); void connect(server.name).finally(() => setBusy(null)); }}
                          >
                            {busy === server.name ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                          </Button>
                        )}
                        <Button
                          variant="ghost" size="icon-sm" title={t('common.delete')}
                          onClick={() => setDeleteTarget(server.name)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                        <Switch
                          checked={enabled}
                          onCheckedChange={(checked) =>
                            void setEnabled(server.name, checked).catch(() => toast.error(t('plugins.mcpToggleFailed')))
                          }
                          aria-label={enabled ? t('common.close') : t('common.open')}
                        />
                      </div>
                    </div>
                    {/* 工具清单（可折叠）：name + annotations 徽章 */}
                    {serverTools.length > 0 && (
                      <details className="group rounded-md border border-border px-2 py-1.5">
                        <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                          <Wrench className="size-3" />
                          {t('plugins.mcpToolsOf', { name: server.name, count: serverTools.length })}
                        </summary>
                        <div className="mt-1.5 flex flex-col gap-1">
                          {serverTools.map((tl) => (
                            <div key={tl.name} className="flex flex-wrap items-center gap-1.5 text-xs">
                              <span className="font-mono">{tl.name}</span>
                              {tl.annotations?.readOnlyHint && (
                                <Badge variant="outline" className="px-1 py-0 text-[10px] font-normal">RO</Badge>
                              )}
                              {tl.annotations?.destructiveHint && (
                                <Badge variant="secondary" className="px-1 py-0 text-[10px] font-normal text-amber-600">
                                  {t('plugins.destructive')}
                                </Badge>
                              )}
                              {tl.description && (
                                <span className="min-w-0 flex-1 truncate text-muted-foreground">{tl.description}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </Card>
                </SortableItem>
              );
            })}
          </SortableContext>
        </DndContext>
      </div>

      {/* 删除服务器确认弹窗 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('common.confirmDelete')}
        description={t('plugins.mcpDeleteConfirm', { name: deleteTarget ?? '' })}
        destructive
        loading={deleting}
        onConfirm={() => {
          if (!deleteTarget) return;
          const name = deleteTarget;
          setDeleting(true);
          void remove(name)
            .catch((err: unknown) =>
              toast.error(err instanceof Error ? err.message : t('plugins.mcpDeleteFailed')),
            )
            .finally(() => {
              setDeleting(false);
              setDeleteTarget(null);
            });
        }}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      />

      {/* 添加服务器弹窗 */}
      <Dialog open={addOpen} onOpenChange={(o) => !saving && setAddOpen(o)}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t('plugins.mcpAdd')}</DialogTitle>
            <DialogDescription>{t('plugins.mcpAddDesc')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Tabs
              value={addMode}
              onValueChange={(v) => {
                setAddMode(v as 'form' | 'json');
                setJsonError(null);
              }}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="form">{t('plugins.mcpAddModeForm')}</TabsTrigger>
                <TabsTrigger value="json">{t('plugins.mcpAddModeJson')}</TabsTrigger>
              </TabsList>
            </Tabs>
            {addMode === 'form' && (
              <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-name">{t('plugins.mcpName')}</Label>
              <Input
                id="mcp-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="github"
                disabled={saving}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('plugins.mcpTransport')}</Label>
              <Select
                value={form.transport}
                onValueChange={(v) => setForm((f) => ({ ...f, transport: v as McpServerForm['transport'] }))}
                disabled={saving}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">stdio</SelectItem>
                  <SelectItem value="http">http</SelectItem>
                  <SelectItem value="sse">sse</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.transport === 'stdio' ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-command">{t('plugins.mcpCommand')}</Label>
                  <Input
                    id="mcp-command"
                    value={form.command}
                    onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                    placeholder="npx -y @modelcontextprotocol/server-github"
                    disabled={saving}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-args">{t('plugins.mcpArgs')}</Label>
                  <Input
                    id="mcp-args"
                    value={form.args}
                    onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                    placeholder="--port 3000 --verbose"
                    disabled={saving}
                  />
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-url">URL</Label>
                <Input
                  id="mcp-url"
                  value={form.url}
                  onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                  placeholder="https://mcp.example.com/mcp"
                  disabled={saving}
                />
              </div>
            )}
              </>
            )}
            {addMode === 'json' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-json">{t('plugins.mcpJsonLabel')}</Label>
                <Textarea
                  id="mcp-json"
                  value={jsonText}
                  spellCheck={false}
                  onChange={(e) => {
                    setJsonText(e.target.value);
                    setJsonError(null);
                  }}
                  placeholder={'{\n  "github": {\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-github"]\n  }\n}'}
                  className="min-h-40 font-mono text-xs"
                  disabled={saving}
                />
                <p className="text-xs text-muted-foreground">{t('plugins.mcpJsonHint')}</p>
                {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={
                saving ||
                (addMode === 'form'
                  ? !form.name.trim() || (form.transport === 'stdio' ? !form.command.trim() : !form.url.trim())
                  : !jsonText.trim())
              }
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
