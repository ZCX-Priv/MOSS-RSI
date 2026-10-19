// webui/src/components/shared/MentionEditor.tsx
// contenteditable 内联 token 编辑器（/ 命令、@ 智能体、# 文件引用）。
//
// 架构要点（为什么是「命令式 DOM」而不是 React 渲染子树）：
//   把 chip 交给 React 协调，会在输入过程中重置光标、破坏 IME 组合——这是自研
//   contenteditable 最大的坑。因此 React 只渲染一个空容器，内部节点（文本节点 +
//   chip 元素）全部用 DOM API 命令式创建/修改；chip 通过 data-* 自描述，
//   不依赖 JS 注册表，撤销/重做后依然自洽。
//
// 权威口径：
//   线格式（wire）  = 序列化文本 = 剪贴板文本 = 发送正文 = LLM 可见文本
//   占位符口径      = 触发判定专用（token 序列化为 U+FFFC，非空白，避免 token
//                     内部含 # / @ / 干扰 detectTrigger）
//
// 不作为：富文本（不加粗/列表）、拖拽、HTML 粘贴；粘贴一律降级为纯文本 + token。

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  chipVariant,
  computeFileLabels,
  detectTrigger,
  parseMentionText,
  tokenWireText,
  type ComposerToken,
  type MentionItem,
  type MentionKind,
  type MentionLookups,
  type TriggerMatch,
} from './mention-data';
import { matchesShortcut } from '../../utils/shortcut';
import { fileNameOf } from '../../render/file/detector';
import { MentionTokenIcon } from './MentionTokenIcon';
import { cn } from '@/lib/utils';

/** token 在触发判定口径下的占位符（对象替换符，非空白字符） */
const PLACEHOLDER_CHAR = '\uFFFC';

/**
 * 文本序列化口径（**混用会直接导致删错位置**，所有 offset 必须两端同口径）：
 *   wire        线格式：file token = `#<绝对路径>` 全长（剪贴板/发送/气泡用）
 *   placeholder 触发判定：每个 token 记 1 个字符（非空白，避免 token 内部含 / @ # 干扰）
 */
type OffsetMode = 'wire' | 'placeholder';

/** chip 图标 portal 目标 */
interface IconHost {
  /** 稳定 key（随宿主元素首次出现分配，避免用下标导致 portal 重挂载） */
  id: number;
  host: HTMLElement;
  token: ComposerToken;
}

// ============================================================================
// DOM ↔ 文本 工具（模块级纯函数，便于单测与复用）
// ============================================================================

/** chip 元素判定：带 data-kind 的原子元素（返回 boolean，避免类型谓词把 else 分支窄化成 never） */
function isChipNode(node: Node | null | undefined): boolean {
  return (
    !!node &&
    node.nodeType === Node.ELEMENT_NODE &&
    (node as HTMLElement).hasAttribute('data-kind')
  );
}

/** chip DOM → token（data-* 自描述，撤销/重做后不失效） */
export function chipToToken(el: HTMLElement): ComposerToken | null {
  const kind = el.getAttribute('data-kind');
  if (kind === 'command') {
    const name = el.getAttribute('data-name') ?? '';
    if (!name) return null;
    return {
      kind: 'command',
      source: el.getAttribute('data-source') === 'skill' ? 'skill' : 'command',
      name,
    };
  }
  if (kind === 'agent') {
    const name = el.getAttribute('data-name') ?? '';
    if (!name) return null;
    return { kind: 'agent', id: el.getAttribute('data-id') ?? '', name };
  }
  if (kind === 'file') {
    const path = el.getAttribute('data-path') ?? '';
    if (!path) return null;
    return { kind: 'file', path };
  }
  return null;
}

/** 单节点的序列化长度（与 serializeChild 严格同口径） */
function childLength(node: Node, mode: OffsetMode): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? '').length;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    if (isChipNode(el)) {
      if (mode === 'placeholder') return 1;
      const token = chipToToken(el);
      return token ? tokenWireText(token).length : (el.textContent ?? '').length;
    }
    if (el.tagName === 'BR') return 1;
    let len = 0;
    el.childNodes.forEach((c) => {
      len += childLength(c, mode);
    });
    // 块级子元素（防御：正常流程已拦截 Enter，浏览器不会插入 div/p）
    if ((el.tagName === 'DIV' || el.tagName === 'P') && el.parentNode) {
      const idx = Array.prototype.indexOf.call(el.parentNode.childNodes, el);
      if (idx > 0) len += 1;
    }
    return len;
  }
  return 0;
}

function serializeChild(node: Node, mode: OffsetMode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.nodeValue ?? '').replace(/\u00A0/g, ' ');
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    if (isChipNode(el)) {
      if (mode === 'placeholder') return PLACEHOLDER_CHAR;
      const token = chipToToken(el);
      return token ? tokenWireText(token) : (el.textContent ?? '');
    }
    if (el.tagName === 'BR') return '\n';
    let out = '';
    el.childNodes.forEach((child, i) => {
      const isBlock = el.tagName === 'DIV' || el.tagName === 'P';
      if (isBlock && i > 0) out += '\n';
      out += serializeChild(child, mode);
    });
    return out;
  }
  return '';
}

/** 容器 → 文本（wire = 线格式；placeholder = 触发判定口径） */
export function serializeRoot(root: HTMLElement, mode: OffsetMode): string {
  let out = '';
  root.childNodes.forEach((node) => {
    out += serializeChild(node, mode);
  });
  return out;
}

/** 序列化偏移 → DOM 位置（文本节点内偏移，或容器 + 子节点下标） */
interface DomPos {
  node: Node;
  offset: number;
}

function locate(root: HTMLElement, index: number, mode: OffsetMode): DomPos {
  let acc = 0;
  const children = Array.from(root.childNodes);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const len = childLength(child, mode);
    if (index <= acc + len) {
      if (child.nodeType === Node.TEXT_NODE) {
        return { node: child, offset: Math.max(0, index - acc) };
      }
      // chip / BR / 元素边界：落在起点之前或之后
      return { node: root, offset: index === acc ? i : i + 1 };
    }
    acc += len;
  }
  return { node: root, offset: children.length };
}

/** 序列化偏移区间 → DOM Range */
function offsetToRange(
  root: HTMLElement,
  start: number,
  end: number,
  mode: OffsetMode,
): Range {
  const s = locate(root, start, mode);
  const e = locate(root, end, mode);
  const range = document.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}

/** DOM 边界 → 序列化偏移 */
function boundaryToOffset(
  root: HTMLElement,
  node: Node,
  offset: number,
  mode: OffsetMode,
): number {
  let total = 0;
  if (node.nodeType === Node.TEXT_NODE) {
    total += offset;
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    const kids = node.childNodes;
    for (let i = 0; i < Math.min(offset, kids.length); i++) {
      total += childLength(kids[i], mode);
    }
  }
  let cur: Node | null = node;
  while (cur && cur !== root) {
    let sib: Node | null = cur.previousSibling;
    while (sib) {
      total += childLength(sib, mode);
      sib = sib.previousSibling;
    }
    cur = cur.parentNode;
  }
  return total;
}

/** 当前光标（折叠选区）在指定口径下的偏移；选区不在容器内时返回 null */
function caretOffset(root: HTMLElement, mode: OffsetMode): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  return boundaryToOffset(root, range.startContainer, range.startOffset, mode);
}

/**
 * 创建 chip 元素（自描述 + 图标宿主）。
 * 结构：`[.mchip-icon 图标宿主（React portal 目标）] + [.mchip-label 文本]`
 * 文本只有名称/标签，不带触发符（触发符由图标承担，与 / @ 菜单一致）。
 */
function createChipElement(token: ComposerToken, label: string): HTMLElement {
  const span = document.createElement('span');
  // 视觉变体走 chipVariant：skill（蓝）与 command（紫）在 class 上就分开
  span.className = `mchip mchip--${chipVariant(token)}`;
  span.setAttribute('contenteditable', 'false');
  span.setAttribute('data-kind', token.kind);
  span.setAttribute('spellcheck', 'false');

  if (token.kind === 'command') {
    span.setAttribute('data-source', token.source);
    span.setAttribute('data-name', token.name);
  } else if (token.kind === 'agent') {
    span.setAttribute('data-id', token.id);
    span.setAttribute('data-name', token.name);
  } else {
    span.setAttribute('data-path', token.path);
    span.setAttribute('data-label', label);
    span.setAttribute('title', token.path);
  }

  const icon = document.createElement('span');
  icon.className = 'mchip-icon';
  span.appendChild(icon);

  const text = document.createElement('span');
  text.className = 'mchip-label';
  text.textContent = token.kind === 'file' ? label : token.name;
  span.appendChild(text);
  return span;
}

/** 把 &nbsp; 归一化为普通空格（浏览器双击空格会插入 nbsp，会污染序列化口径） */
function normalizeNbsp(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if ((t.nodeValue ?? '').includes('\u00A0')) targets.push(t);
  }
  targets.forEach((t) => {
    t.nodeValue = (t.nodeValue ?? '').replace(/\u00A0/g, ' ');
  });
}

/** 构造语音草稿的 DOM 节点序列：换行按 <br> 插入（与 wire 口径长度一致） */
function buildVoiceNodes(text: string): Node[] {
  const nodes: Node[] = [];
  text.split('\n').forEach((part, i) => {
    if (i > 0) nodes.push(document.createElement('br'));
    if (part) nodes.push(document.createTextNode(part));
  });
  return nodes;
}

/** 在光标处插入节点序列，并把光标落到插入内容之后 */
function insertNodesAtCaret(root: HTMLElement, nodes: Node[]): void {
  const sel = window.getSelection();
  let range: Range;
  if (sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer)) {
    range = sel.getRangeAt(0);
    range.deleteContents();
  } else {
    range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
  }
  const frag = document.createDocumentFragment();
  nodes.forEach((n) => frag.appendChild(n));
  const last = frag.lastChild;
  range.insertNode(frag);
  if (last) {
    const after = document.createRange();
    after.setStartAfter(last);
    after.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(after);
  }
}

/**
 * HTML → 纯文本（仅用于剪贴板只提供 text/html 的环境，如部分 WebView / iOS）。
 * 先给块级元素/`<br>` 补换行，再取 textContent，避免多段文字粘连成一行。
 */
function htmlToPlainText(html: string): string {
  const el = document.createElement('div');
  el.innerHTML = html;
  el.querySelectorAll('br').forEach((br) => br.replaceWith(document.createTextNode('\n')));
  el.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6').forEach((block) =>
    block.append(document.createTextNode('\n')),
  );
  return el.textContent ?? '';
}

/**
 * 在光标处插入换行。
 *
 * 必须交给浏览器原生 `insertLineBreak`：手动插入单个 `<br>` 或 `'\n'` 时，
 * Chrome 会把末尾的光标规范化回上一行文本末尾（实测：`abc<br>` 后继续输入得到
 * `abcdef<br>`），表现为「按 Enter 无效 / 要按两次」。
 * 原生命令会额外保留一个「占位换行」来让光标稳定落在新行，该占位在用户继续输入时
 * 自动被消费；序列化对外文本时由 wireValue 剥离（见下）。
 * 命令不可用时回退为手动插入 `<br>`（至少保证换行节点存在）。
 */
function insertLineBreakAtCaret(root: HTMLElement): void {
  if (typeof document !== 'undefined' && document.execCommand('insertLineBreak')) return;
  insertNodesAtCaret(root, [document.createElement('br')]);
}

/**
 * 对外线格式文本：剥离末尾的「占位换行」。
 * 原生换行会在容器末尾保留 1 个换行用于定位光标（DOM 层），它不是用户输入的内容，
 * 因此所有对外出口（getValue / onChange / isEmpty）必须剥离，避免消息末尾凭空多出空行。
 * 注意：仅用于「对外的完整文本」，内部 offset 计算仍走 serializeRoot（含占位，
 * 必须与 DOM 严格同口径）。
 */
function wireValue(root: HTMLElement): string {
  const s = serializeRoot(root, 'wire');
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

// ============================================================================
// 组件
// ============================================================================

export interface MentionEditorHandle {
  /** 线格式序列化文本 */
  getValue(): string;
  isEmpty(): boolean;
  clear(): void;
  focus(): void;
  /** 在光标处插入 token（Plus 命令菜单等入口；自动补必要的分隔空格） */
  insertToken(token: ComposerToken): void;
  /** 选中菜单项：删除触发词并以 token 替换（菜单点击 / 键盘 Enter 共用） */
  commitMention(item: MentionItem): void;
  /** 语音输入：写入/覆盖草稿（首次调用记录当前光标为锚点） */
  setVoiceDraft(text: string): void;
  /** 语音输入：固化草稿（内容保留，清空草稿态） */
  commitVoice(): void;
  /** 覆盖编辑器内容（「编辑队列消息」回填用）：清空后按 wire 格式写入文本（\n→<br>） */
  setValue(text: string): void;
}

interface MentionEditorProps {
  placeholder: string;
  /** 当前触发状态（父层持有，用于渲染 MentionMenu） */
  trigger: TriggerMatch | null;
  /** 已过滤的菜单项 */
  items: MentionItem[];
  activeIndex: number;
  /** 线格式文本变化 */
  onChange: (value: string) => void;
  onTriggerChange: (match: TriggerMatch | null) => void;
  onActiveIndexChange: (index: number) => void;
  onMenuClose: () => void;
  /** 菜单项选中后的副作用（切智能体 / 记录最近命令） */
  onItemSelected: (item: MentionItem) => void;
  /** 同一文件被重复引用（父层 toast 提示） */
  onDuplicateFile: (path: string) => void;
  /** 剪贴板文件（图片/任意文件；父层落盘为附件，不进入输入框） */
  onPasteFiles?: (files: File[]) => void;
  /** 线格式反解析名单（粘贴还原用） */
  lookups: MentionLookups;
  sendShortcut: string;
  onSend: () => void;
  /** 允许触发的类型（缺省全部：command/agent/file）；用于在受限场景禁用某类触发（如 ask 卡片禁用 agent） */
  allowedTriggers?: MentionKind[];
  className?: string;
}

export const MentionEditor = forwardRef<MentionEditorHandle, MentionEditorProps>(function MentionEditor(
  {
    placeholder,
    trigger,
    items,
    activeIndex,
    onChange,
    onTriggerChange,
    onActiveIndexChange,
    onMenuClose,
    onItemSelected,
    onDuplicateFile,
    onPasteFiles,
    lookups,
    sendShortcut,
    onSend,
    allowedTriggers,
    className,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  /** 语音草稿锚点（wire offset；null = 未处于语音输入草稿态） */
  const voiceAnchorRef = useRef<number | null>(null);
  /** 当前语音草稿占用的字符数（写入新草稿前先删除该区间） */
  const voiceDraftLenRef = useRef(0);
  /** Esc 关闭后抑制同一 token 再次弹出（token 变化或消失后解除） */
  const suppressedTokenRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  const onTriggerChangeRef = useRef(onTriggerChange);
  const onMenuCloseRef = useRef(onMenuClose);
  const onDuplicateRef = useRef(onDuplicateFile);
  const onPasteFilesRef = useRef(onPasteFiles);
  const lookupsRef = useRef(lookups);
  const menuOpenRef = useRef(false);
  const itemsRef = useRef(items);
  const activeIndexRef = useRef(activeIndex);
  const onSelectRef = useRef(onItemSelected);
  const onSendRef = useRef(onSend);
  const sendShortcutRef = useRef(sendShortcut);
  /** 允许触发的类型白名单（缺省全部）；用 ref 防止 recomputeTrigger 闭包陈旧 */
  const allowedTriggersRef = useRef<MentionKind[] | undefined>(allowedTriggers);

  onChangeRef.current = onChange;
  onTriggerChangeRef.current = onTriggerChange;
  onMenuCloseRef.current = onMenuClose;
  onDuplicateRef.current = onDuplicateFile;
  onPasteFilesRef.current = onPasteFiles;
  lookupsRef.current = lookups;
  menuOpenRef.current = Boolean(trigger);
  itemsRef.current = items;
  activeIndexRef.current = activeIndex;
  onSelectRef.current = onItemSelected;
  onSendRef.current = onSend;
  sendShortcutRef.current = sendShortcut;
  allowedTriggersRef.current = allowedTriggers;

  /** chip 图标 portal 目标（宿主元素 + 对应 token） */
  const [iconHosts, setIconHosts] = useState<IconHost[]>([]);
  /** 宿主元素 → 稳定 portal key */
  const iconHostIdsRef = useRef(new Map<HTMLElement, number>());
  const nextIconHostIdRef = useRef(0);

  const autosize = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    root.style.height = 'auto';
    root.style.height = `${root.scrollHeight}px`;
  }, []);

  /** 重算全部 file chip 的「最小区分标签」 */
  const relabelFileChips = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const chips = Array.from(root.querySelectorAll<HTMLElement>('[data-kind="file"]'));
    if (chips.length === 0) return;
    const paths = chips.map((c) => c.getAttribute('data-path') ?? '').filter(Boolean);
    const labels = computeFileLabels(paths);
    chips.forEach((chip) => {
      const path = chip.getAttribute('data-path') ?? '';
      if (!path) return;
      const label = labels.get(path) ?? fileNameOf(path);
      chip.setAttribute('data-label', label);
      const labelEl = chip.querySelector('.mchip-label');
      if (labelEl && labelEl.textContent !== label) labelEl.textContent = label;
    });
  }, []);

  /** 空内容 ⇔ 占位符可见 */
  const refreshEmptyFlag = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    // 空 = 剥离「末尾占位换行」后无内容（wireValue）。
    // Enter 会留下「真实换行 + 末尾占位」（实测空编辑器按一次 Enter → ["\n","\n"]），
    // 剥掉占位后仍剩真实换行 → 非空（占位符消失）；
    // contenteditable 被删空后仅残留 1 个占位 <br>（序列化 '\n'）→ 剥离后为空（占位符恢复）；
    // 空格不在末尾换行之列，不会被剥离 → 非空（保持「空格算内容」）。
    const empty = wireValue(root).length === 0;
    root.setAttribute('data-empty', empty ? 'true' : 'false');
  }, []);

  /**
   * 同步 chip 图标宿主（React portal 目标）。
   * chip 是命令式 DOM，图标却要复用 React 资产（FileTypeIcon/缩略图/lucide），
   * 因此由本组件把图标 portal 进各 chip 的 .mchip-icon 宿主；
   * 删除/清空/剪切/撤销导致 chip 消失时，下一次同步自动回收对应 portal。
   */
  const syncIconHosts = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const idMap = iconHostIdsRef.current;
    const next: IconHost[] = [];
    root.querySelectorAll<HTMLElement>('[data-kind] .mchip-icon').forEach((host) => {
      const chip = host.parentElement;
      const token = chip ? chipToToken(chip) : null;
      if (!token) return;
      let id = idMap.get(host);
      if (id === undefined) {
        id = ++nextIconHostIdRef.current;
        idMap.set(host, id);
      }
      next.push({ id, host, token });
    });
    // 回收已脱离文档的宿主 key（删除/清空/剪切/撤销）
    Array.from(idMap.keys()).forEach((host) => {
      if (!root.contains(host)) idMap.delete(host);
    });
    setIconHosts((prev) => {
      if (prev.length === next.length && prev.every((item, i) => item.host === next[i].host)) {
        return prev; // 宿主集合未变 → 不触发重渲染（避免 selectionchange 回环）
      }
      return next;
    });
  }, []);

  const recomputeTrigger = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const caret = caretOffset(root, 'placeholder');
    if (caret === null) {
      onTriggerChangeRef.current(null);
      return;
    }
    const match = detectTrigger(serializeRoot(root, 'placeholder'), caret);
    if (!match || (allowedTriggersRef.current && !allowedTriggersRef.current.includes(match.kind))) {
      suppressedTokenRef.current = null;
      onTriggerChangeRef.current(null);
      return;
    }
    if (suppressedTokenRef.current === match.tokenStart) {
      onTriggerChangeRef.current(null);
      return;
    }
    onTriggerChangeRef.current(match);
  }, []);

  /** DOM → 父层 单向同步（输入 / 粘贴 / 删除 / 撤销 后统一走这里） */
  const syncFromDom = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    normalizeNbsp(root);
    relabelFileChips();
    refreshEmptyFlag();
    autosize();
    syncIconHosts();
    onChangeRef.current(wireValue(root));
    recomputeTrigger();
  }, [autosize, refreshEmptyFlag, relabelFileChips, syncIconHosts, recomputeTrigger]);

  /** 当前容器内全部 file token 的绝对路径 */
  const filePaths = useCallback((): string[] => {
    const root = rootRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('[data-kind="file"]'))
      .map((c) => c.getAttribute('data-path') ?? '')
      .filter(Boolean);
  }, []);

  /**
   * 在指定区间插入 token（删除 [start,end) 后插入；必要时补前导空格保证线格式可反解析）。
   * @param mode start/end 的文本口径，**必须与调用方计算 offset 的口径一致**
   *             （触发词替换 = placeholder；Plus 菜单光标插入 = wire）
   * @returns 实际是否插入了 chip（file 重复引用时为 false）
   */
  const replaceRangeWithToken = useCallback(
    (start: number, end: number, token: ComposerToken, mode: OffsetMode = 'wire'): boolean => {
      const root = rootRef.current;
      if (!root) return false;
      if (token.kind === 'file' && filePaths().includes(token.path)) {
        // 重复引用：toast 提示 + 仅删除触发词，不插入第二个 chip
        offsetToRange(root, start, end, mode).deleteContents();
        syncFromDom();
        onDuplicateRef.current(token.path);
        return false;
      }
      const range = offsetToRange(root, start, end, mode);
      // 「前导是否需要空格」必须按**线格式**判断（与插入位置无关地换算一次 wire 偏移）
      const wireStart = boundaryToOffset(root, range.startContainer, range.startOffset, 'wire');
      const before = serializeRoot(root, 'wire').slice(0, wireStart);
      range.deleteContents();
      const nodes: Node[] = [];
      if (before.length > 0 && !/\s$/.test(before)) nodes.push(document.createTextNode(' '));
      const allPaths =
        token.kind === 'file' ? [...filePaths(), token.path] : filePaths();
      const label =
        token.kind === 'file'
          ? (computeFileLabels(allPaths).get(token.path) ?? fileNameOf(token.path))
          : '';
      nodes.push(createChipElement(token, label));
      insertNodesAtCaret(root, nodes);
      syncFromDom();
      return true;
    },
    [filePaths, syncFromDom],
  );

  /** 菜单项 → token */
  const itemToToken = useCallback((item: MentionItem): ComposerToken | null => {
    if (item.kind === 'command') {
      if (!item.data) return null;
      return { kind: 'command', source: item.data.source, name: item.data.name };
    }
    if (item.kind === 'agent') {
      return { kind: 'agent', id: item.id, name: item.name };
    }
    return { kind: 'file', path: item.id };
  }, []);

  const commitMention = useCallback(
    (item: MentionItem) => {
      const root = rootRef.current;
      if (!root || !trigger) return;
      const token = itemToToken(item);
      if (!token) return;
      root.focus();
      // ⚠️ 口径必须与 detectTrigger 一致（都是 placeholder）：tokenStart 由
      // serializeRoot(root,'placeholder') 得出，若按 wire 口径删除，光标前存在 chip 时
      // 区间会整体左移（chip 在两种口径下长度不同）→ 触发词残留 + 多补空格。
      const caret = caretOffset(root, 'placeholder') ?? trigger.tokenStart + trigger.query.length + 1;
      replaceRangeWithToken(trigger.tokenStart, Math.max(trigger.tokenStart, caret), token, 'placeholder');
      suppressedTokenRef.current = null;
      onSelectRef.current(item);
      onMenuCloseRef.current();
    },
    [trigger, itemToToken, replaceRangeWithToken],
  );

  /** 在光标处插入 token（Plus 命令菜单入口） */
  const insertTokenAtCaret = useCallback(
    (token: ComposerToken) => {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      const caret = caretOffset(root, 'wire') ?? serializeRoot(root, 'wire').length;
      replaceRangeWithToken(caret, caret, token);
    },
    [replaceRangeWithToken],
  );

  /**
   * 语音草稿写入：在锚点处用最新识别文本替换上一次草稿（partial 覆盖语义）。
   * 首次调用记录当前光标为锚点（「光标在哪就从哪开始输入」）。
   * 换行按 <br> 插入，保证 wire 口径长度与文本长度一致（可精确回算光标）。
   */
  const setVoiceDraft = useCallback(
    (text: string) => {
      const root = rootRef.current;
      if (!root) return;
      // 是否聚焦只影响「锚点取光标还是取末尾」与「是否移动光标」，
      // 不再调用 root.focus()：异步 WS 回调里抢焦点会破坏选区，导致文本不入框。
      const focused = document.activeElement === root;
      if (voiceAnchorRef.current === null) {
        const caret = focused ? caretOffset(root, 'wire') : null;
        voiceAnchorRef.current = caret ?? serializeRoot(root, 'wire').length;
        voiceDraftLenRef.current = 0;
      }
      const anchor = voiceAnchorRef.current;
      const range = offsetToRange(root, anchor, anchor + voiceDraftLenRef.current, 'wire');
      range.deleteContents();

      const frag = document.createDocumentFragment();
      buildVoiceNodes(text).forEach((n) => frag.appendChild(n));
      const insertAt = document.createRange();
      insertAt.setStart(range.startContainer, range.startOffset);
      insertAt.collapse(true);
      insertAt.insertNode(frag);

      // 校验：锚点/选区计算异常时兜底追加，保证识别文本一定上屏
      if (!wireValue(root).includes(text)) {
        const before = wireValue(root).length;
        insertNodesAtCaret(root, buildVoiceNodes(text));
        voiceAnchorRef.current = before;
      }

      // 仅在编辑器本就有焦点时把光标落到草稿末尾（未聚焦不动选区）
      if (focused) {
        const end = offsetToRange(root, anchor + text.length, anchor + text.length, 'wire');
        const sel = window.getSelection();
        if (sel) {
          const after = document.createRange();
          after.setStart(end.startContainer, end.startOffset);
          after.collapse(true);
          sel.removeAllRanges();
          sel.addRange(after);
        }
      }
      voiceDraftLenRef.current = text.length;
      syncFromDom();
    },
    [syncFromDom],
  );

  /** 固化语音草稿：内容保留，仅清空草稿态（下次语音从新光标开始） */
  const commitVoice = useCallback(() => {
    voiceAnchorRef.current = null;
    voiceDraftLenRef.current = 0;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getValue: () => {
        const root = rootRef.current;
        return root ? wireValue(root) : '';
      },
      isEmpty: () => {
        const root = rootRef.current;
        return !root || wireValue(root).trim().length === 0;
      },
      clear: () => {
        const root = rootRef.current;
        if (!root) return;
        root.innerHTML = '';
        syncFromDom();
        root.focus();
      },
      focus: () => rootRef.current?.focus(),
      insertToken: insertTokenAtCaret,
      commitMention,
      setVoiceDraft,
      commitVoice,
      setValue: (text: string) => {
        const root = rootRef.current;
        if (!root) return;
        root.innerHTML = '';
        // 复用语音草稿的建节点逻辑：\n → <br>，保证 wire 口径与文本一致
        for (const node of buildVoiceNodes(text)) root.appendChild(node);
        syncFromDom();
        root.focus();
        // 光标落到末尾，便于用户直接续写
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(root);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      },
    }),
    [syncFromDom, insertTokenAtCaret, commitMention, setVoiceDraft, commitVoice],
  );

  // 初始占位符状态 + 初始高度
  useLayoutEffect(() => {
    refreshEmptyFlag();
    autosize();
  }, [refreshEmptyFlag, autosize]);

  // 光标移动（点击 / 方向键）也要重算触发状态；文档级 selectionchange 覆盖 contenteditable 的选区变化
  useEffect(() => {
    const onSelectionChange = () => {
      const root = rootRef.current;
      if (!root || document.activeElement !== root) return;
      if (isComposingRef.current) return;
      recomputeTrigger();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [recomputeTrigger]);

  /**
   * DOM 兜底同步（占位符 / 高度）：无论输入、删除、粘贴、剪切、撤销、IME、execCommand
   * 哪条路径改动了 DOM，都保证 data-empty 与高度最终一致——彻底消除「某条路径漏调
   * syncFromDom 导致占位符判定停在旧值」的一整类 bug（含 Android Chrome 的事件差异）。
   * 只观察 childList + characterData（不观察 attributes）：自身写 style.height / data-* 不自激。
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mo = new MutationObserver(() => {
      refreshEmptyFlag();
      autosize();
    });
    mo.observe(root, { childList: true, characterData: true, subtree: true });
    return () => mo.disconnect();
  }, [refreshEmptyFlag, autosize]);

  /** 组合态标记：data-composing 期间 CSS 隐藏占位符（预编辑文本会进 DOM，占位符必须让位） */
  const setComposingFlag = (on: boolean) => {
    const root = rootRef.current;
    if (!root) return;
    if (on) root.setAttribute('data-composing', 'true');
    else root.removeAttribute('data-composing');
  };

  const handleInput = (e: FormEvent<HTMLDivElement>) => {
    const native = e.nativeEvent as InputEvent;
    // IME 组合期：预编辑文本已写入 DOM，但组合未提交，绝不能回传 onChange / 触发菜单；
    // 但仍需同步占位符与高度，否则预编辑文本与 placeholder 叠字。
    //
    // 组合判定以事件自带的 isComposing 为准（权威）：Android(Chrome) 上 compositionend
    // 可能缺失或与 input 乱序，若沿用「isComposingRef.current || native.isComposing」，
    // 一旦 ref 卡 true，后续所有 input 都会走组合分支直接 return —— 既不回 onChange 也不刷新
    // data-empty，表现为「IME 提交后占位符不消失 / 删空后占位符不出现 / 发送按钮失灵」。
    const flag = (native as InputEvent).isComposing as boolean | undefined;
    const composing = flag === undefined ? isComposingRef.current : flag;
    // 自愈：事件已声明「非组合」而引用仍为 true（IME 漏发 compositionend）→ 清掉卡死状态
    if (flag === false && isComposingRef.current) isComposingRef.current = false;
    setComposingFlag(composing);
    if (composing) {
      refreshEmptyFlag();
      autosize();
      return;
    }
    // 用户手动编辑：语音草稿锚点失效并重置（下次语音从当前光标重新开始）
    voiceAnchorRef.current = null;
    voiceDraftLenRef.current = 0;
    syncFromDom();
  };

  // 失焦兜底：清掉可能残留的组合标记，避免 data-composing 卡住导致占位符永不显示
  const handleBlur = () => {
    isComposingRef.current = false;
    setComposingFlag(false);
    refreshEmptyFlag();
  };

  /**
   * 原子删除：光标紧邻 chip 时整体删除（确定性兜底，不依赖浏览器差异）。
   * 只看折叠选区的 (node, offset)：
   *   - 文本节点：前删要求 offset=0（后删要求 offset=len），再看相邻兄弟
   *   - 元素节点：offset 即子节点下标，直接看前后兄弟
   */
  const deleteAdjacentChip = (dir: -1 | 1): boolean => {
    const root = rootRef.current;
    if (!root) return false;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const offset = range.startOffset;
    if (!root.contains(node)) return false;

    let parent: Node;
    let siblingIndex: number;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.nodeValue ?? '').length;
      if (dir < 0 && offset !== 0) return false;
      if (dir > 0 && offset !== len) return false;
      parent = node.parentNode ?? root;
      const self = Array.prototype.indexOf.call(parent.childNodes, node);
      siblingIndex = self + dir;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      parent = node;
      siblingIndex = offset + (dir < 0 ? -1 : 0);
    } else {
      return false;
    }
    const sibling = childAt(parent, siblingIndex);
    if (!isChipNode(sibling)) return false;
    sibling?.parentNode?.removeChild(sibling);
    return true;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const native = e.nativeEvent;
    if (isComposingRef.current || native.isComposing) return; // IME 组合期间全部放行

    // 菜单打开时优先接管键盘：↑↓ 移动、Enter 选中、Esc 关闭（均不触发发送/换行）
    if (menuOpenRef.current) {
      const list = itemsRef.current;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        onActiveIndexChange(list.length ? (activeIndexRef.current + 1) % list.length : 0);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        onActiveIndexChange(
          list.length ? (activeIndexRef.current - 1 + list.length) % list.length : 0,
        );
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        const root = rootRef.current;
        const caret = root ? caretOffset(root, 'placeholder') : null;
        if (caret !== null) {
          const match = root ? detectTrigger(serializeRoot(root, 'placeholder'), caret) : null;
          suppressedTokenRef.current = match ? match.tokenStart : null;
        }
        onMenuCloseRef.current();
        return;
      }
      if (e.key === 'Enter') {
        const item = list[Math.min(activeIndexRef.current, list.length - 1)];
        if (item) {
          e.preventDefault();
          commitMention(item);
          return;
        }
      }
    }

    if (e.key === 'Backspace' && deleteAdjacentChip(-1)) {
      e.preventDefault();
      syncFromDom();
      return;
    }
    if (e.key === 'Delete' && deleteAdjacentChip(1)) {
      e.preventDefault();
      syncFromDom();
      return;
    }

    // 发送快捷键（默认 mod+enter；自定义可为 enter/f2/ctrl+shift+enter）
    if (matchesShortcut(e, sendShortcutRef.current)) {
      e.preventDefault();
      onSendRef.current();
      return;
    }

    // Enter：非快捷键命中 → 手插换行（杜绝浏览器插入 div/br 破坏纯文本模型）
    if (e.key === 'Enter') {
      e.preventDefault();
      const root = rootRef.current;
      if (root) insertLineBreakAtCaret(root);
      syncFromDom();
    }
  };

  const handleBeforeInput = (e: FormEvent<HTMLDivElement>) => {
    const native = e.nativeEvent as InputEvent;
    if (isComposingRef.current || native.isComposing) return;
    const type = native.inputType;
    if (
      type === 'insertParagraph' ||
      type === 'insertLineBreak' ||
      type === 'insertHorizontalRule' ||
      type === 'insertFromDrop'
    ) {
      e.preventDefault();
      if (type !== 'insertFromDrop') {
        const root = rootRef.current;
        if (root) insertLineBreakAtCaret(root);
        syncFromDom();
      }
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    // 剪贴板文件（图片/任意文件）→ 交给父层落盘为附件。必须在此 preventDefault，
    // 否则浏览器默认行为会把文件作为 <img>/blob 直接插入 contenteditable（占用输入框）。
    const dt = e.clipboardData;
    const fromFiles = Array.from(dt.files);
    const files =
      fromFiles.length > 0
        ? fromFiles
        : Array.from(dt.items)
            .filter((it) => it.kind === 'file')
            .map((it) => it.getAsFile())
            .filter((f): f is File => f !== null);
    if (files.length > 0) {
      e.preventDefault();
      onPasteFilesRef.current?.(files);
      return;
    }

    // 纯文本优先；取不到时回退 text/html（部分 WebView / iOS 只提供 html）
    let rawText = e.clipboardData.getData('text/plain');
    if (!rawText) {
      const html = e.clipboardData.getData('text/html');
      if (html) rawText = htmlToPlainText(html);
    }
    if (!rawText) return;
    // 清理零宽字符与对象替换符（\uFFFC）——否则会作为隐形字符落进正文
    const text = rawText.replace(/[\u200B-\u200D\uFEFF\uFFFC]/g, '');
    if (!text) return;
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const segments = parseMentionText(text, lookupsRef.current);
    const existing = filePaths();
    const dupes: string[] = [];
    const nodes: Node[] = [];
    segments.forEach((seg) => {
      if (seg.type === 'text') {
        const plain = seg.text.replace(/\r\n?/g, '\n');
        if (plain) nodes.push(document.createTextNode(plain));
        return;
      }
      const token = seg.token;
      if (token.kind === 'file') {
        if (existing.includes(token.path)) {
          dupes.push(token.path);
          return;
        }
        existing.push(token.path);
      }
      const label =
        token.kind === 'file'
          ? (computeFileLabels(existing).get(token.path) ?? fileNameOf(token.path))
          : '';
      nodes.push(createChipElement(token, label));
    });
    if (nodes.length === 0) return;
    insertNodesAtCaret(root, nodes);
    syncFromDom();
    dupes.forEach((p) => onDuplicateRef.current(p));
  };

  const handleCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed || !root.contains(range.commonAncestorContainer)) return;
    // 选区 → 线格式文本（chip 输出 `#<绝对路径>` / `/名称` / `@名称`，保证粘贴可还原）
    const full = serializeRoot(root, 'wire');
    const start = boundaryToOffset(root, range.startContainer, range.startOffset, 'wire');
    const end = boundaryToOffset(root, range.endContainer, range.endOffset, 'wire');
    const plain = full.slice(start, end);
    e.clipboardData.setData('text/plain', plain);
    e.preventDefault();
  };

  /** 剪切：与复制同口径写入剪贴板，再真正删除选区内容（否则 preventDefault 会吞掉删除） */
  const handleCut = (e: ClipboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed || !root.contains(range.commonAncestorContainer)) return;
    const full = serializeRoot(root, 'wire');
    const start = boundaryToOffset(root, range.startContainer, range.startOffset, 'wire');
    const end = boundaryToOffset(root, range.endContainer, range.endOffset, 'wire');
    e.clipboardData.setData('text/plain', full.slice(start, end));
    e.preventDefault();
    range.deleteContents();
    const collapsed = document.createRange();
    collapsed.setStart(range.startContainer, range.startOffset);
    collapsed.collapse(true);
    sel.removeAllRanges();
    sel.addRange(collapsed);
    syncFromDom();
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
    setComposingFlag(true);
  };

  const handleCompositionEnd = () => {
    isComposingRef.current = false;
    setComposingFlag(false);
    syncFromDom();
  };

  return (
    <div
      ref={rootRef}
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder={placeholder}
      data-empty="true"
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onBeforeInput={handleBeforeInput}
      onPaste={handlePaste}
      onCopy={handleCopy}
      onCut={handleCut}
      onBlur={handleBlur}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      className={cn(
        // 尺寸与旧 Textarea 逐属性对齐：min-h-16 + px-1 py-2 + text-base/md:text-sm
        // （旧实现 field-sizing-content 使 rows 失效，空态高度即 min-h-16）
        'mention-editor min-h-16 min-w-40 basis-40 flex-1 overflow-y-auto px-1 py-2 text-base outline-none md:text-sm',
        className,
      )}
    >
      {/* chip 图标：命令式 chip 的图标由 portal 挂载（复用 FileTypeIcon / lucide / 缩略图） */}
      {iconHosts.map(({ id, host, token }) =>
        createPortal(<MentionTokenIcon token={token} lookups={lookups} />, host, id),
      )}
    </div>
  );
});

/** 取 parent 的第 index 个子节点（越界返回 null） */
function childAt(parent: Node, index: number): Node | null {
  const kids = parent.childNodes;
  if (index < 0 || index >= kids.length) return null;
  return kids[index];
}