// webui/src/components/pages/overview/OverviewSettings.tsx
// 设置-概览容器：标题 + 胶囊导航（用量 / 资源）+ 内容区。
// 路由：/settings/overview → /settings/overview/usage | /settings/overview/resources
// 两个分区静态引入（同一 chunk）：切 Tab 不再触发动态 import，避免 chunk 拉取失败导致整页报错。

import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity, ChartColumn } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UsageSection } from './UsageSection';
import { ResourcesSection } from './ResourcesSection';

type OverviewTab = 'usage' | 'resources';

export function OverviewSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const tab: OverviewTab = pathname.startsWith('/settings/overview/resources') ? 'resources' : 'usage';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="px-6 py-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{t('settings.overview.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('settings.overview.subtitle')}</p>
        </div>
      </div>

      {/* 胶囊导航：与「外观」「上下文」等设置页共用 TabsList 组件 */}
      <Tabs
        value={tab}
        onValueChange={(next) =>
          navigate(next === 'resources' ? '/settings/overview/resources' : '/settings/overview/usage')
        }
      >
        <div className="px-6 py-3">
          <TabsList aria-label={t('settings.overview.title')}>
            <TabsTrigger value="usage" className="gap-1.5">
              <ChartColumn className="size-3.5" />
              {t('settings.overview.tabs.usage')}
            </TabsTrigger>
            <TabsTrigger value="resources" className="gap-1.5">
              <Activity className="size-3.5" />
              {t('settings.overview.tabs.resources')}
            </TabsTrigger>
          </TabsList>
        </div>
      </Tabs>

      {/* 分区切换入场动画（key=pathname：Tab 切换时重播） */}
      <div key={pathname} className="anim-route flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === 'usage' ? <UsageSection /> : <ResourcesSection />}
      </div>
    </div>
  );
}
