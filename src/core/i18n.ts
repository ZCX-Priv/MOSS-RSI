// src/core/i18n.ts
// 后端轻量 i18n：支持 zh/en，默认 zh

import { zh } from './i18n/locales/zh';

export type BackendLocale = 'zh' | 'en';

/**
 * 语言资源：zh 静态加载（默认语言）；en 按需动态加载。
 * 目的：英文文案约 60KB，默认中文用户无需为其支付启动解析成本。
 */
const resources: { zh: Record<string, unknown>; en: Record<string, unknown> | null } = {
  zh,
  en: null,
};
let currentLocale: BackendLocale = 'zh';

/** 惰性加载英文资源（locale 切到 en 时触发；加载完成前回退 zh） */
function ensureEnResources(): void {
  if (resources.en) return;
  void import('./i18n/locales/en')
    .then((mod) => {
      resources.en = mod.en;
    })
    .catch(() => {
      // 英文资源加载失败：保持 zh 回退
    });
}

/**
 * 运行期就地重载语言资源：带缓存破坏参数动态导入 locale 模块并替换资源表。
 * 用于开发/代理写入场景下让运行中的 t() 立即反映磁盘文案变更，无需重启进程。
 */
export async function reloadBackendResources(): Promise<void> {
  const [zhMod, enMod] = await Promise.all([
    import(`./i18n/locales/zh?t=${Date.now()}`),
    import(`./i18n/locales/en?t=${Date.now()}`),
  ]);
  resources.zh = zhMod.zh;
  resources.en = enMod.en;
}

export function setBackendLocale(locale: BackendLocale): void {
  currentLocale = locale;
  if (locale === 'en') ensureEnResources();
}

export function getBackendLocale(): BackendLocale {
  return currentLocale;
}

/** 翻译函数：支持 {{param}} 插值 */
export function t(key: string, params?: Record<string, string | number>): string {
  const table = resources[currentLocale] ?? resources.zh;
  const parts = key.split('.');
  let cur: unknown = table;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return key;
    }
  }
  if (typeof cur !== 'string') return key;
  if (!params) return cur;
  return cur.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k] ?? ''));
}
