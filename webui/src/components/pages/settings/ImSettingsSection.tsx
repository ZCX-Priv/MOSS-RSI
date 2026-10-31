// webui/src/components/pages/settings/ImSettingsSection.tsx
// IM 连接设置分区（/settings/im）：渠道卡片 + 机器人管理 + 配对码 + 渠道扫码接入。
// 页面结构对齐「远程控制」：标题/说明 + 状态总览 + 卡片网格，移动端单列。

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { api } from '@/api/http';
import { useIm } from '@/hooks/useIm';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BrandIcon } from '@/lib/brand-icons';
import type { ImBotStatus, ImChannelDescriptor } from '@/types/api';
import { CHANNEL_BRAND } from './im/channel-meta';
import { ImBindingDialog } from './im/ImBindingDialog';
import { ImBotDialog } from './im/ImBotDialog';
import { ImChannelCard } from './im/ImChannelCard';
import { ImQrLoginDialog } from './im/ImQrLoginDialog';

export function ImSettingsSection() {
  const { t } = useTranslation();
  const { status, channels, loadError, refresh } = useIm();
  const [dialogChannel, setDialogChannel] = useState<ImChannelDescriptor | null>(null);
  const [editing, setEditing] = useState<ImBotStatus | null>(null);
  const [bindingBotId, setBindingBotId] = useState<string | null>(null);
  const [deleteBotId, setDeleteBotId] = useState<string | null>(null);
  const [qrChannel, setQrChannel] = useState<ImChannelDescriptor | null>(null);
  const [activeChannelId, setActiveChannelId] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const bots = status?.bots ?? [];
  // 按渠道聚合；默认选中首个已配置机器人的渠道，否则第一个渠道
  const channelBots = channels.map(channel => ({
    channel,
    bots: bots.filter(bot => bot.channel === channel.id),
  }));
  const fallbackChannelId =
    channelBots.find(item => item.bots.length > 0)?.channel.id ?? channels[0]?.id ?? '';
  const activeId = channelBots.some(item => item.channel.id === activeChannelId)
    ? activeChannelId
    : fallbackChannelId;
  const active = channelBots.find(item => item.channel.id === activeId) ?? null;

  const run = async (botId: string, action: () => Promise<unknown>, success: string): Promise<void> => {
    setBusyId(botId);
    try {
      await action();
      toast.success(success);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleAdd = (channel: ImChannelDescriptor, mode: 'qr' | 'manual'): void => {
    if (mode === 'qr') {
      setQrChannel(channel);
      return;
    }
    setEditing(null);
    setDialogChannel(channel);
  };

  const handleQrOpenChange = useCallback((open: boolean): void => {
    if (!open) setQrChannel(null);
  }, []);

  const handleReauth = useCallback((bot: ImBotStatus): void => {
    const channel = channels.find(item => item.id === bot.channel);
    if (!channel?.capabilities.qrLogin) return;
    setQrChannel(channel);
  }, [channels]);

  const handleEdit = (bot: ImBotStatus): void => {
    const channel = channels.find(item => item.id === bot.channel) ?? null;
    if (!channel) return;
    setEditing(bot);
    setDialogChannel(channel);
  };

  const confirmDelete = async (): Promise<void> => {
    const botId = deleteBotId;
    if (!botId) return;
    setDeleteBotId(null);
    await run(botId, () => api.deleteImBot(botId), t('settings.im.deleted'));
  };

  const bindingBot = bots.find(bot => bot.botId === bindingBotId) ?? null;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{t('settings.nav.im')}</h1>
          <p className="text-sm text-muted-foreground">{t('settings.im.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {status ? (
            <Badge variant="secondary" className="font-normal">
              {t('settings.im.totals', {
                connected: status.totals.connected,
                configured: status.totals.configured,
              })}
            </Badge>
          ) : null}
          <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" />
            {t('settings.im.refresh')}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
        {t('settings.im.intro')}
      </div>

      {loadError ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {loadError}
        </div>
      ) : null}

      {!status ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Tabs value={activeId} onValueChange={setActiveChannelId}>
            <TabsList aria-label={t('settings.im.channelNavLabel')}>
              {channelBots.map(({ channel, bots: list }) => {
                const connected = list.filter(bot => bot.state === 'connected').length;
                return (
                  <TabsTrigger key={channel.id} value={channel.id} className="gap-1.5">
                    <BrandIcon name={CHANNEL_BRAND[channel.id]} size={14} colored />
                    <span>{channel.label}</span>
                    {list.length > 0 ? (
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {connected}/{list.length}
                      </span>
                    ) : null}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>

          {active ? (
            <ImChannelCard
              channel={active.channel}
              bots={active.bots}
              busyId={busyId}
              onAdd={handleAdd}
              onToggle={(bot, enabled) =>
                void run(
                  bot.botId,
                  () => (enabled ? api.enableImBot(bot.botId) : api.disableImBot(bot.botId)),
                  enabled ? t('settings.im.enabled') : t('settings.im.disabled'),
                )
              }
              onTest={bot =>
                void run(bot.botId, () => api.testImBot(bot.botId), t('settings.im.testSent'))
              }
              onReauth={handleReauth}
              onReconnect={bot =>
                void run(bot.botId, () => api.reconnectImBot(bot.botId), t('settings.im.reconnected'))
              }
              onEdit={handleEdit}
              onBinding={bot => setBindingBotId(bot.botId)}
              onDelete={bot => setDeleteBotId(bot.botId)}
            />
          ) : null}
        </div>
      )}

      <ImBotDialog
        channel={dialogChannel}
        editing={editing}
        onOpenChange={open => {
          if (!open) {
            setDialogChannel(null);
            setEditing(null);
          }
        }}
        onSaved={refresh}
      />

      <ImBindingDialog
        bot={bindingBot}
        onClose={() => setBindingBotId(null)}
        onChanged={refresh}
      />

      <ImQrLoginDialog
        channel={qrChannel}
        open={qrChannel !== null}
        onOpenChange={handleQrOpenChange}
        onConnected={refresh}
      />

      <AlertDialog open={deleteBotId !== null} onOpenChange={open => !open && setDeleteBotId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.im.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.im.deleteBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 text-white hover:bg-red-600"
              onClick={() => void confirmDelete()}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
