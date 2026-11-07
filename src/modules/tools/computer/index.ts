// src/modules/tools/computer/index.ts
// computer 工具：把 cua-driver 的桌面观察/操作能力封装为 MOSS 单一 action 工具。
// 设计：观察 → 动作 → 验证；默认后台投递（不抢焦点/不移动真实鼠标）。
// 元数据见同目录 tool.json；cua 进程与截图由 computer 模块的 ComputerService 持有。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { t } from '../../../core/i18n';
import { ServiceNames } from '../../../core/types';
import type {
  ComputerFocusResult,
  ComputerService,
  ComputerToolResult,
} from '../../contracts';
import type { ToolContext, ToolResult, ToolResultContent } from '../types';
import { errorResult, textResult } from '../types';
import {
  buildCuaCall,
  describeTarget,
  needsScreenshot,
  summarizeAction,
  type ComputerAction,
  type ComputerParams,
} from './actions';

/** 等待上限（与 tool.json 描述保持一致） */
const WAIT_MAX_MS = 10_000;
/** 单张内联截图上限（超过只保留路径） */
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/** 需要自动目标解析的动作（浮层优先；不包含 status/list_apps/list_windows 等纯观察入口） */
const AUTO_TARGET_ACTIONS = new Set<ComputerAction>([
  'get_window_state',
  'zoom',
  'click',
  'double_click',
  'right_click',
  'type_text',
  'press_key',
  'hotkey',
  'drag',
  'scroll',
  'set_value',
  'run_steps',
]);

/** 动作后检查是否弹出新浮层并自动补拍的动作（type_text 不补，避免输入法候选窗噪音） */
const OVERLAY_OBSERVE_ACTIONS = new Set<ComputerAction>([
  'click',
  'double_click',
  'right_click',
  'hotkey',
  'press_key',
  'run_steps',
]);

/** 窗口聚焦结果 → 结果文本（成功且无回退时返回空串，避免噪音） */
function formatFocusNote(focus: ComputerFocusResult, p: ComputerParams): string {
  if (!focus.ok) {
    return t('tools.computerFocusFailed', { error: focus.error ?? 'unknown' });
  }
  if (focus.overlay) {
    return t('tools.computerFocusOverlay', {
      pid: String(p.pid ?? '?'),
      windowId: String(focus.focusedWindowId ?? '?'),
    });
  }
  if (focus.fallback) {
    return t('tools.computerFocusFallback', {
      pid: String(p.pid ?? '?'),
      windowId: String(focus.focusedWindowId ?? '?'),
    });
  }
  return '';
}

/** 窗口失效类错误（WPS/Office 重建窗口后旧 HWND 会命中） */
function isStaleWindowError(message: string): boolean {
  return /(window|hwnd)[^\n]{0,60}(not found|invalid|closed|不存在|已关闭|no such)|no such window|invalid window handle/i.test(
    message,
  );
}

interface WindowCandidate {
  windowId: number;
  onScreen?: boolean;
  minimized?: boolean;
  zIndex?: number;
}

/** 解析 list_windows 结果（structured 优先，兼容文本 JSON） */
function parseWindowCandidates(result: ComputerToolResult): WindowCandidate[] {
  let list: unknown = result.structured;
  if (!Array.isArray(list)) {
    if (isObject(list) && Array.isArray(list.windows)) {
      list = list.windows;
    } else {
      try {
        const parsed = JSON.parse(result.text.trim()) as unknown;
        list = Array.isArray(parsed)
          ? parsed
          : isObject(parsed) && Array.isArray(parsed.windows)
            ? parsed.windows
            : undefined;
      } catch {
        return [];
      }
    }
  }
  if (!Array.isArray(list)) return [];
  return list.filter(isObject).map(item => ({
    windowId: pickNum(item, ['window_id', 'windowId', 'id']) ?? -1,
    onScreen: pickBool(item, ['is_on_screen', 'onScreen']),
    minimized: pickBool(item, ['minimized']),
    zIndex: pickNum(item, ['z_index', 'zIndex']),
  })).filter(item => item.windowId >= 0);
}

function pickBool(obj: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

/** 窗口失效时挑选同 pid 可见窗口（z_index 最大）重试 */
async function resolveFallbackWindow(
  service: ComputerService,
  p: ComputerParams,
  message: string,
): Promise<number | undefined> {
  if (typeof p.pid !== 'number' || !isStaleWindowError(message)) return undefined;
  try {
    const listed = await service.callTool('list_windows', { pid: p.pid }, { source: 'panel', timeoutMs: 8000 });
    if (listed.isError) return undefined;
    const candidates = parseWindowCandidates(listed)
      .filter(item => item.windowId !== p.window_id && item.minimized !== true && item.onScreen !== false)
      .sort((a, b) => (b.zIndex ?? -1) - (a.zIndex ?? -1));
    return candidates[0]?.windowId;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickString(obj: unknown, key: string): string | undefined {
  if (!isObject(obj)) return undefined;
  const value = obj[key];
  return typeof value === 'string' && value ? value : undefined;
}

function pickBoolean(obj: unknown, key: string): boolean | undefined {
  if (!isObject(obj)) return undefined;
  const value = obj[key];
  return typeof value === 'boolean' ? value : undefined;
}

function numberConfig(config: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 可中断的等待 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 本地 status 文本（不依赖 cua 连接是否成功） */
function statusText(service: ComputerService): string {
  const status = service.getStatus();
  return [
    t('tools.computerStatusHeader'),
    `installed: ${status.installed}`,
    `driver: ${status.driverPath ?? '—'}`,
    `version: ${status.version ?? '—'}`,
    `connection: ${status.connection}`,
    `tools: ${status.toolCount}`,
    `screen: ${status.screen ? `${status.screen.width}x${status.screen.height}` : '—'}`,
    `paused: ${status.paused}`,
    `maxImageDimension: ${status.config.maxImageDimension}`,
    `allowForeground: ${status.config.allowForeground}`,
    ...(status.error ? [`error: ${status.error}`] : []),
  ].join('\n');
}

/** cua structured → 最近一帧的画面尺寸信息（只用于向模型说明坐标换算） */
interface WindowCaptureInfo {
  screenshotWidth?: number;
  screenshotHeight?: number;
  windowWidth?: number;
  windowHeight?: number;
  scale?: number;
}

function captureInfoFromResult(structured: unknown): WindowCaptureInfo {
  const obj = isObject(structured) ? structured : {};
  const bounds = isObject(obj.window_bounds) ? obj.window_bounds : {};
  const width = pickNum(obj, ['screenshot_width', 'width']) ?? pickNum(obj, ['screenshotWidth']);
  const height = pickNum(obj, ['screenshot_height', 'height']) ?? pickNum(obj, ['screenshotHeight']);
  const windowWidth = pickNum(bounds, ['width']) ?? pickNum(obj, ['window_width']);
  const windowHeight = pickNum(bounds, ['height']) ?? pickNum(obj, ['window_height']);
  const scale =
    width !== undefined && windowWidth !== undefined && windowWidth > 0 ? width / windowWidth : undefined;
  return {
    ...(width !== undefined ? { screenshotWidth: width } : {}),
    ...(height !== undefined ? { screenshotHeight: height } : {}),
    ...(windowWidth !== undefined ? { windowWidth } : {}),
    ...(windowHeight !== undefined ? { windowHeight } : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
}

function pickNum(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** 截图/窗口尺寸提示（强调 x/y 直接用截图像素，避免模型按物理分辨率换算） */
function describeCapture(structured: unknown): string | undefined {
  const info = captureInfoFromResult(structured);
  if (
    info.screenshotWidth === undefined ||
    info.screenshotHeight === undefined ||
    info.windowWidth === undefined ||
    info.windowHeight === undefined
  ) {
    return undefined;
  }
  return `截图 ${info.screenshotWidth}x${info.screenshotHeight}（x/y 直接使用本截图像素，不要乘缩放；窗口物理尺寸 ${info.windowWidth}x${info.windowHeight}）`;
}

/**
 * 是否自动升级 foreground。
 * 仅当驱动明确表示「后台投递不可用/未投递」（background_unavailable）时才安全重试；
 * effect=unverifiable / foreground_unavailable 表示动作可能已经投递，绝不自动重投，
 * 否则 type_text 会重复输入、click 会重复点击。
 */
function shouldEscalate(p: ComputerParams, result: ComputerToolResult): boolean {
  if (p.action === 'run_steps' || p.action === 'run_script' || p.action === 'verify') return false;
  if (p.action === 'get_window_state' || p.action === 'get_desktop_state' || p.action === 'zoom') return false;
  if (!['click', 'double_click', 'right_click', 'type_text', 'press_key', 'hotkey', 'drag', 'scroll'].includes(p.action)) {
    return false;
  }
  const code = pickString(result.structured, 'code');
  if (code === 'background_unavailable') return true;
  return /background_unavailable|Background delivery is not available/i.test(result.text);
}

/** 无截图 frame 错误：像素动作已被拒绝（未执行），补一次截图后重试是安全的 */
function isScreenshotFrameError(text: string): boolean {
  return /No screenshot frame for window/i.test(text);
}

/** 从前台校验错误中解析 actual foreground HWND */
function foregroundHwndFromError(text: string): number | undefined {
  const match = /actual foreground HWND\s+(0x[0-9a-f]+)/i.exec(text);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1], 16);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 是否为「前台被同进程另一个窗口接管」的动作未确认错误 */
function isForegroundUnavailable(result: ComputerToolResult): boolean {
  const code = pickString(result.structured, 'code');
  return code === 'foreground_unavailable' || /foreground_unavailable/i.test(result.text);
}

interface ObservedWindowState {
  text: string;
  screenshotPath?: string;
  elementCount?: number;
  incomplete?: boolean;
}

/** 自动读取某个窗口的 UIA 树 + 截图（浮层切换/动作未确认时使用） */
async function observeWindowState(
  service: ComputerService,
  ctx: ToolContext,
  pid: number,
  windowId: number,
  kind: string,
): Promise<ObservedWindowState | null> {
  const screenshotPath = service.createScreenshotPath(kind, pid, windowId);
  const maxDimension = numberConfig(ctx.toolConfig, 'maxImageDimension', 1280);
  const maxElements = Math.max(1, numberConfig(ctx.toolConfig, 'maxTreeElements', 250));
  try {
    const result = await service.callTool(
      'get_window_state',
      {
        pid,
        window_id: windowId,
        include_screenshot: true,
        include_accessibility_tree: true,
        tree_format: 'markdown',
        max_elements: maxElements,
        ...(maxDimension > 0 ? { max_image_dimension: maxDimension } : {}),
        screenshot_out_file: screenshotPath,
      },
      {
        source: 'agent',
        sessionId: ctx.sessionId,
        action: 'get_window_state',
        summary: `window ${windowId}`,
        target: `window pid=${pid} id=${windowId}`,
        timeoutMs: 15_000,
        signal: ctx.signal,
      },
    );
    if (result.isError) return null;
    const structured = isObject(result.structured) ? result.structured : {};
    const elementCount = pickNum(structured, [
      'element_count',
      'total_element_count',
      'returned_element_count',
    ]);
    const incomplete =
      pickBoolean(structured, 'elements_complete') === false ||
      pickBoolean(structured, 'truncated') === true;
    return {
      text: result.text.trim(),
      ...(existsSync(screenshotPath) ? { screenshotPath } : {}),
      ...(elementCount !== undefined ? { elementCount } : {}),
      ...(incomplete ? { incomplete: true } : {}),
    };
  } catch {
    return null;
  }
}

/** 两个窗口矩形是否相交 */
function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * list_windows 补充：cua 的列表不含无标题浮层（如 WPS 新建面板），
 * 这里用原生枚举把主窗口之上、与主窗口相交的小窗口标成 [overlay]。
 */
async function describeOverlayWindows(
  service: ComputerService,
  pid: number,
): Promise<string[]> {
  try {
    const windows = await service.listProcessWindows(pid);
    const usable = windows.filter(
      item =>
        item.visible &&
        !item.minimized &&
        item.bounds.width >= 80 &&
        item.bounds.height >= 60 &&
        !!item.className &&
        !item.title.startsWith('Cua.AgentCursorOverlay'),
    );
    if (usable.length < 2) return [];
    const main = usable.reduce(
      (best, item) =>
        item.bounds.width * item.bounds.height > best.bounds.width * best.bounds.height
          ? item
          : best,
      usable[0],
    );
    const mainArea = main.bounds.width * main.bounds.height;
    return usable
      .filter(item => item.windowId !== main.windowId)
      .filter(item => {
        const area = item.bounds.width * item.bounds.height;
        return area > 6000 && area < mainArea * 0.92 && rectsIntersect(item.bounds, main.bounds);
      })
      .sort((a, b) => a.zOrder - b.zOrder)
      .map(
        item =>
          `- [overlay] HWND 0x${item.windowId.toString(16)} class=${item.className} ${item.bounds.width}x${item.bounds.height}`,
      );
  } catch {
    return [];
  }
}

/** 窗口截图可能缺失自绘浮层（Qt 弹层/浮动工具栏）：失败或覆盖不全时补一张整屏 */
function shouldSupplementDesktop(p: ComputerParams, result: ComputerToolResult): boolean {
  if (
    p.action === 'get_desktop_state' ||
    p.action === 'get_window_state' ||
    p.action === 'status' ||
    p.action === 'wait'
  ) {
    return false;
  }
  const effect = pickString(result.structured, 'effect');
  if (effect === 'suspected_noop' || effect === 'refused') return true;
  if (!isObject(result.structured)) return false;
  const coverage = result.structured.capture_coverage;
  if (coverage === undefined || coverage === null) return false;
  try {
    return /partial|incomplete|limit|outside|unavailable/i.test(JSON.stringify(coverage));
  } catch {
    return false;
  }
}

/** 补拍整屏（优先画面来源）：窗口截图看不到的浮层/弹层在这里可见 */
async function captureDesktopSupplement(
  service: ComputerService,
  ctx: ToolContext,
): Promise<string | undefined> {
  try {
    const path = service.createScreenshotPath('desktop-check');
    const maxDimension = numberConfig(ctx.toolConfig, 'maxImageDimension', 1280);
    const result = await service.callTool(
      'get_desktop_state',
      {
        screenshot_out_file: path,
        ...(maxDimension > 0 ? { max_image_dimension: maxDimension } : {}),
      },
      { source: 'panel', timeoutMs: 15_000 },
    );
    if (result.isError) return undefined;
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** cua 结果 → MOSS ToolResult（文本 + 截图 image content + 元信息） */
function formatResult(
  result: ComputerToolResult,
  meta: { action: string; tool: string; screenshotPath?: string; autoEscalated?: boolean },
): ToolResult {
  const images = [...result.images];
  const screenshotPath = meta.screenshotPath;

  if (screenshotPath && existsSync(screenshotPath)) {
    try {
      const st = statSync(screenshotPath);
      if (st.isFile() && st.size > 0 && !images.some(img => img.path === screenshotPath)) {
        if (st.size <= MAX_INLINE_IMAGE_BYTES) {
          const buf = readFileSync(screenshotPath);
          images.push({ data: buf.toString('base64'), mimeType: 'image/png', path: screenshotPath });
        }
      }
    } catch {
      // 截图读取失败不阻断文本结果
    }
  }

  const effect = pickString(result.structured, 'effect');
  const verified = pickBoolean(result.structured, 'verified');
  const textParts: string[] = [];
  if (result.text.trim()) textParts.push(result.text);
  if (meta.autoEscalated) textParts.push('（后台投递不可用，已自动升级 foreground 重试一次）');
  if (effect) textParts.push(`effect=${effect}${verified !== undefined ? ` · verified=${verified}` : ''}`);
  if (effect === 'unverifiable') {
    textParts.push(
      '⚠️ 未验证：驱动只完成了投递，动作可能已经生效。请先用 get_window_state / verify 观察；不要重复投递同一动作（尤其是 type_text / click），否则会重复输入或重复点击。',
    );
  }
  const captureLine = describeCapture(result.structured);
  if (captureLine) textParts.push(captureLine);
  if (meta.action === 'get_desktop_state') {
    textParts.push(
      '坐标提示：本截图（desktop screenshot）的像素坐标直接用于 click/type_text 的 x/y（scope=desktop），不要按屏幕物理分辨率换算。',
    );
  }
  if (screenshotPath && existsSync(screenshotPath)) textParts.push(`截图：${screenshotPath}`);
  if (textParts.length === 0 && images.length === 0) {
    textParts.push(t('tools.computerActionDone', { action: meta.action }));
  }

  const content: ToolResultContent[] = [];
  if (textParts.length > 0) {
    content.push({ type: 'text', text: textParts.join('\n') });
  }
  for (const image of images) {
    content.push({
      type: 'image',
      source: { data: image.data, mimeType: image.mimeType },
      path: image.path,
    });
  }

  // cua 对「投递了但未生效」通常返回 effect=suspected_noop（isError 仍为 false）；
  // 对 MOSS 来说这应视为失败，避免模型把 no-op 当成成功继续往下走。
  const isError =
    result.isError === true || effect === 'suspected_noop' || effect === 'refused';
  return {
    content,
    isError,
    metadata: {
      action: meta.action,
      tool: meta.tool,
      ...(screenshotPath && existsSync(screenshotPath) ? { screenshotPath } : {}),
      ...(effect ? { effect } : {}),
      ...(verified !== undefined ? { verified } : {}),
      ...(meta.autoEscalated ? { autoEscalated: true } : {}),
    },
  };
}

/** 按动作类型收敛超时：避免所有动作都等 120s（会话里出现过 120s AbortError） */
function actionTimeout(p: ComputerParams, configTimeout: number): number {
  if (p.action === 'run_script') {
    const requested = typeof p.timeout_ms === 'number' ? p.timeout_ms : 60_000;
    return Math.max(1_000, Math.min(120_000, requested));
  }
  if (p.action === 'verify') {
    const requested = typeof p.timeout_ms === 'number' ? p.timeout_ms : 5_000;
    return Math.max(500, Math.min(15_000, requested));
  }
  if (p.action === 'get_window_state' || p.action === 'get_desktop_state') {
    return Math.min(configTimeout, 20_000);
  }
  return Math.min(configTimeout, 15_000);
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as ComputerParams;
    if (!p || typeof p.action !== 'string') {
      return errorResult('action is required');
    }

    const service = ctx.services.tryResolve<ComputerService>(ServiceNames.COMPUTER);
    if (!service) {
      return errorResult(t('tools.computerServiceUnavailable'));
    }

    // 状态查询不需要连接，未安装时也能给出可操作信息
    if (p.action === 'status') {
      return textResult(statusText(service));
    }

    if (service.isPaused()) {
      return errorResult(t('tools.computerPaused'));
    }

    // 本地等待：不经过 cua（用于等待窗口出现/动画结束）
    if (p.action === 'wait') {
      const requested = typeof p.wait_ms === 'number' ? p.wait_ms : 1000;
      if (requested < 0 || requested > WAIT_MAX_MS) {
        return errorResult(t('tools.computerWaitTooLong'));
      }
      try {
        await delay(requested, ctx.signal);
        return textResult(t('tools.computerActionDone', { action: `wait ${requested}ms` }));
      } catch {
        return errorResult('aborted');
      }
    }

    try {
      await service.ensureConnected();

      // 显式聚焦：bring_to_front（含浮层/弹窗 HWND），失败自动回退主窗口
      if (p.action === 'focus') {
        if (typeof p.pid !== 'number') {
          return errorResult(t('tools.computerPidRequired'));
        }
        const focus = await service.focusWindow(p.pid, p.window_id, { force: true });
        const detail = formatFocusNote(focus, p);
        return textResult(
          detail ||
            t('tools.computerFocusDone', {
              pid: String(p.pid),
              windowId: String(focus.focusedWindowId ?? p.window_id ?? '—'),
            }),
        );
      }

      // ---- 自动目标（浮层优先）----
      // 不再无条件 bring_to_front：cua 的后台投递 / UIA invoke 不需要前台；
      // 无条件前置会把 WPS 等应用的浮层压下去或失焦关闭。
      const autoTarget = p.auto_focus ?? (ctx.toolConfig?.autoFocus !== false);
      let effectiveParams: ComputerParams = p;
      let targetNote = '';
      if (autoTarget && typeof p.pid === 'number' && AUTO_TARGET_ACTIONS.has(p.action)) {
        const target = await service.resolveWindowTarget(p.pid, p.window_id);
        if (target.windowId && target.windowId !== p.window_id) {
          effectiveParams = { ...p, pid: p.pid, window_id: target.windowId };
          if (target.isOverlay) {
            targetNote = t('tools.computerTargetAutoSwitched', {
              windowId: `0x${target.windowId.toString(16)}`,
              className: target.className || '—',
              width: String(target.bounds?.width ?? '?'),
              height: String(target.bounds?.height ?? '?'),
            });
          } else if (p.window_id === undefined) {
            targetNote = t('tools.computerWindowAutoResolved', {
              windowId: `0x${target.windowId.toString(16)}`,
              className: target.className || '—',
            });
          }
        }
      }

      let activeScreenshotPath = needsScreenshot(effectiveParams)
        ? service.createScreenshotPath(
            effectiveParams.action,
            effectiveParams.pid,
            effectiveParams.window_id,
          )
        : undefined;

      const buildContext = {
        service,
        toolConfig: ctx.toolConfig ?? {},
        screenshotPath: activeScreenshotPath,
      };

      const configTimeout = numberConfig(ctx.toolConfig, 'timeout', 120_000);
      const callOptions = {
        sessionId: ctx.sessionId,
        action: p.action,
        summary: summarizeAction(effectiveParams),
        target: describeTarget(effectiveParams),
        screenshotPath: activeScreenshotPath,
        source: 'agent' as const,
        timeoutMs: actionTimeout(effectiveParams, configTimeout),
        signal: ctx.signal,
      };

      let tool = '';
      const callOnce = async (
        params: ComputerParams,
        timeoutOverride?: number,
      ): Promise<ComputerToolResult> => {
        if (needsScreenshot(params)) {
          activeScreenshotPath = service.createScreenshotPath(
            params.action,
            params.pid,
            params.window_id,
          );
        }
        const call = buildCuaCall(params, {
          ...buildContext,
          screenshotPath: activeScreenshotPath,
        });
        tool = call.tool;
        return service.callTool(call.tool, call.args, {
          ...callOptions,
          summary: summarizeAction(params),
          target: describeTarget(params),
          screenshotPath: activeScreenshotPath,
          ...(timeoutOverride !== undefined ? { timeoutMs: timeoutOverride } : {}),
        });
      };

      let result: ComputerToolResult;
      let windowFallbackNote = '';
      try {
        result = await callOnce(effectiveParams);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 窗口句柄失效（WPS/Office 重建窗口）：自动选择同 pid 可见窗口重试一次
        const fallbackWindowId = await resolveFallbackWindow(service, effectiveParams, message);
        if (fallbackWindowId === undefined) throw err;
        effectiveParams = { ...effectiveParams, window_id: fallbackWindowId };
        result = await callOnce(effectiveParams);
        windowFallbackNote = t('tools.computerWindowFallback', {
          pid: String(effectiveParams.pid),
          windowId: String(fallbackWindowId),
        });
      }

      // cua 工具级错误（isError=true）不会抛异常：窗口失效时同样回退一次
      if (result.isError && isStaleWindowError(result.text)) {
        const fallbackWindowId = await resolveFallbackWindow(service, effectiveParams, result.text);
        if (fallbackWindowId !== undefined) {
          effectiveParams = { ...effectiveParams, window_id: fallbackWindowId };
          result = await callOnce(effectiveParams);
          windowFallbackNote = t('tools.computerWindowFallback', {
            pid: String(effectiveParams.pid),
            windowId: String(fallbackWindowId),
          });
        }
      }

      // 无截图 frame：错误表示像素动作未执行，补一次截图后重试一次
      let frameRetried = false;
      if (result.isError && !frameRetried && isScreenshotFrameError(result.text)) {
        frameRetried = true;
        const pid = effectiveParams.pid;
        const windowId = effectiveParams.window_id;
        if (typeof pid === 'number' && typeof windowId === 'number') {
          const captured = await observeWindowState(service, ctx, pid, windowId, 'frame-retry');
          if (captured) {
            result = await callOnce(effectiveParams);
            if (!result.isError) {
              result = {
                ...result,
                text: `${result.text}\n${t('tools.computerScreenshotFrameRetry')}`.trim(),
              };
            }
          }
        }
      }

      // 仅当驱动明确表示后台未投递（background_unavailable）时才升级 foreground；
      // unverifiable / foreground_unavailable 不重投，避免重复输入/重复点击。
      const allowForeground =
        ctx.toolConfig && typeof ctx.toolConfig.allowForeground === 'boolean'
          ? ctx.toolConfig.allowForeground
          : true;
      let autoEscalated = false;
      let finalTool = tool;
      if (
        shouldEscalate(effectiveParams, result) &&
        effectiveParams.delivery_mode !== 'foreground' &&
        allowForeground
      ) {
        const retried = await callOnce(
          { ...effectiveParams, delivery_mode: 'foreground' },
          // 前台升级后剩余时间可能不足，使用动作型超时
          Math.min(configTimeout, 15_000),
        );
        result = {
          ...retried,
          images: [...retried.images, ...result.images],
          text: retried.text,
        };
        autoEscalated = true;
        finalTool = tool;
      }

      // 动作未确认：前台被同进程的另一个窗口（浮层/对话框）接管 → 视为可能已生效，不重投
      let actionMayHaveTakenEffect = false;
      let observedForegroundWindowId: number | undefined;
      if (result.isError && isForegroundUnavailable(result)) {
        const expectedHwnd = foregroundHwndFromError(result.text);
        const foreground = service.getForegroundWindowInfo();
        const samePid =
          !!foreground && typeof effectiveParams.pid === 'number' && foreground.pid === effectiveParams.pid;
        const matchesExpected =
          expectedHwnd === undefined || (foreground !== null && foreground.windowId === expectedHwnd);
        if (
          samePid &&
          matchesExpected &&
          foreground &&
          foreground.windowId !== effectiveParams.window_id
        ) {
          actionMayHaveTakenEffect = true;
          observedForegroundWindowId = foreground.windowId;
          result = { ...result, isError: false };
        }
      }

      // 动作后检测新浮层：自动把截图与 UIA 树切到浮层，避免「点了没反应」的假象
      let overlayNote = '';
      let overlayState: ObservedWindowState | null = null;
      if (
        autoTarget &&
        OVERLAY_OBSERVE_ACTIONS.has(effectiveParams.action) &&
        typeof effectiveParams.pid === 'number'
      ) {
        const after = await service.resolveWindowTarget(
          effectiveParams.pid,
          effectiveParams.window_id,
        );
        const changedOverlayId =
          after.isOverlay && after.windowId !== effectiveParams.window_id
            ? after.windowId
            : undefined;
        const targetWindowId = changedOverlayId ?? observedForegroundWindowId;
        if (targetWindowId !== undefined && targetWindowId !== effectiveParams.window_id) {
          const foreground = service.getForegroundWindowInfo();
          const meta =
            changedOverlayId !== undefined
              ? after
              : foreground && foreground.windowId === targetWindowId
                ? foreground
                : null;
          overlayState = await observeWindowState(
            service,
            ctx,
            effectiveParams.pid,
            targetWindowId,
            'overlay-state',
          );
          if (overlayState) {
            overlayNote = t('tools.computerTargetAutoSwitched', {
              windowId: `0x${targetWindowId.toString(16)}`,
              className: meta?.className || '—',
              width: String(meta?.bounds?.width ?? '?'),
              height: String(meta?.bounds?.height ?? '?'),
            });
          }
        }
      }

      // 整屏补拍：窗口截图可能缺失自绘浮层（Qt 弹层/浮动工具栏）；失败或覆盖不全时以整屏为准
      const desktopSupplementPath = shouldSupplementDesktop(effectiveParams, result)
        ? await captureDesktopSupplement(service, ctx)
        : undefined;

      const formatted = formatResult(result, {
        action: p.action,
        tool: finalTool,
        screenshotPath: activeScreenshotPath,
        ...(autoEscalated ? { autoEscalated: true } : {}),
      });
      // 动作可能已生效（前台被同进程浮层接管）：不要让 effect=refused 再把它标成失败
      if (actionMayHaveTakenEffect) formatted.isError = false;
      const notes = [
        targetNote,
        windowFallbackNote,
        actionMayHaveTakenEffect ? t('tools.computerActionMayHaveTakenEffect') : '',
        overlayNote,
      ].filter(Boolean);
      if (notes.length > 0) {
        formatted.content.unshift({ type: 'text', text: notes.join('\n') });
      }
      // 浮层状态：UIA 树 + 截图（让模型直接看到浮层，而不是主窗口）
      if (overlayState) {
        const parts = [t('tools.computerOverlayObserved')];
        if (overlayState.text) parts.push(overlayState.text);
        if (
          overlayState.incomplete ||
          (overlayState.elementCount !== undefined && overlayState.elementCount < 5)
        ) {
          parts.push(t('tools.computerSelfDrawnHint'));
        }
        formatted.content.push({ type: 'text', text: parts.join('\n') });
        const overlayPath = overlayState.screenshotPath;
        if (overlayPath) {
          const included = formatted.content.some(
            item => item.type === 'image' && item.path === overlayPath,
          );
          if (!included) {
            try {
              const buf = readFileSync(overlayPath);
              if (buf.length > 0 && buf.length <= MAX_INLINE_IMAGE_BYTES) {
                formatted.content.push({
                  type: 'image',
                  source: { data: buf.toString('base64'), mimeType: 'image/png' },
                  path: overlayPath,
                });
              }
            } catch {
              // 读取失败时只保留路径提示
            }
          }
          formatted.content.push({ type: 'text', text: `截图：${overlayPath}` });
        }
      }
      if (desktopSupplementPath) {
        const included = formatted.content.some(
          item => item.type === 'image' && item.path === desktopSupplementPath,
        );
        if (!included) {
          try {
            const buf = readFileSync(desktopSupplementPath);
            if (buf.length > 0 && buf.length <= MAX_INLINE_IMAGE_BYTES) {
              formatted.content.push({
                type: 'image',
                source: { data: buf.toString('base64'), mimeType: 'image/png' },
                path: desktopSupplementPath,
              });
            }
          } catch {
            // 读取失败时只保留路径提示
          }
        }
        formatted.content.push({
          type: 'text',
          text: `整屏截图（优先参考，含自绘浮层/弹出层）：${desktopSupplementPath}`,
        });
      }
      // list_windows 自动补充 cua 列表里缺失的浮层窗口（Windows 原生枚举）
      if (p.action === 'list_windows') {
        const pidForOverlay =
          typeof p.pid === 'number' ? p.pid : service.getForegroundWindowInfo()?.pid;
        if (pidForOverlay !== undefined) {
          const overlayLines = await describeOverlayWindows(service, pidForOverlay);
          if (overlayLines.length > 0) {
            formatted.content.push({
              type: 'text',
              text: `${t('tools.computerOverlayWindowLine')}\n${overlayLines.join('\n')}`,
            });
          }
        }
      }
      return formatted;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(t('tools.computerActionFailed', { message }));
    }
  },
};
