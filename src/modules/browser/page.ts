// src/modules/browser/page.ts
// 页面层：AX 快照与 ref 解析、点击/输入/按键/选择/滚动/截图/等待/console。
// 只依赖 CdpSession 抽象：外部实例走扩展中继，内置实例走 Browser WS flat session。

import type { BrowserConsoleEntry } from './types';

export interface CdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** 订阅本标签页的 CDP 事件（已按标签页过滤） */
  onEvent(handler: (method: string, params: unknown) => void): () => void;
}

export interface PageInfo {
  url: string;
  title: string;
  readyState: string;
  /** 视口 CSS 宽度（截图坐标换算用） */
  viewportWidth?: number;
  /** 视口 CSS 高度 */
  viewportHeight?: number;
  /** 设备像素比（截图设备像素 / CSS 像素） */
  dpr?: number;
}

export interface SnapshotBuild {
  text: string;
  refs: Map<string, number>;
  refCount: number;
  truncated: boolean;
}

export interface ElementTarget {
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
}

export interface PageRunOptions {
  timeoutMs: number;
  maxSnapshotNodes: number;
  maxImageDimension: number;
  allowEvaluate: boolean;
  signal?: AbortSignal;
}

// ============================================================================
// 基础
// ============================================================================

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickString(obj: unknown, key: string): string | undefined {
  if (!isObject(obj)) return undefined;
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function pickNumber(obj: unknown, key: string): number | undefined {
  if (!isObject(obj)) return undefined;
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('操作已中断'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('操作已中断'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 开启页面操作所需域（DOM/Accessibility/Log 失败不阻断核心能力） */
export async function enablePageDomains(session: CdpSession): Promise<void> {
  await Promise.all([
    session.send('Page.enable').catch(() => undefined),
    session.send('Runtime.enable').catch(() => undefined),
    session.send('DOM.enable').catch(() => undefined),
    session.send('Accessibility.enable').catch(() => undefined),
    session.send('Log.enable').catch(() => undefined),
  ]);
}

/** 读取当前页面信息 */
export async function getPageInfo(session: CdpSession): Promise<PageInfo> {
  const result = await session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression:
      'JSON.stringify({url: location.href, title: document.title, readyState: document.readyState, w: innerWidth, h: innerHeight, dpr: devicePixelRatio})',
    returnByValue: true,
  });
  const raw = result.result?.value;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as {
        url?: unknown;
        title?: unknown;
        readyState?: unknown;
        w?: unknown;
        h?: unknown;
        dpr?: unknown;
      };
      return {
        url: typeof parsed.url === 'string' ? parsed.url : '',
        title: typeof parsed.title === 'string' ? parsed.title : '',
        readyState: typeof parsed.readyState === 'string' ? parsed.readyState : 'unknown',
        ...(typeof parsed.w === 'number' ? { viewportWidth: parsed.w } : {}),
        ...(typeof parsed.h === 'number' ? { viewportHeight: parsed.h } : {}),
        ...(typeof parsed.dpr === 'number' ? { dpr: parsed.dpr } : {}),
      };
    } catch {
      // fall through
    }
  }
  return { url: '', title: '', readyState: 'unknown' };
}

/** 轮询等待 document.readyState=complete；超时返回 false（不抛错） */
export async function waitForReady(session: CdpSession, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('操作已中断');
    try {
      const info = await getPageInfo(session);
      if (info.readyState === 'complete') return true;
    } catch {
      // 页面切换瞬间 evaluate 可能失败，继续等待
    }
    await sleep(250, signal);
  }
  return false;
}

// ============================================================================
// 导航
// ============================================================================

export interface NavigateOptions {
  url?: string;
  back?: boolean;
  forward?: boolean;
  reload?: boolean;
}

/**
 * 等待主 frame 真正提交导航（而不是旧文档的 readyState 仍是 complete）。
 * 事件优先：Page.frameNavigated（主 frame 无 parentId）/ Page.navigatedWithinDocument；
 * URL 变化作为兜底（覆盖部分重定向/同文档跳转的事件时序差异）。
 */
async function waitForNavigationCommit(
  session: CdpSession,
  beforeUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  let committed = false;
  const off = session.onEvent((method, params) => {
    if (method === 'Page.frameNavigated') {
      const frame = isObject(params) && isObject(params.frame) ? params.frame : null;
      // 主 frame 没有 parentId；子 frame 的导航不能作为提交信号
      if (frame && !frame.parentId) committed = true;
      return;
    }
    if (method === 'Page.navigatedWithinDocument') committed = true;
  });
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('操作已中断');
      if (committed) return true;
      try {
        const info = await getPageInfo(session);
        if (beforeUrl && info.url && info.url !== beforeUrl) return true;
      } catch {
        // 导航切换瞬间 evaluate 可能失败，继续等待
      }
      await sleep(100, signal);
    }
    return committed;
  } finally {
    off();
  }
}

export async function navigatePage(
  session: CdpSession,
  options: NavigateOptions,
  run: PageRunOptions,
): Promise<{ info: PageInfo; loading: boolean }> {
  const timeoutMs = Math.max(1000, run.timeoutMs);
  const before = await getPageInfo(session).catch(() => ({ url: '', title: '', readyState: 'unknown' }));
  let waitCommit = false;
  if (options.back) {
    waitCommit = true;
    await session.send('Runtime.evaluate', { expression: 'history.back()' });
  } else if (options.forward) {
    waitCommit = true;
    await session.send('Runtime.evaluate', { expression: 'history.forward()' });
  } else if (options.reload) {
    await session.send('Page.reload', { ignoreCache: true });
  } else if (options.url) {
    waitCommit = true;
    const url = normalizeUrl(options.url);
    const result = await session.send<{ errorText?: string }>('Page.navigate', { url });
    if (result.errorText) throw new Error(`导航失败：${result.errorText}`);
  } else {
    throw new Error('navigate 需要 url / back / forward / reload 之一');
  }

  const deadline = Date.now() + timeoutMs;
  if (waitCommit) {
    const committed = await waitForNavigationCommit(session, before.url, timeoutMs, run.signal);
    if (!committed) {
      const now = await getPageInfo(session).catch(() => null);
      // URL 完全没变 = 导航没有提交：必须明确报错，不能把启动占位页/旧页面当成功结果返回。
      if (!now?.url || now.url === before.url) {
        const stayed = now?.url || before.url || '当前页';
        throw new Error(
          `导航未完成：页面仍停留在 ${stayed}（可能被拦截、DNS/网络不可达或目标拒绝连接）`,
        );
      }
    }
  }

  const remaining = Math.max(1000, deadline - Date.now());
  const ready = await waitForReady(session, remaining, run.signal);
  const info = await getPageInfo(session);
  // Chrome 的网络错误页是 chrome-error://chromewebdata/：它不是目标页面，必须按失败处理。
  if (/^chrome-error:\/\//i.test(info.url)) {
    throw new Error(
      '导航失败：浏览器返回错误页（DNS 解析失败、连接被拒绝、证书错误或被安全软件/扩展拦截）',
    );
  }
  return { info, loading: !ready };
}

/** 规范化用户输入的 URL（补全 https://；导航与建页共用同一口径） */
export function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error('URL 不能为空');
  if (/^(https?|file|about|data):/i.test(value)) return value;
  return `https://${value}`;
}

// ============================================================================
// AX 快照
// ============================================================================

interface AxValue {
  value?: unknown;
}

interface AxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  description?: AxValue;
  value?: AxValue;
  properties?: Array<{ name?: string; value?: AxValue }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
  'gridcell',
  'cell',
  'row',
  'img',
  'image',
]);

const PRINTED_STRUCTURAL_ROLES = new Set([
  'heading',
  'paragraph',
  'list',
  'listitem',
  'navigation',
  'main',
  'form',
  'table',
  'row',
  'cell',
  'dialog',
  'alert',
  'status',
  'toolbar',
  'menu',
  'menubar',
  'tablist',
  'tree',
  'grid',
  'article',
  'banner',
  'contentinfo',
  'complementary',
]);

const TEXT_ROLES = new Set(['StaticText', 'text']);

/** 交互元素属性状态标记 */
function formatFlags(node: AxNode): string {
  const flags: string[] = [];
  const properties = Array.isArray(node.properties) ? node.properties : [];
  for (const prop of properties) {
    const name = typeof prop.name === 'string' ? prop.name : '';
    const value = prop.value && typeof prop.value === 'object' ? (prop.value as AxValue).value : undefined;
    if (!name) continue;
    if ((name === 'checked' || name === 'selected' || name === 'expanded' || name === 'pressed') && value === true) {
      flags.push(name);
    } else if (name === 'disabled' && value === true) {
      flags.push('disabled');
    } else if (name === 'focused' && value === true) {
      flags.push('focused');
    } else if (name === 'required' && value === true) {
      flags.push('required');
    } else if (name === 'readonly' && value === true) {
      flags.push('readonly');
    }
  }
  return flags.length > 0 ? ` (${flags.join(', ')})` : '';
}

function truncateText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

/**
 * 构建可读 AX 树，给交互元素分配 ref=eN。
 * refs 表供 click/type 等动作按 ref 定位。
 * refPrefix：跨域 iframe 合并时使用（如 f1:），保证 ref 全局唯一并可路由回子会话。
 */
export async function buildSnapshot(
  session: CdpSession,
  maxNodes: number,
  options: { refPrefix?: string } = {},
): Promise<SnapshotBuild> {
  const refPrefix = options.refPrefix ?? '';
  const tree = await session.send<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree');
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  const byId = new Map<string, AxNode>();
  for (const node of nodes) {
    if (typeof node.nodeId === 'string') byId.set(node.nodeId, node);
  }
  const root = nodes[0];
  const lines: string[] = [];
  const refs = new Map<string, number>();
  let refSeq = 0;
  let printed = 0;
  let truncated = false;
  let textLength = 0;
  const MAX_TEXT_CHARS = 80_000;
  const MAX_DEPTH = 40;

  const pushLine = (line: string): boolean => {
    if (printed >= maxNodes || textLength + line.length > MAX_TEXT_CHARS) {
      truncated = true;
      return false;
    }
    lines.push(line);
    printed += 1;
    textLength += line.length;
    return true;
  };

  const visit = (node: AxNode, depth: number, insideInteractive: boolean): void => {
    if (truncated || depth > MAX_DEPTH) return;
    const children = Array.isArray(node.childIds)
      ? node.childIds.map((id) => byId.get(id)).filter((child): child is AxNode => child !== undefined)
      : [];
    if (node.ignored === true) {
      for (const child of children) visit(child, depth, insideInteractive);
      return;
    }
    const role = pickString(node.role, 'value') ?? '';
    const name = pickString(node.name, 'value') ?? '';
    const value = node.value && typeof node.value === 'object' ? node.value.value : undefined;
    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isText = TEXT_ROLES.has(role);

    let nextInsideInteractive = insideInteractive || isInteractive;

    if (isText) {
      if (!insideInteractive && name.trim()) {
        const line = `${'  '.repeat(depth)}- text: ${truncateText(name, 200)}`;
        if (!pushLine(line)) return;
      }
    } else if (isInteractive) {
      let refPart = '';
      if (typeof node.backendDOMNodeId === 'number') {
        refSeq += 1;
        const ref = `${refPrefix}e${refSeq}`;
        refs.set(ref, node.backendDOMNodeId);
        refPart = ` [ref=${ref}]`;
      }
      const parts: string[] = [`${'  '.repeat(depth)}- ${role || 'element'}`];
      if (name.trim()) parts.push(` "${truncateText(name, 200)}"`);
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        parts.push(` value="${truncateText(String(value), 120)}"`);
      }
      parts.push(formatFlags(node));
      parts.push(refPart);
      if (!pushLine(parts.join(''))) return;
    } else if (PRINTED_STRUCTURAL_ROLES.has(role) && name.trim()) {
      const line = `${'  '.repeat(depth)}- ${role}: ${truncateText(name, 200)}`;
      if (!pushLine(line)) return;
    }

    for (const child of children) {
      if (truncated) break;
      visit(child, isText || isInteractive || PRINTED_STRUCTURAL_ROLES.has(role) ? depth + 1 : depth, nextInsideInteractive);
    }
  };

  if (root) {
    visit(root, 0, false);
  } else {
    truncated = nodes.length > 0;
  }

  return {
    text: lines.join('\n'),
    refs,
    refCount: refs.size,
    truncated: truncated || nodes.length === 0,
  };
}

// ============================================================================
// 元素定位与输入
// ============================================================================

interface ResolvedElement {
  backendNodeId?: number;
  objectId?: string;
}

async function resolveElement(
  session: CdpSession,
  target: ElementTarget,
  refs: Map<string, number>,
): Promise<ResolvedElement> {
  if (target.ref) {
    const backendNodeId = refs.get(target.ref);
    if (typeof backendNodeId !== 'number') {
      throw new Error(`ref ${target.ref} 已失效，请重新调用 snapshot`);
    }
    return { backendNodeId };
  }
  if (target.selector) {
    const result = await session.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(target.selector)})`,
      returnByValue: false,
    });
    const objectId = result.result?.objectId;
    if (!objectId) throw new Error(`未找到选择器匹配的元素：${target.selector}`);
    try {
      const node = await session.send<{ nodeId?: number }>('DOM.requestNode', { objectId });
      if (typeof node.nodeId === 'number') {
        const described = await session.send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', {
          nodeId: node.nodeId,
        });
        if (typeof described.node?.backendNodeId === 'number') {
          return { backendNodeId: described.node.backendNodeId, objectId };
        }
      }
    } catch {
      // DOM 域不可用时仅保留 objectId，走 JS 回退
    }
    return { objectId };
  }
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    return {};
  }
  throw new Error('需要 ref / selector / x+y 之一');
}

async function scrollIntoView(session: CdpSession, element: ResolvedElement): Promise<void> {
  if (typeof element.backendNodeId !== 'number') return;
  try {
    await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: element.backendNodeId });
  } catch {
    // 元素可能已不可见，交给后续坐标解析报错
  }
}

async function elementCenter(
  session: CdpSession,
  element: ResolvedElement,
): Promise<{ x: number; y: number } | null> {
  if (typeof element.backendNodeId !== 'number') return null;
  try {
    const box = await session.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', {
      backendNodeId: element.backendNodeId,
    });
    const content = box.model?.content;
    if (!Array.isArray(content) || content.length < 8) return null;
    const xs = [content[0], content[2], content[4], content[6]];
    const ys = [content[1], content[3], content[5], content[7]];
    const x = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const y = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    return { x, y };
  } catch {
    return null;
  }
}

function modifierMask(modifiers?: string[]): number {
  let mask = 0;
  for (const modifier of modifiers ?? []) {
    switch (modifier.toLowerCase()) {
      case 'alt':
        mask |= 1;
        break;
      case 'ctrl':
      case 'control':
        mask |= 2;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
        mask |= 4;
        break;
      case 'shift':
        mask |= 8;
        break;
      default:
        break;
    }
  }
  return mask;
}

async function jsClick(session: CdpSession, element: ResolvedElement): Promise<boolean> {
  if (!element.objectId) return false;
  try {
    const result = await session.send<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
      objectId: element.objectId,
      functionDeclaration: 'function(){ this.click(); return true; }',
      returnByValue: true,
    });
    return result.result?.value === true;
  } catch {
    return false;
  }
}

export interface ClickOptions {
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  modifiers?: string[];
}

export async function clickElement(
  session: CdpSession,
  options: ClickOptions,
  refs: Map<string, number>,
): Promise<PageInfo> {
  let x = options.x;
  let y = options.y;
  let element: ResolvedElement | null = null;

  if (typeof x !== 'number' || typeof y !== 'number') {
    element = await resolveElement(session, options, refs);
    await scrollIntoView(session, element);
    const center = await elementCenter(session, element);
    if (!center) {
      if (await jsClick(session, element)) return getPageInfo(session);
      throw new Error('元素不可见或没有布局框，无法点击；可先 snapshot 或滚动页面');
    }
    x = center.x;
    y = center.y;
  }

  const button = options.button ?? 'left';
  const clickCount = Math.max(1, Math.min(3, Math.trunc(options.clickCount ?? 1)));
  const modifiers = modifierMask(options.modifiers);
  // 先移动再按下：Canvas 游戏依赖 mousemove/pointermove 更新指针命中状态，
  // 直接 pressed 会出现「坐标正确但游戏无反应」。
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons: 0,
    modifiers,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    clickCount,
    buttons: mouseButtonsMask(button),
    modifiers,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    clickCount,
    buttons: 0,
    modifiers,
  });
  return getPageInfo(session);
}

export async function hoverElement(
  session: CdpSession,
  options: { ref?: string; selector?: string },
  refs: Map<string, number>,
): Promise<PageInfo> {
  const element = await resolveElement(session, options, refs);
  await scrollIntoView(session, element);
  const center = await elementCenter(session, element);
  if (!center) throw new Error('元素不可见，无法悬停');
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
  return getPageInfo(session);
}

export interface DragOptions {
  fromRef?: string;
  fromSelector?: string;
  fromX?: number;
  fromY?: number;
  toRef?: string;
  toSelector?: string;
  toX?: number;
  toY?: number;
  button?: 'left' | 'right' | 'middle';
  steps?: number;
  durationMs?: number;
}

function mouseButtonsMask(button: 'left' | 'right' | 'middle'): number {
  if (button === 'right') return 2;
  if (button === 'middle') return 4;
  return 1;
}

/** 解析拖动起点/终点：坐标直接使用；元素取中心点（起点会先滚入视口） */
async function resolveDragPoint(
  session: CdpSession,
  target: ElementTarget,
  refs: Map<string, number>,
  scroll: boolean,
): Promise<{ x: number; y: number }> {
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    return { x: target.x, y: target.y };
  }
  const element = await resolveElement(session, target, refs);
  if (scroll) await scrollIntoView(session, element);
  const center = await elementCenter(session, element);
  if (!center) throw new Error('元素不可见或没有布局框，无法拖动；可先 snapshot 或改用坐标');
  return center;
}

/**
 * 按住鼠标从起点拖到终点（滑块/地图/画布/拖拽排序）。
 * 终点元素不再滚动，避免改变已计算的起点坐标。
 */
export async function dragElement(
  session: CdpSession,
  options: DragOptions,
  refs: Map<string, number>,
): Promise<PageInfo> {
  const from: ElementTarget = {
    ...(options.fromRef ? { ref: options.fromRef } : {}),
    ...(options.fromSelector ? { selector: options.fromSelector } : {}),
    ...(typeof options.fromX === 'number' ? { x: options.fromX } : {}),
    ...(typeof options.fromY === 'number' ? { y: options.fromY } : {}),
  };
  const to: ElementTarget = {
    ...(options.toRef ? { ref: options.toRef } : {}),
    ...(options.toSelector ? { selector: options.toSelector } : {}),
    ...(typeof options.toX === 'number' ? { x: options.toX } : {}),
    ...(typeof options.toY === 'number' ? { y: options.toY } : {}),
  };
  const start = await resolveDragPoint(session, from, refs, true);
  const end = await resolveDragPoint(session, to, refs, false);
  const button = options.button ?? 'left';
  const buttons = mouseButtonsMask(button);
  const steps = Math.max(2, Math.min(60, Math.trunc(options.steps ?? 12)));
  const durationMs = Math.max(0, Math.min(5000, Math.trunc(options.durationMs ?? 300)));
  const stepDelay = Math.round(durationMs / steps);

  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: start.x,
    y: start.y,
    button,
    clickCount: 1,
    buttons,
  });
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    const x = start.x + (end.x - start.x) * ratio;
    const y = start.y + (end.y - start.y) * ratio;
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons });
    if (stepDelay > 0) await sleep(stepDelay);
  }
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: end.x,
    y: end.y,
    button,
    clickCount: 1,
    buttons: 0,
  });
  return getPageInfo(session);
}

const KEY_MAP: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

for (let i = 1; i <= 12; i += 1) {
  KEY_MAP[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };
}

interface KeySpec {
  key: string;
  code: string;
  vk: number;
  text?: string;
}

function resolveKeySpec(key: string): KeySpec {
  const normalized = key.trim();
  if (!normalized) throw new Error('按键不能为空');
  const mapped = KEY_MAP[normalized.toLowerCase()];
  if (mapped) return mapped;
  return {
    key: normalized,
    code: normalized.length === 1 ? `Key${normalized.toUpperCase()}` : normalized,
    vk: normalized.length === 1 ? normalized.toUpperCase().charCodeAt(0) : 0,
    ...(normalized.length === 1 ? { text: normalized } : {}),
  };
}

function keyEventBase(spec: KeySpec, mask: number, autoRepeat = false): Record<string, unknown> {
  return {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    modifiers: mask,
    ...(autoRepeat ? { autoRepeat: true } : {}),
  };
}

/** 只按下按键（游戏/需要持续移动时配合 key_up 使用） */
export async function keyDown(
  session: CdpSession,
  key: string,
  modifiers?: string[],
  autoRepeat = false,
): Promise<void> {
  const spec = resolveKeySpec(key);
  const mask = modifierMask(modifiers);
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...keyEventBase(spec, mask, autoRepeat),
    ...(spec.text && mask === 0 ? { text: spec.text, unmodifiedText: spec.text } : {}),
  });
}

/** 抬起按键（与 keyDown 成对） */
export async function keyUp(session: CdpSession, key: string, modifiers?: string[]): Promise<void> {
  const spec = resolveKeySpec(key);
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    ...keyEventBase(spec, modifierMask(modifiers)),
  });
}

/** 同时按住多个键 durationMs 后全部抬起（一次调用完成持续移动/组合键） */
export async function holdKeys(
  session: CdpSession,
  keys: string[],
  durationMs: number,
  modifiers?: string[],
  signal?: AbortSignal,
): Promise<{ keys: string[]; durationMs: number }> {
  const normalized = keys.map((key) => key.trim()).filter((key) => key.length > 0);
  if (normalized.length === 0) throw new Error('按住操作至少需要一个按键');
  const duration = Math.max(0, Math.min(5000, Math.trunc(durationMs)));
  for (const key of normalized) await keyDown(session, key, modifiers);
  try {
    await sleep(duration, signal);
  } finally {
    for (const key of normalized.slice().reverse()) {
      await keyUp(session, key, modifiers).catch(() => undefined);
    }
  }
  return { keys: normalized, durationMs: duration };
}

async function dispatchKey(session: CdpSession, key: string, modifiers?: string[]): Promise<void> {
  const normalized = key.trim();
  if (!normalized) throw new Error('按键不能为空');
  const mask = modifierMask(modifiers);
  const mapped = KEY_MAP[normalized.toLowerCase()];
  if (!mapped && normalized.length === 1 && mask === 0) {
    await session.send('Input.insertText', { text: normalized });
    return;
  }
  const spec = resolveKeySpec(normalized);
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...keyEventBase(spec, mask),
    ...(spec.text && mask === 0 ? { text: spec.text, unmodifiedText: spec.text } : {}),
  });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyEventBase(spec, mask) });
}

export interface TypeOptions {
  ref?: string;
  selector?: string;
  text: string;
  replace?: boolean;
  submit?: boolean;
}

export async function typeInto(
  session: CdpSession,
  options: TypeOptions,
  refs: Map<string, number>,
): Promise<PageInfo> {
  const element = await resolveElement(session, options, refs);
  await scrollIntoView(session, element);
  if (typeof element.backendNodeId === 'number') {
    await session.send('DOM.focus', { backendNodeId: element.backendNodeId });
  } else if (element.objectId) {
    await session.send('Runtime.callFunctionOn', {
      objectId: element.objectId,
      functionDeclaration: 'function(){ this.focus(); }',
    });
  }
  if (options.replace) {
    await dispatchKey(session, 'a', ['ctrl']);
    await dispatchKey(session, 'Delete');
  }
  if (options.text) {
    await session.send('Input.insertText', { text: options.text });
  }
  if (options.submit) {
    await dispatchKey(session, 'Enter');
  }
  return getPageInfo(session);
}

export async function pressKey(session: CdpSession, key: string, modifiers?: string[]): Promise<PageInfo> {
  await dispatchKey(session, key, modifiers);
  return getPageInfo(session);
}

export async function selectOption(
  session: CdpSession,
  options: { ref?: string; selector?: string; values: string[] },
  refs: Map<string, number>,
): Promise<PageInfo> {
  const element = await resolveElement(session, options, refs);
  let objectId = element.objectId;
  if (!objectId && typeof element.backendNodeId === 'number') {
    const resolved = await session.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
      backendNodeId: element.backendNodeId,
    });
    objectId = resolved.object?.objectId;
  }
  if (!objectId) throw new Error('无法解析下拉框元素');
  const result = await session.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `function(values) {
        const el = this;
        if (!el || el.tagName !== 'SELECT') throw new Error('目标不是 select 元素');
        const wanted = new Set(Array.isArray(values) ? values.map(String) : []);
        let changed = false;
        for (const option of el.options) {
          const matched = wanted.has(option.value) || wanted.has(option.text) || wanted.has(option.label);
          if (option.selected !== matched) changed = true;
          option.selected = matched;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return Array.from(el.selectedOptions).map((option) => option.value);
      }`,
      arguments: [{ value: options.values }],
      returnByValue: true,
    },
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? '设置下拉框失败');
  }
  return getPageInfo(session);
}

export async function scrollPage(
  session: CdpSession,
  options: { ref?: string; deltaX?: number; deltaY?: number },
  refs: Map<string, number>,
): Promise<PageInfo> {
  if (options.ref) {
    const backendNodeId = refs.get(options.ref);
    if (typeof backendNodeId !== 'number') throw new Error(`ref ${options.ref} 已失效，请重新 snapshot`);
    await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    return getPageInfo(session);
  }
  const size = await session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression: 'JSON.stringify({w: innerWidth, h: innerHeight})',
    returnByValue: true,
  });
  let width = 800;
  let height = 600;
  if (typeof size.result?.value === 'string') {
    try {
      const parsed = JSON.parse(size.result.value) as { w?: unknown; h?: unknown };
      if (typeof parsed.w === 'number') width = parsed.w;
      if (typeof parsed.h === 'number') height = parsed.h;
    } catch {
      // 使用默认视口
    }
  }
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(width / 2),
    y: Math.round(height / 2),
    deltaX: options.deltaX ?? 0,
    deltaY: options.deltaY ?? 600,
  });
  return getPageInfo(session);
}

// ============================================================================
// evaluate / wait / console
// ============================================================================

export async function evaluateExpression(
  session: CdpSession,
  expression: string,
  allowEvaluate: boolean,
): Promise<{ result: string; type: string }> {
  if (!allowEvaluate) throw new Error('evaluate 已在 browser 工具配置中禁用');
  interface EvalResult {
    result?: { type?: string; value?: unknown; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }
  const response = await session.send<EvalResult>('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        '页面脚本执行异常',
    );
  }
  const result = response.result;
  const type = typeof result?.type === 'string' ? result.type : 'undefined';
  if (result?.value === undefined) {
    return { result: result?.description ?? 'undefined', type };
  }
  const value = result.value;
  if (typeof value === 'string') return { result: value, type };
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return { result: String(value), type };
  }
  try {
    return { result: JSON.stringify(value, null, 2), type };
  } catch {
    return { result: result.description ?? String(value), type };
  }
}

export async function waitCondition(
  session: CdpSession,
  options: { waitMs?: number; selector?: string; text?: string },
  run: PageRunOptions,
): Promise<PageInfo> {
  const started = Date.now();
  if (options.waitMs && options.waitMs > 0) {
    await sleep(Math.min(10_000, options.waitMs), run.signal);
  }
  if (options.selector || options.text) {
    const deadline = started + Math.max(1000, run.timeoutMs);
    while (Date.now() < deadline) {
      if (run.signal?.aborted) throw new Error('操作已中断');
      const expression = options.selector
        ? `!!document.querySelector(${JSON.stringify(options.selector)})`
        : `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(options.text ?? '')}))`;
      const check = await session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
      });
      if (check.result?.value === true) return getPageInfo(session);
      await sleep(250, run.signal);
    }
    throw new Error(`等待条件超时：${options.selector ?? options.text ?? ''}`);
  }
  return getPageInfo(session);
}

/** 单标签页 console / 异常缓冲 */
export class ConsoleBuffer {
  private entries: BrowserConsoleEntry[] = [];
  private readonly maxEntries = 200;
  private detachHandler: (() => void) | null = null;

  attach(session: CdpSession): void {
    this.dispose();
    this.detachHandler = session.onEvent((method, params) => this.onEvent(method, params));
  }

  dispose(): void {
    this.detachHandler?.();
    this.detachHandler = null;
  }

  list(clear = false): BrowserConsoleEntry[] {
    const copy = [...this.entries];
    if (clear) this.entries = [];
    return copy;
  }

  private onEvent(method: string, params: unknown): void {
    try {
      if (method === 'Runtime.consoleAPICalled') {
        const type = pickString(params, 'type') ?? 'log';
        const args = isObject(params) && Array.isArray(params.args) ? params.args : [];
        const text = args.map((arg) => formatRemoteObject(arg)).join(' ');
        this.push({ type, text, ts: Date.now() });
      } else if (method === 'Runtime.exceptionThrown') {
        const details = isObject(params) ? params.exceptionDetails : undefined;
        if (!isObject(details)) return;
        const exception = isObject(details.exception) ? details.exception : undefined;
        const text =
          pickString(exception, 'description') ?? pickString(details, 'text') ?? '页面异常（无详情）';
        this.push({ type: 'exception', text, ts: Date.now() });
      } else if (method === 'Log.entryAdded') {
        const entry = isObject(params) ? params.entry : undefined;
        if (!isObject(entry)) return;
        this.push({
          type: pickString(entry, 'level') ?? 'log',
          text: pickString(entry, 'text') ?? '',
          ts: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
          ...(pickString(entry, 'url') ? { url: pickString(entry, 'url') } : {}),
          ...(typeof entry.lineNumber === 'number' ? { line: entry.lineNumber } : {}),
        });
      }
    } catch {
      // console 解析失败不影响页面操作
    }
  }

  private push(entry: BrowserConsoleEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }
}

function formatRemoteObject(value: unknown): string {
  if (!isObject(value)) return String(value);
  const type = pickString(value, 'type') ?? '';
  if (type === 'string') return pickString(value, 'value') ?? '';
  if (type === 'undefined') return 'undefined';
  const description = pickString(value, 'description');
  if (description) return description;
  const raw = value.value;
  if (raw === undefined) return type || '[object]';
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

// ============================================================================
// 截图
// ============================================================================

interface SharpLike {
  resize: (options: Record<string, unknown>) => SharpLike;
  png: () => SharpLike;
  greyscale: () => SharpLike;
  raw: () => SharpLike;
  metadata: () => Promise<{ width?: number; height?: number }>;
  toBuffer: () => Promise<Buffer>;
}

type SharpFactory = (input: Buffer) => SharpLike;

let sharpPromise: Promise<SharpFactory | null> | null = null;

async function loadSharp(): Promise<SharpFactory | null> {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((mod) => {
        const factory = (mod as unknown as { default?: unknown }).default ?? mod;
        return typeof factory === 'function' ? (factory as SharpFactory) : null;
      })
      .catch(() => null);
  }
  return sharpPromise;
}

/**
 * 截图长边硬上限：与上下文图片优化 maxEdgePx(1568) 对齐。
 * 超过该值会被图片优化器再次缩放，导致工具回报尺寸与模型看到的图片不一致，
 * 坐标换算随之中断；因此工具层先统一到 ≤1568。
 */
const MAX_INLINE_EDGE = 1568;

export interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotResult {
  buffer: Buffer<ArrayBufferLike>;
  width?: number;
  height?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  dpr?: number;
  /** 图像像素 / CSS 像素（坐标换算用） */
  scale?: number;
  region?: ScreenshotRegion;
}

function clampEdge(value: number): number {
  if (value <= 0) return 0;
  return Math.min(value, MAX_INLINE_EDGE);
}

/** 读取视口尺寸与 DPR（失败不阻断截图） */
async function readViewport(session: CdpSession): Promise<{
  viewportWidth?: number;
  viewportHeight?: number;
  dpr?: number;
}> {
  try {
    const info = await getPageInfo(session);
    return {
      ...(info.viewportWidth !== undefined ? { viewportWidth: info.viewportWidth } : {}),
      ...(info.viewportHeight !== undefined ? { viewportHeight: info.viewportHeight } : {}),
      ...(info.dpr !== undefined ? { dpr: info.dpr } : {}),
    };
  } catch {
    return {};
  }
}

export async function captureScreenshot(
  session: CdpSession,
  fullPage: boolean,
  maxImageDimension: number,
  options: { region?: ScreenshotRegion } = {},
): Promise<ScreenshotResult> {
  const viewport = await readViewport(session);
  const edgeCap = clampEdge(maxImageDimension);
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  if (options.region) {
    const region = {
      x: Math.max(0, Math.trunc(options.region.x)),
      y: Math.max(0, Math.trunc(options.region.y)),
      width: Math.max(1, Math.trunc(options.region.width)),
      height: Math.max(1, Math.trunc(options.region.height)),
    };
    clip = { ...region, scale: 1 };
  } else if (fullPage) {
    const metrics = await session.send<{
      cssContentSize?: { width?: number; height?: number };
      contentSize?: { width?: number; height?: number };
    }>('Page.getLayoutMetrics');
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const width = Math.max(1, Math.ceil(size?.width ?? 0));
    const height = Math.max(1, Math.min(20_000, Math.ceil(size?.height ?? 0)));
    const scale = edgeCap > 0 ? Math.min(1, edgeCap / width) : 1;
    clip = { x: 0, y: 0, width, height, scale };
  }
  const capture = await session.send<{ data?: string }>('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: fullPage,
    ...(clip ? { clip } : {}),
  });
  if (typeof capture.data !== 'string' || !capture.data) throw new Error('截图失败（无数据）');
  let buffer: Buffer<ArrayBufferLike> = Buffer.from(capture.data, 'base64');
  let width: number | undefined;
  let height: number | undefined;
  if (edgeCap > 0) {
    const sharp = await loadSharp();
    if (sharp) {
      try {
        const meta = await sharp(buffer).metadata();
        width = meta.width;
        height = meta.height;
        const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
        if (longEdge > edgeCap) {
          buffer = await sharp(buffer)
            .resize({ width: edgeCap, height: edgeCap, fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer();
          const resized = await sharp(buffer).metadata();
          width = resized.width;
          height = resized.height;
        }
      } catch {
        // sharp 处理失败保留原图
      }
    }
  }
  const referenceWidth = options.region?.width ?? (clip ? clip.width : viewport.viewportWidth);
  const scale =
    width !== undefined && referenceWidth !== undefined && referenceWidth > 0
      ? width / referenceWidth
      : viewport.dpr;
  return {
    buffer,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...viewport,
    ...(scale !== undefined ? { scale } : {}),
    ...(options.region ? { region: options.region } : {}),
  };
}

// ============================================================================
// 画面变化检测（低分辨率灰度帧差；不返回图片，只返回变化百分比）
// ============================================================================

export interface FrameSignature {
  width: number;
  height: number;
  data: Buffer;
}

/** 抓取一帧低分辨率灰度签名（默认 96px 宽），用于判断画面是否发生变化 */
export async function frameSignature(
  session: CdpSession,
  options: { region?: ScreenshotRegion; maxWidth?: number } = {},
): Promise<FrameSignature> {
  const viewport = await readViewport(session);
  const maxWidth = Math.max(32, Math.min(320, Math.trunc(options.maxWidth ?? 96)));
  const region = options.region;
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  if (region) {
    clip = { ...region, scale: maxWidth / Math.max(1, region.width) };
  } else if (viewport.viewportWidth && viewport.viewportWidth > 0) {
    clip = {
      x: 0,
      y: 0,
      width: viewport.viewportWidth,
      height: Math.max(1, viewport.viewportHeight ?? viewport.viewportWidth),
      scale: maxWidth / viewport.viewportWidth,
    };
  }
  const capture = await session.send<{ data?: string }>('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    ...(clip ? { clip } : {}),
  });
  if (typeof capture.data !== 'string' || !capture.data) throw new Error('帧签名失败（无数据）');
  const buffer = Buffer.from(capture.data, 'base64');
  const sharp = await loadSharp();
  if (!sharp) throw new Error('帧差需要 sharp 但不可用');
  const raw = await sharp(buffer).resize({ width: maxWidth, fit: 'inside' }).greyscale().raw().toBuffer();
  return { width: maxWidth, height: 0, data: raw };
}

/** 两帧签名的平均绝对差（百分比 0-100） */
export function diffPercent(a: FrameSignature, b: FrameSignature): number {
  const length = Math.min(a.data.length, b.data.length);
  if (length === 0) return 0;
  let total = 0;
  for (let i = 0; i < length; i += 1) {
    total += Math.abs(a.data[i] - b.data[i]);
  }
  return Number(((total / length / 255) * 100).toFixed(2));
}

export interface FrameWaitOptions {
  region?: ScreenshotRegion;
  timeoutMs?: number;
  intervalMs?: number;
  /** 变化阈值（百分比）；默认 1.5 */
  threshold?: number;
  /** wait_stable 需要连续稳定采样次数；默认 2 */
  stableSamples?: number;
  signal?: AbortSignal;
}

export interface FrameWaitResult {
  matched: boolean;
  diffPercent: number;
  samples: number;
  elapsedMs: number;
  reason: 'stable' | 'changed' | 'timeout';
}

async function captureSignatureForWait(session: CdpSession, options: FrameWaitOptions): Promise<FrameSignature> {
  return frameSignature(session, options.region ? { region: options.region } : {});
}

/** 等待画面稳定（连续 stableSamples 次变化低于阈值） */
export async function waitStable(session: CdpSession, options: FrameWaitOptions = {}): Promise<FrameWaitResult> {
  const timeoutMs = Math.max(100, Math.min(10_000, options.timeoutMs ?? 3000));
  const intervalMs = Math.max(30, Math.min(1000, options.intervalMs ?? 80));
  const threshold = Math.max(0, Math.min(100, options.threshold ?? 1.5));
  const required = Math.max(1, Math.min(10, Math.trunc(options.stableSamples ?? 2)));
  const started = Date.now();
  let previous = await captureSignatureForWait(session, options);
  let samples = 1;
  let stable = 0;
  let delta = 0;
  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) throw new Error('操作已中断');
    await sleep(intervalMs, options.signal);
    const current = await captureSignatureForWait(session, options);
    samples += 1;
    delta = diffPercent(previous, current);
    previous = current;
    if (delta <= threshold) {
      stable += 1;
      if (stable >= required) {
        return { matched: true, diffPercent: delta, samples, elapsedMs: Date.now() - started, reason: 'stable' };
      }
    } else {
      stable = 0;
    }
  }
  return {
    matched: false,
    diffPercent: delta,
    samples,
    elapsedMs: Date.now() - started,
    reason: 'timeout',
  };
}

/** 等待画面发生变化（变化超过阈值即返回） */
export async function waitChange(session: CdpSession, options: FrameWaitOptions = {}): Promise<FrameWaitResult> {
  const timeoutMs = Math.max(100, Math.min(10_000, options.timeoutMs ?? 3000));
  const intervalMs = Math.max(30, Math.min(1000, options.intervalMs ?? 80));
  const threshold = Math.max(0, Math.min(100, options.threshold ?? 1.5));
  const started = Date.now();
  const baseline = await captureSignatureForWait(session, options);
  let samples = 1;
  let delta = 0;
  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) throw new Error('操作已中断');
    await sleep(intervalMs, options.signal);
    const current = await captureSignatureForWait(session, options);
    samples += 1;
    delta = diffPercent(baseline, current);
    if (delta > threshold) {
      return { matched: true, diffPercent: delta, samples, elapsedMs: Date.now() - started, reason: 'changed' };
    }
  }
  return {
    matched: false,
    diffPercent: delta,
    samples,
    elapsedMs: Date.now() - started,
    reason: 'timeout',
  };
}
