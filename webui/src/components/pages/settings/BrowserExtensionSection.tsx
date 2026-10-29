// webui/src/components/pages/settings/BrowserExtensionSection.tsx
// 浏览器设置 · 插件模式：扩展桥接状态与配置 / 扩展目录与安装指引 / 自动安装 / 外部实例与 AI 标签页。

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AlertCircle, Copy, Download, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/api/http';
import { copyText } from '@/lib/clipboard';
import { InstallerBadge, Row, Section, formatClock } from './browser-shared';
import {
  readConfigBoolean,
  readConfigNumber,
  readConfigString,
  useBrowserStatus,
  useBrowserToolConfig,
} from './useBrowserStatus';

export function BrowserExtensionSection() {
  const { t } = useTranslation();
  const { status, loading, busy, error, refresh, run } = useBrowserStatus();
  const { values, save } = useBrowserToolConfig();

  const bridgePort = readConfigNumber(values, 'bridgePort', 7799);
  const bridgeToken = readConfigString(values, 'bridgeToken', '');
  const autoInstall = readConfigBoolean(values, 'autoInstallExtensions', false);

  const [portDraft, setPortDraft] = useState(String(bridgePort));
  const [tokenDraft, setTokenDraft] = useState(bridgeToken);

  useEffect(() => {
    setPortDraft(String(bridgePort));
  }, [bridgePort]);

  useEffect(() => {
    setTokenDraft(bridgeToken);
  }, [bridgeToken]);

  const commitPort = () => {
    const parsed = Math.round(Number(portDraft));
    if (!Number.isFinite(parsed)) {
      setPortDraft(String(bridgePort));
      return;
    }
    const next = Math.max(1024, Math.min(65535, parsed));
    setPortDraft(String(next));
    if (next === bridgePort) return;
    void save({ bridgePort: next }).catch(() => undefined);
  };

  const commitToken = () => {
    const next = tokenDraft.trim();
    if (next === bridgeToken) return;
    void save({ bridgeToken: next }).catch(() => undefined);
  };

  const copyPath = async () => {
    if (!status) return;
    const ok = await copyText(status.extension.dir);
    if (ok) toast.success(t('settings.browser.copied'));
    else toast.error(t('settings.browser.copyFailed'));
  };

  const bridge = status?.bridge;
  const extension = status?.extension;
  const installer = status?.installer;
  const externalInstances =
    status?.instances.filter((instance) => instance.kind === 'external') ?? [];
  const externalTabs = status?.tabs.filter((tab) => tab.instanceKind === 'external') ?? [];
  const bridgeRunning = bridge?.running === true;

  return (
    <div className="flex min-w-0 flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-sm font-medium text-foreground">{t('settings.browser.extensionModeTitle')}</div>
          <p className="text-xs text-muted-foreground">{t('settings.browser.extensionModeDesc')}</p>
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

      {status && bridge && (
        <>
          <Section title={t('settings.browser.bridgeTitle')} desc={t('settings.browser.bridgeDesc')}>
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.browser.bridgeStatus')}</span>
                <span className="text-xs text-muted-foreground">
                  {bridgeRunning ? t('settings.browser.bridgeRunning') : t('settings.browser.bridgeStopped')}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t('settings.browser.bridgePort')}:{' '}
                  <code className="text-foreground">{bridge.port ?? '—'}</code>
                </span>
                <span>
                  {t('settings.browser.bridgeToken')}:{' '}
                  {bridge.tokenConfigured
                    ? t('settings.browser.bridgeTokenOn')
                    : t('settings.browser.bridgeTokenOff')}
                </span>
              </div>
            </Row>
            {(bridge.error ||
              (bridge.running &&
                bridge.port !== null &&
                bridge.port !== bridge.configuredPort)) && (
              <Row last>
                <span className="break-all text-xs text-amber-600 dark:text-amber-400">
                  {bridge.error ??
                    t('settings.browser.bridgePortMismatch', {
                      configured: bridge.configuredPort,
                      actual: bridge.port,
                    })}
                </span>
              </Row>
            )}
          </Section>

          <Section
            title={t('settings.browser.bridgeConfigTitle')}
            desc={t('settings.browser.bridgeConfigDesc')}
          >
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.browser.bridgePortSetting')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.browser.bridgePortSettingDesc')}
                </span>
              </div>
              <Input
                type="number"
                min={1024}
                max={65535}
                value={portDraft}
                onChange={(event) => setPortDraft(event.target.value)}
                onBlur={commitPort}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className="h-8 w-28 shrink-0 text-right"
              />
            </Row>
            <Row last>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.browser.bridgeTokenSetting')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.browser.bridgeTokenSettingDesc')}
                </span>
              </div>
              <Input
                type="password"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                onBlur={commitToken}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                placeholder={t('settings.browser.bridgeTokenPlaceholder')}
                className="h-8 w-full font-mono text-xs sm:w-64"
              />
            </Row>
          </Section>

          {extension && (
            <Section title={t('settings.browser.extensionTitle')} desc={t('settings.browser.extensionDesc')}>
              <Row>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs text-muted-foreground">
                    {t('settings.browser.extensionPath')}
                  </span>
                  <code className="break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">
                    {extension.dir}
                  </code>
                  <span className="text-xs text-muted-foreground">
                    {extension.seeded
                      ? t('settings.browser.extensionVersion', { version: extension.version ?? '—' })
                      : t('settings.browser.extensionNotSeeded')}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === 'open-dir'}
                    onClick={() =>
                      void run(
                        'open-dir',
                        () => api.openBrowserExtensionDir(),
                        'settings.browser.folderOpened',
                      )
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
          )}

          {installer && (
            <Section
              title={t('settings.browser.installerTitle')}
              desc={t('settings.browser.installerDesc')}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={installer.running || busy === 'installer'}
                  onClick={() =>
                    void run(
                      'installer',
                      () => api.runBrowserInstaller(),
                      'settings.browser.installerStarted',
                    )
                  }
                >
                  {installer.running || busy === 'installer' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {t('settings.browser.installerRun')}
                </Button>
              }
            >
              {installer.browsers.length === 0 ? (
                <Row last>
                  <span className="text-sm text-muted-foreground">
                    {t('settings.browser.installerNone')}
                  </span>
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
                    <InstallerBadge state={browser.state} />
                  </Row>
                ))
              )}
              {installer.running && installer.current && (
                <Row last>
                  <span className="text-xs text-muted-foreground">
                    {t('settings.browser.installerRunning', { name: installer.current })}
                  </span>
                </Row>
              )}
              <Row last>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm text-foreground">{t('settings.browser.autoInstall')}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('settings.browser.autoInstallDesc')}
                  </span>
                </div>
                <Switch
                  checked={autoInstall}
                  onCheckedChange={(checked) =>
                    void save({ autoInstallExtensions: checked }).catch(() => undefined)
                  }
                  aria-label={t('settings.browser.autoInstall')}
                />
              </Row>
            </Section>
          )}

          <Section title={t('settings.browser.instancesTitle')} desc={t('settings.browser.instancesDesc')}>
            {externalInstances.length === 0 ? (
              <Row last>
                <span className="text-sm text-muted-foreground">
                  {t('settings.browser.noInstances')}
                </span>
              </Row>
            ) : (
              externalInstances.map((instance, index) => (
                <Row key={instance.id} last={index === externalInstances.length - 1}>
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
                  <Badge variant="secondary">{t('settings.browser.kindExternal')}</Badge>
                </Row>
              ))
            )}
          </Section>

          <Section title={t('settings.browser.extensionTabsTitle')} desc={t('settings.browser.tabsDesc')}>
            {externalTabs.length === 0 ? (
              <Row last>
                <span className="text-sm text-muted-foreground">{t('settings.browser.tabsEmpty')}</span>
              </Row>
            ) : (
              externalTabs.map((tab, index) => (
                <Row key={tab.tab} last={index === externalTabs.length - 1}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm text-foreground">
                      {tab.tab} · {tab.title || t('settings.browser.untitled')}
                    </span>
                    <span className="break-all text-xs text-muted-foreground">{tab.url}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('settings.browser.tabGroup', { group: tab.groupId ?? '—' })}
                    </span>
                  </div>
                  <Badge variant="secondary">{t('settings.browser.kindExternal')}</Badge>
                </Row>
              ))
            )}
            {status.currentTab && externalTabs.some((tab) => tab.tab === status.currentTab) && (
              <Row last>
                <span className="text-xs text-muted-foreground">
                  {t('settings.browser.currentTab', { tab: status.currentTab })}
                </span>
              </Row>
            )}
          </Section>

          <p className="text-xs text-muted-foreground">{t('settings.browser.extensionHint')}</p>
        </>
      )}
    </div>
  );
}
