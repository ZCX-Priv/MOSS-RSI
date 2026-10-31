// UI/src/components/pages/ProviderSettings.tsx
// 服务商设置页：服务商卡片（品牌图标 + API 格式/地址/Key/自定义查询地址）+ 旗下模型与服务管理。
// - 添加服务商（图标选择 + 可选自定义余额查询地址、模型列表获取地址）
// - 新建后自动拉取远程模型列表 → 勾选弹窗（实时搜索）批量添加
// - 手动添加模型（名称 + 模型 id + 模型级高级配置）
// - 附加服务（文件存储：api地址/key/最大限额）
// - 余额查询（CircleDollarSign 按钮 → 弹窗，OpenAI 兼容计费格式解析）
// - 思考强度标签化（服务商级等级库，可增删，至少保留 1 个，删除自动回退）

import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Box,
  Plus,
  Search,
  Trash2,
  GripVertical,
  Loader2,
  ChevronRight,
  ChevronLeft,
  Brain,
  ServerCrash,
  CircleDollarSign,
  RefreshCw,
  Pencil,
  Server,
  X,
  Check,
  Mic,
  Download,
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { useProviders, type UseProvidersResult } from '../../hooks/useProviders';
import { useVoiceStatus, useVoiceModels } from '../../hooks/useVoiceInput';
import { isLocalAsrSupported } from '@/lib/asr-local';
import { api } from '../../api/http';
import { useStore } from '../../store';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { parseLegacyWindow, DEFAULT_LEVELS, generateLevelId } from '../../lib/model-utils';
import { getProviderIcon, PROVIDER_ICON_LIST } from '../../lib/provider-icons';
import type {
  ProviderItem,
  ProviderModelItem,
  ProviderServiceItem,
  RemoteModelItem,
  ThinkingLevelItem,
} from '../../types/api';

const FORMAT_OPTIONS = [
  { value: 'openai-chat', label: 'OpenAI Chat' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
] as const;

/* ===== 卡片头图标按钮（统一小图标 + title 提示） ===== */
function IconActionButton({
  title,
  onClick,
  danger,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50',
        danger && 'hover:text-destructive',
      )}
    >
      {children}
    </button>
  );
}

/** 服务商品牌图标（未配置/未命中 fallback lucide Server） */
function ProviderLogo({ icon, className, size = 20 }: { icon?: string; className?: string; size?: number }) {
  const Logo = getProviderIcon(icon);
  if (!Logo) {
    return <Server className={cn('size-4 text-muted-foreground', className)} />;
  }
  return <Logo size={size} className={className} />;
}

/** 服务商类别（胶囊导航：模型 / 语音） */
type ProviderCategory = 'model' | 'voice';

/* ===== 服务商设置页 ===== */
export function ProviderSettings() {
  const { t } = useTranslation();
  const {
    providers,
    currentModel,
    setCurrent,
    reorderProviders,
    deleteProvider,
    fetchProviderModels,
  } = useProviders();
  // 类别胶囊导航：模型 / 语音（路由驱动，刷新/直达/前进后退均保持）
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const category: ProviderCategory = pathname.startsWith('/settings/provider/voice')
    ? 'voice'
    : 'model';
  const { status: voiceStatus, refresh: refreshVoiceStatus } = useVoiceStatus();
  const { models: voiceModels, refresh: refreshVoiceModels } = useVoiceModels();
  // 推理位置标签：在线服务商 / 服务端本地引擎 / 浏览器端 WASM / 不可用
  const voiceLocalModel = voiceModels.find((m) => m.state === 'installed' && m.engine === 'zipformer');
  const voiceInferLabel =
    voiceStatus?.providerId ||
    (voiceStatus?.runtimeAvailable && (voiceStatus.installed?.length ?? 0) > 0)
      ? t('settings.provider.voiceInferServer')
      : isLocalAsrSupported() && voiceLocalModel
        ? t('settings.provider.voiceInferLocal')
        : t('settings.provider.voiceInferUnavailable');
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderItem | null>(null);
  const [pickProvider, setPickProvider] = useState<ProviderItem | null>(null);
  const [balanceProvider, setBalanceProvider] = useState<ProviderItem | null>(null);
  const [modelDialogProvider, setModelDialogProvider] = useState<ProviderItem | null>(null);
  const [editingModel, setEditingModel] = useState<ProviderModelItem | null>(null);
  const [serviceDialogProvider, setServiceDialogProvider] = useState<ProviderItem | null>(null);
  const [editingService, setEditingService] = useState<ProviderServiceItem | null>(null);
  const [query, setQuery] = useState('');
  const [formatFilter, setFormatFilter] = useState<'all' | ProviderItem['format']>('all');
  // 删除服务商确认弹窗（替代原生 confirm）
  const [deleteConfirmProvider, setDeleteConfirmProvider] = useState<ProviderItem | null>(null);
  const [deletingProvider, setDeletingProvider] = useState(false);
  // 远程模型勾选 → 分页「添加模型」弹窗
  const [batchPick, setBatchPick] = useState<{
    provider: ProviderItem;
    models: Array<{ name: string; model: string }>;
  } | null>(null);
  const providerDialogRequest = useStore((s) => s.providerDialogRequest);
  const clearProviderDialogRequest = useStore((s) => s.clearProviderDialogRequest);
  // 移动端 header 搜索按钮信号：seq 计数 → 切换搜索框显隐
  const providerSearchSeq = useStore((s) => s.providerSearchSeq);
  const [searchOpen, setSearchOpen] = useState(false);

  // 从模型选择器"添加服务商"跳转过来时自动打开添加弹窗
  useEffect(() => {
    if (providerDialogRequest) {
      clearProviderDialogRequest();
      setEditingProvider(null);
      setProviderDialogOpen(true);
    }
  }, [providerDialogRequest, clearProviderDialogRequest]);

  // header 搜索按钮：切换移动端搜索框显隐
  useEffect(() => {
    if (providerSearchSeq > 0) {
      setSearchOpen((v) => !v);
    }
  }, [providerSearchSeq]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const openAdd = () => {
    setEditingProvider(null);
    setProviderDialogOpen(true);
  };

  const openEdit = (provider: ProviderItem) => {
    setEditingProvider(provider);
    setProviderDialogOpen(true);
  };

  const openAddModel = (provider: ProviderItem) => {
    setModelDialogProvider(provider);
    setEditingModel(null);
  };

  const openEditModel = (provider: ProviderItem, model: ProviderModelItem) => {
    setModelDialogProvider(provider);
    setEditingModel(model);
  };

  const openAddService = (provider: ProviderItem) => {
    setServiceDialogProvider(provider);
    setEditingService(null);
  };

  const openEditService = (provider: ProviderItem, service: ProviderServiceItem) => {
    setServiceDialogProvider(provider);
    setEditingService(service);
  };

  const openPick = (provider: ProviderItem) => {
    setPickProvider(provider);
  };

  // ===== 语音类别操作（开关 / 默认服务商 / 本地模型安装） =====
  const toggleVoiceEnabled = async (enabled: boolean) => {
    try {
      await api.setVoiceEnabled(enabled);
      await refreshVoiceStatus();
    } catch {
      toast.error(t('settings.provider.voiceToggleFailed'));
    }
  };

  const selectVoiceProvider = async (providerId: string) => {
    try {
      await api.setVoiceProvider(providerId);
      await refreshVoiceStatus();
    } catch {
      toast.error(t('settings.provider.voiceProviderFailed'));
    }
  };

  const setDefaultVoiceModel = async (id: string) => {
    try {
      await api.setVoiceDefaultModel(id);
      await refreshVoiceStatus();
    } catch {
      toast.error(t('settings.provider.voiceModelFailed'));
    }
  };

  const installVoiceModel = async (id: string) => {
    try {
      await api.installVoiceModel(id);
      toast.info(t('settings.provider.voiceDownloading'));
      await refreshVoiceModels();
    } catch {
      toast.error(t('settings.provider.voiceInstallFailed'));
    }
  };

  const uninstallVoiceModel = async (id: string) => {
    try {
      await api.uninstallVoiceModel(id);
      await refreshVoiceModels();
      await refreshVoiceStatus();
    } catch {
      toast.error(t('settings.provider.voiceUninstallFailed'));
    }
  };

  const handleDelete = () => {
    if (!deleteConfirmProvider) return;
    const provider = deleteConfirmProvider;
    setDeletingProvider(true);
    void (async () => {
      try {
        await deleteProvider(provider.id);
        toast.success(t('settings.provider.deleteSuccess'));
        setDeleteConfirmProvider(null);
      } catch {
        // 错误已由 hook toast
      } finally {
        setDeletingProvider(false);
      }
    })();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = providers.findIndex((p) => p.id === active.id);
    const newIndex = providers.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const newOrder = arrayMove(providers, oldIndex, newIndex).map((p) => p.id);
    void reorderProviders(newOrder);
  };

  // 类别归属：voice 为独立类别；其余归模型
  const kindOf = (p: ProviderItem): 'model' | 'voice' =>
    p.kind === 'voice' ? 'voice' : 'model';

  // 搜索（服务商名/地址/旗下模型名或 id）+ API 格式筛选（实时本地过滤）
  const q = query.trim().toLowerCase();
  const visibleProviders = providers.filter((p) => {
    if (kindOf(p) !== category) return false;
    const matchQ =
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.endpoint.toLowerCase().includes(q) ||
      p.models.some(
        (m) => m.name.toLowerCase().includes(q) || m.model.toLowerCase().includes(q),
      );
    const matchF = formatFilter === 'all' || p.format === formatFilter;
    return matchQ && matchF;
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* 页头：移动端筛选独占一行（搜索/添加收纳进全局 header 按钮）；桌面端单行紧凑 */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">
            {t('settings.provider.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('settings.provider.subtitle')}</p>
        </div>

        {/* 类别胶囊导航：模型 / 语音（带图标，同「上下文」「外观」区 TabsList 样式） */}
        <Tabs
          value={category}
          onValueChange={(v) => {
            const next = v as ProviderCategory;
            navigate(next === 'model' ? '/settings/provider' : `/settings/provider/${next}`);
          }}
        >
          <TabsList>
            <TabsTrigger value="model" className="gap-1.5">
              <Box className="size-3.5" />
              {t('settings.provider.categoryModel')}
            </TabsTrigger>
            <TabsTrigger value="voice" className="gap-1.5">
              <Mic className="size-3.5" />
              {t('settings.provider.categoryVoice')}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* 移动端搜索展开行：header 搜索按钮触发，出现在筛选上方 */}
        {searchOpen && (
          <div className="flex items-center gap-2 sm:hidden">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder={t('settings.provider.searchPlaceholder')}
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              shrink-0
              aria-label={t('common.close')}
              onClick={() => {
                setQuery('');
                setSearchOpen(false);
              }}
            >
              <X className="size-4" />
            </Button>
          </div>
        )}

        {/* 筛选 + 搜索 + 添加同一组靠右（移动端筛选独占一行，搜索/添加收纳进全局 header 按钮） */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          {category !== 'voice' && (
          <Select
            value={formatFilter}
            onValueChange={(v) => setFormatFilter(v as 'all' | ProviderItem['format'])}
          >
            <SelectTrigger className="w-full shrink-0 sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('settings.provider.allFormats')}</SelectItem>
              {FORMAT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}
          {/* 桌面端搜索框 + 添加按钮（移动端由 header 按钮替代） */}
          <div className="hidden items-center gap-2 sm:flex">
            <div className="relative w-full sm:w-64 sm:shrink-0">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder={t('settings.provider.searchPlaceholder')}
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Button className="shrink-0 gap-1.5" onClick={openAdd}>
              <Plus className="size-3.5" />
              {t('settings.provider.addProvider')}
            </Button>
          </div>
        </div>
      </div>

      {/* 语音类别：能力开关 + 默认服务商 + 本地模型管理 */}
      {category === 'voice' && (
        <div className="flex flex-col gap-4">
          {/* 总开关（默认关闭；关闭时输入框麦克风按钮隐藏） */}
          <div className="flex items-start justify-between gap-4 rounded-xl border border-border p-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {t('settings.provider.voiceEnable')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('settings.provider.voiceEnableDesc')}
              </span>
              {voiceStatus && !voiceStatus.runtimeAvailable && (
                <div className="mt-1 flex flex-col gap-0.5">
                  <span className="text-xs text-destructive">
                    {voiceStatus.platformSupported
                      ? t('settings.provider.voiceRuntimeUnavailable')
                      : t('settings.provider.voiceRuntimePlatformUnsupported', { platform: voiceStatus.platform })}
                  </span>
                  {voiceStatus.platformSupported && voiceStatus.runtimeError && (
                    <span className="break-all text-[11px] text-muted-foreground">
                      {t('settings.provider.voiceRuntimeReasonLabel')}: {voiceStatus.runtimeError}
                    </span>
                  )}
                  {!voiceStatus.platformSupported && (
                    <span className="text-[11px] text-muted-foreground">
                      {t('settings.provider.voiceRuntimePlatformHint')}
                    </span>
                  )}
                </div>
              )}
            </div>
            <Switch
              checked={Boolean(voiceStatus?.enabled)}
              onCheckedChange={(v) => void toggleVoiceEnabled(v)}
            />
          </div>

          {/* 推理位置（服务端本地引擎 / 浏览器端 WASM） */}
          <div className="flex items-center justify-between rounded-xl border border-border p-4">
            <span className="text-sm font-medium text-foreground">
              {t('settings.provider.voiceInferLocation')}
            </span>
            <span className="text-xs text-muted-foreground">{voiceInferLabel}</span>
          </div>

          {/* 默认语音服务商（本地引擎 / 在线服务商） */}
          <div className="flex flex-col gap-2 rounded-xl border border-border p-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {t('settings.provider.voiceProvider')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('settings.provider.voiceProviderDesc')}
              </span>
            </div>
            <Select
              value={voiceStatus?.providerId || '__local__'}
              onValueChange={(v) => void selectVoiceProvider(v === '__local__' ? '' : v)}
            >
              <SelectTrigger className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__local__">
                  {t('settings.provider.voiceLocalEngine')}
                </SelectItem>
                {providers
                  .filter((p) => p.kind === 'voice')
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {/* 本地模型：三类引擎（Zipformer / SenseVoice / Whisper）模型管理 */}
          <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {t('settings.provider.voiceLocalModels')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('settings.provider.voiceLocalModelsDesc')}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {voiceModels.map((m) => {
                const isDefault = voiceStatus?.defaultModel === m.id;
                return (
                  <div
                    key={m.id}
                    className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{m.name}</span>
                          {m.recommended && (
                            <Badge variant="secondary" className="shrink-0 text-[10px]">
                              {t('settings.provider.voiceRecommended')}
                            </Badge>
                          )}
                          {isDefault && m.state === 'installed' && (
                            <Badge variant="secondary" className="shrink-0 text-[10px]">
                              {t('settings.provider.voiceDefault')}
                            </Badge>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">{m.description}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {(m.sizeBytes / 1024 / 1024).toFixed(0)} MB · {m.languages.join(' / ')}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {m.state === 'installed' ? (
                          <>
                            {!isDefault && (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                title={t('settings.provider.voiceSetDefault')}
                                onClick={() => void setDefaultVoiceModel(m.id)}
                              >
                                <Check className="size-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title={t('settings.provider.voiceUninstall')}
                              onClick={() => void uninstallVoiceModel(m.id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </>
                        ) : m.state === 'downloading' ? (
                          <span className="text-xs text-muted-foreground">
                            {Math.round((m.progress ?? 0) * 100)}%
                          </span>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => void installVoiceModel(m.id)}
                          >
                            <Download className="size-3.5" />
                            {t('settings.provider.voiceDownload')}
                          </Button>
                        )}
                      </div>
                    </div>
                    {m.state === 'downloading' && (
                      <Progress value={(m.progress ?? 0) * 100} className="h-1" />
                    )}
                    {m.state === 'error' && m.error && (
                      <span className="text-xs text-destructive">{m.error}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 在线语音服务商列表标题 */}
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">
              {t('settings.provider.voiceOnlineProviders')}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('settings.provider.voiceOnlineProvidersDesc')}
            </span>
          </div>
        </div>
      )}

      {/* 服务商卡片列表（按类别过滤） */}
      {visibleProviders.length === 0 ? (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-border p-8 text-sm text-muted-foreground">
          {providers.filter((p) => kindOf(p) === category).length === 0
            ? t('settings.provider.empty')
            : t('settings.provider.noMatch')}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={visibleProviders.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-3">
              {visibleProviders.map((provider) => (
                <SortableProviderCard
                  key={provider.id}
                  provider={provider}
                  currentModel={currentModel}
                  onSelectModel={(modelId) => void setCurrent(modelId)}
                  onBalance={() => setBalanceProvider(provider)}
                  onEdit={() => openEdit(provider)}
                  onDelete={() => setDeleteConfirmProvider(provider)}
                  onAddModel={() => openAddModel(provider)}
                  onAddService={() => openAddService(provider)}
                  onEditModel={(model) => openEditModel(provider, model)}
                  onEditService={(service) => openEditService(provider, service)}
                  onFetchModels={() => openPick(provider)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* 服务商新建/编辑弹窗 */}
      <AddProviderDialog
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
        editingProvider={editingProvider}
      />

      {/* 远程模型勾选弹窗（实时搜索；勾选提交 → 分页添加弹窗） */}
      {pickProvider && (
        <ModelPickDialog
          open={!!pickProvider}
          onOpenChange={(o) => {
            if (!o) setPickProvider(null);
          }}
          provider={pickProvider}
          fetchProviderModels={fetchProviderModels}
          onPick={(models) => setBatchPick({ provider: pickProvider, models })}
        />
      )}

      {/* 余额查询弹窗 */}
      {balanceProvider && (
        <BalanceDialog
          open={!!balanceProvider}
          onOpenChange={(o) => {
            if (!o) setBalanceProvider(null);
          }}
          provider={balanceProvider}
        />
      )}

      {/* 手动添加/编辑模型弹窗 */}
      {modelDialogProvider && (
        <ProviderModelDialog
          open={!!modelDialogProvider}
          onOpenChange={(o) => {
            if (!o) {
              setModelDialogProvider(null);
              setEditingModel(null);
            }
          }}
          provider={modelDialogProvider}
          editingModel={editingModel}
        />
      )}

      {/* 远程勾选批量添加：分页「添加模型」弹窗（每页一个模型） */}
      {batchPick && (
        <ProviderModelDialog
          open
          onOpenChange={(o) => {
            if (!o) setBatchPick(null);
          }}
          provider={batchPick.provider}
          editingModel={null}
          batchModels={batchPick.models}
        />
      )}

      {/* 添加/编辑服务弹窗（文件存储） */}
      {serviceDialogProvider && (
        <AddServiceDialog
          open={!!serviceDialogProvider}
          onOpenChange={(o) => {
            if (!o) {
              setServiceDialogProvider(null);
              setEditingService(null);
            }
          }}
          provider={serviceDialogProvider}
          editingService={editingService}
        />
      )}

      {/* 删除服务商确认弹窗 */}
      <ConfirmDialog
        open={!!deleteConfirmProvider}
        title={t('common.confirmDelete')}
        description={t('settings.provider.deleteConfirm', {
          count: deleteConfirmProvider?.models.length ?? 0,
        })}
        destructive
        loading={deletingProvider}
        onConfirm={handleDelete}
        onOpenChange={(o) => !o && setDeleteConfirmProvider(null)}
      />
    </div>
  );
}

/* ===== 可拖拽服务商卡片 ===== */
interface SortableProviderCardProps {
  provider: ProviderItem;
  currentModel: string;
  onSelectModel: (modelId: string) => void;
  onBalance: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddModel: () => void;
  onAddService: () => void;
  onEditModel: (model: ProviderModelItem) => void;
  onEditService: (service: ProviderServiceItem) => void;
  onFetchModels: () => void;
}

function SortableProviderCard({
  provider,
  currentModel,
  onSelectModel,
  onBalance,
  onEdit,
  onDelete,
  onAddModel,
  onAddService,
  onEditModel,
  onEditService,
  onFetchModels,
}: SortableProviderCardProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: provider.id,
  });
  const [testingId, setTestingId] = useState<string | null>(null);
  const { testProviderModel, deleteProviderModel, deleteProviderService } = useProviders();
  // 删除模型/服务确认弹窗（替代原生 confirm）
  const [deleteModelTarget, setDeleteModelTarget] = useState<ProviderModelItem | null>(null);
  const [deletingModel, setDeletingModel] = useState(false);
  const [deleteServiceTarget, setDeleteServiceTarget] = useState<ProviderServiceItem | null>(null);
  const [deletingService, setDeletingService] = useState(false);

  const handleTest = async (model: ProviderModelItem) => {
    setTestingId(model.id);
    try {
      const result = await testProviderModel(provider.id, model.id);
      if (result.success) {
        toast.success(t('settings.provider.testSuccess', { latencyMs: result.latencyMs }));
      } else {
        toast.error(t('settings.provider.testFail', { error: result.error }));
      }
    } finally {
      setTestingId(null);
    }
  };

  const handleDeleteModel = () => {
    if (!deleteModelTarget) return;
    const model = deleteModelTarget;
    setDeletingModel(true);
    void (async () => {
      try {
        await deleteProviderModel(provider.id, model.id);
        toast.success(t('settings.provider.deleteModelSuccess'));
        setDeleteModelTarget(null);
      } catch {
        // 错误已由 hook toast
      } finally {
        setDeletingModel(false);
      }
    })();
  };

  const handleDeleteService = () => {
    if (!deleteServiceTarget) return;
    const service = deleteServiceTarget;
    setDeletingService(true);
    void (async () => {
      try {
        await deleteProviderService(provider.id, service.id);
        toast.success(t('settings.provider.serviceDeleteSuccess'));
        setDeleteServiceTarget(null);
      } catch {
        // 错误已由 hook toast
      } finally {
        setDeletingService(false);
      }
    })();
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'rounded-xl border border-border transition-colors',
        isDragging && 'opacity-50 shadow-lg',
      )}
    >
      {/* 卡片头（单行紧凑：图标 + 名称 + endpoint + 操作按钮组） */}
      <div className="flex items-center gap-2.5 border-b border-border/60 p-3">
        <button
          type="button"
          className="cursor-grab shrink-0 text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        {/* 品牌图标 */}
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <ProviderLogo icon={provider.icon} />
        </div>
        {/* 名称 + endpoint 同行 */}
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-sm font-semibold text-foreground">{provider.name}</span>
          <span className="truncate text-xs text-muted-foreground">{provider.endpoint}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('settings.provider.modelCount', { count: provider.models.length })}
        </span>
        {/* 操作按钮组（全部图标化） */}
        <div className="flex shrink-0 items-center gap-0.5">
              {/* + 菜单：添加模型 / 添加服务 */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('settings.provider.addMenu')}
                    title={t('settings.provider.addMenu')}
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-auto min-w-40">
                  <DropdownMenuItem className="gap-1.5" onSelect={onAddModel}>
                    <Brain className="size-3.5" />
                    {t('settings.provider.addModel')}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-1.5" onSelect={onAddService}>
                    <ServerCrash className="size-3.5" />
                    {t('settings.provider.addService')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <IconActionButton title={t('settings.provider.fetchModels')} onClick={onFetchModels}>
                <RefreshCw className="size-4" />
              </IconActionButton>
              <IconActionButton title={t('settings.provider.balanceTitle')} onClick={onBalance}>
                <CircleDollarSign className="size-4" />
              </IconActionButton>
          <IconActionButton title={t('settings.provider.edit')} onClick={onEdit}>
            <Pencil className="size-4" />
          </IconActionButton>
          <IconActionButton title={t('settings.provider.delete')} onClick={onDelete} danger>
            <Trash2 className="size-4" />
          </IconActionButton>
        </div>
      </div>

      {/* 模型行列表 */}
      <div className="flex flex-col">
        {provider.models.length === 0 ? (
          <div className="px-4 py-3 text-xs text-muted-foreground">
            {t('settings.provider.noModels')}
          </div>
        ) : (
          provider.models.map((model) => {
            const isSelected = currentModel === model.id;
            const isTesting = testingId === model.id;
            return (
              <div
                key={model.id}
                className={cn(
                  'flex items-center gap-3 px-4 py-2.5 transition-colors',
                  isSelected ? 'bg-primary-strong/5' : 'hover:bg-muted/50',
                )}
              >
                {/* 主体可点击区域 */}
                <div
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                  onClick={() => onSelectModel(model.id)}
                >
                  {/* 状态点 */}
                  <span
                    className={cn(
                      'size-2.5 shrink-0 rounded-full',
                      isSelected ? 'bg-emerald-500' : 'bg-muted-foreground/30',
                    )}
                  />
                  {/* 名称 + 徽章 */}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{model.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{model.model}</span>
                      {isSelected && (
                        <Badge variant="secondary" className="font-normal">
                          {t('common.current')}
                        </Badge>
                      )}
                    </div>
                    {model.inputTokens && (
                      <span className="text-xs text-muted-foreground">
                        {t('settings.provider.inputWindow')}: {model.inputTokens.toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
                {/* 操作链接 */}
                <div className="flex shrink-0 items-center gap-4">
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleTest(model);
                    }}
                    disabled={isTesting}
                  >
                    {isTesting && <Loader2 className="size-3 animate-spin" />}
                    {isTesting ? t('settings.provider.testing') : t('settings.provider.test')}
                  </button>
                  <IconActionButton
                    title={t('settings.provider.edit')}
                    onClick={() => onEditModel(model)}
                  >
                    <Pencil className="size-3.5" />
                  </IconActionButton>
                  <IconActionButton
                    title={t('settings.provider.delete')}
                    danger
                    disabled={isTesting}
                    onClick={() => setDeleteModelTarget(model)}
                  >
                    <Trash2 className="size-3.5" />
                  </IconActionButton>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 服务区块（文件存储等附加服务） */}
      {(provider.services?.length ?? 0) > 0 && (
        <div className="border-t border-border/60">
          <div className="px-4 pb-0.5 pt-2.5 text-xs font-medium text-muted-foreground">
            {t('settings.provider.services')} · {provider.services!.length}
          </div>
          {provider.services!.map((service) => (
            <div
              key={service.id}
              className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
            >
              <Badge variant="outline" className="shrink-0 font-normal">
                {t('settings.provider.fileStorage')}
              </Badge>
              <span className="shrink-0 text-sm text-foreground">{service.name}</span>
              <span className="flex-1 truncate text-xs text-muted-foreground">
                {service.endpoint}
              </span>
              {service.maxQuota !== undefined && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {service.maxQuota} {service.quotaUnit ?? 'GB'}
                </span>
              )}
              <IconActionButton title={t('settings.provider.edit')} onClick={() => onEditService(service)}>
                <Pencil className="size-3.5" />
              </IconActionButton>
              <IconActionButton
                title={t('settings.provider.delete')}
                danger
                onClick={() => setDeleteServiceTarget(service)}
              >
                <Trash2 className="size-3.5" />
              </IconActionButton>
            </div>
          ))}
        </div>
      )}

      {/* 删除模型/服务确认弹窗 */}
      <ConfirmDialog
        open={!!deleteModelTarget}
        title={t('common.confirmDelete')}
        description={t('settings.provider.deleteModelConfirm')}
        destructive
        loading={deletingModel}
        onConfirm={handleDeleteModel}
        onOpenChange={(o) => !o && setDeleteModelTarget(null)}
      />
      <ConfirmDialog
        open={!!deleteServiceTarget}
        title={t('common.confirmDelete')}
        description={t('settings.provider.deleteServiceConfirm')}
        destructive
        loading={deletingService}
        onConfirm={handleDeleteService}
        onOpenChange={(o) => !o && setDeleteServiceTarget(null)}
      />
    </div>
  );
}

/* ===== 服务商弹窗（新建/编辑共用；图标选择 + 类型切换：模型/语音） ===== */
interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingProvider: ProviderItem | null;
}

function AddProviderDialog({
  open,
  onOpenChange,
  editingProvider,
}: AddProviderDialogProps) {
  const { t } = useTranslation();
  const isEdit = !!editingProvider;
  const { createProvider, updateProvider } = useProviders();

  const [kind, setKind] = useState<'model' | 'voice'>('model');
  const [name, setName] = useState('');
  const [format, setFormat] = useState<ProviderItem['format']>('openai-chat');
  const [voiceModel, setVoiceModel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [balanceUrl, setBalanceUrl] = useState('');
  const [modelsUrl, setModelsUrl] = useState('');
  const [icon, setIcon] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 弹窗打开时同步表单数据
  useEffect(() => {
    if (!open) return;
    if (editingProvider) {
      setName(editingProvider.name);
      setKind(editingProvider.kind === 'voice' ? 'voice' : 'model');
      setFormat(editingProvider.format);
      setVoiceModel(editingProvider.voiceModel ?? '');
      setEndpoint(editingProvider.endpoint);
      setApiKey(''); // 留空 = 不修改
      setBalanceUrl(editingProvider.balanceUrl ?? '');
      setModelsUrl(editingProvider.modelsUrl ?? '');
      setIcon(editingProvider.icon ?? '');
    } else {
      setName('');
      setKind('model');
      setFormat('openai-chat');
      setVoiceModel('');
      setEndpoint('');
      setApiKey('');
      setBalanceUrl('');
      setModelsUrl('');
      setIcon('');
    }
  }, [open, editingProvider]);

  const isVoice = kind === 'voice';

  const handleSubmit = async () => {
    // 语音服务商：名称 + 引擎必填，endpoint 可选；模型服务商：名称 + endpoint 必填
    if (!name.trim() || (!isVoice && !endpoint.trim())) {
      toast.error(t('settings.provider.fieldsRequired'));
      return;
    }
    setSubmitting(true);
    try {
      if (isVoice) {
        const payload = {
          kind: 'voice' as const,
          name: name.trim(),
          voiceEngine: 'openai-transcriptions' as const,
          ...(voiceModel.trim() ? { voiceModel: voiceModel.trim() } : {}),
          endpoint: endpoint.trim(),
          apiKey: apiKey.trim(),
          ...(icon ? { icon } : {}),
        };
        if (isEdit && editingProvider) {
          await updateProvider(editingProvider.id, payload);
          toast.success(t('settings.provider.updateSuccess'));
        } else {
          await createProvider(payload);
          toast.success(t('settings.provider.createSuccess'));
        }
      } else {
        const payload = {
          kind: 'model' as const,
          name: name.trim(),
          format,
          endpoint: endpoint.trim(),
          apiKey: apiKey.trim(),
          ...(balanceUrl.trim() ? { balanceUrl: balanceUrl.trim() } : {}),
          ...(modelsUrl.trim() ? { modelsUrl: modelsUrl.trim() } : {}),
          ...(icon ? { icon } : {}),
        };
        if (isEdit && editingProvider) {
          await updateProvider(editingProvider.id, payload);
          toast.success(t('settings.provider.updateSuccess'));
        } else {
          await createProvider(payload);
          toast.success(t('settings.provider.createSuccess'));
          // 不再自动拉取模型列表（用户手动点"获取模型列表"）
        }
      }
      onOpenChange(false);
    } catch {
      // 错误已由 hook toast
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('settings.provider.editProviderTitle')
              : t('settings.provider.addProviderTitle')}
          </DialogTitle>
        </DialogHeader>

        <DialogBody>
          {/* 服务商类型（新建时可切换；编辑时锁定避免数据语义漂移） */}
          <div className="flex flex-col gap-1.5">
            <Label>{t('settings.provider.providerKind')}</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as 'model' | 'voice')}
              disabled={isEdit}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="model">{t('settings.provider.kindModel')}</SelectItem>
                <SelectItem value="voice">{t('settings.provider.kindVoice')}</SelectItem>
              </SelectContent>
            </Select>
            {isEdit && (
              <span className="text-xs text-muted-foreground">
                {t('settings.provider.kindLocked')}
              </span>
            )}
          </div>
          {/* 品牌图标 */}
          <div className="flex flex-col gap-1.5">
            <Label>{t('settings.provider.icon')}</Label>
            <IconPicker value={icon} onChange={setIcon} />
          </div>
          {/* 服务商名称 */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-name">{t('settings.provider.providerName')}</Label>
            <Input
              id="provider-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.provider.providerNamePlaceholder')}
            />
          </div>

          {isVoice ? (
            <>
              {/* 语音引擎（当前仅 OpenAI 兼容整段转写） */}
              <div className="flex flex-col gap-1.5">
                <Label>{t('settings.provider.voiceEngine')}</Label>
                <Input value="openai-transcriptions" readOnly className="text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  {t('settings.provider.voiceEngineHint')}
                </span>
              </div>
              {/* 语音模型名 */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider-voice-model">{t('settings.provider.voiceModelName')}</Label>
                <Input
                  id="provider-voice-model"
                  value={voiceModel}
                  onChange={(e) => setVoiceModel(e.target.value)}
                  placeholder={t('settings.provider.voiceModelNamePlaceholder')}
                />
              </div>
              {/* API Key */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider-voice-apikey">{t('settings.provider.apiKey')}</Label>
                <Input
                  id="provider-voice-apikey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={isEdit ? t('settings.provider.apiKeyKeep') : 'sk-...'}
                />
              </div>
              {/* 高级设置：转写端点（留空 = 官方端点） */}
              <Collapsible defaultOpen={false}>
                <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded-md py-1 text-sm text-muted-foreground transition-colors hover:text-foreground data-[state=open]:text-foreground">
                  <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                  <span>{t('settings.provider.advancedConfig')}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="flex flex-col gap-1.5 pt-1">
                    <Label htmlFor="provider-voice-endpoint">
                      {t('settings.provider.endpoint')}
                    </Label>
                    <Input
                      id="provider-voice-endpoint"
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      placeholder="https://api.openai.com/v1/audio/transcriptions"
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </>
          ) : (
            <>
              {/* API 格式 */}
              <div className="flex flex-col gap-1.5">
                <Label>{t('settings.provider.apiFormat')}</Label>
                <Select value={format} onValueChange={(v) => setFormat(v as ProviderItem['format'])}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FORMAT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* API 地址 */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider-endpoint">{t('settings.provider.endpoint')}</Label>
                <Input
                  id="provider-endpoint"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder={t('settings.provider.endpointPlaceholder')}
                />
              </div>
              {/* API Key */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider-apikey">{t('settings.provider.apiKey')}</Label>
                <Input
                  id="provider-apikey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={isEdit ? t('settings.provider.apiKeyKeep') : 'sk-...'}
                />
              </div>
              {/* 高级设置（默认折叠）：自定义余额查询地址 / 模型列表获取地址 */}
              <Collapsible defaultOpen={false}>
                <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded-md py-1 text-sm text-muted-foreground transition-colors hover:text-foreground data-[state=open]:text-foreground">
                  <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                  <span>{t('settings.provider.advancedConfig')}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="flex flex-col gap-3 pt-1">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="provider-balance-url">{t('settings.provider.balanceUrl')}</Label>
                      <Input
                        id="provider-balance-url"
                        value={balanceUrl}
                        onChange={(e) => setBalanceUrl(e.target.value)}
                        placeholder={t('settings.provider.balanceUrlPlaceholder')}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="provider-models-url">{t('settings.provider.modelsUrl')}</Label>
                      <Input
                        id="provider-models-url"
                        value={modelsUrl}
                        onChange={(e) => setModelsUrl(e.target.value)}
                        placeholder={t('settings.provider.modelsUrlPlaceholder')}
                      />
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('settings.provider.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="size-3.5 animate-spin" />}
            {t('settings.provider.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== 图标选择器（内联展开：搜索 + 网格；未选择 = 默认 Server） ===== */
function IconPicker({ value, onChange }: { value: string; onChange: (icon: string) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const filtered = PROVIDER_ICON_LIST.filter(
    (e) => !q || e.name.toLowerCase().includes(q) || e.key.toLowerCase().includes(q),
  );
  const Selected = getProviderIcon(value);

  return (
    <div className="flex flex-col gap-2">
      {/* 图标槽 */}
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="group relative flex size-12 items-center justify-center rounded-lg border border-border transition-colors hover:border-ring hover:bg-muted/50"
        aria-label={t('settings.provider.icon')}
      >
        {Selected ? (
          <Selected size={24} />
        ) : (
          <Server className="size-5 text-muted-foreground" />
        )}
        {!value && (
          <span className="absolute -top-1.5 -right-1.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
            {t('settings.provider.defaultIcon')}
          </span>
        )}
      </button>

      {/* 展开面板：搜索 + 网格 */}
      {expanded && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder={t('settings.provider.iconSearch')}
              className="h-8 pl-8 text-sm"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
          <div className="grid max-h-52 grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1 overflow-y-auto p-0.5">
            {/* 默认项 */}
            <button
              type="button"
              title={t('settings.provider.defaultIcon')}
              onClick={() => {
                onChange('');
                setExpanded(false);
              }}
              className={cn(
                'flex size-9 items-center justify-center rounded-md transition-colors hover:bg-muted',
                !value && 'ring-2 ring-primary-strong',
              )}
            >
              <Server className="size-4 text-muted-foreground" />
            </button>
            {filtered.map((entry) => (
              <button
                key={entry.key}
                type="button"
                title={entry.name}
                onClick={() => {
                  onChange(entry.key);
                  setExpanded(false);
                }}
                className={cn(
                  'flex size-9 items-center justify-center rounded-md transition-colors hover:bg-muted',
                  value === entry.key && 'ring-2 ring-primary-strong',
                )}
              >
                <entry.Icon size={18} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ===== 思考强度标签组（模型级等级库：单选 + 可增删 + 拖拽排序 + 删除回退 + 保底 1 个） ===== */
interface ThinkingLevelTagsProps {
  /** 有效等级库（调用方已 fallback DEFAULT_LEVELS） */
  levels: ThinkingLevelItem[];
  /** 当前模型 thinking */
  value: ProviderModelItem['thinking'];
  /** 选中等级（单选生效） */
  onThinkingChange: (thinking: ProviderModelItem['thinking']) => void;
  /** 等级库变更（增/删/拖拽排序，整组写回模型） */
  onLevelsChange: (levels: ThinkingLevelItem[]) => void;
}

/** 可拖拽排序的思考等级标签（点击选档 + x 删除 + 拖拽重排） */
function SortableTag({
  level,
  isCurrent,
  canRemove,
  onSelect,
  onRemove,
  deleteLabel,
  currentLabel,
}: {
  level: ThinkingLevelItem;
  isCurrent: boolean;
  canRemove: boolean;
  onSelect: () => void;
  onRemove: () => void;
  deleteLabel: string;
  currentLabel: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: level.id,
  });
  return (
    <span
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={cn(
        'group/tag relative inline-flex cursor-grab touch-none select-none items-center gap-1 rounded-md border py-1 pl-2.5 pr-2 text-xs transition-colors',
        isCurrent
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-foreground hover:bg-muted',
        canRemove && 'pr-6',
        isDragging && 'z-10 opacity-60 shadow-md ring-1 ring-ring',
      )}
    >
      <button
        type="button"
        className="transition-opacity"
        onClick={onSelect}
      >
        {level.label}
      </button>
      {isCurrent && (
        <span className="rounded-sm bg-primary-foreground/20 px-1.5 py-px text-[10px] leading-none">
          {currentLabel}
        </span>
      )}
      {canRemove && (
        <button
          type="button"
          aria-label={deleteLabel}
          title={deleteLabel}
          onClick={onRemove}
          className={cn(
            'absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 opacity-40 transition-opacity hover:opacity-100',
            isCurrent && 'opacity-70',
          )}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

export function ThinkingLevelTags({ levels, value, onThinkingChange, onLevelsChange }: ThinkingLevelTagsProps) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newEffort, setNewEffort] = useState('');
  // 拖拽排序：移动 4px 激活（与点击选档区分）
  const dragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  /** 当前生效的 effort 值（enabled=false 视为 off） */
  const currentEffort = value.enabled ? value.effort : 'off';

  /** 选中某等级 → thinking（off 档 = 关闭思考） */
  const selectLevel = (level: ThinkingLevelItem) => {
    if (level.effort === 'off') {
      onThinkingChange({ enabled: false });
    } else {
      onThinkingChange({ enabled: true, effort: level.effort, label: level.label });
    }
  };

  /** 删除等级：整组写回 provider（后端原子回退旗下模型）；若删的是当前档，本地立即切到回退目标 */
  const removeLevel = (index: number) => {
    if (levels.length <= 1) return; // 保底：至少保留 1 个（UI 已隐藏 x，双保险）
    const target = levels[index];
    const next = levels.filter((_, i) => i !== index);
    onLevelsChange(next);
    if (currentEffort === target.effort) {
      // 回退目标：原列表前一个（更低档）；无前一个用后一个
      const fallback = index > 0 ? levels[index - 1] : levels[index + 1];
      if (fallback) selectLevel(fallback);
    }
  };

  /** 添加等级：追加到列表末尾（最高档） */
  const addLevel = () => {
    const label = newLabel.trim();
    const effort = newEffort.trim();
    if (!label || !effort) {
      toast.error(t('settings.provider.levelRequired'));
      return;
    }
    onLevelsChange([...levels, { id: generateLevelId(), label, effort }]);
    setNewLabel('');
    setNewEffort('');
    setAdding(false);
  };

  /** 拖拽排序：整组按新顺序写回（顺序即档位高低） */
  const handleTagDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = levels.findIndex((l) => l.id === active.id);
    const newIndex = levels.findIndex((l) => l.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onLevelsChange(arrayMove(levels, oldIndex, newIndex));
  };

  /** 当前值不在等级库（历史数据/等级被删）：额外渲染一个"当前值"标签 */
  const orphanEffort =
    currentEffort !== 'off' && !levels.some((l) => l.effort === currentEffort)
      ? currentEffort
      : null;

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{t('settings.provider.thinkingLevel')}</Label>
      <div className="flex flex-wrap items-center gap-1.5">
        <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={handleTagDragEnd}>
          <SortableContext items={levels.map((l) => l.id)} strategy={horizontalListSortingStrategy}>
            {levels.map((level, index) => (
              <SortableTag
                key={level.id}
                level={level}
                isCurrent={currentEffort === level.effort}
                canRemove={levels.length > 1 && currentEffort !== level.effort}
                onSelect={() => selectLevel(level)}
                onRemove={() => removeLevel(index)}
                deleteLabel={t('settings.provider.delete')}
                currentLabel={t('settings.provider.current')}
              />
            ))}
          </SortableContext>

          {/* 孤儿值：当前 effort 不在等级库（历史数据），显示为只读标签（不参与排序） */}
          {orphanEffort !== null && (
            <span className="inline-flex items-center gap-1 rounded-md border border-primary bg-primary text-primary-foreground py-1 pl-2.5 pr-2 text-xs">
              {orphanEffort}
              <span className="rounded-sm bg-primary-foreground/20 px-1.5 py-px text-[10px] leading-none">
                {t('settings.provider.current')}
              </span>
            </span>
          )}

          {/* 添加按钮（不参与排序） */}
          <button
            type="button"
            onClick={() => setAdding((p) => !p)}
            className="inline-flex items-center gap-0.5 rounded-md border border-dashed border-border py-1 pl-2.5 pr-2 text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            <Plus className="size-3" />
            {t('settings.provider.addLevel')}
          </button>
        </DndContext>
      </div>

      {/* 添加输入区（内联展开） */}
      {adding && (
        <div className="flex items-center gap-2">
          <Input
            className="h-8 w-32 text-sm"
            placeholder={t('settings.provider.levelLabel')}
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            autoFocus
          />
          <Input
            className="h-8 w-32 text-sm"
            placeholder={t('settings.provider.levelEffort')}
            value={newEffort}
            onChange={(e) => setNewEffort(e.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            onClick={() => {
              setNewLabel('');
              setNewEffort('');
              setAdding(false);
            }}
          >
            <X className="size-3.5" />
            {t('common.cancel')}
          </Button>
          <Button size="sm" className="h-8 gap-1" onClick={addLevel}>
            <Check className="size-3.5" />
            {t('settings.provider.confirm')}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ===== 远程模型勾选弹窗（实时搜索 + 已添加标记 + 勾选后进入分页添加） ===== */
interface ModelPickDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderItem;
  fetchProviderModels: UseProvidersResult['fetchProviderModels'];
  /** 勾选提交 → 打开分页「添加模型」弹窗填写详细信息 */
  onPick: (models: Array<{ name: string; model: string }>) => void;
}

function ModelPickDialog({ open, onOpenChange, provider, fetchProviderModels, onPick }: ModelPickDialogProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteModels, setRemoteModels] = useState<RemoteModelItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');

  const loadModels = async () => {
    setLoading(true);
    setError(null);
    setRemoteModels([]);
    setSelected(new Set());
    try {
      const result = await fetchProviderModels(provider.id);
      if (result.success) {
        setRemoteModels(result.models);
        if (result.models.length === 0) {
          setError(t('settings.provider.noRemoteModels'));
        }
      } else {
        setError(result.error ?? t('settings.provider.fetchFailUnknown'));
      }
    } finally {
      setLoading(false);
    }
  };

  // 弹窗打开时拉取
  useEffect(() => {
    if (open) {
      setQuery('');
      void loadModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider.id]);

  // 实时搜索过滤（模型 id / 显示名包含关键词，大小写不敏感）
  const q = query.trim().toLowerCase();
  const filtered = remoteModels.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q));

  // 已存在于服务商的模型（禁止重复添加）
  const existingModels = new Set(provider.models.map((m) => m.model));

  const toggle = (modelId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  // 全选（当前过滤结果中未添加的项）
  const selectableFiltered = filtered.filter((m) => !existingModels.has(m.id));
  const allSelected =
    selectableFiltered.length > 0 && selectableFiltered.every((m) => selected.has(m.id));
  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const m of selectableFiltered) next.delete(m.id);
      } else {
        for (const m of selectableFiltered) next.add(m.id);
      }
      return next;
    });
  };

  const handleSubmit = () => {
    if (selected.size === 0) return;
    // 勾选模型 → 分页「添加模型」弹窗填写详细配置后批量入库
    const models = remoteModels
      .filter((m) => selected.has(m.id))
      .map((m) => ({ name: m.name ?? m.id, model: m.id }));
    onPick(models);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('settings.provider.pickTitle', { name: provider.name })}</DialogTitle>
        </DialogHeader>

        <DialogBody>
        {/* 实时搜索框 */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t('settings.provider.pickSearchPlaceholder')}
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        {/* 模型列表 */}
        <div className="min-h-40 max-h-80 overflow-y-auto rounded-lg border border-border">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('settings.provider.fetchingModels')}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-2 p-6 text-sm text-muted-foreground">
              <span>{t('settings.provider.fetchFail', { error })}</span>
              <Button variant="outline" size="sm" className="gap-1" onClick={() => void loadModels()}>
                <RefreshCw className="size-3" />
                {t('settings.provider.retry')}
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center p-6 text-sm text-muted-foreground">
              {t('settings.provider.noRemoteModels')}
            </div>
          ) : (
            <>
              {/* 全选行 */}
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 py-2">
                <Checkbox
                  id="pick-select-all"
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={selectableFiltered.length === 0}
                />
                <Label
                  htmlFor="pick-select-all"
                  className="cursor-pointer text-xs text-muted-foreground"
                >
                  {t('settings.provider.selectAll')}
                </Label>
              </div>
              {filtered.map((m) => {
                const exists = existingModels.has(m.id);
                const checked = selected.has(m.id);
                return (
                  <div
                    key={m.id}
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-2 transition-colors',
                      exists ? 'opacity-60' : 'hover:bg-muted/50',
                    )}
                  >
                    <Checkbox
                      id={`pick-${m.id}`}
                      checked={checked}
                      onCheckedChange={() => toggle(m.id)}
                      disabled={exists}
                    />
                    <Label
                      htmlFor={`pick-${m.id}`}
                      className={cn(
                        'flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm',
                        exists && 'cursor-not-allowed',
                      )}
                    >
                      <span className="truncate">{m.name ?? m.id}</span>
                      <span className="truncate text-xs text-muted-foreground">{m.id}</span>
                    </Label>
                    {exists && (
                      <Badge variant="secondary" className="shrink-0 font-normal">
                        {t('settings.provider.alreadyAdded')}
                      </Badge>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
        </DialogBody>

        <DialogFooter className="items-center">
          <span className="mr-auto text-xs text-muted-foreground">
            {t('settings.provider.selectedCount', { count: selected.size })}
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('settings.provider.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={selected.size === 0}>
            {t('settings.provider.addSelected', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== 余额查询弹窗（OpenAI 兼容计费格式：总额度 - 已用量） ===== */
interface BalanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderItem;
}

function BalanceDialog({ open, onOpenChange, provider }: BalanceDialogProps) {
  const { t } = useTranslation();
  const { fetchProviderBalance } = useProviders();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    totalUsd?: number;
    usedUsd?: number;
    balanceUsd?: number;
    error?: string;
  } | null>(null);

  const queryBalance = async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await fetchProviderBalance(provider.id);
      setResult(r);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setResult(null);
      void queryBalance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider.id]);

  const fmt = (v: number | undefined) =>
    v !== undefined ? `$${v.toFixed(2)}` : '-';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('settings.provider.balanceTitle')}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ProviderLogo icon={provider.icon} size={16} />
            {provider.name}
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('settings.provider.balanceLoading')}
            </div>
          ) : !result ? null : result.success ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('settings.provider.balanceTotal')}</span>
                <span className="tabular-nums text-foreground">{fmt(result.totalUsd)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('settings.provider.balanceUsed')}</span>
                <span className="tabular-nums text-foreground">{fmt(result.usedUsd)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-border pt-2 text-sm font-medium">
                <span className="text-muted-foreground">
                  {t('settings.provider.balanceRemaining')}
                </span>
                <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                  {fmt(result.balanceUsd)}
                </span>
              </div>
            </div>
          ) : result.error === 'BALANCE_URL_NOT_CONFIGURED' ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              {t('settings.provider.balanceNotConfigured')}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-destructive/30 p-4 text-sm text-destructive">
              <span>{t('settings.provider.balanceQueryFail', { error: result.error ?? '' })}</span>
              <Button variant="outline" size="sm" className="gap-1" onClick={() => void queryBalance()}>
                <RefreshCw className="size-3" />
                {t('settings.provider.retry')}
              </Button>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('settings.provider.close')}
          </Button>
          {!loading && result?.success && (
            <Button className="gap-1" onClick={() => void queryBalance()}>
              <RefreshCw className="size-3.5" />
              {t('settings.provider.refresh')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== 服务弹窗（添加/编辑文件存储服务共用） ===== */
interface AddServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderItem;
  editingService: ProviderServiceItem | null;
}

function AddServiceDialog({ open, onOpenChange, provider, editingService }: AddServiceDialogProps) {
  const { t } = useTranslation();
  const isEdit = !!editingService;
  const { addProviderService, updateProviderService } = useProviders();

  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [maxQuota, setMaxQuota] = useState('');
  const [quotaUnit, setQuotaUnit] = useState<'MB' | 'GB' | 'TB'>('GB');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editingService) {
      setName(editingService.name);
      setEndpoint(editingService.endpoint);
      setApiKey(''); // 留空 = 不修改
      setMaxQuota(editingService.maxQuota !== undefined ? String(editingService.maxQuota) : '');
      setQuotaUnit(editingService.quotaUnit ?? 'GB');
    } else {
      setName('');
      setEndpoint('');
      setApiKey('');
      setMaxQuota('');
      setQuotaUnit('GB');
    }
  }, [open, editingService]);

  const handleSubmit = async () => {
    if (!name.trim() || !endpoint.trim()) {
      toast.error(t('settings.provider.serviceFieldsRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        type: 'file-storage' as const,
        endpoint: endpoint.trim(),
        apiKey: apiKey.trim(),
        ...(maxQuota.trim() ? { maxQuota: Math.max(1, Math.floor(Number(maxQuota))) } : {}),
        quotaUnit,
      };
      if (isEdit && editingService) {
        await updateProviderService(provider.id, editingService.id, payload);
        toast.success(t('settings.provider.serviceUpdateSuccess'));
      } else {
        await addProviderService(provider.id, payload);
        toast.success(t('settings.provider.serviceAddSuccess'));
      }
      onOpenChange(false);
    } catch {
      // 错误已由 hook toast
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('settings.provider.editServiceTitle')
              : t('settings.provider.addServiceTitle')}
          </DialogTitle>
        </DialogHeader>

        <DialogBody>
          {/* 服务名称 */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="service-name">{t('settings.provider.serviceName')}</Label>
            <Input
              id="service-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.provider.serviceNamePlaceholder')}
            />
          </div>
          {/* 服务类型（当前仅文件存储） */}
          <div className="flex flex-col gap-1.5">
            <Label>{t('settings.provider.serviceType')}</Label>
            <div className="flex h-8 items-center gap-2">
              <Badge variant="outline" className="font-normal">
                {t('settings.provider.fileStorage')}
              </Badge>
            </div>
          </div>
          {/* API 地址 */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="service-endpoint">{t('settings.provider.serviceEndpoint')}</Label>
            <Input
              id="service-endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={t('settings.provider.endpointPlaceholder')}
            />
          </div>
          {/* API Key */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="service-apikey">{t('settings.provider.apiKey')}</Label>
            <Input
              id="service-apikey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isEdit ? t('settings.provider.apiKeyKeep') : 'sk-...'}
            />
          </div>
          {/* 最大限额 + 单位 */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="service-quota">{t('settings.provider.maxQuota')}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="service-quota"
                type="number"
                min={1}
                className="flex-1"
                value={maxQuota}
                onChange={(e) => setMaxQuota(e.target.value)}
                placeholder="10"
              />
              <Select value={quotaUnit} onValueChange={(v) => setQuotaUnit(v as 'MB' | 'GB' | 'TB')}>
                <SelectTrigger className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MB">MB</SelectItem>
                  <SelectItem value="GB">GB</SelectItem>
                  <SelectItem value="TB">TB</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('settings.provider.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="size-3.5 animate-spin" />}
            {t('settings.provider.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== 模型弹窗（手动添加/编辑/远程批量添加共用；思考强度标签化） ===== */
/** 单个模型表单草稿 */
interface ModelDraft {
  name: string;
  model: string;
  inputTokens: string;
  outputTokens: string;
  temperature: number;
  topP: number;
  topK: number;
  thinking: ProviderModelItem['thinking'];
  /** 模型级思考强度等级库草稿（undefined = 默认库） */
  thinkingLevels?: ThinkingLevelItem[];
}

interface ProviderModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderItem;
  editingModel: ProviderModelItem | null;
  /** 远程模型批量添加（分页模式，每页一个模型） */
  batchModels?: Array<{ name: string; model: string }>;
}

function ProviderModelDialog({
  open,
  onOpenChange,
  provider,
  editingModel,
  batchModels,
}: ProviderModelDialogProps) {
  const { t } = useTranslation();
  const isEdit = !!editingModel;
  const isBatch = !editingModel && !!batchModels && batchModels.length > 0;
  const { addProviderModels, updateProviderModel } = useProviders();

  /** 统一草稿数组：单模型场景长度恒为 1；批量场景每页一项（切页暂存不丢失） */
  const [drafts, setDrafts] = useState<ModelDraft[]>([]);
  const [page, setPage] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const draft = drafts[page];
  /** 有效等级库（草稿未配置 = 默认库；本地草稿更新保证增删/排序即时显示） */
  const levels = draft?.thinkingLevels ?? DEFAULT_LEVELS;

  /** 新建默认草稿：输入 200000 / 输出 128000 / 思考等级 high（label 取等级库定义） */
  const makeDefaultDraft = (name: string, model: string): ModelDraft => {
    const highLevel = DEFAULT_LEVELS.find((l) => l.effort === 'high');
    return {
      name,
      model,
      inputTokens: '200000',
      outputTokens: '128000',
      temperature: 1.0,
      topP: 1.0,
      topK: 0,
      thinking: { enabled: true, effort: 'high', label: highLevel?.label ?? 'High' },
    };
  };

  // 弹窗打开时同步表单数据
  useEffect(() => {
    if (!open) return;
    setPage(0);
    if (editingModel) {
      setDrafts([
        {
          name: editingModel.name,
          model: editingModel.model,
          inputTokens: String(
            editingModel.inputTokens ?? parseLegacyWindow(editingModel.contextWindow) ?? '',
          ),
          outputTokens: String(editingModel.outputTokens ?? ''),
          temperature: editingModel.temperature ?? 1.0,
          topP: editingModel.topP ?? 1.0,
          topK: editingModel.topK ?? 0,
          thinking: editingModel.thinking,
          thinkingLevels: editingModel.thinkingLevels,
        },
      ]);
    } else if (batchModels && batchModels.length > 0) {
      // 远程勾选批量添加：每页一个模型，均预填默认高级配置
      setDrafts(batchModels.map((m) => makeDefaultDraft(m.name, m.model)));
    } else {
      setDrafts([makeDefaultDraft('', '')]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingModel, batchModels]);

  /** 更新当前页草稿 */
  const updateDraft = (patch: Partial<ModelDraft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === page ? { ...d, ...patch } : d)));
  };

  /** 等级库变更（增/删/拖拽排序）→ 写入草稿即时显示；编辑模式同步落库（模型级独立存储） */
  const handleLevelsChange = (next: ThinkingLevelItem[]) => {
    updateDraft({ thinkingLevels: next });
    if (editingModel) {
      void updateProviderModel(provider.id, editingModel.id, { thinkingLevels: next }).catch(() => {
        // 错误已由 hook toast
      });
    }
  };

  const handleSubmit = async () => {
    if (!draft) return;
    // 批量模式校验所有页；单模式校验当前页
    const targets = isBatch ? drafts : [draft];
    if (targets.some((d) => !d.name.trim() || !d.model.trim())) {
      toast.error(t('settings.provider.modelFieldsRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const toPayload = (d: ModelDraft) => ({
        name: d.name.trim(),
        model: d.model.trim(),
        inputTokens: d.inputTokens.trim() ? Math.max(1, Math.floor(Number(d.inputTokens))) : undefined,
        outputTokens: d.outputTokens.trim()
          ? Math.max(1, Math.floor(Number(d.outputTokens)))
          : undefined,
        temperature: d.temperature,
        topP: d.topP,
        topK: d.topK,
        thinking: d.thinking,
        thinkingLevels: d.thinkingLevels,
      });
      if (isEdit && editingModel) {
        const d = drafts[0];
        await updateProviderModel(provider.id, editingModel.id, toPayload(d));
        toast.success(t('settings.provider.updateModelSuccess'));
      } else if (isBatch) {
        const result = await addProviderModels(provider.id, drafts.map(toPayload));
        toast.success(t('settings.provider.addSelectedSuccess', { count: result.added }));
      } else {
        await addProviderModels(provider.id, [toPayload(draft)]);
        toast.success(t('settings.provider.addModelSuccess'));
      }
      onOpenChange(false);
    } catch {
      // 错误已由 hook toast
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('settings.provider.editModelTitle')
              : t('settings.provider.addModelTitle')}
          </DialogTitle>
        </DialogHeader>

        {draft && (
          <DialogBody>
          {/* 模型名称 */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pm-name">{t('settings.provider.modelName')}</Label>
            <Input
              id="pm-name"
              value={draft.name}
              onChange={(e) => updateDraft({ name: e.target.value })}
              placeholder={t('settings.provider.modelNamePlaceholder')}
            />
          </div>
          {/* 模型 id */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pm-model">{t('settings.provider.modelId')}</Label>
            <Input
              id="pm-model"
              value={draft.model}
              onChange={(e) => updateDraft({ model: e.target.value })}
              placeholder={t('settings.provider.modelIdPlaceholder')}
            />
          </div>
          {/* 高级配置（始终默认折叠；切页重置折叠态） */}
          <Collapsible defaultOpen={false} key={page}>
            <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded-md py-1 text-sm text-muted-foreground transition-colors hover:text-foreground data-[state=open]:text-foreground">
              <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
              <span>{t('settings.provider.advancedConfig')}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="flex flex-col gap-3 pt-1">
                {/* 上下文窗口：输入 / 输出 */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="pm-input-tokens">{t('settings.provider.inputWindow')}</Label>
                    <Input
                      id="pm-input-tokens"
                      type="number"
                      min={1}
                      value={draft.inputTokens}
                      onChange={(e) => updateDraft({ inputTokens: e.target.value })}
                      placeholder="200000"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="pm-output-tokens">{t('settings.provider.outputWindow')}</Label>
                    <Input
                      id="pm-output-tokens"
                      type="number"
                      min={1}
                      value={draft.outputTokens}
                      onChange={(e) => updateDraft({ outputTokens: e.target.value })}
                      placeholder="8192"
                    />
                  </div>
                </div>
                {/* 模型温度 */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label>{t('settings.provider.temperature')}</Label>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {draft.temperature.toFixed(1)}
                    </span>
                  </div>
                  <Slider
                    value={[draft.temperature]}
                    min={0}
                    max={2}
                    step={0.1}
                    onValueChange={(v) => updateDraft({ temperature: v[0] ?? 1 })}
                  />
                </div>
                {/* Top P */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label>{t('settings.provider.topP')}</Label>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {draft.topP.toFixed(2)}
                    </span>
                  </div>
                  <Slider
                    value={[draft.topP]}
                    min={0}
                    max={1}
                    step={0.05}
                    onValueChange={(v) => updateDraft({ topP: v[0] ?? 1 })}
                  />
                </div>
                {/* Top K */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label>{t('settings.provider.topK')}</Label>
                    <span className="text-sm tabular-nums text-muted-foreground">{draft.topK}</span>
                  </div>
                  <Slider
                    value={[draft.topK]}
                    min={0}
                    max={100}
                    step={1}
                    onValueChange={(v) => updateDraft({ topK: Math.round(v[0] ?? 0) })}
                  />
                </div>
                {/* 思考强度（标签化：服务商级等级库） */}
                <ThinkingLevelTags
                  levels={levels}
                  value={draft.thinking}
                  onThinkingChange={(thinking) => updateDraft({ thinking })}
                  onLevelsChange={handleLevelsChange}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </DialogBody>
        )}

        <DialogFooter className="items-center">
          {/* 批量分页：左侧后退/前进 + 页码 */}
          {isBatch && drafts.length > 1 && (
            <div className="mr-auto flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t('settings.provider.prevModel')}
                disabled={page === 0 || submitting}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
                {page + 1} / {drafts.length}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t('settings.provider.nextModel')}
                disabled={page >= drafts.length - 1 || submitting}
                onClick={() => setPage((p) => Math.min(drafts.length - 1, p + 1))}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('settings.provider.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="size-3.5 animate-spin" />}
            {t('settings.provider.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
