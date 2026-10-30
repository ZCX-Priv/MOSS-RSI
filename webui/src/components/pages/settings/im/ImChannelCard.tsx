// webui/src/components/pages/settings/im/ImChannelCard.tsx
// 渠道卡片：渠道图标/名称/机器人数 + 接入指引 + 机器人列表 + 添加按钮。

import { useTranslation } from 'react-i18next';
import { Plus, QrCode } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { BrandIcon } from '@/lib/brand-icons';
import type { ImBotStatus, ImChannelDescriptor } from '@/types/api';
import { CHANNEL_BRAND } from './channel-meta';
import { ImBotRow } from './ImBotRow';

interface Props {
  channel: ImChannelDescriptor;
  bots: ImBotStatus[];
  busyId: string | null;
  onAdd: (channel: ImChannelDescriptor, mode: 'qr' | 'manual') => void;
  onToggle: (bot: ImBotStatus, enabled: boolean) => void;
  onTest: (bot: ImBotStatus) => void;
  onReconnect: (bot: ImBotStatus) => void;
  onEdit: (bot: ImBotStatus) => void;
  onBinding: (bot: ImBotStatus) => void;
  onDelete: (bot: ImBotStatus) => void;
}

export function ImChannelCard({
  channel,
  bots,
  busyId,
  onAdd,
  onToggle,
  onTest,
  onReconnect,
  onEdit,
  onBinding,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const brand = CHANNEL_BRAND[channel.id];
  const connected = bots.filter(bot => bot.state === 'connected').length;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <BrandIcon name={brand} size={18} colored />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{channel.label}</span>
            {bots.length > 0 ? (
              <Badge variant="secondary" className="px-1.5 text-[10px] font-normal">
                {t('settings.im.channelCount', { connected, total: bots.length })}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{channel.guide}</p>
        </div>
      </div>

      {bots.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-4 text-center text-xs text-muted-foreground">
          {t('settings.im.noBots')}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {bots.map(bot => (
            <ImBotRow
              key={bot.botId}
              bot={bot}
              busy={busyId === bot.botId}
              onToggle={onToggle}
              onTest={onTest}
              onReconnect={onReconnect}
              onEdit={onEdit}
              onBinding={onBinding}
              onDelete={onDelete}
              editable={!channel.capabilities.qrOnly}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {channel.capabilities.qrLogin ? (
          <Button variant="outline" size="sm" className="w-fit gap-1.5" onClick={() => onAdd(channel, 'qr')}>
            <QrCode className="size-3.5" />
            {t('settings.im.qrAdd')}
          </Button>
        ) : null}
        {!channel.capabilities.qrOnly ? (
          <Button
            variant={channel.capabilities.qrLogin ? 'ghost' : 'outline'}
            size="sm"
            className="w-fit gap-1.5"
            onClick={() => onAdd(channel, 'manual')}
          >
            <Plus className="size-3.5" />
            {channel.capabilities.qrLogin ? t('settings.im.manualAdd') : t('settings.im.addBot')}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
