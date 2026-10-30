// webui/src/components/pages/settings/ComputerSettingsSection.tsx
// 电脑控制设置页：cua-driver 状态 / 安装 / 暂停 / 重连 + computer 工具参数。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertCircle,
  Download,
  Loader2,
  Pause,
  Play,
  PlugZap,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/api/http';
import { useTools } from '@/hooks/useTools';
import type { ComputerConnectionState, ComputerStatus } from '@/types/api';
import { Row, Section } from './browser-shared';

const POLL_MS = 5000;

const COMPUTER_DEFAULTS = {
  enabled: true,
  requireConfirmation: true,
  timeout: 120_000,
  maxImageDimension: 1280,
  maxTreeElements: 250,
  allowForeground: true,
};

function connectionVariant(
  state: ComputerConnectionState,
): 'default' | 'secondary' | 'destructive' {
  if (state === 'connected') return 'default';
  if (state === 'error') return 'destructive';
  return 'secondary';
}

type NumberKey = 'timeout' | 'maxImageDimension' | 'maxTreeElements';
type BooleanKey = 'enabled' | 'requireConfirmation' | 'allowForeground';

function readNumber(
  values: Record<string, unknown>,
  key: NumberKey,
  fallback: number,
): number {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(
  values: Record<string, unknown>,
  key: BooleanKey,
  fallback: boolean,
): boolean {
  const value = values[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function ComputerSettingsSection() {
  const { t } = useTranslation();
  const { tools, saveToolConfig } = useTools();
  const computerTool = tools.find((tool) => tool.name === 'computer');
  const values = computerTool?.configValues ?? {};

  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getComputerStatus();
      if (!mountedRef.current) return;
      setStatus(next);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const saveConfig = useCallback(
    (patch: Record<string, unknown>) => {
      void saveToolConfig('computer', patch).catch(() => undefined);
    },
    [saveToolConfig],
  );

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, successKey: string) => {
      setBusy(key);
      try {
        await action();
        toast.success(t(successKey));
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [refresh, t],
  );

  const install = useCallback(async () => {
    setBusy('install');
    try {
      const result = await api.installComputerDriver();
      if (result.ok) toast.success(t('settings.computer.installDone'));
      else toast.error(result.output || t('settings.computer.installFailed'));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [refresh, t]);

  const enabled = readBoolean(values, 'enabled', COMPUTER_DEFAULTS.enabled);
  const requireConfirmation = readBoolean(
    values,
    'requireConfirmation',
    COMPUTER_DEFAULTS.requireConfirmation,
  );
  const allowForeground = readBoolean(
    values,
    'allowForeground',
    COMPUTER_DEFAULTS.allowForeground,
  );
  const timeout = readNumber(values, 'timeout', COMPUTER_DEFAULTS.timeout);
  const maxImageDimension = readNumber(
    values,
    'maxImageDimension',
    COMPUTER_DEFAULTS.maxImageDimension,
  );
  const maxTreeElements = readNumber(values, 'maxTreeElements', COMPUTER_DEFAULTS.maxTreeElements);

  const [timeoutDraft, setTimeoutDraft] = useState(String(timeout));
  const [imageDraft, setImageDraft] = useState(String(maxImageDimension));
  const [treeDraft, setTreeDraft] = useState(String(maxTreeElements));

  useEffect(() => {
    setTimeoutDraft(String(timeout));
  }, [timeout]);

  useEffect(() => {
    setImageDraft(String(maxImageDimension));
  }, [maxImageDimension]);

  useEffect(() => {
    setTreeDraft(String(maxTreeElements));
  }, [maxTreeElements]);

  const commitNumber = (
    raw: string,
    current: number,
    min: number,
    max: number,
    key: 'timeout' | 'maxImageDimension' | 'maxTreeElements',
    reset: (value: number) => void,
  ) => {
    const parsed = Math.round(Number(raw));
    if (!Number.isFinite(parsed)) {
      reset(current);
      return;
    }
    const next = Math.max(min, Math.min(max, parsed));
    reset(next);
    if (next === current) return;
    saveConfig({ [key]: next });
  };

  const installDisabled = status?.installed === true || busy === 'install';
  const paused = status?.paused === true;

  return (
    <div className="flex min-w-0 flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{t('settings.computer.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('settings.computer.subtitle')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          {t('settings.computer.refresh')}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-all">{error}</span>
        </div>
      )}

      {!status && loading ? (
        <div className="flex items-center justify-center p-10 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('settings.computer.loading')}
        </div>
      ) : null}

      {status && (
        <>
          <Section title={t('settings.computer.statusTitle')} desc={t('settings.computer.statusDesc')}>
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.computer.connection')}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`settings.computer.connectionState.${status.connection}`)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={connectionVariant(status.connection)}>
                  {paused ? t('settings.computer.pausedBadge') : t('settings.computer.activeBadge')}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={installDisabled}
                  onClick={() => void install()}
                >
                  {busy === 'install' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {status.installed
                    ? t('settings.computer.installed')
                    : t('settings.computer.install')}
                </Button>
                {paused ? (
                  <Button
                    size="sm"
                    disabled={busy === 'resume'}
                    onClick={() =>
                      void run(
                        'resume',
                        () => api.controlComputer('resume'),
                        'settings.computer.resumed',
                      )
                    }
                  >
                    {busy === 'resume' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {t('settings.computer.resume')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === 'pause'}
                    onClick={() =>
                      void run(
                        'pause',
                        () => api.controlComputer('pause'),
                        'settings.computer.pauseDone',
                      )
                    }
                  >
                    {busy === 'pause' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Pause className="h-4 w-4" />
                    )}
                    {t('settings.computer.pause')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!status.installed || busy === 'reconnect'}
                  onClick={() =>
                    void run(
                      'reconnect',
                      () => api.controlComputer('reconnect'),
                      'settings.computer.reconnected',
                    )
                  }
                >
                  {busy === 'reconnect' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <PlugZap className="h-4 w-4" />
                  )}
                  {t('settings.computer.reconnect')}
                </Button>
              </div>
            </Row>
            <Row last>
              <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                <span className="break-all">
                  {t('settings.computer.driverPath')}:{' '}
                  <code className="text-foreground">{status.driverPath ?? '—'}</code>
                </span>
                <span>
                  {t('settings.computer.version')}:{' '}
                  <span className="text-foreground">{status.version ?? '—'}</span>
                </span>
                <span>
                  {t('settings.computer.toolCount')}:{' '}
                  <span className="text-foreground">{status.toolCount}</span>
                </span>
                <span>
                  {t('settings.computer.screen')}:{' '}
                  <span className="text-foreground">
                    {status.screen ? `${status.screen.width}×${status.screen.height}` : '—'}
                  </span>
                </span>
                {status.error && <span className="break-all text-destructive">{status.error}</span>}
              </div>
            </Row>
          </Section>

          <Section title={t('settings.computer.paramsTitle')} desc={t('settings.computer.paramsDesc')}>
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.computer.enabled')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.computer.enabledDesc')}
                </span>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={(checked) => saveConfig({ enabled: checked })}
                aria-label={t('settings.computer.enabled')}
              />
            </Row>
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">
                  {t('settings.computer.requireConfirmation')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.computer.requireConfirmationDesc')}
                </span>
              </div>
              <Switch
                checked={requireConfirmation}
                onCheckedChange={(checked) => saveConfig({ requireConfirmation: checked })}
                aria-label={t('settings.computer.requireConfirmation')}
              />
            </Row>
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.computer.allowForeground')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.computer.allowForegroundDesc')}
                </span>
              </div>
              <Switch
                checked={allowForeground}
                onCheckedChange={(checked) => saveConfig({ allowForeground: checked })}
                aria-label={t('settings.computer.allowForeground')}
              />
            </Row>
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.computer.timeout')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.computer.timeoutDesc')}
                </span>
              </div>
              <Input
                type="number"
                min={5000}
                max={300000}
                step={1000}
                value={timeoutDraft}
                onChange={(event) => setTimeoutDraft(event.target.value)}
                onBlur={() =>
                  commitNumber(timeoutDraft, timeout, 5000, 300000, 'timeout', (value) =>
                    setTimeoutDraft(String(value)),
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className="h-8 w-28 shrink-0 text-right"
              />
            </Row>
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">
                  {t('settings.computer.maxImageDimension')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.computer.maxImageDimensionDesc')}
                </span>
              </div>
              <Input
                type="number"
                min={0}
                max={4096}
                value={imageDraft}
                onChange={(event) => setImageDraft(event.target.value)}
                onBlur={() =>
                  commitNumber(imageDraft, maxImageDimension, 0, 4096, 'maxImageDimension', (value) =>
                    setImageDraft(String(value)),
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className="h-8 w-24 shrink-0 text-right"
              />
            </Row>
            <Row last>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.computer.maxTreeElements')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.computer.maxTreeElementsDesc')}
                </span>
              </div>
              <Input
                type="number"
                min={10}
                max={2000}
                value={treeDraft}
                onChange={(event) => setTreeDraft(event.target.value)}
                onBlur={() =>
                  commitNumber(treeDraft, maxTreeElements, 10, 2000, 'maxTreeElements', (value) =>
                    setTreeDraft(String(value)),
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className="h-8 w-24 shrink-0 text-right"
              />
            </Row>
          </Section>

          <p className="text-xs text-muted-foreground">{t('settings.computer.hint')}</p>
        </>
      )}
    </div>
  );
}
