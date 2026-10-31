// webui/src/components/pages/settings/im/ImQrLoginDialog.tsx
// 渠道通用扫码接入弹窗：后端创建扫码会话 → 前端渲染二维码 → 轮询本地状态 → 成功后自动创建并连接机器人。
// 微信支持验证码与扫码重定向；QQ 二维码过期后由后端自动刷新。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import QRCode from 'qrcode';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import type {
  ImChannelDescriptor,
  ImProvisioningSnapshot,
  ImProvisioningStatus,
} from '@/types/api';

interface Props {
  channel: ImChannelDescriptor | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => Promise<void> | void;
}

const TERMINAL = new Set<ImProvisioningStatus>(['connected', 'expired', 'failed', 'cancelled']);

function formatRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function ImQrLoginDialog({ channel, open, onOpenChange, onConnected }: Props) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ImProvisioningSnapshot | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrError, setQrError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const aliveRef = useRef(true);
  const handledRef = useRef(false);

  const channelId = channel?.id ?? null;
  const channelLabel = channel?.label ?? '';

  const reset = useCallback((): void => {
    setSnapshot(null);
    setLoginId(null);
    setQrDataUrl('');
    setQrError(null);
    setStartError(null);
    setVerifyCode('');
    setRemainingMs(null);
    handledRef.current = false;
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (!channelId) return;
    reset();
    setBusy(true);
    try {
      const started = await api.startImProvisioning(channelId);
      if (!aliveRef.current) {
        // 弹窗在请求期间被关闭：清掉服务端刚创建的会话，避免悬挂
        void api.cancelImProvisioning(started.loginId).catch(() => undefined);
        return;
      }
      setSnapshot(started);
      setLoginId(started.loginId);
    } catch (err) {
      if (!aliveRef.current) return;
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [channelId, reset]);

  useEffect(() => {
    aliveRef.current = true;
    if (open) void start();
    else reset();
    return () => {
      aliveRef.current = false;
    };
  }, [open, start, reset]);

  // 二维码链接 → 图片（后端返回原始 URL，编码在前端完成）
  useEffect(() => {
    let alive = true;
    const source = snapshot?.qrUrl ?? '';
    setQrDataUrl('');
    setQrError(null);
    if (!source) return () => {
      alive = false;
    };
    void QRCode.toDataURL(source, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 384,
      type: 'image/png',
    })
      .then(dataUrl => {
        if (alive) setQrDataUrl(dataUrl);
      })
      .catch(err => {
        if (alive) setQrError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [snapshot?.qrUrl]);

  // 本地会话状态轮询：只读后端快照，不在前端阻塞上游长轮询
  useEffect(() => {
    if (!open || !loginId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      try {
        const next = await api.getImProvisioning(loginId);
        if (cancelled || !aliveRef.current) return;
        setStartError(null);
        setSnapshot(next);
        if (next.status === 'connected') {
          if (!handledRef.current) {
            handledRef.current = true;
            toast.success(t('settings.im.qrConnected', { channel: channelLabel }));
            await onConnected();
            onOpenChange(false);
          }
          return;
        }
        if (TERMINAL.has(next.status)) return;
        const interval = Math.min(5_000, Math.max(500, next.pollIntervalMs || 1_000));
        timer = setTimeout(() => void tick(), interval);
      } catch (err) {
        if (cancelled || !aliveRef.current) return;
        setStartError(err instanceof Error ? err.message : String(err));
        timer = setTimeout(() => void tick(), 3_000);
      }
    };

    timer = setTimeout(() => void tick(), 800);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, loginId, channelLabel, onConnected, onOpenChange, t]);

  // 剩余有效期
  useEffect(() => {
    const expiresAt = snapshot?.expiresAt;
    if (!expiresAt || !open) {
      setRemainingMs(null);
      return;
    }
    const update = (): void => setRemainingMs(Math.max(0, expiresAt - Date.now()));
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [open, snapshot?.expiresAt]);

  const cancel = useCallback(async (): Promise<void> => {
    if (loginId && snapshot && !TERMINAL.has(snapshot.status)) {
      await api.cancelImProvisioning(loginId).catch(() => undefined);
    }
    reset();
  }, [loginId, snapshot, reset]);

  const close = useCallback(async (): Promise<void> => {
    await cancel();
    onOpenChange(false);
  }, [cancel, onOpenChange]);

  const restart = useCallback(async (): Promise<void> => {
    if (loginId && snapshot && !TERMINAL.has(snapshot.status)) {
      await api.cancelImProvisioning(loginId).catch(() => undefined);
    }
    await start();
  }, [loginId, snapshot, start]);

  const submitVerifyCode = async (): Promise<void> => {
    if (!loginId) return;
    const code = verifyCode.trim();
    if (!code) return;
    try {
      const next = await api.verifyImProvisioning(loginId, code);
      setSnapshot(next);
      setVerifyCode('');
      toast.success(t('settings.im.qrCodeSaved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (!open || !channel) return null;

  const status: ImProvisioningStatus = snapshot?.status ?? (startError ? 'failed' : 'starting');
  const error = snapshot?.error ?? startError;
  const message = snapshot?.message;
  const showQr = Boolean(qrDataUrl) && status !== 'refreshing' && !TERMINAL.has(status);
  const showVerify = status === 'needs_verification';
  const showCountdown = remainingMs !== null && remainingMs > 0
    && (status === 'pending' || status === 'scanned' || status === 'needs_verification');

  const statusText = (): string => {
    if (status === 'starting') return t('settings.im.qrPreparing');
    if (status === 'pending') return t('settings.im.qrWaiting');
    if (status === 'scanned') return t('settings.im.qrScanned');
    if (status === 'needs_verification') return t('settings.im.qrNeedCode');
    if (status === 'refreshing') return t('settings.im.qrRefreshing');
    if (status === 'connecting') return t('settings.im.qrConnecting');
    if (status === 'connected') return t('settings.im.qrConnectedShort');
    if (status === 'expired') return t('settings.im.qrExpired');
    if (status === 'failed') return error || t('settings.im.qrFailed');
    return t('settings.im.qrCancelled');
  };

  const placeholder = (): string => {
    if (status === 'refreshing') return t('settings.im.qrRefreshing');
    if (status === 'expired') return t('settings.im.qrExpired');
    if (status === 'failed' || status === 'cancelled') return t('settings.im.qrFailed');
    if (qrError) return t('settings.im.qrQrFailed');
    return t('settings.im.qrPreparing');
  };

  return (
    <Dialog open onOpenChange={value => !value && void close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.im.qrTitle', { channel: channel.label })}</DialogTitle>
          <DialogDescription>{t('settings.im.qrDesc')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col items-center gap-3">
            {busy || !showQr ? (
              <div className="flex size-48 items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-xs text-muted-foreground">
                {busy || status === 'starting' || status === 'refreshing' ? (
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                ) : (
                  placeholder()
                )}
              </div>
            ) : (
              <img
                src={qrDataUrl}
                alt={t('settings.im.qrTitle', { channel: channel.label })}
                className="size-48 rounded-lg border border-border bg-white p-2"
              />
            )}

            <div className="text-sm text-foreground">{statusText()}</div>
            {message && message !== error ? (
              <div className="text-xs text-muted-foreground">{message}</div>
            ) : null}
            {error ? <div className="text-xs text-red-600 dark:text-red-400">{error}</div> : null}
            {showCountdown ? (
              <div className="text-xs text-muted-foreground">
                {t('settings.im.qrValidFor', { time: formatRemaining(remainingMs ?? 0) })}
              </div>
            ) : null}
            {snapshot?.qrUrl ? (
              <a
                href={snapshot.qrUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground underline"
              >
                {t('settings.im.qrFallbackLink')}
              </a>
            ) : null}

            {showVerify ? (
              <div className="flex w-full flex-col gap-1.5">
                <Label htmlFor="im-qr-verify">{t('settings.im.qrVerifyCode')}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="im-qr-verify"
                    value={verifyCode}
                    onChange={event => setVerifyCode(event.target.value)}
                    inputMode="numeric"
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    disabled={!verifyCode.trim()}
                    onClick={() => void submitVerifyCode()}
                  >
                    {t('common.save')}
                  </Button>
                </div>
              </div>
            ) : null}

            {status === 'expired' || status === 'failed' ? (
              <div className="text-center text-xs leading-relaxed text-muted-foreground">
                {t('settings.im.qrExpiredHint')}
              </div>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => void close()}>
            {t('common.cancel')}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void restart()} disabled={busy}>
            <RefreshCw className="size-3.5" />
            {t('settings.im.qrRefresh')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
