// webui/src/components/pages/settings/BrowserCdpSection.tsx
// 浏览器设置 · CDP 模式：外部 CDP 端点配置 / 连接状态 / 启动命令指引 / CDP AI 标签页。

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, PlugZap, RefreshCw, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/api/http';
import { Row, Section } from './browser-shared';
import {
  readConfigString,
  useBrowserStatus,
  useBrowserToolConfig,
} from './useBrowserStatus';

export function BrowserCdpSection() {
  const { t } = useTranslation();
  const { status, loading, busy, error, refresh, run } = useBrowserStatus();
  const { values, save } = useBrowserToolConfig();

  const configuredEndpoint = readConfigString(values, 'cdpEndpoint', 'http://127.0.0.1:9222');
  const [endpointDraft, setEndpointDraft] = useState(configuredEndpoint);

  useEffect(() => {
    setEndpointDraft(configuredEndpoint);
  }, [configuredEndpoint]);

  const commitEndpoint = () => {
    const next = endpointDraft.trim() || 'http://127.0.0.1:9222';
    setEndpointDraft(next);
    if (next === configuredEndpoint) return;
    void save({ cdpEndpoint: next }).catch(() => undefined);
  };

  const connect = async () => {
    const endpoint = endpointDraft.trim() || 'http://127.0.0.1:9222';
    await run(
      'cdp-connect',
      async () => {
        await api.controlBrowserCdp('connect', endpoint);
        if (endpoint !== configuredEndpoint) await save({ cdpEndpoint: endpoint }).catch(() => undefined);
      },
      'settings.browser.cdpConnectedToast',
    );
  };

  const cdp = status?.cdp;
  const cdpTabs = status?.tabs.filter((tab) => tab.instanceKind === 'cdp') ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-sm font-medium text-foreground">{t('settings.browser.cdpPageTitle')}</div>
          <p className="text-xs text-muted-foreground">{t('settings.browser.cdpPageDesc')}</p>
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

      {status && cdp && (
        <>
          <Section title={t('settings.browser.cdpStatusTitle')}>
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.browser.cdpStatusTitle')}</span>
                <span className="text-xs text-muted-foreground">
                  {cdp.connected
                    ? t('settings.browser.cdpConnected')
                    : t('settings.browser.cdpDisconnected')}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy === 'cdp-connect'}
                  onClick={() => void connect()}
                >
                  {busy === 'cdp-connect' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <PlugZap className="h-4 w-4" />
                  )}
                  {t('settings.browser.cdpConnect')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!cdp.connected || busy === 'cdp-disconnect'}
                  onClick={() =>
                    void run(
                      'cdp-disconnect',
                      () => api.controlBrowserCdp('disconnect'),
                      'settings.browser.cdpDisconnectedToast',
                    )
                  }
                >
                  {busy === 'cdp-disconnect' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Unplug className="h-4 w-4" />
                  )}
                  {t('settings.browser.cdpDisconnect')}
                </Button>
              </div>
            </Row>
            <Row last>
              <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                <span>
                  {t('settings.browser.cdpEndpointLabel')}:{' '}
                  <code className="break-all text-foreground">{cdp.endpoint}</code>
                </span>
                {cdp.resolvedUrl && (
                  <span className="break-all">
                    {t('settings.browser.cdpResolvedUrl')}:{' '}
                    <code className="text-foreground">{cdp.resolvedUrl}</code>
                  </span>
                )}
                <span>
                  {t('settings.browser.cdpProduct')}:{' '}
                  <span className="text-foreground">{cdp.product ?? '—'}</span>
                </span>
                <span>
                  {t('settings.browser.cdpVersion')}:{' '}
                  <span className="text-foreground">{cdp.version ?? '—'}</span>
                </span>
                <span>
                  {t('settings.browser.cdpTargets')}:{' '}
                  <span className="text-foreground">{cdp.targetCount}</span>
                </span>
                {cdp.error && <span className="break-all text-destructive">{cdp.error}</span>}
              </div>
            </Row>
          </Section>

          <Section
            title={t('settings.browser.cdpConfigTitle')}
            desc={t('settings.browser.cdpConfigDesc')}
          >
            <Row last>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.browser.cdpEndpointSetting')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.browser.cdpEndpointSettingDesc')}
                </span>
              </div>
              <Input
                value={endpointDraft}
                onChange={(event) => setEndpointDraft(event.target.value)}
                onBlur={commitEndpoint}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                placeholder={t('settings.browser.cdpEndpointPlaceholder')}
                className="h-8 w-full font-mono text-xs sm:w-72"
              />
            </Row>
          </Section>

          <Section title={t('settings.browser.cdpHowToTitle')} desc={t('settings.browser.cdpHowToDesc')}>
            <Row>
              <div className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">
                <span className="text-sm text-foreground">{t('settings.browser.cdpHowToChrome')}</span>
                <code className="break-all rounded-md bg-muted px-2 py-1 font-mono text-[11px]">
                  chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\Temp\moss-cdp
                </code>
                <span className="text-sm text-foreground">{t('settings.browser.cdpHowToEdge')}</span>
                <code className="break-all rounded-md bg-muted px-2 py-1 font-mono text-[11px]">
                  msedge.exe --remote-debugging-port=9222 --user-data-dir=C:\Temp\moss-cdp
                </code>
                <span className="text-sm text-foreground">{t('settings.browser.cdpHowToElectron')}</span>
                <code className="break-all rounded-md bg-muted px-2 py-1 font-mono text-[11px]">
                  YourApp.exe --remote-debugging-port=9223
                </code>
              </div>
            </Row>
            <Row last>
              <span className="text-xs text-muted-foreground">{t('settings.browser.cdpHowToNote')}</span>
            </Row>
          </Section>

          <Section title={t('settings.browser.cdpTabsTitle')} desc={t('settings.browser.tabsDesc')}>
            {cdpTabs.length === 0 ? (
              <Row last>
                <span className="text-sm text-muted-foreground">{t('settings.browser.tabsEmpty')}</span>
              </Row>
            ) : (
              cdpTabs.map((tab, index) => (
                <Row key={tab.tab} last={index === cdpTabs.length - 1}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm text-foreground">
                      {tab.tab} · {tab.title || t('settings.browser.untitled')}
                    </span>
                    <span className="break-all text-xs text-muted-foreground">{tab.url}</span>
                  </div>
                  <Badge>{t('settings.browser.kindCdp')}</Badge>
                </Row>
              ))
            )}
            {status.currentTab && cdpTabs.some((tab) => tab.tab === status.currentTab) && (
              <Row last>
                <span className="text-xs text-muted-foreground">
                  {t('settings.browser.currentTab', { tab: status.currentTab })}
                </span>
              </Row>
            )}
          </Section>

          <p className="text-xs text-muted-foreground">{t('settings.browser.cdpHint')}</p>
        </>
      )}
    </div>
  );
}
