// webui/src/components/pages/settings/BrowserSettingsSection.tsx
// 浏览器设置容器：内置 / 插件 / CDP 三模式 Tab（路由驱动）。
// 点击 Tab = 切换默认模式（写入 tools.browser.mode）+ 跳转子页；直接访问子页不写配置。
// 各模式的具体选项在 BrowserBuiltinSection / BrowserExtensionSection / BrowserCdpSection。

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, Outlet, Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Earth, Loader2, PlugZap, Puzzle } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/api/http';
import { usePlatform } from '@/hooks/usePlatform';
import type { BrowserMode } from '@/types/api';
import { useBrowserToolConfig } from './useBrowserStatus';

const BROWSER_MODES: Array<{ id: BrowserMode; Icon: typeof Earth }> = [
  { id: 'builtin', Icon: Earth },
  { id: 'extension', Icon: Puzzle },
  { id: 'cdp', Icon: PlugZap },
];

function isBrowserMode(value: string): value is BrowserMode {
  return value === 'builtin' || value === 'extension' || value === 'cdp';
}

export function BrowserSettingsSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { save } = useBrowserToolConfig();
  const { platform } = usePlatform();
  const mobileUnavailable = platform.isAndroid;
  const [savedMode, setSavedMode] = useState<BrowserMode | null>(null);

  useEffect(() => {
    if (mobileUnavailable) return;
    let alive = true;
    void api
      .getBrowserStatus()
      .then((status) => {
        if (alive) setSavedMode(status.mode);
      })
      .catch(() => {
        if (alive) setSavedMode('extension');
      });
    return () => {
      alive = false;
    };
  }, [mobileUnavailable]);

  const suffix = pathname.startsWith('/settings/browser/')
    ? pathname.slice('/settings/browser/'.length)
    : '';
  const tab: BrowserMode = isBrowserMode(suffix) ? suffix : 'extension';

  const switchMode = (mode: BrowserMode) => {
    navigate(`/settings/browser/${mode}`);
    if (savedMode === mode) return;
    void save({ mode })
      .then(() => {
        setSavedMode(mode);
        toast.success(
          t('settings.browser.modeSwitched', { mode: t(`settings.browser.modeTabs.${mode}`) }),
        );
      })
      .catch(() => {
        // toast 已在 saveToolConfig 内提示
      });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-col gap-1 px-6 py-4">
        <h1 className="text-xl font-semibold text-foreground">{t('settings.browser.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {mobileUnavailable ? t('common.mobileUnavailableDesc') : t('settings.browser.subtitle')}
        </p>
        {!mobileUnavailable && savedMode && (
          <p className="text-xs text-muted-foreground">
            {t('settings.browser.currentMode', {
              mode: t(`settings.browser.modeTabs.${savedMode}`),
            })}
          </p>
        )}
      </div>

      {mobileUnavailable ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="flex w-full max-w-md items-center justify-center rounded-xl border border-border bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
            {t('common.mobileUnavailable')}
          </div>
        </div>
      ) : (
        <>
          {/* 普通设置条目 + 下拉框（替代胶囊导航；切换仍写入 tools.browser.mode + 子路由） */}
          <div className="flex flex-col gap-2 px-6 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {t('settings.browser.modeRowLabel')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(`settings.browser.modeTabs.${tab}Desc`)}
                </span>
              </div>
              <Select value={tab} onValueChange={(value) => switchMode(value as BrowserMode)}>
                <SelectTrigger className="w-56 shrink-0" aria-label={t('settings.browser.modeRowLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BROWSER_MODES.map(({ id, Icon }) => (
                    <SelectItem key={id} value={id}>
                      <span className="flex items-center gap-2">
                        <Icon className="size-3.5" />
                        {t(`settings.browser.modeTabs.${id}`)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 子页切换入场动画（key=pathname：模式切换时重播） */}
          <div
            key={pathname}
            className="anim-route animate-in fade-in slide-in-from-bottom-1 duration-200 flex-1 overflow-auto"
          >
            <Outlet />
          </div>
        </>
      )}
    </div>
  );
}

/** /settings/browser 索引重定向：按已保存的模式跳到对应子页 */
export function BrowserModeRedirect() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<BrowserMode | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .getBrowserStatus()
      .then((status) => {
        if (alive) setMode(status.mode);
      })
      .catch(() => {
        if (alive) setMode('extension');
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!mode) {
    return (
      <div className="flex items-center justify-center p-10 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('settings.browser.loading')}
      </div>
    );
  }
  return <Navigate to={`/settings/browser/${mode}`} replace />;
}
