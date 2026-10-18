import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App.tsx'
import { ErrorBoundary } from './components/shared/ErrorBoundary'
import { ThemeProvider } from './contexts/ThemeContext'
import { I18nProvider } from './contexts/I18nContext'
import { idbGet, idbSet, migrateLegacyDatabase } from './utils/idb'
import { normalizeShortcut } from './utils/shortcut'
import { waitForBackendReady } from './api/readiness'
import { useStore, type PersistedState, LEGACY_DEFAULT_WORKING_DIRECTORY, DEFAULT_WORKING_DIRECTORY } from './store'
import { isValidRenderSettings } from './render/core/types'
import { isValidAnimationSettings } from './types/animation'
import { applyAppearanceToDom } from './lib/appearance'
import i18n, { type Locale, resolveLocale, LOCALE_STORAGE_KEY } from './i18n'
import './styles/global.css'

// dev 兜底：Vite 重新预构建依赖后，此前引用的 ?v=<hash> chunk 会 404（懒加载渲染器报
// “Failed to fetch dynamically imported module”）。捕获 vite:preloadError 后做一次
// 节流整页重载自愈；10s 内只重载一次，防止异常情况下重载循环。
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  try {
    const KEY = 'moss-preload-reload-at';
    const last = Number(sessionStorage.getItem(KEY) ?? '0');
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // sessionStorage 不可用时不节流（仍重载一次）
  }
  window.location.reload();
});

type ThemeMode = 'light' | 'dark' | 'system';

// 防止主题闪烁：在 React 渲染前异步从 IndexedDB 读取主题并设置 data-theme
async function initTheme() {
  try {
    const stored = await idbGet<ThemeMode>('moss-theme');
    const mode = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    const resolved = mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode;
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    // 补写 localStorage 快照：供 index.html boot 骨架首帧判定主题（消除白→黑突变）
    try {
      localStorage.setItem('moss-theme-fast', mode);
    } catch {
      // 快照写失败不影响本次启动
    }
  } catch (err) {
    // 启动兜底：主题读取失败跟随系统偏好渲染，不阻塞应用启动
    console.warn('initTheme failed, fallback to system preference:', err);
    const resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }
}

// 防止语言闪烁：在 React 渲染前异步从 IndexedDB 读取语言并初始化 i18n
// 存储值为用户选择（'auto' | 'zh' | 'en'）；未设置过时默认 'auto'，实际语言由 resolveLocale 解析
async function initLocale() {
  try {
    const stored = await idbGet<Locale>(LOCALE_STORAGE_KEY);
    const locale: Locale =
      stored === 'zh' || stored === 'en' || stored === 'auto' ? stored : 'auto';
    const resolved = resolveLocale(locale);
    await i18n.changeLanguage(resolved);
    document.documentElement.lang = resolved;
  } catch (err) {
    // 启动兜底：语言初始化失败按默认语言继续，不阻塞应用启动
    console.warn('initLocale failed, fallback to default locale:', err);
  }
}

// store 中需要持久化的 key 列表（与 store 内 idbSet 使用的 key 保持一致）
const PERSISTED_KEYS = [
  'moss-working-directory',
  'moss-recent-directories',
  'moss-recent-dir-aliases',
  'moss-send-shortcut',
  'moss-follow-up-behavior',
  'moss-permission-mode',
  'moss-sidebar-tabs-by-session',
  'moss-render-settings',
  'moss-animation-settings',
  // 排队消息队列：刷新后队列不丢，任务结束后按序继续投递
  'moss-message-queues',
  // 外观设置（此前只写不读：刷新后一律回默认，导致「改了没生效」）
  'moss-accent-color',
  'moss-font-size',
  'moss-ui-density',
  'moss-corner-radius',
  'moss-right-panel-ratio',
  // 右侧面板宽度是否为手动拖拽产生（true → 设置项显示「自定义」）
  'moss-right-panel-custom',
  // 任务分组（左侧边栏文件夹）展开/收起状态：刷新后保持
  'moss-task-group-expanded',
] as const;

/**
 * 预填充 store 的持久化状态到 IndexedDB 内存缓存，并执行一次性迁移：
 * 仅当 IndexedDB 中该 key 无值而旧 localStorage 有值时，把旧值搬入 IndexedDB 并清除 localStorage。
 */
async function prefetchStoreState(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const key of PERSISTED_KEYS) {
    const current = await idbGet<unknown>(key);
    if (current === undefined) {
      const legacy = localStorage.getItem(key);
      if (legacy !== null) {
        let migrated: unknown = legacy;
        try {
          migrated = JSON.parse(legacy);
        } catch {
          // 非 JSON，按普通字符串处理
        }
        await idbSet(key, migrated);
        localStorage.removeItem(key);
        result[key] = migrated;
      }
    } else {
      result[key] = current;
    }
  }
  // 存量迁移：旧默认工作目录（C:\）→ 本机 System 哨兵（覆盖 IndexedDB 与旧 localStorage 两来源）
  if (result['moss-working-directory'] === LEGACY_DEFAULT_WORKING_DIRECTORY) {
    result['moss-working-directory'] = DEFAULT_WORKING_DIRECTORY;
    await idbSet('moss-working-directory', DEFAULT_WORKING_DIRECTORY);
  }
  return result;
}

// 先迁移旧库数据到 MOSS-DB，再预填充 store 状态（迁移写入内存缓存后，预填充即可命中）
async function initPersisted(): Promise<Record<string, unknown>> {
  try {
    await migrateLegacyDatabase();
    return await prefetchStoreState();
  } catch (err) {
    // 启动兜底：持久化状态读取失败按空状态继续（全部回落默认值）
    console.warn('initPersisted failed, fallback to defaults:', err);
    return {};
  }
}

function buildPersistedState(data: Record<string, unknown>): PersistedState {
  return {
    workingDirectory:
      typeof data['moss-working-directory'] === 'string'
        ? (data['moss-working-directory'] as string)
        : undefined,
    recentDirectories: Array.isArray(data['moss-recent-directories'])
      ? (data['moss-recent-directories'] as string[])
      : undefined,
    recentDirectoryAliases:
      data['moss-recent-dir-aliases'] && typeof data['moss-recent-dir-aliases'] === 'object'
        ? (data['moss-recent-dir-aliases'] as Record<string, string>)
        : undefined,
    sendShortcut:
      typeof data['moss-send-shortcut'] === 'string'
        ? normalizeShortcut(data['moss-send-shortcut'] as string) || undefined
        : undefined,
    followUpBehavior:
      data['moss-follow-up-behavior'] === 'queue' || data['moss-follow-up-behavior'] === 'guide'
        ? (data['moss-follow-up-behavior'] as 'queue' | 'guide')
        : undefined,
    accentColor:
      typeof data['moss-accent-color'] === 'string' && (data['moss-accent-color'] as string).length > 0
        ? (data['moss-accent-color'] as string)
        : undefined,
    fontSize:
      data['moss-font-size'] === 'small' || data['moss-font-size'] === 'medium' || data['moss-font-size'] === 'large'
        ? (data['moss-font-size'] as 'small' | 'medium' | 'large')
        : undefined,
    uiDensity:
      data['moss-ui-density'] === 'compact' || data['moss-ui-density'] === 'standard' || data['moss-ui-density'] === 'comfortable'
        ? (data['moss-ui-density'] as 'compact' | 'standard' | 'comfortable')
        : undefined,
    cornerRadius:
      data['moss-corner-radius'] === 'small' || data['moss-corner-radius'] === 'standard' || data['moss-corner-radius'] === 'large'
        ? (data['moss-corner-radius'] as 'small' | 'standard' | 'large')
        : undefined,
    rightPanelRatio:
      typeof data['moss-right-panel-ratio'] === 'number' &&
      (data['moss-right-panel-ratio'] as number) > 0 &&
      (data['moss-right-panel-ratio'] as number) < 1
        ? (data['moss-right-panel-ratio'] as number)
        : undefined,
    rightPanelCustom: data['moss-right-panel-custom'] === true ? true : undefined,
    permissionMode:
      data['moss-permission-mode'] === 'ask' ||
      data['moss-permission-mode'] === 'auto' ||
      data['moss-permission-mode'] === 'skip'
        ? (data['moss-permission-mode'] as 'ask' | 'auto' | 'skip')
        : undefined,
    sidebarTabsBySession:
      data['moss-sidebar-tabs-by-session'] && typeof data['moss-sidebar-tabs-by-session'] === 'object'
        ? (data['moss-sidebar-tabs-by-session'] as PersistedState['sidebarTabsBySession'])
        : undefined,
    renderSettings: isValidRenderSettings(data['moss-render-settings'])
      ? data['moss-render-settings']
      : undefined,
    animationSettings: isValidAnimationSettings(data['moss-animation-settings'])
      ? data['moss-animation-settings']
      : undefined,
    messageQueues:
      data['moss-message-queues'] && typeof data['moss-message-queues'] === 'object'
        ? (data['moss-message-queues'] as PersistedState['messageQueues'])
        : undefined,
    taskGroupExpanded:
      data['moss-task-group-expanded'] && typeof data['moss-task-group-expanded'] === 'object'
        ? (data['moss-task-group-expanded'] as PersistedState['taskGroupExpanded'])
        : undefined,
  };
}

/**
 * 一次性清理历史坏 Service Worker 与缓存（恢复通道，**仅生产环境**）。
 * 背景：旧版生产 sw.js 因 index.html 未进 precache 而调用 createHandlerBoundToURL('index.html')
 * 抛错，SW 安装/更新必然失败；叠加 skipWaiting:false，旧坏 SW 会长期接管并返回旧应用外壳，
 * 表现为「硬刷新/普通刷新拿不到新版本」。此处主动注销一次并清空 Cache Storage，
 * 让修复后的新 SW 立即生效，无需用户手清站点数据。
 * 用 localStorage 哨兵保证只执行一次、且不触发刷新（幂等、无刷新循环）。
 * dev 不执行：dev 的 /dev-sw.js 是用于调试 PWA 的，不能被清理。
 */
async function resetStaleServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  const KEY = 'moss-sw-reset-2026-10';
  try {
    if (localStorage.getItem(KEY)) return;
    localStorage.setItem(KEY, '1');
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    // 清理失败不阻塞启动
  }
}

// 启动即执行（非阻塞，与主题/语言/持久化初始化并行）
void resetStaleServiceWorker();

// 后端就绪门控：内核按序初始化（server 早于 agent），若在 agent 引擎注册前渲染应用，
// 首批列表/历史请求会拿到 503（未就绪）→ 首屏侧边栏与消息列表为空，需刷新才恢复。
// 这里与其他初始化并行等待就绪（有 12s 上限，后端不可用时不无限阻塞；期间 #moss-boot 骨架可见）。
Promise.all([initTheme(), initLocale(), initPersisted(), waitForBackendReady()]).then((results) => {
  const persisted = results[2];
  useStore.getState().hydratePersisted(buildPersistedState(persisted));
  // 首帧前同步应用外观（主题色 / 字号 / 密度 / 圆角）：避免先渲染一帧默认外观再跳变
  applyAppearanceToDom(useStore.getState());
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider>
          <I18nProvider>
            <HashRouter>
              <App />
            </HashRouter>
          </I18nProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}).catch((err: unknown) => {
  // 启动链路最后兜底：任何未预期异常也要给用户可见反馈，而非白屏
  console.error('App bootstrap failed:', err);
  const root = document.getElementById('root');
  if (root) {
    const msg = String(err instanceof Error ? err.message : err).replace(
      /[<>&]/g,
      (c: string) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'),
    );
    root.innerHTML = [
      '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif;">',
      '  <div style="max-width:480px;padding:32px;text-align:center;">',
      '    <h1 style="font-size:20px;margin:0 0 12px;">MOSS 启动失败 / Bootstrap failed</h1>',
      '    <p style="font-size:13px;color:#a1a1aa;margin:0 0 16px;word-break:break-all;">' + msg + '</p>',
      '    <button onclick="location.reload()" style="padding:8px 20px;border-radius:8px;border:1px solid #3f3f46;background:#18181b;color:#e4e4e7;cursor:pointer;">重新加载 / Reload</button>',
      '  </div>',
      '</div>',
    ].join('');
  }
});
