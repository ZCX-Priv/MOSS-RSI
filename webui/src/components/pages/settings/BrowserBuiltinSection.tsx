// webui/src/components/pages/settings/BrowserBuiltinSection.tsx
// 浏览器设置 · 内置模式：内置 Chrome 启停 / 启动配置 / Chrome for Testing / 内置 AI 标签页。

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Download, Loader2, Play, RefreshCw, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { api } from '@/api/http';
import { Row, Section, formatBytes } from './browser-shared';
import {
  readConfigBoolean,
  readConfigString,
  useBrowserStatus,
  useBrowserToolConfig,
} from './useBrowserStatus';

export function BrowserBuiltinSection() {
  const { t } = useTranslation();
  const { status, loading, busy, error, refresh, run } = useBrowserStatus();
  const { values, save } = useBrowserToolConfig();

  const browserPath = readConfigString(values, 'browserPath', '');
  const autoDownload = readConfigBoolean(values, 'autoDownloadChromeForTesting', false);
  const [pathDraft, setPathDraft] = useState(browserPath);

  useEffect(() => {
    setPathDraft(browserPath);
  }, [browserPath]);

  const commitPath = () => {
    const next = pathDraft.trim();
    if (next === browserPath) {
      setPathDraft(browserPath);
      return;
    }
    void save({ browserPath: next }).catch(() => undefined);
  };

  const builtin = status?.builtin;
  const cft = status?.cft;
  const builtinTabs = status?.tabs.filter((tab) => tab.instanceKind === 'builtin') ?? [];
  const builtinRunning = builtin?.running === true;

  const sourceLabel =
    builtin?.source === 'chrome-for-testing'
      ? t('settings.browser.sourceCft')
      : builtin?.source === 'config'
        ? t('settings.browser.sourceConfig')
        : builtin?.source === 'local'
          ? t('settings.browser.sourceLocal')
          : '—';

  return (
    <div className="flex min-w-0 flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-sm font-medium text-foreground">{t('settings.browser.builtinTitle')}</div>
          <p className="text-xs text-muted-foreground">{t('settings.browser.builtinDesc')}</p>
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

      {status && builtin && (
        <>
          <Section title={t('settings.browser.builtinStatus')}>
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
                    void run(
                      'builtin-launch',
                      () => api.controlBrowserBuiltin('launch'),
                      'settings.browser.builtinLaunched',
                    )
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
                    void run(
                      'builtin-close',
                      () => api.controlBrowserBuiltin('close'),
                      'settings.browser.builtinClosed',
                    )
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
            <Row last>
              <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                <span>
                  {t('settings.browser.builtinSource')}:{' '}
                  <span className="text-foreground">{sourceLabel}</span>
                </span>
                <span className="break-all">
                  {t('settings.browser.builtinExecutable')}:{' '}
                  <code className="text-foreground">{builtin.executable ?? '—'}</code>
                </span>
                <span>
                  {t('settings.browser.builtinVersion')}:{' '}
                  <span className="text-foreground">{builtin.version ?? '—'}</span>
                </span>
                <span className="break-all">
                  {t('settings.browser.builtinProfile')}:{' '}
                  <code className="text-foreground">{builtin.profileDir}</code>
                </span>
                <span>
                  {t('settings.browser.builtinExtension')}:{' '}
                  <span
                    className={
                      builtin.extensionLoaded
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }
                  >
                    {builtin.extensionLoaded
                      ? t('settings.browser.builtinExtLoaded')
                      : t('settings.browser.builtinExtMissing')}
                  </span>
                </span>
                {builtin.error && (
                  <span className="break-all text-destructive">{builtin.error}</span>
                )}
              </div>
            </Row>
          </Section>

          <Section
            title={t('settings.browser.builtinConfigTitle')}
            desc={t('settings.browser.builtinConfigDesc')}
          >
            <Row>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.browser.browserPath')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.browser.browserPathDesc')}
                </span>
              </div>
              <Input
                value={pathDraft}
                onChange={(event) => setPathDraft(event.target.value)}
                onBlur={commitPath}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                placeholder={t('settings.browser.browserPathPlaceholder')}
                className="h-8 w-full font-mono text-xs sm:w-80"
              />
            </Row>
            <Row last>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{t('settings.browser.autoDownload')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.browser.autoDownloadDesc')}
                </span>
              </div>
              <Switch
                checked={autoDownload}
                onCheckedChange={(checked) =>
                  void save({ autoDownloadChromeForTesting: checked }).catch(() => undefined)
                }
                aria-label={t('settings.browser.autoDownload')}
              />
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
                {cft?.executable && <code className="break-all text-foreground">{cft.executable}</code>}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={cft?.downloading === true || busy === 'cft-download'}
                onClick={() =>
                  void run(
                    'cft-download',
                    () => api.downloadChromeForTesting(),
                    'settings.browser.cftDownloadStarted',
                  )
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

          <Section title={t('settings.browser.builtinTabsTitle')} desc={t('settings.browser.tabsDesc')}>
            {builtinTabs.length === 0 ? (
              <Row last>
                <span className="text-sm text-muted-foreground">{t('settings.browser.tabsEmpty')}</span>
              </Row>
            ) : (
              builtinTabs.map((tab, index) => (
                <Row key={tab.tab} last={index === builtinTabs.length - 1}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm text-foreground">
                      {tab.tab} · {tab.title || t('settings.browser.untitled')}
                    </span>
                    <span className="break-all text-xs text-muted-foreground">{tab.url}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('settings.browser.tabGroup', { group: tab.groupId ?? '—' })}
                    </span>
                  </div>
                  <Badge>{t('settings.browser.kindBuiltin')}</Badge>
                </Row>
              ))
            )}
            {status.currentTab && builtinTabs.some((tab) => tab.tab === status.currentTab) && (
              <Row last>
                <span className="text-xs text-muted-foreground">
                  {t('settings.browser.currentTab', { tab: status.currentTab })}
                </span>
              </Row>
            )}
          </Section>

          <p className="text-xs text-muted-foreground">{t('settings.browser.builtinHint')}</p>
        </>
      )}
    </div>
  );
}
