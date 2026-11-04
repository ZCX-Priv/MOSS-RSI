// render/math/mathjax.ts
// MathJax 4 懒加载器（KaTeX 失败时的回退引擎，100% LaTeX 覆盖）。
//
// vite 集成要点（规避 better-react-mathjax 的坑，直接用 mathjax npm 包 es5 浏览器组件）：
//   1. import 前必须先设置 window.MathJax 配置（mathjax es5 是副作用脚本，启动时读取该全局）
//   2. dynamic import 懒加载 —— 首次遇到 KaTeX 失败公式才加载（~1MB），首屏零负担
//   3. startup.typeset:false —— 不自动扫描页面，只按需 tex2chtmlPromise
//   4. chtml 样式表只注入一次

import { normalizeTex } from './katex';

interface MathJaxAdaptor {
  outerHTML(node: unknown): string;
}

interface MathJaxStartup {
  promise: Promise<void>;
  adaptor: MathJaxAdaptor;
}

interface MathJaxGlobal {
  startup: MathJaxStartup;
  tex2chtmlPromise(tex: string, opts?: { display?: boolean }): Promise<unknown>;
  chtmlStylesheet(): unknown;
}

declare global {
  interface Window {
    MathJax?: MathJaxGlobal | Record<string, unknown>;
  }
}

let mathjaxPromise: Promise<MathJaxGlobal> | null = null;
let stylesheetInjected = false;

/** 懒加载 MathJax（单例；返回就绪后的全局对象） */
export function loadMathJax(): Promise<MathJaxGlobal> {
  if (!mathjaxPromise) {
    mathjaxPromise = (async () => {
      // 配置必须在 import es5 组件之前就位
      window.MathJax = {
        loader: { load: ['input/tex', 'output/chtml', '[tex]/mhchem', '[tex]/ams'] },
        startup: { typeset: false },
        tex: {
          packages: { '[+]': ['mhchem', 'ams'] },
          inlineMath: [['\\(', '\\)']],
          displayMath: [['$$', '$$'], ['\\[', '\\]']],
        },
        options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'] },
      };
      await import('mathjax/es5/tex-mml-chtml.js');
      const MJ = window.MathJax;
      if (!MJ || !('startup' in MJ) || !('tex2chtmlPromise' in MJ)) {
        throw new Error('MathJax failed to initialize');
      }
      const typed = MJ as unknown as MathJaxGlobal;
      await typed.startup.promise;
      return typed;
    })();
    mathjaxPromise.catch(() => {
      // 失败重置，下次可重试
      mathjaxPromise = null;
    });
  }
  return mathjaxPromise;
}

/** MathJax 渲染公式为 HTML 字符串（含 mjx-container）；样式表一次性注入文档 */
export async function mathjaxTypeset(tex: string, displayMode: boolean): Promise<string> {
  const MJ = await loadMathJax();
  if (!stylesheetInjected) {
    const style = MJ.chtmlStylesheet() as HTMLElement | undefined;
    if (style && style.nodeType === 1) {
      document.head.appendChild(style);
      stylesheetInjected = true;
    }
  }
  const node = await MJ.tex2chtmlPromise(normalizeTex(tex), { display: displayMode });
  const html = MJ.startup.adaptor.outerHTML(node);
  // MathJax 的 TeX 错误不会 reject，而是渲染成红色 <mjx-merror>；
  // 这里视为失败抛出，交给 MathSpan 走「带框兜底/原始文本」，绝不把红字交给用户。
  if (html.includes('mjx-merror')) {
    throw new Error('MathJax tex error');
  }
  return html;
}
