// webui/src/components/pages/settings/im/ImBotRow.tsx
// 单个机器人状态行：状态点 + 名称 + 掩码身份 + 操作（测试/重新扫码/重连/编辑/配对/删除）+ 启用开关。

import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2, Pencil, PlugZap, QrCode, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { ImBotStatus } from '@/types/api';
import { STATE_BADGE_CLASS, STATE_DOT_CLASS } from './channel-meta';

interface Props {
  bot: ImBotStatus;
  busy: boolean;
  onToggle: (bot: ImBotStatus, enabled: boolean) => void;
  onTest: (bot: ImBotStatus) => void;
  /** 扫码授权被平台回收后重新扫码（更新同一个机器人） */
  onReauth: (bot: ImBotStatus) => void;
  onReconnect: (bot: ImBotStatus) => void;
  onEdit: (bot: ImBotStatus) => void;
  onBinding: (bot: ImBotStatus) => void;
  onDelete: (bot: ImBotStatus) => void;
}

export function ImBotRow({
  bot,
  busy,
  onToggle,
  onTest,
  onReauth,
  onReconnect,
  onEdit,
  onBinding,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const stateLabel =
    bot.state === 'connected'
      ? t('settings.im.stateConnected')
      : bot.state === 'connecting'
        ? t('settings.im.stateConnecting')
        : bot.state === 'error'
          ? t('settings.im.stateError')
          : t('settings.im.stateOffline');

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('size-2 shrink-0 rounded-full', STATE_DOT_CLASS[bot.state])} />
        <img src="/MOSS.png" alt="MOSS" className="size-5 shrink-0 rounded-md object-cover" />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{bot.name}</span>
        <Badge variant="secondary" className={cn('px-1.5 text-[10px] font-normal', STATE_BADGE_CLASS[bot.state])}>
          {stateLabel}
        </Badge>
        <span className="font-mono text-[11px] text-muted-foreground">{bot.platformIdMasked}</span>

        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            title={t('settings.im.test')}
            disabled={busy}
            onClick={() => onTest(bot)}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
          </Button>
          {bot.extra?.authExpired === 'true' ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              title={t('settings.im.reauthHint')}
              onClick={() => onReauth(bot)}
            >
              <QrCode className="size-3.5" />
              {t('settings.im.reauth')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              title={t('settings.im.reconnect')}
              disabled={busy}
              onClick={() => onReconnect(bot)}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            title={t('settings.im.binding')}
            onClick={() => onBinding(bot)}
          >
            <KeyRound className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            title={t('common.edit')}
            onClick={() => onEdit(bot)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
            title={t('common.delete')}
            onClick={() => onDelete(bot)}
          >
            <Trash2 className="size-3.5" />
          </Button>
          <Switch
            checked={bot.enabled}
            disabled={busy}
            onCheckedChange={checked => onToggle(bot, checked)}
            aria-label={bot.enabled ? t('common.close') : t('common.open')}
          />
        </div>
      </div>

      {bot.lastError ? (
        <div className="line-clamp-2 text-xs text-red-600 dark:text-red-400">{bot.lastError}</div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>{t('settings.im.stats', { received: bot.stats.received, replied: bot.stats.replied })}</span>
        <span>{t('settings.im.boundCount', { count: bot.boundUsers.length })}</span>
        {bot.extra?.wsUrl || bot.extra?.backendUrl ? (
          <span className="truncate font-mono">{bot.extra.wsUrl ?? bot.extra.backendUrl}</span>
        ) : null}
        {bot.extra?.selfId ? <span className="font-mono">#{bot.extra.selfId}</span> : null}
      </div>
    </div>
  );
}
