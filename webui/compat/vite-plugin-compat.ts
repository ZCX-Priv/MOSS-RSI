// webui/compat/vite-plugin-compat.ts
// WebUI 浏览器兼容层（不修改任何业务源码），dev 与 build 共用：
// 1) index.html 头部内联 polyfills.js（先于 module 脚本执行）；
// 2) CSS 普通 transform（在 Tailwind 生成之后、哈希之前）：
//    - 展开 @layer（Chrome < 99 会整层丢弃）；
//    - svh/dvh/lvh → 先输出 vh 回退声明（Chrome < 108）；
//    - 独立 translate/rotate/scale → 追加 @supports 包裹的 transform 回退（Chrome < 104）；
//    - 逻辑属性/inset → 先输出物理属性回退（Chrome < 87）；
//    - :is()/:where() 的 Tailwind 变体选择器降级（Chrome < 88）；
//    - color-mix() 静态混色回退（Chrome < 111，含 Chrome 100）。
// 3) 构建期清扫残留的 Chrome 80 不兼容 JS 语法（worker 等未过 target 的 asset）。

import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

interface CompatOptions {
  /** polyfills.js 的绝对路径（由 vite.config.ts 用 import.meta.dirname 解析后传入） */
  polyfillsFile: string;
}

/** 逐字符展开 @layer：删除 `@layer a,b;` 声明，去掉 `@layer name{...}` 外层包装 */
function flattenLayers(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@layer', i);
    if (at === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    let j = at + '@layer'.length;
    while (j < css.length && /\s/.test(css[j])) j += 1;
    // `@layer a, b;` 是声明语句，直接丢弃；块形式则继续找 `{`
    let next = '';
    let p = j;
    while (p < css.length) {
      const ch = css[p];
      if (ch === ';' || ch === '{') {
        next = ch;
        break;
      }
      p += 1;
    }
    if (next === ';') {
      i = p + 1;
      continue;
    }
    if (next !== '{') {
      out += css.slice(at);
      break;
    }
    const brace = p;
    let depth = 0;
    let k = brace;
    let quote = '';
    for (; k < css.length; k += 1) {
      const ch = css[k];
      // CSS 反斜杠转义在字符串内外都生效（选择器里的 \" \' 等不能当作引号起始）
      if (ch === '\\') {
        k += 1;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (k >= css.length) {
      out += css.slice(at);
      break;
    }
    out += flattenLayers(css.slice(brace + 1, k));
    i = k + 1;
  }
  return out;
}

/** 按顶层分隔符切分（忽略括号/引号内部） */
function splitList(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        i += 1;
        if (i < value.length) current += value[i];
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && ch === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** 按顶层空白切分值（忽略括号/引号内部空白），用于 inset / translate / scale 简写 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        i += 1;
        if (i < value.length) current += value[i];
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

/** 找到某个左括号对应的右括号下标 */
function findMatchingParen(value: string, openIndex: number): number {
  let depth = 0;
  let quote = '';
  for (let i = openIndex; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 逻辑属性 → 物理属性（应用仅 zh/en，按 LTR 展开） */
const LOGICAL_PROPS: Record<string, string[]> = {
  'padding-inline': ['padding-left', 'padding-right'],
  'padding-inline-start': ['padding-left'],
  'padding-inline-end': ['padding-right'],
  'padding-block': ['padding-top', 'padding-bottom'],
  'padding-block-start': ['padding-top'],
  'padding-block-end': ['padding-bottom'],
  'margin-inline': ['margin-left', 'margin-right'],
  'margin-inline-start': ['margin-left'],
  'margin-inline-end': ['margin-right'],
  'margin-block': ['margin-top', 'margin-bottom'],
  'margin-block-start': ['margin-top'],
  'margin-block-end': ['margin-bottom'],
  'inset-inline': ['left', 'right'],
  'inset-inline-start': ['left'],
  'inset-inline-end': ['right'],
  'inset-block': ['top', 'bottom'],
  'inset-block-start': ['top'],
  'inset-block-end': ['bottom'],
  'border-inline-width': ['border-left-width', 'border-right-width'],
  'border-block-width': ['border-top-width', 'border-bottom-width'],
  'border-inline-style': ['border-left-style', 'border-right-style'],
  'border-block-style': ['border-top-style', 'border-bottom-style'],
  'border-inline-color': ['border-left-color', 'border-right-color'],
  'border-block-color': ['border-top-color', 'border-bottom-color'],
  'inline-size': ['width'],
  'block-size': ['height'],
  'min-inline-size': ['min-width'],
  'max-inline-size': ['max-width'],
  'min-block-size': ['min-height'],
  'max-block-size': ['max-height'],
};

/** 为单条声明生成兼容回退声明（不含 transform 组合，单独处理） */
function fallbackDeclarations(prop: string, value: string): string[] {
  const extras: string[] = [];

  // svh/dvh/lvh → vh
  if (/\d(?:svh|dvh|lvh)\b/.test(value)) {
    const downgraded = value.replace(/(\d(?:\.\d+)?)(?:svh|dvh|lvh)\b/g, '$1vh');
    if (downgraded !== value) extras.push(`${prop}:${downgraded}`);
  }

  const physical = LOGICAL_PROPS[prop];
  if (physical) {
    for (const target of physical) extras.push(`${target}:${value}`);
    return extras;
  }

  if (prop === 'inset') {
    const parts = splitTopLevel(value);
    if (parts.length >= 1 && parts.length <= 4) {
      const top = parts[0];
      const right = parts.length > 1 ? parts[1] : top;
      const bottom = parts.length > 2 ? parts[2] : top;
      const left = parts.length > 3 ? parts[3] : right;
      extras.push(`top:${top}`, `right:${right}`, `bottom:${bottom}`, `left:${left}`);
    }
  }

  return extras;
}

/** 声明级回退（视口单位 / 逻辑属性 / inset） */
function addDeclarationFallbacks(css: string): string {
  return css.replace(
    /(^|[;{])(\s*)([a-zA-Z-]+)\s*:\s*([^;}]*)/g,
    (whole: string, sep: string, ws: string, prop: string, value: string) => {
      const extras = fallbackDeclarations(prop, value);
      if (extras.length === 0) return whole;
      return `${sep}${ws}${extras.join(';')};${prop}:${value}`;
    },
  );
}

/** 独立变换属性（translate/rotate/scale）→ @supports 包裹的 transform 回退 */
function addTransformFallbacks(css: string): string {
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (whole: string, selector: string, body: string) => {
    if (!/(?:^|[;])\s*(?:translate|rotate|scale)\s*:/.test(body)) return whole;
    // 已有 transform 的规则不做组合，避免覆盖既有变换
    if (/(?:^|[;])\s*transform\s*:/.test(body)) return whole;
    // keyframes 的步骤选择器（0%/from/to）不能包进 @supports
    if (/^\s*(?:from|to|\d+(?:\.\d+)?%)\s*$/.test(selector.trim())) return whole;

    let translateValue = '';
    let rotateValue = '';
    let scaleValue = '';
    for (const decl of body.split(';')) {
      const match = /^\s*(translate|rotate|scale)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
      if (!match) continue;
      if (match[1] === 'translate') translateValue = match[2];
      else if (match[1] === 'rotate') rotateValue = match[2];
      else scaleValue = match[2];
    }

    const functions: string[] = [];
    if (translateValue && translateValue !== 'none') {
      const parts = splitTopLevel(translateValue);
      if (parts.length === 1) functions.push(`translate(${parts[0]})`);
      else if (parts.length >= 2) functions.push(`translate(${parts[0]}, ${parts[1]})`);
    }
    if (rotateValue && rotateValue !== 'none') functions.push(`rotate(${rotateValue})`);
    if (scaleValue && scaleValue !== 'none') {
      const parts = splitTopLevel(scaleValue);
      if (parts.length >= 2) functions.push(`scale(${parts[0]}, ${parts[1]})`);
      else if (parts.length === 1) functions.push(`scale(${parts[0]})`);
    }
    if (functions.length === 0) return whole;

    return `${whole}@supports not (translate:0px){${selector}{transform:${functions.join(' ')}}}`;
  });
}

// ============================================================================
// :is() / :where() 降级（Chrome < 88）
// 只处理 Tailwind 生成的 group/peer 变体与 [hidden] reset，其余保持原样。
// ============================================================================
interface PseudoMatch {
  start: number;
  end: number;
  inner: string;
}

/** 在 selector 中查找一个 :is( 或 :where( 的匹配区间 */
function findPseudo(selector: string, pseudo: ':is(' | ':where('): PseudoMatch | null {
  const start = selector.indexOf(pseudo);
  if (start === -1) return null;
  const open = start + pseudo.length - 1;
  const close = findMatchingParen(selector, open);
  if (close === -1) return null;
  return { start, end: close + 1, inner: selector.slice(open + 1, close) };
}

/** 去掉 :where(<无空格的简单复合选择器>)，如 :where(.group) / :where([title]) */
function stripSimpleWhere(selector: string): string {
  let out = selector;
  for (let guard = 0; guard < 8; guard += 1) {
    const match = findPseudo(out, ':where(');
    if (!match) break;
    if (/[\s>,+~]/.test(match.inner.trim())) break;
    out = out.slice(0, match.start) + match.inner.trim() + out.slice(match.end);
  }
  return out;
}

/** 展开不含逗号嵌套的简单 :is(a,b) 列表 */
function expandSimpleIs(selector: string): string[] {
  let results = [selector];
  for (let guard = 0; guard < 3; guard += 1) {
    const next: string[] = [];
    let changed = false;
    for (const sel of results) {
      const match = findPseudo(sel, ':is(');
      if (!match || /[\s>,+~]/.test(match.inner.trim())) {
        next.push(sel);
        continue;
      }
      const alternatives = splitList(match.inner, ',').map((item) => item.trim());
      if (alternatives.length <= 1) {
        next.push(sel);
        continue;
      }
      changed = true;
      for (const alt of alternatives) {
        next.push(sel.slice(0, match.start) + alt + sel.slice(match.end));
      }
    }
    results = next;
    if (!changed) break;
  }
  return results;
}

/** 单个选择器的降级（返回 1..n 个选择器） */
function lowerSingleSelector(selector: string): string[] {
  let sel = selector.trim();

  // [hidden]:where(:not([hidden=until-found])) → [hidden]:not([hidden=until-found])
  if (sel.includes('[hidden]:where(')) {
    sel = stripSimpleWhere(sel);
    if (!sel.includes(':is(') && !sel.includes(':where(')) return [sel];
  }

  // Tailwind group/peer 变体：PREFIX:is(COND *) / PREFIX:is(COND ~ *)
  for (let guard = 0; guard < 4; guard += 1) {
    const match = findPseudo(sel, ':is(');
    if (!match) break;
    const suffix = sel.slice(match.end).trim();
    if (suffix !== '') break;
    const complex = /^([\s\S]*?)\s*([>+~]?)\s*\*$/.exec(match.inner.trim());
    if (!complex) break;
    const prefix = sel.slice(0, match.start);
    if (!prefix || /[\s>+~]$/.test(prefix)) break;
    const rest = stripSimpleWhere(complex[1].trim());
    const combinator = complex[2] ? ` ${complex[2]} ` : ' ';
    const bases = expandSimpleIs(rest);
    const lowered = bases.map((base) => `${base}${combinator}${prefix}`.trim());
    return lowered.flatMap((item) => lowerSingleSelector(item));
  }

  return [sel];
}

/** 选择器列表降级 */
function lowerModernSelectors(css: string): string {
  return css.replace(/([^{}]+)\{/g, (whole: string, prelude: string) => {
    const selector = prelude.trim();
    if (!selector || selector.startsWith('@')) return whole;
    if (/^(?:from|to|\d+(?:\.\d+)?%)$/.test(selector)) return whole;
    if (!selector.includes(':is(') && !selector.includes(':where(')) return whole;
    const lowered = splitList(selector, ',').flatMap(lowerSingleSelector).join(',');
    return lowered === selector ? whole : `${lowered}{`;
  });
}

// ============================================================================
// color-mix() 静态回退（Chrome < 111）
// 旧浏览器会把整条声明当非法值丢弃，因此必须在构建期计算出 light/dark 两套颜色，
// 以「原声明前插入 light 回退 + 规则后追加 .dark 覆盖」的形式输出。
// ============================================================================
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const VARIABLE_VALUE_RE = /^#[0-9a-f]{3,8}$|^rgba?\(|^oklch\(|^oklab\(|^transparent$/i;

/** 提取 :root 或 .dark 中的颜色变量（只认 hex/rgb，lab/oklch 跳过保持旧回退） */
function extractColorVars(css: string, selector: string): Map<string, string> {
  const vars = new Map<string, string>();
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`(?:^|[},])\\s*${escaped}(?:\\s*,\\s*:host)?\\s*\\{([^{}]*)\\}`, 'g');
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(css)) !== null) {
    for (const decl of block[1].split(';')) {
      const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
      if (!match) continue;
      const value = match[2].trim();
      if (!VARIABLE_VALUE_RE.test(value)) continue;
      vars.set(match[1], value);
    }
  }
  return vars;
}

function parseHexColor(value: string): Rgba | null {
  const hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
    return { r, g, b, a };
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  return null;
}

function parseRgbColor(value: string): Rgba | null {
  const match = /^rgba?\(([\s\S]*)\)$/i.exec(value);
  if (!match) return null;
  const body = match[1].replace(/\//g, ' ');
  const parts = body.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (input: string): number => {
    if (input.endsWith('%')) return (parseFloat(input) / 100) * 255;
    return parseFloat(input);
  };
  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);
  let a = 1;
  if (parts.length >= 4) {
    a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  }
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
  return { r, g, b, a };
}

/** oklab → sRGB（含 gamma 编码），用于 dev CSS 里的 oklch/oklab 主题色 */
function oklabToRgba(l: number, a: number, b: number, alpha: number): Rgba {
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  const encode = (value: number) => {
    const clamped = value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(Math.max(value, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(255, Math.max(0, clamped * 255)));
  };
  return { r: encode(linear[0]), g: encode(linear[1]), b: encode(linear[2]), a: alpha };
}

function parseAlpha(value: string | undefined): number {
  if (!value) return 1;
  return value.trim().endsWith('%') ? parseFloat(value) / 100 : parseFloat(value);
}

/** 解析 oklch(L C H [/ A]) 与 oklab(L a b [/ A]) */
function parseOkColor(value: string): Rgba | null {
  const match = /^(oklch|oklab)\(([\s\S]*)\)$/i.exec(value.trim());
  if (!match) return null;
  const body = match[2].replace(/\//g, ' ');
  const parts = body.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const numbers = parts.slice(0, 3).map((part) => parseFloat(part));
  if (numbers.some((n) => Number.isNaN(n))) return null;
  const alpha = parts.length >= 4 ? parseAlpha(parts[3]) : 1;
  if (match[1].toLowerCase() === 'oklab') {
    return oklabToRgba(numbers[0], numbers[1], numbers[2], alpha);
  }
  const l = numbers[0] > 1 ? numbers[0] / 100 : numbers[0];
  const c = numbers[1];
  const h = (numbers[2] * Math.PI) / 180;
  return oklabToRgba(l, c * Math.cos(h), c * Math.sin(h), alpha);
}

/** 解析颜色值（支持 var() 链 / hex / rgb / oklch / oklab） */
function parseColor(value: string, vars: Map<string, string>, depth = 0): Rgba | null {
  const input = value.trim();
  if (!input || depth > 8) return null;
  if (input === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (input.startsWith('#')) return parseHexColor(input);
  if (/^rgba?\(/i.test(input)) return parseRgbColor(input);
  if (/^oklch\(|^oklab\(/i.test(input)) return parseOkColor(input);
  const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(input);
  if (varMatch) {
    const resolved = vars.get(varMatch[1]) ?? varMatch[2];
    return resolved ? parseColor(resolved, vars, depth + 1) : null;
  }
  return null;
}

/** 解析带百分比权重的颜色 */
function parseWeightedColor(value: string, vars: Map<string, string>): { color: Rgba; weight: number | null } | null {
  let input = value.trim();
  if (!input) return null;
  let weight: number | null = null;
  const trailing = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)$/.exec(input);
  if (trailing) {
    input = trailing[1].trim();
    weight = parseFloat(trailing[2]);
  } else {
    const leading = /^(\d+(?:\.\d+)?)%\s+(.*)$/.exec(input);
    if (leading) {
      weight = parseFloat(leading[1]);
      input = leading[2].trim();
    }
  }
  const color = parseColor(input, vars);
  return color ? { color, weight } : null;
}

/** 混合两个颜色（sRGB 近似，oklab 的轻微差异接受） */
function mixColors(first: { color: Rgba; weight: number | null }, second: { color: Rgba; weight: number | null }): string | null {
  let w1 = first.weight;
  let w2 = second.weight;
  if (w1 === null && w2 === null) {
    w1 = 50;
    w2 = 50;
  } else if (w1 === null) {
    w1 = 100 - (w2 as number);
  } else if (w2 === null) {
    w2 = 100 - w1;
  }
  const total = w1 + w2;
  if (!total) return null;
  const p1 = w1 / total;
  const p2 = w2 / total;
  const alpha = first.color.a * p1 + second.color.a * p2;
  if (alpha <= 0) return 'rgba(0,0,0,0)';
  const mix = (a: number, b: number) => Math.round((a * first.color.a * p1 + b * second.color.a * p2) / alpha);
  const r = mix(first.color.r, second.color.r);
  const g = mix(first.color.g, second.color.g);
  const b = mix(first.color.b, second.color.b);
  return `rgba(${r},${g},${b},${Math.round(alpha * 1000) / 1000})`;
}

/** 运行时变量（如 --palette-warning 由 JS 注入）无法在构建期取色。
 *  对 `color-mix(..., var(--x) N%, transparent)` 生成 rgba(var(--x-rgb), N%)，
 *  由 polyfills.js 在浏览器侧把当前主题色写入 --x-rgb。 */
function resolveDynamicColorMix(inner: string): string | null {
  const parts = splitList(inner, ',');
  if (parts.length < 3) return null;
  const first = parts[1].trim();
  const second = parts[2].trim();
  const transparentFirst = /^transparent(\s+\d+(?:\.\d+)?%)?$/i.test(first);
  const transparentSecond = /^transparent(\s+\d+(?:\.\d+)?%)?$/i.test(second);
  const colorPart = transparentFirst ? second : transparentSecond ? first : '';
  if (!colorPart) return null;
  const match = /^var\(\s*(--[\w-]+)\s*\)(?:\s+(\d+(?:\.\d+)?)%)?$/i.exec(colorPart);
  if (!match) return null;
  const transparentPart = transparentFirst ? first : second;
  const transparentWeight = /(\d+(?:\.\d+)?)%/.exec(transparentPart);
  let alpha: number;
  if (transparentWeight) {
    alpha = 1 - parseFloat(transparentWeight[1]) / 100;
  } else {
    const colorWeight = /(\d+(?:\.\d+)?)%/.exec(colorPart);
    alpha = colorWeight ? parseFloat(colorWeight[1]) / 100 : 0.5;
  }
  return `rgba(var(${match[1]}-rgb), ${Math.round(alpha * 1000) / 1000})`;
}

/** 计算 color-mix(in oklab, A P%, B) 表达式 */
function resolveColorMix(inner: string, vars: Map<string, string>): string | null {
  const parts = splitList(inner, ',');
  if (parts.length < 3) return null;
  const first = parseWeightedColor(parts[1], vars);
  const second = parseWeightedColor(parts[2], vars);
  if (!first || !second) return resolveDynamicColorMix(inner);
  return mixColors(first, second);
}

/** 把值中所有 color-mix(...) 替换为静态颜色 */
function replaceColorMix(value: string, vars: Map<string, string>): string | null {
  let out = '';
  let cursor = 0;
  let changed = false;
  const lower = value.toLowerCase();
  while (cursor < value.length) {
    const index = lower.indexOf('color-mix(', cursor);
    if (index === -1) {
      out += value.slice(cursor);
      break;
    }
    out += value.slice(cursor, index);
    const open = index + 'color-mix'.length;
    const close = findMatchingParen(value, open);
    if (close === -1) return null;
    const mixed = resolveColorMix(value.slice(open + 1, close), vars);
    if (!mixed) return null;
    out += mixed;
    changed = true;
    cursor = close + 1;
  }
  return changed ? out : null;
}

interface ColorContext {
  light: Map<string, string>;
  dark: Map<string, string>;
}

function buildColorContext(css: string): ColorContext {
  const light = extractColorVars(css, ':root');
  const dark = new Map(light);
  for (const [name, value] of extractColorVars(css, '.dark')) dark.set(name, value);
  return { light, dark };
}

/** 为含 color-mix 的普通规则补 light 声明 + .dark 覆盖（@supports 块由 maskColorMixSupports 处理） */
function addColorMixFallbacks(css: string, context: ColorContext): string {
  if (context.light.size === 0) return css;
  const { light: lightVars, dark: darkVars } = context;

  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (whole: string, selector: string, body: string) => {
    const sel = selector.trim();
    if (!sel || sel.startsWith('@')) return whole;
    if (!body.includes('color-mix(')) return whole;
    if (sel.includes(':root') || sel === 'html') return whole;
    // keyframes 步骤不能往里塞 @supports 覆盖块
    const isKeyframeStep = /^(?:from|to|\d+(?:\.\d+)?%)$/.test(sel);

    const isDarkRule = sel.startsWith('.dark ') || sel.startsWith('.dark\\');
    const vars = isDarkRule ? darkVars : lightVars;
    const declarations = body.split(';');
    const output: string[] = [];
    const darkOverrides: string[] = [];
    let changed = false;

    for (const decl of declarations) {
      const match = /^(\s*)([-\w]+)\s*:\s*([\s\S]+)$/.exec(decl);
      if (!match || !match[3].includes('color-mix(')) {
        output.push(decl);
        continue;
      }
      const [, indent, prop, value] = match;
      const light = replaceColorMix(value, vars);
      if (!light) {
        output.push(decl);
        continue;
      }
      output.push(`${indent}${prop}:${light}`);
      output.push(decl);
      changed = true;
      // 动态变量的 rgba(var(--x-rgb)) 由运行时按当前主题取值，不需要静态 .dark 覆盖
      if (!isDarkRule && !isKeyframeStep && !light.includes('var(--')) {
        const dark = replaceColorMix(value, darkVars);
        if (dark && dark !== light) darkOverrides.push(`${prop}:${dark}`);
      }
    }

    if (!changed) return whole;
    let replacement = `${selector}{${output.join(';')}}`;
    if (darkOverrides.length > 0) {
      const darkSelector = splitList(sel, ',')
        .map((item) => `.dark ${item.trim()}`)
        .join(',');
      replacement += `@supports not (color:color-mix(in oklab,red,red)){${darkSelector}{${darkOverrides.join(';')}}}`;
    }
    return replacement;
  });
}

/** 查找与左花括号匹配的右花括号 */
function findMatchingBrace(value: string, openIndex: number): number {
  let depth = 0;
  let quote = '';
  for (let i = openIndex; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 为 @supports (color-mix(...)) 内的规则生成旧浏览器可用的静态回退块 */
function buildColorMixSupportsFallback(inner: string, context: ColorContext): string {
  const lightRules: string[] = [];
  const darkRules: string[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(inner)) !== null) {
    const sel = match[1].trim();
    const body = match[2];
    if (!sel || sel.startsWith('@') || !body.includes('color-mix(')) continue;
    if (/^(?:from|to|\d+(?:\.\d+)?%)$/.test(sel)) continue;

    const isDarkRule = sel.startsWith('.dark ') || sel.startsWith('.dark\\');
    const lightDecls: string[] = [];
    const darkDecls: string[] = [];
    for (const decl of body.split(';')) {
      const dm = /^(\s*)([-\w]+)\s*:\s*([\s\S]+)$/.exec(decl);
      if (!dm || !dm[3].includes('color-mix(')) continue;
      const light = replaceColorMix(dm[3], isDarkRule ? context.dark : context.light);
      const dark = replaceColorMix(dm[3], context.dark);
      if (isDarkRule) {
        if (dark) darkDecls.push(`${dm[2]}:${dark}`);
        continue;
      }
      if (light) lightDecls.push(`${dm[2]}:${light}`);
      if (dark && dark !== light && !light.includes('var(--')) darkDecls.push(`${dm[2]}:${dark}`);
    }
    if (lightDecls.length > 0) lightRules.push(`${sel}{${lightDecls.join(';')}}`);
    if (darkDecls.length > 0) {
      const target = isDarkRule ? sel : splitList(sel, ',').map((item) => `.dark ${item.trim()}`).join(',');
      darkRules.push(`${target}{${darkDecls.join(';')}}`);
    }
  }
  if (lightRules.length === 0 && darkRules.length === 0) return '';
  return `@supports not (color:color-mix(in oklab,red,red)){${lightRules.join('')}${darkRules.join('')}}`;
}

/**
 * Tailwind/lightningcss 会把 color-mix 声明包在 @supports (color: color-mix(...)) 里，
 * 旧浏览器会跳过整个块。这里把这类块暂存为占位符，并生成等价的旧浏览器回退块，
 * 最后与原始块一起恢复，避免后续规则级处理误伤。
 */
function maskColorMixSupports(
  css: string,
  context: ColorContext,
): { masked: string; blocks: Map<string, string> } {
  const blocks = new Map<string, string>();

  const processBlock = (input: string): string => {
    let out = '';
    let i = 0;
    while (i < input.length) {
      const at = input.indexOf('@supports', i);
      if (at === -1) {
        out += input.slice(i);
        break;
      }
      const brace = input.indexOf('{', at);
      if (brace === -1) {
        out += input.slice(i);
        break;
      }
      const close = findMatchingBrace(input, brace);
      if (close === -1) {
        out += input.slice(i);
        break;
      }
      const condition = input.slice(at, brace);
      const inner = input.slice(brace + 1, close);
      let replacement: string;
      if (condition.includes('color-mix(')) {
        const fallback = buildColorMixSupportsFallback(inner, context);
        const token = `/*MOSS_CM_${blocks.size}*/`;
        blocks.set(token, fallback + input.slice(at, close + 1));
        replacement = token;
      } else {
        replacement = `${input.slice(at, brace + 1)}${processBlock(inner)}}`;
      }
      out += input.slice(i, at) + replacement;
      i = close + 1;
    }
    return out;
  };

  return { masked: processBlock(css), blocks };
}

/**
 * Tailwind 把全部 --tw-* 初始值兜底放在
 * `@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ...` 里。
 * Chrome 80 不认识 -webkit-hyphens / -moz-orient，整个条件为假 → --tw-* 全部缺失，
 * 表现为边框（--tw-border-style）、阴影、变换全部失效。
 * 这里把这些变量声明原样提升为无条件 :root 级声明；现代浏览器的值与 @property
 * 初始值一致，不改变渲染结果。
 */
function hoistTwPropertyFallbacks(css: string): string {
  const hoisted: string[] = [];
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@supports', i);
    if (at === -1) {
      out += css.slice(i);
      break;
    }
    const brace = css.indexOf('{', at);
    if (brace === -1) {
      out += css.slice(i);
      break;
    }
    const close = findMatchingBrace(css, brace);
    if (close === -1) {
      out += css.slice(i);
      break;
    }
    const condition = css.slice(at, brace);
    const inner = css.slice(brace + 1, close);
    if ((condition.includes('margin-trim') || condition.includes('-moz-orient')) && inner.includes('--tw-')) {
      // 原块内容原样提升为无条件声明，原块不再保留（避免重复体积）
      hoisted.push(inner);
      out += css.slice(i, at);
      i = close + 1;
      continue;
    }
    out += css.slice(i, at) + css.slice(at, close + 1);
    i = close + 1;
  }
  if (hoisted.length === 0) return css;
  return hoisted.join('') + out;
}

/** 对外暴露（便于构建脚本/测试复用） */
export function transformLegacyCss(css: string): string {
  let out = flattenLayers(css);
  out = hoistTwPropertyFallbacks(out);
  out = lowerModernSelectors(out);
  const context = buildColorContext(out);
  const masked = maskColorMixSupports(out, context);
  out = addColorMixFallbacks(masked.masked, context);
  for (const [token, block] of masked.blocks) {
    out = out.split(token).join(block);
  }
  out = addDeclarationFallbacks(out);
  out = addTransformFallbacks(out);
  return out;
}

interface AssetLike {
  type: 'asset';
  fileName: string;
  source: string | Uint8Array;
}

function isAsset(value: unknown): value is AssetLike {
  if (typeof value !== 'object' || value === null) return false;
  const asset = value as { type?: unknown; fileName?: unknown; source?: unknown };
  return (
    asset.type === 'asset' &&
    typeof asset.fileName === 'string' &&
    (typeof asset.source === 'string' || asset.source instanceof Uint8Array)
  );
}

/** Chrome 80 不支持的语法快速探测 */
const INCOMPATIBLE_JS_RE = /\?\?=|\|\|=|&&=|static\s*\{|#[A-Za-z_$][\w$]*\s+in\s+/;

export function mossCompat(options: CompatOptions): Plugin[] {
  const polyfills = readFileSync(options.polyfillsFile, 'utf8');
  let isServe = false;
  const setMode = (command: 'serve' | 'build') => {
    isServe = command === 'serve';
  };

  return [
    {
      name: 'moss-compat:html',
      configResolved(config) {
        setMode(config.command);
      },
      transformIndexHtml() {
        return [
          {
            tag: 'script',
            children: polyfills,
            injectTo: 'head-prepend',
          },
        ];
      },
    },
    {
      // 普通顺序：Tailwind 是 enforce:'pre'，本插件在其后、vite:css-post（转 JS/哈希）之前，
      // 因此 dev 与 build 都能拿到生成后的 CSS，且产物哈希基于最终内容。
      name: 'moss-compat:css',
      async transform(code: string, id: string) {
        if (id.includes('/node_modules/.vite/')) return null;
        if (id.includes('?inline') || id.includes('?raw')) return null;
        const file = id.split('?')[0];
        if (!file.endsWith('.css')) return null;

        let source = code;
        if (isServe) {
          // dev 的 Tailwind 产物未经过 lightningcss 优化：含 CSS nesting、oklch 主题色。
          // 先按 Chrome 80 降级一次（展开嵌套、补 hex 回退），后续规则级处理才有稳定的扁平结构。
          try {
            const { transform: lightningTransform } = (await import('lightningcss')) as {
              transform: (options: {
                filename: string;
                code: Buffer;
                targets: { chrome: number };
                minify: boolean;
                sourceMap: boolean;
              }) => { code: Uint8Array };
            };
            source = lightningTransform({
              filename: file,
              code: Buffer.from(code),
              targets: { chrome: 80 << 16 },
              minify: false,
              sourceMap: false,
            }).code.toString();
          } catch {
            // CSS 解析失败时保持原样，交给浏览器兜底
          }
        }

        const transformed = transformLegacyCss(source);
        return transformed === code ? null : { code: transformed, map: null };
      },
    },
    {
      // 构建期兜底：worker 等未经过 target 转换的 JS asset
      name: 'moss-compat:js-assets',
      apply: 'build',
      async generateBundle(_outputOptions, bundle) {
        let transformSync: ((filename: string, source: string, opts?: unknown) => { code: string; errors: Error[] }) | null = null;
        for (const item of Object.values(bundle)) {
          if (!isAsset(item)) continue;
          if (!item.fileName.endsWith('.js')) continue;
          const source = typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8');
          if (!INCOMPATIBLE_JS_RE.test(source)) continue;
          if (!transformSync) {
            const mod = (await import('rolldown/utils')) as {
              transformSync: (filename: string, source: string, opts?: unknown) => { code: string; errors: Error[] };
            };
            transformSync = mod.transformSync;
          }
          const result = transformSync(item.fileName, source, { target: 'chrome80' });
          if (result.errors.length === 0 && result.code) item.source = result.code;
        }
      },
    },
  ];
}
