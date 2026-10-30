// webui/src/components/pages/settings/im/ImWechatLoginDialog.tsx
// 微信 iLink 扫码登录：服务端申请二维码 → 前端展示 → 2s 轮询状态 → 确认后自动创建机器人。

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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => Promise<void> | void;
}

const TERMINAL = new Set(['confirmed', 'expired']);

export function ImWechatLoginDialog({ open, onOpenChange, onConnected }: Props) {
  const { t } = useTranslation();
  const [loginId, setLoginId] = useState<string | null>(null);
  /** iLink 返回的是登录链接（liteapp.weixin.qq.com/...），需要前端编码成二维码 */
  const [qrUrl, setQrUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrError, setQrError] = useState<string | null>(null);
  const [status, setStatus] = useState('wait');
  const [message, setMessage] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);

  const start = useCallback(async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    setStatus('wait');
    setQrUrl('');
    setQrDataUrl('');
    setQrError(null);
    try {
      const response = await api.startWechatLogin();
      setLoginId(response.loginId);
      setQrUrl(response.qrUrl);
    } catch (err) {
      setStatus('expired');
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    if (open) void start();
    return () => {
      aliveRef.current = false;
    };
  }, [open, start]);

  // 登录链接 → 二维码图片（iLink 不提供图片，只给链接）
  useEffect(() => {
    let alive = true;
    setQrDataUrl('');
    setQrError(null);
    if (!qrUrl) return () => {
      alive = false;
    };
    void QRCode.toDataURL(qrUrl, {
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
  }, [qrUrl]);

  useEffect(() => {
    if (!open || !loginId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const result = await api.pollWechatLogin(loginId);
        if (cancelled || !aliveRef.current) return;
        setStatus(result.status);
        setMessage(result.message ?? null);
        if (result.status === 'confirmed' && result.bot) {
          toast.success(t('settings.im.wechatConnected'));
          await onConnected();
          onOpenChange(false);
          return;
        }
        if (TERMINAL.has(result.status)) return;
        timer = setTimeout(() => void poll(), 2000);
      } catch (err) {
        if (cancelled) return;
        setMessage(err instanceof Error ? err.message : String(err));
        timer = setTimeout(() => void poll(), 2000);
      }
    };

    timer = setTimeout(() => void poll(), 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, loginId, onConnected, onOpenChange, t]);

  const cancel = async (): Promise<void> => {
    if (loginId) await api.cancelWechatLogin(loginId).catch(() => undefined);
    setLoginId(null);
    setQrUrl('');
    setQrDataUrl('');
    setQrError(null);
    onOpenChange(false);
  };

  const statusText = (): string => {
    if (status === 'scaned') return t('settings.im.wechatScanned');
    if (status === 'need_verifycode') return t('settings.im.wechatNeedCode');
    if (status === 'expired') return t('settings.im.wechatExpired');
    if (status === 'confirmed') return t('settings.im.wechatConfirmed');
    return t('settings.im.wechatWait');
  };

  return (
    <Dialog open={open} onOpenChange={value => !value && void cancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.im.wechatTitle')}</DialogTitle>
          <DialogDescription>{t('settings.im.wechatDesc')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col items-center gap-3">
            {busy ? (
              <div className="flex size-48 items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : qrDataUrl && status !== 'expired' ? (
              <img
                src={qrDataUrl}
                alt="WeChat QR"
                className="size-48 rounded-lg border border-border bg-white p-2"
              />
            ) : (
              <div className="flex size-48 items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-xs text-muted-foreground">
                {qrError
                  ? t('settings.im.wechatQrFailed')
                  : qrUrl
                    ? t('settings.im.wechatQrPreparing')
                    : t('settings.im.wechatExpired')}
              </div>
            )}
            <div className="text-sm text-foreground">{statusText()}</div>
            {message ? <div className="text-xs text-muted-foreground">{message}</div> : null}
            {qrUrl ? (
              <a
                href={qrUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground underline"
              >
                {t('settings.im.wechatFallbackLink')}
              </a>
            ) : null}

            {status === 'need_verifycode' ? (
              <div className="flex w-full flex-col gap-1.5">
                <Label htmlFor="wechat-verify">{t('settings.im.wechatVerifyCode')}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="wechat-verify"
                    value={verifyCode}
                    onChange={event => setVerifyCode(event.target.value)}
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    disabled={!verifyCode.trim() || !loginId}
                    onClick={() => {
                      if (!loginId) return;
                      void api.verifyWechatLogin(loginId, verifyCode.trim()).then(
                        () => toast.success(t('settings.im.wechatCodeSaved')),
                        err => toast.error(err instanceof Error ? err.message : String(err)),
                      );
                    }}
                  >
                    {t('common.save')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => void cancel()}>
            {t('common.cancel')}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void start()} disabled={busy}>
            <RefreshCw className="size-3.5" />
            {t('settings.im.wechatRefresh')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
