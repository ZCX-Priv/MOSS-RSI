// src/modules/tools/computer/native-overlay.ts
// 不可寻址浮层的观察：整屏截图 + Windows 原生 UIA。
//
// 背景：cua 只登记有标题的顶层窗口，Qt 自绘弹层（Qt5QWindowPopupSaveBits 等）
// 无法作为 window_id 交给驱动。这里把浮层本身转成模型可直接使用的结果：
// - 整屏截图（浮层在画面里可见）；
// - 原生 UIA 元素（角色 / 名称 / 整屏截图坐标 / 点击中心点）；
// - 操作提示（scope="desktop" 的 x/y）。
//
// 只读，任何失败都退化为「仅坐标提示」，不阻断主流程。

import { existsSync } from 'node:fs';
import { t } from '../../../core/i18n';
import type { ComputerOverlayWindow, ComputerService } from '../../contracts';
import {
  isInteractiveControlType,
  readNativeUia,
  type NativeUiaNode,
} from '../../computer/native-uia';
import type { ToolContext } from '../types';

export interface NativeOverlayObserveOptions {
  includeTree: boolean;
  includeScreenshot: boolean;
  maxImageDimension: number;
  maxElements: number;
  query?: string;
  signal?: AbortSignal;
}

export interface NativeOverlayObservation {
  text: string;
  screenshotPath?: string;
  screenshotWidth?: number;
  screenshotHeight?: number;
  elementCount: number;
  incomplete: boolean;
}

interface ShotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickNumber(obj: unknown, keys: string[]): number | undefined {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function hwndHex(id: number): string {
  return id.toString(16);
}

/** 物理像素矩形 → 整屏截图矩形 */
function toShotRect(rect: ShotRect, scaleX: number, scaleY: number): ShotRect {
  return {
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY)),
  };
}

function centerOf(rect: ShotRect): { x: number; y: number } {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}

/** query 过滤：保留命中节点及其祖先链（与 cua 的 query 语义一致） */
function filterByQuery(nodes: NativeUiaNode[], query: string): NativeUiaNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  const keep = new Set<NativeUiaNode>();
  const ancestry: NativeUiaNode[] = [];
  for (const node of nodes) {
    ancestry.length = Math.min(ancestry.length, node.depth);
    ancestry[node.depth] = node;
    if (node.name.toLowerCase().includes(needle)) {
      for (let depth = 0; depth <= node.depth; depth += 1) {
        const ancestor = ancestry[depth];
        if (ancestor) keep.add(ancestor);
      }
    }
  }
  return nodes.filter(node => keep.has(node));
}

/** 默认过滤：有名称，或属于可交互控件类型 */
function filterNamedNodes(nodes: NativeUiaNode[]): NativeUiaNode[] {
  return nodes.filter(
    node => node.name.trim().length > 0 || isInteractiveControlType(node.controlType),
  );
}

interface OverlayTree {
  overlay: ComputerOverlayWindow;
  nodes: NativeUiaNode[];
}

/**
 * 观察不可寻址浮层。
 * @param overlays 主浮层在前（最多 4 个候选）；会遍历并合并有内容的 UIA 树
 */
export async function observeNativeOverlay(
  service: ComputerService,
  ctx: ToolContext,
  overlays: ComputerOverlayWindow[],
  opts: NativeOverlayObserveOptions,
): Promise<NativeOverlayObservation | null> {
  const candidates = overlays.filter(item => item.windowId > 0).slice(0, 4);
  if (candidates.length === 0) return null;

  const screen = service.getStatus().screen;
  let screenshotPath: string | undefined;
  let screenshotWidth: number | undefined;
  let screenshotHeight: number | undefined;

  if (opts.includeScreenshot) {
    try {
      const path = service.createScreenshotPath('overlay-desktop');
      const raw = await service.callTool(
        'get_desktop_state',
        {
          screenshot_out_file: path,
          ...(opts.maxImageDimension > 0 ? { max_image_dimension: opts.maxImageDimension } : {}),
        },
        {
          source: 'agent',
          sessionId: ctx.sessionId,
          action: 'get_desktop_state',
          summary: 'native overlay',
          screenshotPath: path,
          timeoutMs: 15_000,
          signal: opts.signal,
          silent: true,
        },
      );
      if (!raw.isError && existsSync(path)) {
        screenshotPath = path;
        const structured = raw.structured;
        screenshotWidth = pickNumber(structured, ['screenshot_width', 'width']);
        screenshotHeight = pickNumber(structured, ['screenshot_height', 'height']);
      }
    } catch {
      // 整屏截图失败：继续走纯 UIA/坐标文本
    }
  }

  const scaleX =
    screenshotWidth && screen && screen.width > 0 ? screenshotWidth / screen.width : 1;
  const scaleY =
    screenshotHeight && screen && screen.height > 0 ? screenshotHeight / screen.height : 1;

  const trees: OverlayTree[] = [];
  if (opts.includeTree) {
    for (const overlay of candidates) {
      const result = await readNativeUia(overlay.windowId, { maxNodes: opts.maxElements });
      if (!result || result.nodes.length === 0) continue;
      const filtered = filterNamedNodes(result.nodes);
      if (filtered.length === 0) continue;
      trees.push({ overlay, nodes: opts.query ? filterByQuery(filtered, opts.query) : filtered });
    }
  }

  const lines: string[] = [t('tools.computerNativeOverlayHeader')];
  const coordinateSpace = screenshotPath
    ? t('tools.computerNativeUiaCoordinates')
    : t('tools.computerNativeUiaCoordinatesPhysical');

  let elementCount = 0;
  if (trees.length > 0) {
    for (const tree of trees) {
      const shot = toShotRect(tree.overlay.bounds, scaleX, scaleY);
      lines.push(
        t('tools.computerNativeOverlayLine', {
          windowId: hwndHex(tree.overlay.windowId),
          className: tree.overlay.className || '—',
          x: String(shot.x),
          y: String(shot.y),
          width: String(shot.width),
          height: String(shot.height),
          elements: String(tree.nodes.length),
        }),
      );
      const dims = screenshotPath
        ? t('tools.computerNativeShotDims', {
            shotWidth: String(screenshotWidth ?? '?'),
            shotHeight: String(screenshotHeight ?? '?'),
            screenWidth: String(screen?.width ?? '?'),
            screenHeight: String(screen?.height ?? '?'),
          })
        : '';
      if (dims) lines.push(`  ${dims}`);
      lines.push(`  ${coordinateSpace}`);
      // 过滤后中间层可能缺失：用「已保留的祖先数」重新计算缩进，避免出现超大空档
      const ancestorDepths: number[] = [];
      for (const node of tree.nodes) {
        while (
          ancestorDepths.length > 0 &&
          ancestorDepths[ancestorDepths.length - 1] >= node.depth
        ) {
          ancestorDepths.pop();
        }
        const relativeDepth = ancestorDepths.length;
        ancestorDepths.push(node.depth);
        const rect = toShotRect(node.rect, scaleX, scaleY);
        const center = centerOf(rect);
        const indent = '  '.repeat(Math.min(5, relativeDepth + 1));
        const name = node.name.trim();
        lines.push(
          `${indent}- [${elementCount}] ${node.controlType}${name ? ` "${name}"` : ''} ` +
            `rect=${rect.x},${rect.y} ${rect.width}x${rect.height} center=(${center.x},${center.y})`,
        );
        elementCount += 1;
      }
    }
    lines.push(t('tools.computerNativeOverlayOperate'));
  } else {
    for (const overlay of candidates) {
      const shot = toShotRect(overlay.bounds, scaleX, scaleY);
      lines.push(
        t('tools.computerNativeOverlayLine', {
          windowId: hwndHex(overlay.windowId),
          className: overlay.className || '—',
          x: String(shot.x),
          y: String(shot.y),
          width: String(shot.width),
          height: String(shot.height),
          elements: '0',
        }),
      );
    }
    if (opts.includeTree) lines.push(t('tools.computerNativeUiaEmpty'));
    lines.push(t('tools.computerNativeOverlayOperate'));
  }

  return {
    text: lines.join('\n'),
    ...(screenshotPath ? { screenshotPath } : {}),
    ...(screenshotWidth !== undefined ? { screenshotWidth } : {}),
    ...(screenshotHeight !== undefined ? { screenshotHeight } : {}),
    elementCount,
    incomplete: opts.includeTree && trees.length === 0,
  };
}
