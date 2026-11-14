// render/code/highlight.worker.ts
// Shiki 高亮 Worker：把语法分析/HTML 生成移出主线程。
//
// 为什么需要：实测 131k 字符 Python 代码高亮约 1.3s、产出 2.8MB HTML；
// 流式期间每 300ms 在主线程重跑会直接抢占滚动/输入事件（上滑卡顿的来源之一）。
// 放进 Worker 后主线程只做 innerHTML 更新；Worker 崩溃/超时由 shiki.ts 回退主线程引擎。
//
// 协议：{ id, code, lang } → { id, ok:true, html } | { id, ok:false, unsupported?, error? }
// 任何异常都以 ok:false 回包，绝不挂起请求。

import { createHighlighter, bundledLanguages, type Highlighter } from 'shiki';
import { resolveShikiLang } from './lang-alias';

interface HighlightRequest {
  id: number;
  code: string;
  lang: string;
}

interface HighlightResponse {
  id: number;
  ok: boolean;
  html?: string;
  unsupported?: boolean;
  error?: string;
}

/** 引擎单例：失败时清空，允许下一次请求重建（避免一次失败后永久无高亮） */
let engine: Promise<Highlighter> | null = null;
/** 已加载语言（引擎重建时同步清空） */
const loadedLangs = new Set<string>();

function getEngine(): Promise<Highlighter> {
  if (!engine) {
    engine = createHighlighter({
      themes: ['catppuccin-latte', 'catppuccin-mocha'],
      langs: [],
    }).catch((err) => {
      engine = null;
      loadedLangs.clear();
      throw err;
    });
  }
  return engine;
}

function reply(msg: HighlightResponse): void {
  self.postMessage(msg);
}

async function handle(req: HighlightRequest): Promise<void> {
  const { id, code, lang } = req;
  try {
    const resolved = resolveShikiLang(lang, bundledLanguages as Record<string, unknown>);
    if (resolved === null) {
      reply({ id, ok: false, unsupported: true });
      return;
    }
    const highlighter = await getEngine();
    if (!loadedLangs.has(resolved)) {
      await highlighter.loadLanguage(resolved as Parameters<Highlighter['loadLanguage']>[0]);
      loadedLangs.add(resolved);
    }
    const html = highlighter.codeToHtml(code, {
      lang: resolved,
      themes: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
      // 只输出 --shiki-light/--shiki-dark 变量，不写内联 color（与主线程路径一致）
      defaultColor: false,
    });
    reply({ id, ok: true, html });
  } catch (err) {
    // 引擎可能已损坏：清空语言缓存，下一次请求会重建引擎并重新加载语法
    loadedLangs.clear();
    reply({ id, ok: false, error: String((err as Error)?.message ?? err) });
  }
}

self.onmessage = (e: MessageEvent<HighlightRequest>) => {
  const req = e.data;
  if (!req || typeof req.id !== 'number' || typeof req.code !== 'string') return;
  void handle(req);
};
