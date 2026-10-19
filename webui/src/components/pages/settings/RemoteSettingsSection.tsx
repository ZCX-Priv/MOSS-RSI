// webui/src/components/pages/settings/RemoteSettingsSection.tsx
// 远程控制设置分区（/settings/remote）：手机扫码远程访问 webui「派活」与控制 agent。
// 区块：总开关（热重绑）→ 局域网（二维码/密码/IP 高级）→ 公网隧道（免责声明/进度/二维码/密码）→ 安全提示。
// 移动端优先布局（触控友好、全宽卡片）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import QRCode from 'qrcode';
import {
  RefreshCw,
  Copy,
  Globe,
  Loader2,
  ShieldAlert,
  Pencil,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { api } from '@/api/http';
import { copyText } from '@/lib/clipboard';
import { useRemote } from '@/hooks/useRemote';
import type { RemoteStatus } from '@/types/api';
import { RebindProgressDialog } from './RebindProgressDialog';

// ============================================================================
// 二维码（URL 变化时重新生成，本地渲染无第三方依赖）
// ============================================================================

function QrImage({ url, size = 200 }: { url: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: size * 2, type: 'image/png' })
      .then(d => {
        if (alive) setDataUrl(d);
      })
      .catch(() => {
        if (alive) setDataUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [url, size]);

  if (!dataUrl) {
    return <div className="flex items-center justify-center text-muted-foreground" style={{ width: size, height: size }}><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }
  return (
    <img
      src={dataUrl}
      alt="QR"
      className="rounded-lg border border-border bg-white p-2"
      style={{ width: size, height: size }}
    />
  );
}

// ============================================================================
// 密码管理行（lan/public 复用）
// ============================================================================

interface PinManagerProps {
  scope: 'lan' | 'public';
  pin: string | null;
  passwordEnabled: boolean;
  /** public 无 disable/enable 操作（公网始终要密码），lan 有 */
  supportsDisable?: boolean;
  customized?: boolean;
  onChanged: () => Promise<void> | void;
}

function PinManager({ scope, pin, passwordEnabled, supportsDisable = false, customized, onChanged }: PinManagerProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remote.operationFailed'));
    } finally {
      setBusy(false);
    }
  };

  const saveCustom = () => {
    if (!/^\d{8}$/.test(value)) {
      toast.error(t('settings.remote.pin.invalid'));
      return;
    }
    void run(async () => {
      // 严格分域：公网密码走隧道接口，局域网密码走局域网接口
      if (scope === 'public') {
        await api.setRemoteTunnelPassword('custom', value);
      } else {
        await api.setRemoteLanPassword('custom', value);
      }
      toast.success(t('settings.remote.pin.customized'));
      setEditing(false);
      setValue('');
    });
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between py-3 border-b border-border/60 last:border-b-0">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{t(`settings.remote.pin.${scope}`)}</span>
          {pin && !editing && (
            <code className="rounded bg-muted px-2 py-0.5 text-base font-mono tracking-[0.3em]">{pin}</code>
          )}
          {customized && <Badge variant="secondary" className="text-[10px]">{t('settings.remote.pin.custom')}</Badge>}
          {supportsDisable && !passwordEnabled && (
            <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/40">
              {t('settings.remote.pin.disabled')}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t(`settings.remote.pin.${scope}Desc`)}</p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {editing ? (
          <>
            <Input
              value={value}
              onChange={e => setValue(e.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="00000000"
              inputMode="numeric"
              className="w-32 font-mono tracking-widest"
              autoFocus
            />
            <Button size="sm" disabled={busy || value.length !== 8} onClick={saveCustom}>
              {t('settings.remote.pin.save')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setValue(''); }}>
              {t('settings.remote.pin.cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(async () => {
                const isPublic = scope === 'public';
                const r = isPublic
                  ? await api.setRemoteTunnelPassword('refresh')
                  : await api.setRemoteLanPassword('refresh');
                toast.success(t('settings.remote.pin.refreshed', { pin: r.pin ?? '' }));
              })}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              {t('settings.remote.pin.refresh')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5 mr-1" />
              {t('settings.remote.pin.customize')}
            </Button>
            {supportsDisable && (
              <Switch
                checked={passwordEnabled}
                disabled={busy}
                onCheckedChange={checked => void run(() => api.setRemoteLanPassword(checked ? 'enable' : 'disable'))}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 主组件
// ============================================================================

export function RemoteSettingsSection() {
  const { t } = useTranslation();
  const { status, passwords, refreshAll } = useRemote();
  const [rebindOpen, setRebindOpen] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [lanBusy, setLanBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const enabled = status?.enabled ?? false;
  const tunnelPhase = status?.tunnel.phase ?? 'idle';

  const lanUrl = status?.lanUrl ?? null;
  const tunnelUrl = status?.tunnelUrl ?? null;

  const tunnelProgress = useMemo((): number => {
    switch (tunnelPhase) {
      case 'downloading': return 25;
      case 'starting': return 55;
      case 'registering': return 80;
      case 'ready': return 100;
      default: return 0;
    }
  }, [tunnelPhase]);

  const copyUrl = useCallback((url: string): void => {
    void copyText(url).then((ok) => {
      if (ok) toast.success(t('settings.remote.copied'));
      else toast.error(t('common.copyManualHint'));
    });
  }, [t]);

  /** 总开关：切换 → 热重绑弹窗（响应发出后后端 300ms 切换绑定）。 */
  const toggleEnabled = useCallback(async (next: boolean): Promise<void> => {
    try {
      const result = next ? await api.enableRemote() : await api.disableRemote();
      if (result.rebound) {
        setRebindOpen(true); // 弹窗轮询 health，完成后自动 reload
      } else {
        await refreshAll();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remote.operationFailed'));
    }
  }, [t, refreshAll]);

  /** 开启公网隧道（免责声明确认后）。 */
  const startTunnel = useCallback(async (): Promise<void> => {
    setDisclaimerOpen(false);
    setTunnelBusy(true);
    try {
      const r = await api.startRemoteTunnel(true);
      toast.success(t('settings.remote.tunnel.started'));
      void r;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remote.tunnel.startFailed'));
    } finally {
      setTunnelBusy(false);
      await refreshAll();
    }
  }, [t, refreshAll]);

  const stopTunnel = useCallback(async (): Promise<void> => {
    setTunnelBusy(true);
    try {
      await api.stopRemoteTunnel();
      toast.success(t('settings.remote.tunnel.stopped'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remote.operationFailed'));
    } finally {
      setTunnelBusy(false);
      await refreshAll();
    }
  }, [t, refreshAll]);

  const setLanEnabled = useCallback(async (next: boolean): Promise<void> => {
    setLanBusy(true);
    try {
      await api.setRemoteLan(next);
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remote.operationFailed'));
    } finally {
      setLanBusy(false);
    }
  }, [t, refreshAll]);

  const setLanIp = useCallback(async (ip: string): Promise<void> => {
    try {
      await api.setRemoteLanIp(ip);
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remote.operationFailed'));
    }
  }, [t, refreshAll]);

  if (!status) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        {t('settings.remote.loading')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* ============ 页头（与其它设置子页统一） ============ */}
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{t('settings.remote.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.remote.desc')}</p>
      </div>

      {/* ============ 总开关 ============ */}
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-foreground">{t('settings.remote.masterSwitch')}</div>
        <div className="text-xs text-muted-foreground">
          {enabled ? t('settings.remote.masterOnDesc') : t('settings.remote.masterOffDesc')}
        </div>
        <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
          <div className="flex items-center justify-between gap-4 py-3">
            {enabled ? (
              <Badge className="border-green-500/30 bg-green-500/15 text-green-600 dark:text-green-400">
                {t('settings.remote.state.on')}
              </Badge>
            ) : (
              <Badge variant="secondary">{t('settings.remote.state.off')}</Badge>
            )}
            <Switch
              checked={enabled}
              onCheckedChange={checked => void toggleEnabled(checked)}
              aria-label={t('settings.remote.masterSwitch')}
            />
          </div>
        </div>
      </div>

      {enabled && (
        <>
          {/* ============ 局域网 ============ */}
          <div className="flex flex-col gap-1">
            <div className="text-sm font-medium text-foreground">{t('settings.remote.lan.title')}</div>
            <div className="text-xs text-muted-foreground">{t('settings.remote.lan.desc')}</div>
            <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
              {/* 局域网开关 */}
              <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm text-foreground">{t('settings.remote.lan.switch')}</span>
                  <span className="text-xs text-muted-foreground">{t('settings.remote.lan.switchDesc')}</span>
                </div>
                <Switch
                  checked={status.lanEnabled}
                  disabled={lanBusy}
                  onCheckedChange={checked => void setLanEnabled(checked)}
                />
              </div>

              {status.lanEnabled && (
                <>
                  {/* 二维码 + URL */}
                  <div className="border-b border-border/60 py-3">
                    {lanUrl ? (
                      <div className="flex flex-col items-center gap-4 rounded-lg border border-border/60 p-4 sm:flex-row sm:items-start">
                        <QrImage url={lanUrl} />
                        <div className="flex-1 min-w-0 space-y-2 text-center sm:text-left">
                          <div className="text-xs text-muted-foreground">{t('settings.remote.lan.scanHint')}</div>
                          <div className="flex items-center justify-center gap-2 flex-wrap sm:justify-start">
                            <code className="rounded bg-muted px-2 py-1 text-sm break-all">{lanUrl}</code>
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copyUrl(lanUrl)}>
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <div className="text-xs text-muted-foreground">{t('settings.remote.lan.sameWifi')}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                        {t('settings.remote.lan.noIp')}
                      </div>
                    )}
                  </div>

                  {/* 密码管理（PinManager 行自带 py-3 分隔） */}
                  <div className="border-b border-border/60 pt-3">
                    <div className="text-sm text-foreground">{t('settings.remote.pin.title')}</div>
                    <PinManager
                      scope="lan"
                      pin={passwords?.lan ?? null}
                      passwordEnabled={status.lanPasswordEnabled}
                      supportsDisable
                      onChanged={refreshAll}
                    />
                  </div>

                  {/* 高级：局域网地址选择 */}
                  <div className="py-3">
                    <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                      <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? '' : '-rotate-90'}`} />
                        {t('settings.remote.lan.advanced')}
                      </CollapsibleTrigger>
                      <CollapsibleContent className="pt-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <span className="shrink-0 text-sm">{t('settings.remote.lan.address')}</span>
                          <Select
                            value={status.lanIpOverride || status.lanIp || ''}
                            onValueChange={v => void setLanIp(v === status.lanIp ? '' : v)}
                          >
                            <SelectTrigger className="w-full sm:w-64">
                              <SelectValue placeholder={t('settings.remote.lan.auto')} />
                            </SelectTrigger>
                            <SelectContent>
                              {status.lanCandidates.map(ip => (
                                <SelectItem key={ip} value={ip}>
                                  {ip}
                                  {ip === status.lanIp ? ` (${t('settings.remote.lan.auto')})` : ''}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <p className="mt-1.5 text-xs text-muted-foreground">{t('settings.remote.lan.advancedDesc')}</p>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ============ 公网 ============ */}
          <div className="flex flex-col gap-1">
            <div className="text-sm font-medium text-foreground">{t('settings.remote.tunnel.title')}</div>
            <div className="text-xs text-muted-foreground">{t('settings.remote.tunnel.desc')}</div>
            <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
              {tunnelPhase === 'idle' && (
                <div className="flex flex-col items-start gap-3 py-3">
                  <Button
                    variant="default"
                    disabled={tunnelBusy}
                    onClick={() => { setDisclaimerChecked(false); setDisclaimerOpen(true); }}
                  >
                    <Globe className="h-4 w-4 mr-2" />
                    {t('settings.remote.tunnel.open')}
                  </Button>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t('settings.remote.tunnel.openHint')}
                  </p>
                </div>
              )}

              {(tunnelPhase === 'downloading' || tunnelPhase === 'starting' || tunnelPhase === 'registering') && (
                <div className="space-y-3 py-3">
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    {t(`settings.remote.tunnel.phase.${tunnelPhase}`)}
                  </div>
                  <Progress value={tunnelProgress} className="h-2" />
                  <p className="text-xs text-muted-foreground">{status.tunnel.detail}</p>
                </div>
              )}

              {tunnelPhase === 'ready' && tunnelUrl && (
                <>
                  <div className="border-b border-border/60 py-3">
                    <div className="flex flex-col items-center gap-4 rounded-lg border border-border/60 p-4 sm:flex-row sm:items-start">
                      <QrImage url={tunnelUrl} />
                      <div className="flex-1 min-w-0 space-y-2 text-center sm:text-left">
                        <div className="text-xs text-muted-foreground">{t('settings.remote.tunnel.scanHint')}</div>
                        <div className="flex items-center justify-center gap-2 flex-wrap sm:justify-start">
                          <code className="rounded bg-muted px-2 py-1 text-sm break-all">{tunnelUrl}</code>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copyUrl(tunnelUrl)}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <div className="text-xs text-muted-foreground">{t('settings.remote.tunnel.anyNetwork')}</div>
                      </div>
                    </div>
                  </div>
                  <div className="border-b border-border/60 pt-3">
                    <PinManager
                      scope="public"
                      pin={passwords?.public ?? null}
                      passwordEnabled
                      customized={status.publicPasswordCustomized}
                      onChanged={refreshAll}
                    />
                  </div>
                  <div className="py-3">
                    <Button variant="outline" size="sm" disabled={tunnelBusy} onClick={() => void stopTunnel()}>
                      {t('settings.remote.tunnel.close')}
                    </Button>
                  </div>
                </>
              )}

              {tunnelPhase === 'error' && (
                <div className="space-y-3 py-3">
                  <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400 break-all">
                    {status.tunnel.detail || t('settings.remote.tunnel.errorGeneric')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="default"
                      size="sm"
                      disabled={tunnelBusy}
                      onClick={() => { setDisclaimerChecked(false); setDisclaimerOpen(true); }}
                    >
                      {t('settings.remote.tunnel.retry')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={tunnelBusy} onClick={() => void stopTunnel()}>
                      {t('settings.remote.tunnel.reset')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ============ 安全提示 ============ */}
          <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <ShieldAlert className="h-5 w-5 shrink-0 text-amber-500" />
            <div className="space-y-1.5 text-xs text-muted-foreground leading-relaxed">
              <div className="text-sm font-medium text-foreground">{t('settings.remote.security.title')}</div>
              <p>{t('settings.remote.security.1')}</p>
              <p>{t('settings.remote.security.2')}</p>
              <p>{t('settings.remote.security.3')}</p>
            </div>
          </div>
        </>
      )}

      {/* ============ 热重绑进度弹窗 ============ */}
      <RebindProgressDialog open={rebindOpen} />

      {/* ============ 公网免责声明 ============ */}
      <AlertDialog open={disclaimerOpen} onOpenChange={setDisclaimerOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.remote.tunnel.disclaimer.title')}</AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">
              {t('settings.remote.tunnel.disclaimer.body')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            <label className="flex items-start gap-2 rounded-md border border-border p-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={disclaimerChecked}
                onChange={e => setDisclaimerChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span className="text-sm">{t('settings.remote.tunnel.disclaimer.confirm')}</span>
            </label>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={tunnelBusy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!disclaimerChecked || tunnelBusy}
              onClick={e => {
                e.preventDefault();
                void startTunnel();
              }}
            >
              {tunnelBusy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {t('settings.remote.tunnel.disclaimer.open')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
