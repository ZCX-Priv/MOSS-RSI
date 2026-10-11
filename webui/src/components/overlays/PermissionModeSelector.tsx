// UI/src/components/overlays/PermissionModeSelector.tsx
// 执行权限选择器：DropdownMenu 上拉菜单。
// 3 种权限模式（对齐后端 safety 模块）：ask=手动审批 / auto=自动审批 / skip=完全访问。
// 会话级作用域：当前会话独立记忆（后端 session 持久化，刷新恢复）；新会话用全局默认。
// 选择随 task.stream 传给后端，由 safety 模块统一决策（真正生效，非 UI 装饰）。

import { useTranslation } from 'react-i18next';
import {
  Hand,
  Shield,
  ShieldAlert,
  ChevronDown,
  CheckCircle2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useStore } from '../../store';
import type { PermissionMode } from '../../types/api';

/** 权限模式配置 */
interface ModeConfig {
  id: PermissionMode;
  icon: LucideIcon;
  labelKey: string;
  descKey: string;
  badgeKey?: string;
  badgeClass?: string;
  iconClass?: string;
}

const MODE_CONFIG: ModeConfig[] = [
  {
    id: 'ask',
    icon: Hand,
    labelKey: 'permissionMode.ask.label',
    descKey: 'permissionMode.ask.desc',
  },
  {
    id: 'auto',
    icon: Shield,
    labelKey: 'permissionMode.auto.label',
    descKey: 'permissionMode.auto.desc',
  },
  {
    id: 'skip',
    icon: ShieldAlert,
    labelKey: 'permissionMode.skip.label',
    descKey: 'permissionMode.skip.desc',
    badgeKey: 'permissionMode.skip.badge',
    badgeClass:
      'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
    iconClass: 'text-red-600 dark:text-red-500',
  },
];

export function PermissionModeSelector({ fullLabel = false }: { fullLabel?: boolean }) {
  const { t } = useTranslation();
  const activeSessionId = useStore((s) => s.activeSessionId);
  const globalMode = useStore((s) => s.permissionMode);
  const sessionMode = useStore((s) => (activeSessionId ? s.permissionModeBySession[activeSessionId] : undefined));
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  // 会话级覆盖优先，缺省回退全局默认
  const permissionMode = sessionMode ?? globalMode;

  const currentConfig =
    MODE_CONFIG.find((m) => m.id === permissionMode) ?? MODE_CONFIG[0];
  const CurrentIcon = currentConfig.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge
          variant="secondary"
          className="min-w-0 shrink gap-1 h-7 rounded-[min(var(--radius-md),12px)] border border-border bg-transparent px-3 py-1 font-normal cursor-pointer [&>svg]:size-3.5"
          title={t('permissionMode.title')}
        >
          <CurrentIcon className={cn('size-3 shrink-0', currentConfig.iconClass)} />
          <span className={cn('min-w-0 flex-1 truncate whitespace-nowrap', !fullLabel && 'hidden sm:inline', currentConfig.iconClass)}>
            {t(currentConfig.labelKey)}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-70" />
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="min-w-[18rem] p-1"
      >
        <DropdownMenuLabel className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {t('permissionMode.title')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {MODE_CONFIG.map((mode) => {
          const isSelected = permissionMode === mode.id;
          const Icon = mode.icon;
          return (
            <DropdownMenuItem
              key={mode.id}
              onSelect={() => setPermissionMode(mode.id, activeSessionId ?? undefined)}
              className={cn(
                'gap-2.5 px-2 py-1.5 focus:text-inherit',
              )}
            >
              <Icon
                className={cn('size-4 shrink-0', mode.iconClass)}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm leading-tight">
                  {t(mode.labelKey)}
                </span>
                <span className="text-[11px] leading-tight text-muted-foreground">
                  {t(mode.descKey)}
                </span>
              </div>
              {mode.badgeKey && (
                <Badge
                  variant="secondary"
                  className={cn(
                    'shrink-0 border font-normal',
                    mode.badgeClass,
                  )}
                >
                  {t(mode.badgeKey)}
                </Badge>
              )}
              {isSelected && (
                <CheckCircle2 className="ml-auto size-4 shrink-0 fill-primary text-primary-foreground" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
