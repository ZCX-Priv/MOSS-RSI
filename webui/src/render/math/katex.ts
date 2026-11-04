// render/math/katex.ts
// KaTeX 封装：mhchem 扩展（\ce 化学方程式）+ renderToString 结果缓存。
// throwOnError:true —— 不支持的命令抛异常，由 MathSpan 触发 MathJax 回退。

import katex from 'katex';
import 'katex/dist/contrib/mhchem.mjs';

const CACHE_MAX = 500;
const cache = new Map<string, string>();

/**
 * 常见 LaTeX 命令（用于识别「双转义」：模型偶尔把 `\boxed` 写成 `\\boxed`）。
 * 只折叠白名单命令，避免误伤矩阵换行 `a\\b`（`b` 不是命令，必须保留 `\\` 语义）。
 */
const DOUBLE_ESCAPE_COMMANDS = new Set([
  'box', 'boxed', 'fbox', 'frac', 'dfrac', 'tfrac', 'cfrac', 'sqrt', 'text', 'textrm',
  'textbf', 'textit', 'textsf', 'texttt', 'textnormal', 'mathrm', 'mathbf', 'mathit',
  'mathsf', 'mathtt', 'mathcal', 'mathbb', 'mathfrak', 'operatorname', 'left', 'right',
  'middle', 'big', 'Big', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'begin',
  'end', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'array',
  'cases', 'aligned', 'align', 'equation', 'split', 'gathered', 'overline', 'underline',
  'hat', 'bar', 'vec', 'dot', 'ddot', 'tilde', 'widehat', 'widetilde', 'overbrace',
  'underbrace', 'tag', 'label', 'quad', 'qquad', 'hline', 'cdot', 'times',
  'div', 'pm', 'mp', 'leq', 'geq', 'neq', 'ne', 'lt', 'gt', 'approx', 'equiv', 'sim',
  'propto', 'sum', 'prod', 'int', 'oint', 'lim', 'infty', 'partial', 'nabla', 'alpha',
  'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau',
  'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda',
  'Xi', 'Pi', 'Sigma', 'Phi', 'Psi', 'Omega', 'ce', 'pu', 'to', 'mapsto', 'rightarrow',
  'leftarrow', 'Rightarrow', 'Leftarrow', 'leftrightarrow', 'therefore', 'because',
  'degree', 'circ', 'ast', 'star', 'prime', 'ldots', 'cdots', 'vdots', 'ddots', 'space',
  'hspace', 'vspace', 'color', 'textcolor', 'overset', 'underset', 'stackrel', 'limits',
  'nolimits', 'displaystyle', 'textstyle', 'scriptstyle', 'binom', 'choose', 'above',
  'atop', 'cr', 'newline', 'nonumber', 'notag', 'ref', 'eqref', 'bm', 'boldsymbol',
]);

/**
 * 归一化 LaTeX：只把「**恰好 2 个**反斜杠 + 白名单命令名」折叠为单反斜杠。
 * - `\\boxed{42}`（模型双转义）→ `\boxed{42}`
 * - `a\\b`（矩阵换行 + 普通变量，`b` 不在白名单）原样保留
 * - `a\\\text{...}`（矩阵换行 + 真命令，3 个反斜杠）不会被误折叠（lookbehind 排除）
 */
export function normalizeTex(tex: string): string {
  return tex.replace(/(?<!\\)\\\\([A-Za-z]+)/g, (match: string, name: string) =>
    DOUBLE_ESCAPE_COMMANDS.has(name) ? `\\${name}` : match,
  );
}

/**
 * KaTeX 渲染为 HTML 字符串（可信输出，可直接注入）。
 * 失败（不支持命令/语法错误）返回 null —— 调用方决定回退策略。
 */
export function renderKatex(tex: string, displayMode: boolean): string | null {
  const normalized = normalizeTex(tex);
  const key = `${displayMode ? 'D' : 'I'}:${normalized}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    const html = katex.renderToString(normalized, {
      displayMode,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      // 非标准命令 `\box` 别名到标准 `\boxed`（模型/用户常在两者间混用）
      macros: { '\\box': '\\boxed' },
    });
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, html);
    return html;
  } catch {
    // 失败不缓存（流式中公式可能还在增长，闭合后语义会变）
    return null;
  }
}
