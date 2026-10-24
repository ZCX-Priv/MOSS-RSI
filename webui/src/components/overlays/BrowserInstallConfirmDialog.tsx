// webui/src/components/overlays/BrowserInstallConfirmDialog.tsx
// 浏览器扩展安装失败后的全局确认弹窗：轮询状态，用户确认后才重新触发安装。
// 启动阶段不会自动安装，因此 checked=false 时本弹窗不会出现。
// 「稍后」只在当前浏览器会话内隐藏，避免每次轮询都打断用户。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppWindow, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/http';
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
import type { BrowserInstallerBrowser, BrowserStatus } from '@/types/api';

const POLL_MS = 10_000;
const SNOOZE_KEY = 'moss-browser-install-snooze';

function failedBrowsers(status: BrowserStatus | null): BrowserInstallerBrowser[] {
  if (!status || !status.installer.checked || status.installer.running) {
    return [];
  }
  return status.installer.browsers.filter(
    (browser) => browser.state === 'manual' || browser.state === 'failed',
  );
}

function isSnoozed(): boolean {
  try {
    return sessionStorage.getItem(SNOOZE_KEY) === '1';
  } catch {
    return false;
  }
}

export function BrowserInstallConfirmDialog() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getBrowserStatus();
      if (!mountedRef.current) return;
      setStatus(next);
      if (failedBrowsers(next).length === 0) {
        setOpen(false);
        return;
      }
      if (!isSnoozed()) setOpen(true);
    } catch {
      // 浏览器服务未就绪时静默，等待下次轮询
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const confirm = useCallback(async () => {
    setBusy(true);
    try {
      await api.runBrowserInstaller();
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [refresh]);

  const snooze = useCallback(() => {
    try {
      sessionStorage.setItem(SNOOZE_KEY, '1');
    } catch {
      // 隐私模式等场景忽略
    }
    setOpen(false);
  }, []);

  const failed = failedBrowsers(status);
  const names = failed.map((browser) => browser.name).join(' / ');

  return (
    <Dialog
      open={open && failed.length > 0}
      onOpenChange={(next) => {
        if (!next) snooze();
      }}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AppWindow className="size-4" />
            {t('settings.browser.installConfirmTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('settings.browser.installConfirmDesc', { names })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-2">
            {failed.map((browser) => (
              <div key={browser.id} className="rounded-md border border-border p-2">
                <div className="text-sm text-foreground">{browser.name}</div>
                {browser.detail && (
                  <div className="mt-1 break-all text-xs text-muted-foreground">
                    {browser.detail}
                  </div>
                )}
              </div>
            ))}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={snooze} disabled={busy}>
            {t('settings.browser.installConfirmSnooze')}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <AppWindow className="h-4 w-4" />
            )}
            {t('settings.browser.installConfirmAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
