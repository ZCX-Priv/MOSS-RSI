import { useState, useCallback, useEffect, Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, RefreshCw, Search, SlidersHorizontal, Loader2 } from 'lucide-react';
import type { OverlayType } from './types';
import { Sidebar } from './components/layout/Sidebar';
import { SearchModal } from './components/overlays/SearchModal';

// 任务页路由级懒加载：主包不再携带 127KB 的 TaskPage + 消息渲染树，
// 首屏可先渲染侧边栏/shell，TaskPage 分块与后端初始化并行加载 → 打开即见界面。
const TaskPage = lazy(() =>
  import('./components/pages/TaskPage').then((m) => ({ default: m.TaskPage })),
);

// 非任务页全部路由级懒加载：设置/插件/自动化/系统监控及其重依赖（全量 lucide 图标、
// 各类表单与表格）只在进入对应页面时下载，首屏 main chunk 不再被它们撑大。
const OverviewSettings = lazy(() =>
  import('./components/pages/overview/OverviewSettings').then((m) => ({ default: m.OverviewSettings })),
);
const PluginMarketPage = lazy(() =>
  import('./components/pages/PluginMarketPage').then((m) => ({ default: m.PluginMarketPage })),
);
const SkillMarketPage = lazy(() =>
  import('./components/pages/SkillMarketPage').then((m) => ({ default: m.SkillMarketPage })),
);
const AutomationPage = lazy(() =>
  import('./components/pages/AutomationPage').then((m) => ({ default: m.AutomationPage })),
);
const ConfiguredTab = lazy(() =>
  import('./components/pages/AutomationPage').then((m) => ({ default: m.ConfiguredTab })),
);
const HistoryTab = lazy(() =>
  import('./components/pages/AutomationPage').then((m) => ({ default: m.HistoryTab })),
);
const SettingsPage = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const GeneralSettings = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.GeneralSettings })),
);
const AgentSettings = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.AgentSettings })),
);
const ProviderSettings = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.ProviderSettings })),
);
const ContextSettings = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.ContextSettings })),
);
const ContextEngineSettings = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.ContextEngineSettings })),
);
const AppearanceSettings = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.AppearanceSettings })),
);
const ToolsSettings = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.ToolsSettings })),
);
const SafetySettings = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.SafetySettings })),
);
const LogsSettings = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.LogsSettings })),
);
const AboutSettings = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.AboutSettings })),
);
const CommandsSettings = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.CommandsSettings })),
);
const RenderSettingsSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.RenderSettingsSection })),
);
const AnimSettingsSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.AnimSettingsSection })),
);
const AppearanceSettingsSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.AppearanceSettingsSection })),
);
const RulesSettingsSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.RulesSettingsSection })),
);
const HooksSettingsSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.HooksSettingsSection })),
);
const MemorySettingsSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.MemorySettingsSection })),
);
const RemoteSettingsSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.RemoteSettingsSection })),
);
const ImSettingsSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.ImSettingsSection })),
);
const BrowserSettingsSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.BrowserSettingsSection })),
);
const BrowserModeRedirect = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.BrowserModeRedirect })),
);
const BrowserBuiltinSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.BrowserBuiltinSection })),
);
const BrowserExtensionSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.BrowserExtensionSection })),
);
const BrowserCdpSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.BrowserCdpSection })),
);
const ComputerSettingsSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.ComputerSettingsSection })),
);
const MigrationSettingsSection = lazy(() =>
  import('./components/pages/SettingsPage').then((m) => ({ default: m.MigrationSettingsSection })),
);
import { BrowserInstallConfirmDialog } from './components/overlays/BrowserInstallConfirmDialog';
import { SplashScreen } from './components/shared/SplashScreen';
// 文件预览弹层按需加载：它会把 markdown/katex/文件预览整条渲染链带进入口静态依赖，
// 改为首次打开时才加载，入口 modulepreload 链进一步缩短。
const FilePreviewDialog = lazy(() =>
  import('./render/file/FilePreviewDialog').then((m) => ({ default: m.FilePreviewDialog })),
);
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { useWebSocket } from './hooks/useWebSocket';
import { useConfig } from './hooks/useConfig';
import { useTools } from './hooks/useTools';
import { useAnimationClass } from './hooks/useAnimationClass';
import { useSkills } from './hooks/useSkills';
import { useAgents } from './hooks/useAgents';
import { useCommands } from './hooks/useCommands';
import { useTheme } from './contexts/ThemeContext';
import { useStore } from './store';
import { applyAppearanceToDom } from './lib/appearance';
import { resolveAccentHex } from './lib/theme-palette';

export default function App() {
  // 阶段1.6：WS 连接初始化 + 事件分发（单例，全应用只调用一次）
  useWebSocket();
  // 阶段2.1：全局加载 appConfig + apiConfig（含外观主题色同步到后端，供 computer 原生光标取色）
  const { appConfig, updateAppConfig } = useConfig();
  // 拉取工具图标映射（toolName → icon 字符串），供工具调用卡片渲染
  useTools();
  // 动画开关 → <html> class 桥接（含 prefers-reduced-motion 实时监听）
  useAnimationClass();
  // / @ 菜单数据预载（skills / agents / commands）：根组件一次性拉取，
  // WS resources.changed 自动刷新——首页输入 / @ 即有数据，不再依赖特定页面挂载
  useSkills();
  useAgents();
  useCommands();

  const [overlay, setOverlay] = useState<OverlayType>(null);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const openAutomationForm = useStore((s) => s.openAutomationForm);
  // 外观设置：从 store 读取，变化时同步到 DOM（CSS 变量 / data 属性）
  const accentColor = useStore((s) => s.accentColor);
  const fontSize = useStore((s) => s.fontSize);
  const uiDensity = useStore((s) => s.uiDensity);
  const cornerRadius = useStore((s) => s.cornerRadius);
  // 亮暗模式：切换后需重算项目级色卡（theme-palette 按模式取色）
  const { resolvedTheme } = useTheme();
  // TaskPage 自带含左 trigger 的合并 header，全局移动端 header 仅在其他路由显示
  const isTaskRoute = pathname === '/' || pathname.startsWith('/task');
  // 移动端 header 标题与右侧 button（仅非 TaskPage 路由）
  const isPluginsRoute = pathname.startsWith('/plugins');
  const isPluginsMarketRoute = pathname === '/plugins';
  const isPluginsMcpRoute = pathname === '/plugins/mcp';
  const isPluginsSkillsRoute = pathname === '/plugins/skills';
  // 插件库管理页（技能 / MCP）：标题「管理插件」并显示返回插件库按钮
  const isPluginsManageRoute = isPluginsMcpRoute || isPluginsSkillsRoute;
  const isAutomationRoute = pathname.startsWith('/automation');
  const isSettingsRoute = pathname.startsWith('/settings');
  const isProviderRoute = pathname.startsWith('/settings/provider');
  const mobileTitle = isPluginsManageRoute
    ? t('plugins.manageTitle')
    : isPluginsRoute
      ? t('plugins.title')
      : isAutomationRoute
      ? t('automation.title')
      : isSettingsRoute
        ? t('settings.title')
        : '';

  const openOverlay = useCallback((o: OverlayType) => {
    setOverlay(o);
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlay(null);
  }, []);

  // 路由切换时关闭 overlay（替代原 navigate() 内的 setOverlay(null) 副作用）
  useEffect(() => {
    setOverlay(null);
  }, [pathname]);

  // 外观设置 → DOM 同步：实现集中在 lib/appearance.ts（main.tsx 亦在首帧前调用一次，
  // 保证持久化值不闪默认态）；此处仅在设置变化时即时应用
  useEffect(() => {
    applyAppearanceToDom({ accentColor, fontSize, uiDensity, cornerRadius }, resolvedTheme);
  }, [accentColor, fontSize, uiDensity, cornerRadius, resolvedTheme]);

  // 主题色同步到后端（computer 原生鼠标颜色按最近调色板色跟随主题）
  useEffect(() => {
    if (!appConfig) return;
    const hex = resolveAccentHex(accentColor);
    if ((appConfig.appearance?.accentColor ?? '').toUpperCase() === hex) return;
    void updateAppConfig({ appearance: { accentColor: hex } }).catch(() => {
      // 后端未就绪：静默，下一次配置加载/主题切换会重试
    });
  }, [accentColor, appConfig, updateAppConfig]);

  return (
    <TooltipProvider>
      {/* 入场加载屏：接管 index.html boot 骨架，进度完成后淡出（每会话一次） */}
      <SplashScreen />
      <SidebarProvider className="h-svh min-h-0 overflow-hidden">
        <Sidebar onOpenOverlay={openOverlay} />
        <SidebarInset className="min-h-0 overflow-hidden">
          {/* 移动端顶部 header：仅非 TaskPage 路由显示（TaskPage 自带含左 trigger 的 header） */}
          {!isTaskRoute && (
            <header className="grid h-12 grid-cols-3 items-center border-b border-border px-3 md:hidden">
              <div className="flex items-center gap-1">
                <SidebarTrigger />
                {/* 插件库管理页：返回插件库（桌面返回键在页面标题区） */}
                {isPluginsManageRoute && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title={t('plugins.backToMarket')}
                    aria-label={t('plugins.backToMarket')}
                    onClick={() => navigate('/plugins')}
                  >
                    <ArrowLeft />
                  </Button>
                )}
              </div>
              <h1 className="truncate text-center text-sm font-medium text-foreground">
                {mobileTitle}
              </h1>
              <div className="flex justify-end">
                {/* 插件库主页：移动端管理入口（桌面按钮在页面标题区） */}
                {isPluginsMarketRoute && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={t('plugins.manage')}
                    aria-label={t('plugins.manage')}
                    onClick={() => navigate('/plugins/skills')}
                  >
                    <SlidersHorizontal />
                  </Button>
                )}
                {isAutomationRoute && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={t('automation.manualCreate')}
                    onClick={() => openAutomationForm()}
                  >
                    <Plus />
                  </Button>
                )}
                {/* 插件库技能 tab：刷新 + 添加技能（移动端收纳进 header，页面内按钮在桌面头部） */}
                {isPluginsSkillsRoute && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t('common.refresh')}
                      aria-label={t('common.refresh')}
                      onClick={() => useStore.getState().requestSkillsRefresh()}
                    >
                      <RefreshCw />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t('plugins.skillsAdd')}
                      aria-label={t('plugins.skillsAdd')}
                      onClick={() => useStore.getState().requestSkillsDialog()}
                    >
                      <Plus />
                    </Button>
                  </>
                )}
                {/* 插件库 MCP tab：刷新 + 添加服务器（移动端收纳进 header，页面内按钮在桌面头部） */}
                {isPluginsMcpRoute && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t('common.refresh')}
                      aria-label={t('common.refresh')}
                      onClick={() => useStore.getState().requestMcpRefresh()}
                    >
                      <RefreshCw />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t('plugins.mcpAdd')}
                      aria-label={t('plugins.mcpAdd')}
                      onClick={() => useStore.getState().requestMcpDialog()}
                    >
                      <Plus />
                    </Button>
                  </>
                )}
                {/* 服务商设置页：搜索 + 添加（语音类别只保留本地模型，不展示服务商操作） */}
                {isProviderRoute && !pathname.startsWith('/settings/provider/voice') && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t('settings.provider.searchPlaceholder')}
                      onClick={() => useStore.getState().toggleProviderSearch()}
                    >
                      <Search />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t('settings.provider.addProvider')}
                      aria-label={t('settings.provider.addProvider')}
                      onClick={() => useStore.getState().requestProviderDialog()}
                    >
                      <Plus />
                    </Button>
                  </>
                )}
              </div>
            </header>
          )}
          {/* 路由切换入场动画：按顶层路由段 remount 重播（设置内部分区切换由各 Outlet 容器负责）。
              欢迎页与任务页**刻意同 key（'task'）**：`/`（重定向前）与 `/task`、`/task/xxx` 都归
              'task' 段——发送消息时是同 key 参数切换，页面容器不重挂、不重播动画。
              **只做位移、不做 opacity 淡入**：淡入起点为透明度 0，暗色主题下整页就是「闪一片黑」，
              故移除 fade-in，仅保留 4px 上移（纯 transform，无黑帧）。
              flex flex-col：保持父级（SidebarInset）到页面根元素的 flex 纵向链路，页面 flex-1 撑满（缺失会导致页面高度塌陷） */}
          <div
            key={pathname === '/' ? 'task' : (pathname.split('/')[1] ?? 'task')}
            className="anim-route animate-in slide-in-from-bottom-1 duration-200 flex min-h-0 flex-1 flex-col"
          >
            <Suspense fallback={<PageLoading />}>
            {/* 路由就绪信号：挂载即说明 Suspense 子树（懒加载页面 chunk）已真正渲染，
                此时才把 Splash 的 page 里程碑置为完成（Loading 期间不会误报 100%）。 */}
            <RouteReadySignal />
            <Routes>
            {/* 欢迎页与任务页同一条路由（可选段）：`/` 重定向到 `/task`；发送消息后
                URL 从 /task → /task/xxx 是**同一路由内参数切换，TaskPage 不卸载重挂**——
                根治「发送后任务页整页重挂 + 浮出动画起点黑帧」；刷新/前进后退保持任务页 */}
            <Route path="/" element={<Navigate to="/task" replace />} />
            <Route path="/task/:taskId?" element={<TaskPage />} />
            {/* 插件库：主页为 SkillHub 技能市场，管理页为技能/MCP 管理 */}
            <Route path="/plugins" element={<SkillMarketPage />} />
            <Route path="/plugins/skills" element={<PluginMarketPage />} />
            <Route path="/plugins/mcp" element={<PluginMarketPage />} />
            {/* 未匹配的插件路径回主页（绝对路径：splat 内相对 to 会以完整 pathname 为基准） */}
            <Route path="/plugins/*" element={<Navigate to="/plugins" replace />} />
            <Route path="/automation" element={<AutomationPage />}>
              <Route index element={<Navigate to="configured" replace />} />
              <Route path="configured" element={<ConfiguredTab />} />
              <Route path="history" element={<HistoryTab />} />
              <Route path="*" element={<Navigate to="/automation/configured" replace />} />
            </Route>
            <Route path="/settings" element={<SettingsPage />}>
              <Route index element={<Navigate to="overview" replace />} />
              {/* 概览：设置默认页；用量/资源两分区在同一 OverviewSettings chunk 内静态引入 */}
              <Route path="overview" element={<Navigate to="usage" replace />} />
              <Route path="overview/usage" element={<OverviewSettings />} />
              <Route path="overview/resources" element={<OverviewSettings />} />
              <Route path="overview/*" element={<Navigate to="/settings/overview/usage" replace />} />
              <Route path="general" element={<GeneralSettings />} />
              {/* 外观：Tab 容器（外观占位 / 渲染设置 / 动画设置） */}
              <Route path="appearance" element={<AppearanceSettings />}>
                <Route index element={<AppearanceSettingsSection />} />
                <Route path="render" element={<RenderSettingsSection />} />
                <Route path="anim" element={<AnimSettingsSection />} />
              </Route>
              <Route path="agent" element={<AgentSettings />} />
              {/* 服务商：Tab 容器（模型 / 搜索 / 语音；路由驱动，刷新/直达保持）。
                  基路径 = 模型页（与 /settings/context、/settings/appearance 约定一致） */}
              <Route path="provider" element={<ProviderSettings />} />
              <Route path="provider/search" element={<ProviderSettings />} />
              <Route path="provider/voice" element={<ProviderSettings />} />
              <Route path="provider/*" element={<Navigate to="/settings/provider" replace />} />
              {/* 旧路径兼容：模型设置并入服务商 */}
              <Route path="model" element={<Navigate to="/settings/provider" replace />} />
              {/* 上下文：Tab 容器（引擎 / 规则 / 记忆） */}
              <Route path="context" element={<ContextSettings />}>
                <Route index element={<ContextEngineSettings />} />
                <Route path="rules" element={<RulesSettingsSection />} />
                <Route path="memory" element={<MemorySettingsSection />} />
              </Route>
              <Route path="tools" element={<ToolsSettings />} />
              <Route path="safety" element={<SafetySettings />} />
              {/* 浏览器：Tab 容器（内置 / 插件 / CDP 三模式，路由驱动） */}
              <Route path="browser" element={<BrowserSettingsSection />}>
                <Route index element={<BrowserModeRedirect />} />
                <Route path="builtin" element={<BrowserBuiltinSection />} />
                <Route path="extension" element={<BrowserExtensionSection />} />
                <Route path="cdp" element={<BrowserCdpSection />} />
                <Route path="*" element={<Navigate to="/settings/browser/extension" replace />} />
              </Route>
              <Route path="computer" element={<ComputerSettingsSection />} />
              <Route path="remote" element={<RemoteSettingsSection />} />
              {/* IM 连接：渠道机器人管理 + 配对码 + 微信扫码 */}
              <Route path="im" element={<ImSettingsSection />} />
              <Route path="logs" element={<LogsSettings />} />
              {/* 数据迁移：外部 Agent 会话导入 / MOSS 备份导出与恢复 */}
              <Route path="migration" element={<MigrationSettingsSection />} />
              <Route path="about" element={<AboutSettings />} />
              <Route path="commands" element={<CommandsSettings />} />
              <Route path="hooks" element={<HooksSettingsSection />} />
              {/* 旧路径重定向（并入 Tab 后保留兼容：搜索索引/书签仍指向旧地址） */}
              <Route path="render" element={<Navigate to="/settings/appearance/render" replace />} />
              <Route path="anim" element={<Navigate to="/settings/appearance/anim" replace />} />
              <Route path="index" element={<Navigate to="/settings/context" replace />} />
              <Route path="rules" element={<Navigate to="/settings/context/rules" replace />} />
              <Route path="memory" element={<Navigate to="/settings/context/memory" replace />} />
              <Route path="*" element={<Navigate to="/settings/overview" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/task" replace />} />
            </Routes>
            </Suspense>
          </div>
        </SidebarInset>

        {/* 受控 overlay：各组件自带 Dialog/Sheet，由 overlay state 驱动开关 */}
        <SearchModal open={overlay === 'search'} onClose={closeOverlay} />
      </SidebarProvider>
      {/* 全局文件预览弹层：移动端从消息流/附件等非侧边栏入口打开时使用 */}
      <GlobalFilePreviewDialog />
      <BrowserInstallConfirmDialog />
      <Toaster position="top-center" />
    </TooltipProvider>
  );
}

/**
 * 路由就绪信号（Splash 里程碑）。
 * 放在 Suspense 内部：页面 chunk 加载中时整个子树被 fallback 替换，本组件不渲染；
 * 只有真正渲染出页面内容后才标记 pageReady。
 * 初始 `'/'` 会重定向到 `/task`，这一帧不标记（避免在重定向前误报页面就绪）。
 */
function RouteReadySignal() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (pathname === '/') return;
    useStore.getState().markPageReady();
  }, [pathname]);
  return null;
}

/** 懒加载页面占位（不阻塞 TaskPage 主路径；进入设置等页面时短暂显示） */
function PageLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      <span>{t('common.loading')}</span>
    </div>
  );
}

/**
 * 全局文件预览弹层（移动端非侧边栏入口）。
 * 独立订阅 store：弹层开合只重渲染本组件，不影响 App 整树（流式期间尤其重要）。
 */
function GlobalFilePreviewDialog() {
  const path = useStore((s) => s.filePreviewDialogPath);
  const hideFilePreviewDialog = useStore((s) => s.hideFilePreviewDialog);
  // 首次打开后保持挂载（关闭时走弹层自身动画，而不是直接卸载）
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (path !== null) setMounted(true);
  }, [path]);
  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <FilePreviewDialog
        path={path ?? ''}
        open={path !== null}
        onOpenChange={(open) => {
          if (!open) hideFilePreviewDialog();
        }}
      />
    </Suspense>
  );
}
