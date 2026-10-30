// webui/src/components/pages/settings/im/ImBindingDialog.tsx
// 配对码 + 已绑定用户管理：用户需在 IM 私聊里发送 /bind <配对码> 才能使用机器人。

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Copy, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/api/http';
import { copyText } from '@/lib/clipboard';
import type { ImBotStatus } from '@/types/api';

interface Props {
  bot: ImBotStatus | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}

export function ImBindingDialog({ bot, onClose, onChanged }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  if (!bot) return null;

  const rotate = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.rotateImPairing(bot.botId);
      toast.success(t('settings.im.pairingRotated'));
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const unbind = async (userId: string): Promise<void> => {
    setBusy(true);
    try {
      await api.unbindImUser(bot.botId, userId);
      toast.success(t('settings.im.unbound'));
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={value => !busy && !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.im.pairingTitle')}</DialogTitle>
          <DialogDescription>{t('settings.im.pairingDesc')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <code className="rounded bg-muted px-3 py-1.5 text-2xl font-mono tracking-[0.35em]">
                {bot.pairingCode || '------'}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                title={t('settings.im.copy')}
                onClick={() => {
                  void copyText(bot.pairingCode).then(() => toast.success(t('settings.im.copied')));
                }}
              >
                <Copy className="size-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                disabled={busy}
                onClick={() => void rotate()}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                {t('settings.im.pairingRotate')}
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium text-foreground">{t('settings.im.boundUsers')}</div>
              {bot.boundUsers.length === 0 ? (
                <div className="text-xs text-muted-foreground">{t('settings.im.noBoundUsers')}</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {bot.boundUsers.map(user => (
                    <div
                      key={user.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-xs text-foreground">{user.name || user.id}</span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">{user.id}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                        title={t('settings.im.unbind')}
                        disabled={busy}
                        onClick={() => void unbind(user.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
