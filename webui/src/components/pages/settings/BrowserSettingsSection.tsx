// webui/src/components/pages/settings/BrowserSettingsSection.tsx
// 浏览器设置分区（/settings/browser）：自动安装 / 桥接 / 实例 / 扩展目录 / 内置 Chrome / CfT / AI 标签页。
// 布局与 RemoteSettingsSection 一致：根节点 p-6、gap-6、分区标题 + 边框容器。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertCircle,
  AppWindow,
  Copy,
  Download,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { api } from '@/api/http';
import { copyText } from '@/lib/clipboard';
import type { BrowserInstallerState, BrowserStatus } from '@/types/api';

const POLL_MS = 5000;

function formatClock(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '—';
  }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function installerBadgeVariant(state: BrowserInstallerState): 'default' | 'secondary' | 'destructive' {
  if (state === 'installed' || state === 'already' || state === 'reloaded') return 'default';
  if (state === 'failed') return 'destructive';
  return 'secondary';
}

function Section({
  title,
  desc,
  action,
  children,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {action}
      </div>
      {desc && <div className="text-xs text-muted-foreground">{desc}</div>}
      <div className="mt-2 flex min-w-0 flex-col rounded-lg border border-border px-4">{children}</div>
    </section>
  );
}

function Row({ children, last = false }: { children: ReactNode; last?: boolean }) {
  return (
    <div
      className={
        last
          ? 'flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between'
          : 'flex min-w-0 flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between'
      }
    >
      {children}
    </div>
  );
}

export function BrowserSettingsSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
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

  const copyPath = useCallback(async () => {
    if (!status) return;
    const ok = await copyText(status.extension.dir);
    if (ok) toast.success(t('settings.browser.copied'));
    else toast.error(t('settings.browser.copyFailed'));
  }, [status, t]);

  const sourceLabel = useMemo(() => {
    const source = status?.builtin.source;
    if (source === 'chrome-for-testing') return t('settings.browser.sourceCft');
    if (source === 'config') return t('settings.browser.sourceConfig');
    if (source === 'local') return t('settings.browser.sourceLocal');
    return '—';
  }, [status?.builtin.source, t]);

  const bridgeRunning = status?.bridge.running === true;
  const builtinRunning = status?.builtin.running === true;
  const cft = status?.cft;
  const installer = status?.installer;

  return (
    <div className="flex min-w-0 flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <AppWindow className="size-5 shrink-0" />
            {t('settings.browser.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('settings.browser.subtitle')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          {t('settings.browser.refresh')}
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
          {t('settings.browser.loading')}
        </div>
      ) : null}

      {status && (
        <>
          <Section
            title={t('settings.browser.installerTitle')}
            desc={t('settings.browser.installerDesc')}
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={installer?.running === true || busy === 'installer'}
                onClick={() =>
                  void run('installer', () => api.runBrowserInstaller(), 'settings.browser.installerStarted')
                }
              >
                {installer?.running || busy === 'installer' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {t('settings.browser.installerRun')}
              </Button>
            }
          >
            {!installer || installer.browsers.length === 0 ? (
              <Row last>
                <span className="text-sm text-muted-foreground">{t('settings.browser.installerNone')}</span>
              </Row>
            ) : (
              installer.browsers.map((browser, index) => (
                <Row key={browser.id} last={index === installer.browsers.length - 1}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm text-foreground">{browser.name}</span>
                    <span className="break-all font-mono text-xs text-muted-foreground">
                      {browser.executable}
                    </span>
                    {browser.detail && (
                      <span className="break-all text-xs text-muted-foreground">{browser.detail}</span>
                    )}
                  </div>
                  <Badge variant={installerBadgeVariant(browser.state)}>
                    {t(`settings.browser.installerState.${browser.state}`)}
                  </Badge>
                </Row>
              ))
            )}
            {installer?.running && installer.current && (
              <Row last>
                <span className="text-xs text-muted-foreground">
                  {t('settings.browser.installerRunning', { name: installer.current })}
                </span>
              </Row>
            )}
          </Section>

          <Section title={t('settings.browser.bridgeTitle')} desc={t('settings.browser.bridgeDesc')}>
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.browser.bridgeStatus')}</span>
                <span className="text-xs text-muted-foreground">
                  {bridgeRunning
                    ? t('settings.browser.bridgeRunning')
                    : t('settings.browser.bridgeStopped')}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t('settings.browser.bridgePort')}:{' '}
                  <code className="text-foreground">{status.bridge.port ?? '—'}</code>
                </span>
                <span>
                  {t('settings.browser.bridgeToken')}:{' '}
                  {status.bridge.tokenConfigured
                    ? t('settings.browser.bridgeTokenOn')
                    : t('settings.browser.bridgeTokenOff')}
                </span>
              </div>
            </Row>
            {(status.bridge.error ||
              (status.bridge.running &&
                status.bridge.port !== null &&
                status.bridge.port !== status.bridge.configuredPort)) && (
              <Row last>
                <span className="break-all text-xs text-amber-600 dark:text-amber-400">
                  {status.bridge.error ??
                    t('settings.browser.bridgePortMismatch', {
                      configured: status.bridge.configuredPort,
                      actual: status.bridge.port,
                    })}
                </span>
              </Row>
            )}
          </Section>

          <Section title={t('settings.browser.instancesTitle')} desc={t('settings.browser.instancesDesc')}>
            {status.instances.length === 0 ? (
              <Row last>
                <span className="text-sm text-muted-foreground">{t('settings.browser.noInstances')}</span>
              </Row>
            ) : (
              status.instances.map((instance, index) => (
                <Row key={instance.id} last={index === status.instances.length - 1}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm text-foreground">
                      {instance.browserName} {instance.browserVersion}
                    </span>
                    <span className="break-all text-xs text-muted-foreground">
                      {t('settings.browser.instanceMeta', {
                        tabs: instance.tabCount,
                        time: formatClock(instance.connectedAt),
                        id: instance.id.slice(0, 8),
                      })}
                    </span>
                  </div>
                  <Badge variant={instance.kind === 'builtin' ? 'default' : 'secondary'}>
                    {instance.kind === 'builtin'
                      ? t('settings.browser.kindBuiltin')
                      : t('settings.browser.kindExternal')}
                  </Badge>
                </Row>
              ))
            )}
          </Section>

          <Section title={t('settings.browser.extensionTitle')} desc={t('settings.browser.extensionDesc')}>
            <Row>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {t('settings.browser.extensionPath')}
                </span>
                <code className="break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">
                  {status.extension.dir}
                </code>
                <span className="text-xs text-muted-foreground">
                  {status.extension.seeded
                    ? t('settings.browser.extensionVersion', { version: status.extension.version ?? '—' })
                    : t('settings.browser.extensionNotSeeded')}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === 'open-dir'}
                  onClick={() =>
                    void run('open-dir', () => api.openBrowserExtensionDir(), 'settings.browser.folderOpened')
                  }
                >
                  {busy === 'open-dir' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FolderOpen className="h-4 w-4" />
                  )}
                  {t('settings.browser.openFolder')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void copyPath()}>
                  <Copy className="h-4 w-4" />
                  {t('settings.browser.copyPath')}
                </Button>
              </div>
            </Row>
            <Row last>
              <details className="min-w-0 text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  {t('settings.browser.manualInstallTitle')}
                </summary>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                  <li>{t('settings.browser.step1')}</li>
                  <li>{t('settings.browser.step2')}</li>
                  <li>{t('settings.browser.step3')}</li>
                  <li>{t('settings.browser.step4')}</li>
                  <li>{t('settings.browser.step5')}</li>
                </ol>
                <p className="mt-2 text-xs text-muted-foreground">{t('settings.browser.chromiumOnly')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('settings.browser.popupHint')}</p>
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {t('settings.browser.permissionNote')}
                </p>
              </details>
            </Row>
          </Section>

          <Section title={t('settings.browser.builtinTitle')} desc={t('settings.browser.builtinDesc')}>
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.browser.builtinStatus')}</span>
                <span className="text-xs text-muted-foreground">
                  {builtinRunning
                    ? t('settings.browser.builtinRunning')
                    : t('settings.browser.builtinStopped')}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={builtinRunning || busy === 'builtin-launch'}
                  onClick={() =>
                    void run('builtin-launch', () => api.controlBrowserBuiltin('launch'), 'settings.browser.builtinLaunched')
                  }
                >
                  {busy === 'builtin-launch' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  {t('settings.browser.launch')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!builtinRunning || busy === 'builtin-close'}
                  onClick={() =>
                    void run('builtin-close', () => api.controlBrowserBuiltin('close'), 'settings.browser.builtinClosed')
                  }
                >
                  {busy === 'builtin-close' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                  {t('settings.browser.close')}
                </Button>
              </div>
            </Row>
            <Row>
              <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                <span>
                  {t('settings.browser.builtinSource')}:{' '}
                  <span className="text-foreground">{sourceLabel}</span>
                </span>
                <span className="break-all">
                  {t('settings.browser.builtinExecutable')}:{' '}
                  <code className="text-foreground">{status.builtin.executable ?? '—'}</code>
                </span>
                <span>
                  {t('settings.browser.builtinVersion')}:{' '}
                  <span className="text-foreground">{status.builtin.version ?? '—'}</span>
                </span>
                <span className="break-all">
                  {t('settings.browser.builtinProfile')}:{' '}
                  <code className="text-foreground">{status.builtin.profileDir}</code>
                </span>
                <span>
                  {t('settings.browser.builtinExtension')}:{' '}
                  <span
                    className={
                      status.builtin.extensionLoaded
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }
                  >
                    {status.builtin.extensionLoaded
                      ? t('settings.browser.builtinExtLoaded')
                      : t('settings.browser.builtinExtMissing')}
                  </span>
                </span>
                {status.builtin.error && (
                  <span className="break-all text-destructive">{status.builtin.error}</span>
                )}
              </div>
            </Row>
            <Row last>
              <span className="text-xs text-muted-foreground">{t('settings.browser.builtinHint')}</span>
            </Row>
          </Section>

          <Section title={t('settings.browser.cftTitle')} desc={t('settings.browser.cftDesc')}>
            <Row>
              <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                <span>
                  {cft?.installed
                    ? t('settings.browser.cftInstalled', { build: cft.buildId ?? '—' })
                    : t('settings.browser.cftNotInstalled')}
                </span>
                {cft?.executable && (
                  <code className="break-all text-foreground">{cft.executable}</code>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={cft?.downloading === true || busy === 'cft-download'}
                onClick={() =>
                  void run('cft-download', () => api.downloadChromeForTesting(), 'settings.browser.cftDownloadStarted')
                }
              >
                {cft?.downloading || busy === 'cft-download' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {t('settings.browser.cftDownload')}
              </Button>
            </Row>
            {cft?.downloading && (
              <Row>
                <div className="flex w-full flex-col gap-1">
                  <Progress value={cft.progress?.percent ?? 0} />
                  <span className="text-xs text-muted-foreground">
                    {t('settings.browser.cftDownloading', {
                      percent: cft.progress?.percent ?? 0,
                      received: formatBytes(cft.progress?.received ?? 0),
                      total: formatBytes(cft.progress?.total ?? 0),
                    })}
                  </span>
                </div>
              </Row>
            )}
            <Row last>
              <span className="break-all text-xs text-muted-foreground">
                {cft?.error ?? t('settings.browser.cftHint')}
              </span>
            </Row>
          </Section>

          <Section title={t('settings.browser.tabsTitle')} desc={t('settings.browser.tabsDesc')}>
            {status.tabs.length === 0 ? (
              <Row last>
                <span className="text-sm text-muted-foreground">{t('settings.browser.tabsEmpty')}</span>
              </Row>
            ) : (
              status.tabs.map((tab, index) => (
                <Row key={tab.tab} last={index === status.tabs.length - 1}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm text-foreground">
                      {tab.tab} · {tab.title || t('settings.browser.untitled')}
                    </span>
                    <span className="break-all text-xs text-muted-foreground">{tab.url}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('settings.browser.tabGroup', { group: tab.groupId ?? '—' })}
                    </span>
                  </div>
                  <Badge variant={tab.instanceKind === 'builtin' ? 'default' : 'secondary'}>
                    {tab.instanceKind === 'builtin'
                      ? t('settings.browser.kindBuiltin')
                      : t('settings.browser.kindExternal')}
                  </Badge>
                </Row>
              ))
            )}
            {status.currentTab && (
              <Row last>
                <span className="text-xs text-muted-foreground">
                  {t('settings.browser.currentTab', { tab: status.currentTab })}
                </span>
              </Row>
            )}
          </Section>

          <p className="text-xs text-muted-foreground">{t('settings.browser.toolsHint')}</p>
        </>
      )}
    </div>
  );
}
