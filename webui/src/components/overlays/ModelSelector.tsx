// UI/src/components/overlays/ModelSelector.tsx
// 模型选择器（按服务商分组）：
// - 桌面端：DropdownMenu 上拉菜单 + Popover 作为参数面板。
//   Popover 锚定齿轮按钮，点击打开，鼠标移开不关闭，点击外部/齿轮/Esc 才关闭。
//   子菜单左右自适应相对于整个上拉菜单（非齿轮按钮）。
// - 移动端：底部 Sheet 抽屉，齿轮展开内联设置。
// 自包含触发按钮，不再依赖外部 children。

import { useState, useRef, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { SlidersHorizontal, Plus, ChevronDown, Server } from 'lucide-react';
import { useStore } from '../../store';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { DEFAULT_LEVELS } from '../../lib/model-utils';
import { getProviderIcon } from '../../lib/provider-icons';
import { ThinkingLevelTags } from '../pages/ProviderSettings';
import { useProviders } from '../../hooks/useProviders';
import { useIsMobile } from '../../hooks/use-mobile';
import type { ProviderItem, ProviderModelItem } from '../../types/api';

/** 渲染上下文：模型 + 所属服务商 id（调参写回用） */
interface ModelWithContext extends ProviderModelItem {
  providerId: string;
}

/** 服务商分组标题（品牌图标 + 名称；未配置 fallback Server） */
function GroupLabel({ provider, className }: { provider: ProviderItem; className?: string }) {
  const Logo = getProviderIcon(provider.icon);
  return (
    <div className={cn('flex items-center gap-1.5 text-xs font-medium text-muted-foreground', className)}>
      {Logo ? (
        <Logo size={14} />
      ) : (
        <Server className="size-3.5" />
      )}
      <span className="truncate">{provider.name}</span>
    </div>
  );
}

export function ModelSelector() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { providers, currentModel, setCurrent, updateProviderModel } = useProviders();
  const isMobile = useIsMobile();
  const hasAnyModel = providers.some((p) => p.models.length > 0);
  // 模型列表只展示「有模型的服务商」；语音服务商 models 恒空，自然被过滤
  const modelProviders = providers.filter((p) => p.models.length > 0);
  const currentModelName = providers
    .flatMap((p) => p.models)
    .find((m) => m.id === currentModel)?.name;
  // 触发按钮文案：无任何可用模型时显示"暂无模型"
  const triggerLabel = hasAnyModel
    ? (currentModelName || t('modelSelector.auto'))
    : t('modelSelector.noModels');

  // 桌面端子菜单控制
  const [mainOpen, setMainOpen] = useState(false);
  const [openSubId, setOpenSubId] = useState<string | undefined>();
  const [subSide, setSubSide] = useState<'right' | 'left'>('right');
  const [subSideOffset, setSubSideOffset] = useState(4);
  const contentRef = useRef<HTMLDivElement>(null);

  // 移动端抽屉控制
  const [sheetOpen, setSheetOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | undefined>();

  // 主菜单打开时测量内容宽度，计算子菜单应放左侧还是右侧（相对于整个菜单）
  useLayoutEffect(() => {
    if (!mainOpen) return;
    const measure = () => {
      const el = contentRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const rightSpace = window.innerWidth - rect.right;
      if (rightSpace < 256 + 8) {
        setSubSide('left');
        // 让子菜单右边缘对齐菜单左边缘 - 4px 间距
        setSubSideOffset(Math.round(rect.width) - 24 + 4);
      } else {
        setSubSide('right');
        setSubSideOffset(4);
      }
    };
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [mainOpen]);

  /** 渲染模型参数设置区（桌面子菜单与移动端内联共用） */
  const renderSettings = (model: ModelWithContext, provider: ProviderItem) => {
    return (
      <>
        {/* 上下文窗口：输入 / 输出 */}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              {t('settings.provider.inputWindow')}
            </label>
            <Input
              type="number"
              min={1}
              defaultValue={model.inputTokens ?? ''}
              placeholder="200000"
              onBlur={(e) => {
                const v = e.target.value.trim();
                void updateProviderModel(model.providerId, model.id, {
                  inputTokens: v ? Math.max(1, Math.floor(Number(v))) : undefined,
                });
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              {t('settings.provider.outputWindow')}
            </label>
            <Input
              type="number"
              min={1}
              defaultValue={model.outputTokens ?? ''}
              placeholder="8192"
              onBlur={(e) => {
                const v = e.target.value.trim();
                void updateProviderModel(model.providerId, model.id, {
                  outputTokens: v ? Math.max(1, Math.floor(Number(v))) : undefined,
                });
              }}
            />
          </div>
        </div>

        {/* 思考强度（标签化：服务商级等级库） */}
        <div className="mt-4">
          <ThinkingLevelTags
            levels={model.thinkingLevels ?? DEFAULT_LEVELS}
            value={model.thinking}
            onThinkingChange={(thinking) => {
              void updateProviderModel(model.providerId, model.id, { thinking });
            }}
            onLevelsChange={(levels) => {
              void updateProviderModel(model.providerId, model.id, { thinkingLevels: levels });
            }}
          />
        </div>
      </>
    );
  };

  // ======================== 移动端：底部抽屉 ========================
  if (isMobile) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 shrink gap-1.5 rounded-[min(var(--radius-md),12px)]"
          onClick={() => setSheetOpen(true)}
        >
          <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
          <ChevronDown className="size-3 shrink-0 opacity-70" />
        </Button>
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto p-4">
            <SheetHeader>
              <SheetTitle>{t('modelSelector.title')}</SheetTitle>
            </SheetHeader>
            <div className="flex flex-col gap-1 px-1 pb-2 pt-2">
              {!hasAnyModel && (
                <div className="px-2 py-4 text-xs text-muted-foreground">
                  {t('modelSelector.noModels')}
                </div>
              )}
              {modelProviders.map((provider) => (
                <div key={provider.id} className="flex flex-col">
                  {/* 服务商分组标题（含品牌图标） */}
                  <GroupLabel provider={provider} />
                  {provider.models.map((model) => {
                    const isSelected = currentModel === model.id;
                    return (
                      <div key={model.id} className="flex flex-col">
                        <div
                          className={cn(
                            'flex items-center justify-between rounded-md px-2 py-1.5',
                            isSelected && 'bg-muted',
                          )}
                        >
                          <button
                            className="min-w-0 flex-1 truncate text-left text-sm"
                            onClick={() => {
                              void setCurrent(model.id);
                              setSheetOpen(false);
                            }}
                          >
                            {model.name}
                          </button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0"
                            onClick={() =>
                              setExpandedId((p) => (p === model.id ? undefined : model.id))
                            }
                          >
                            <SlidersHorizontal className="size-3.5" />
                          </Button>
                        </div>
                        {expandedId === model.id && (
                          <div className="border-t px-1 py-3">
                            {renderSettings({ ...model, providerId: provider.id }, provider)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              <DropdownMenuSeparator />
              <button
                className="flex items-center gap-1.5 px-2 py-1.5 text-sm text-muted-foreground"
                onClick={() => {
                  navigate('/settings/provider');
                  useStore.getState().requestProviderDialog();
                  setSheetOpen(false);
                }}
              >
                <Plus className="size-3.5" />
                {t('modelSelector.addProvider')}
              </button>
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // ======================== 桌面端：DropdownMenu ========================
  return (
    <DropdownMenu
      modal={false}
      open={mainOpen}
      onOpenChange={(o) => {
        setMainOpen(o);
        if (!o) setOpenSubId(undefined);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="min-w-0 shrink gap-1.5 rounded-[min(var(--radius-md),12px)]">
          <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
          <ChevronDown className="size-3 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onInteractOutside={(e) => {
          // 二级调参面板（独立 Portal）上的交互不应关闭主菜单
          const target = e.target as Node | null;
          if (
            target &&
            (target as HTMLElement).closest?.('[data-slot="popover-content"]')
          ) {
            e.preventDefault();
          }
        }}
        className="w-64 max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto p-1"
      >
        {!hasAnyModel && (
          <div className="px-2 py-4 text-xs text-muted-foreground">
            {t('modelSelector.noModels')}
          </div>
        )}
        {modelProviders.map((provider) => (
          <div key={provider.id}>
            {/* 服务商分组标题（品牌图标 + 名称） */}
            <GroupLabel provider={provider} className="px-2 py-1.5" />
            {provider.models.map((model) => {
              const isSelected = currentModel === model.id;
              return (
                <DropdownMenuItem
                  key={model.id}
                  onSelect={(e) => {
                    if (isSelected) {
                      // 已选中模型：再次点击切换参数面板（保持菜单打开）
                      e.preventDefault();
                      setOpenSubId((p) => (p === model.id ? undefined : model.id));
                    } else {
                      void setCurrent(model.id);
                    }
                  }}
                  className={cn('justify-between', isSelected && 'bg-muted text-foreground')}
                >
                  <span className="truncate">{model.name}</span>
                  {/* 齿轮触发参数面板：Popover 点击打开，鼠标移开不关闭 */}
                  <Popover
                    open={openSubId === model.id}
                    onOpenChange={(o) =>
                      setOpenSubId(o ? model.id : undefined)
                    }
                  >
                    <PopoverAnchor asChild>
                      <button
                        type="button"
                        className="ml-auto inline-flex size-6 items-center justify-center rounded-md hover:bg-accent"
                        onMouseDown={(e) => {
                          // 阻止 DropdownMenuItem 获得焦点/触发 onSelect
                          e.preventDefault();
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setOpenSubId((p) =>
                            p === model.id ? undefined : model.id
                          );
                        }}
                      >
                        <SlidersHorizontal className="size-3.5" />
                      </button>
                    </PopoverAnchor>
                    <PopoverContent
                      side={subSide}
                      sideOffset={subSideOffset}
                      align={subSide === 'left' ? 'end' : 'start'}
                      collisionPadding={8}
                      className="w-64 p-3"
                      // 阻止点击面板内容时冒泡到 DropdownMenu 导致关闭
                      onMouseDown={(e) => e.preventDefault()}
                      // 鼠标在主菜单 item 间移动触发 item 聚焦 / pointerdown 时，
                      // 对 PopoverContent 而言是 outside，会触发子菜单自我关闭。
                      // 这里拦截来自主菜单的交互，保持子菜单打开。
                      onInteractOutside={(e) => {
                        const target = e.target as Node | null;
                        if (
                          target &&
                          ((target as HTMLElement).closest?.(
                            '[data-slot="dropdown-menu-content"]'
                          ) ||
                            (target as HTMLElement).closest?.(
                              '[data-slot="dropdown-menu-item"]'
                            ))
                        ) {
                          e.preventDefault();
                        }
                      }}
                    >
                      {renderSettings({ ...model, providerId: provider.id }, provider)}
                    </PopoverContent>
                  </Popover>
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-1.5 text-muted-foreground"
          onSelect={() => {
            navigate('/settings/provider');
            useStore.getState().requestProviderDialog();
          }}
        >
          <Plus className="size-3.5" />
          {t('modelSelector.addProvider')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
