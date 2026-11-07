// src/modules/tools/computer/actions.ts
// computer 工具的 action → cua-driver MCP 工具映射与参数归一化。
// 只负责「MOSS 参数 → cua 参数」与本地校验；cua 自身的 schema 校验与投递策略由驱动负责。

import { t } from '../../../core/i18n';
import type { ComputerService } from '../../contracts';

export const OBSERVE_ACTIONS = new Set([
  'status',
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_desktop_state',
  'get_screen_size',
  'get_cursor_position',
  'zoom',
  'wait',
]);

export type ComputerAction =
  | 'status'
  | 'list_apps'
  | 'list_windows'
  | 'get_window_state'
  | 'get_desktop_state'
  | 'get_screen_size'
  | 'get_cursor_position'
  | 'zoom'
  | 'focus'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'drag'
  | 'scroll'
  | 'type_text'
  | 'press_key'
  | 'hotkey'
  | 'set_value'
  | 'launch_app'
  | 'kill_app'
  | 'clipboard_read'
  | 'clipboard_write'
  | 'run_script'
  | 'verify'
  | 'run_steps'
  | 'wait';

export interface ComputerStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface ComputerParams {
  action: ComputerAction;
  pid?: number;
  window_id?: number;
  element_token?: string;
  x?: number;
  y?: number;
  display_id?: string;
  scope?: 'window' | 'desktop';
  from_zoom?: boolean;
  button?: 'left' | 'right' | 'middle';
  count?: number;
  modifier?: string[];
  key?: string;
  modifiers?: string[];
  keys?: string[];
  text?: string;
  value?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  /** 滚动粒度：line（按行，缺省）或 page（按页） */
  by?: 'line' | 'page';
  /** 像素增量别名：正数向下（会换算为 amount 并推导 direction） */
  delta_y?: number;
  /** 像素增量别名：正数向右 */
  delta_x?: number;
  /** amount 的别名 */
  scroll_amount?: number;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  delivery_mode?: 'background' | 'foreground';
  /** 操作前自动聚焦目标窗口（缺省取工具配置 autoFocus；false 时保持后台） */
  auto_focus?: boolean;
  include_screenshot?: boolean;
  include_accessibility_tree?: boolean;
  max_elements?: number;
  max_depth?: number;
  query?: string;
  since?: string;
  timeout_ms?: number;
  max_image_dimension?: number;
  on_screen_only?: boolean;
  app?: string;
  wait_ms?: number;
  steps?: ComputerStep[];
  delay_ms?: number;
  observe?: Record<string, unknown>;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  include_text?: boolean;
  image_path?: string;
  file_path?: string;
  /** run_script：cua 脚本函数体（async function body） */
  script?: string;
  /** run_script：最多驱动调用次数（1-500） */
  max_calls?: number;
  /** verify：1-8 个断言谓词 */
  expect?: unknown;
  /** verify：连续满足采样次数（1-5） */
  stable_samples?: number;
}

export interface BuildContext {
  service: ComputerService;
  toolConfig: Record<string, unknown>;
  screenshotPath?: string;
}

/** 需要截图的 action（由工具调用前分配路径） */
export function needsScreenshot(p: ComputerParams): boolean {
  if (p.action === 'get_desktop_state') return true;
  if (p.action === 'get_window_state') return p.include_screenshot !== false;
  return false;
}

/** action → cua 工具候选名（按优先级） */
export function mapActionToCua(action: ComputerAction): string[] {
  if (action === 'run_steps') return ['run_actions', 'run_steps'];
  if (action === 'status') return ['health_report'];
  if (action === 'verify') return ['verify_state'];
  if (action === 'run_script') return ['run_script'];
  if (action === 'focus') return ['bring_to_front'];
  return [action];
}

/** 当前连接实际支持的工具（候选按顺序取第一个） */
export function pickCuaTool(service: ComputerService, action: ComputerAction): string {
  const candidates = mapActionToCua(action);
  for (const candidate of candidates) {
    if (service.supportsTool(candidate)) return candidate;
  }
  throw new Error(
    t('tools.computerUnsupportedAction', {
      action,
      tools: service.listToolNames().slice(0, 30).join(', ') || '—',
    }),
  );
}

/** 去掉 undefined 字段（cua schema 多为 deny_unknown_fields，但 undefined 可安全省略） */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function numberConfig(cfg: Record<string, unknown>, key: string, fallback: number): number {
  const value = cfg[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** cua 工具 schema 是否声明某个参数（旧驱动 additionalProperties:false，不能乱传） */
function schemaHasProp(service: ComputerService, tool: string, prop: string): boolean {
  const schema = service.getToolSchema(tool) as
    | { properties?: Record<string, unknown> }
    | null;
  return !!schema?.properties && Object.prototype.hasOwnProperty.call(schema.properties, prop);
}

interface ScrollLike {
  direction?: string;
  amount?: number;
  by?: string;
  delta_x?: number;
  delta_y?: number;
  scroll_amount?: number;
}

/**
 * 归一化 scroll 参数：
 * - direction 缺省时由 delta_y（正下负上）/ delta_x（正右负左）推导；
 * - amount 优先级 scroll_amount → amount → ceil(|delta| / 120)；
 * - amount 限制在 1–50；by 仅接受 line/page。
 */
export function normalizeScrollParams(p: ScrollLike): {
  direction: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  by?: 'line' | 'page';
} {
  const validDirections = new Set(['up', 'down', 'left', 'right']);
  let direction =
    typeof p.direction === 'string' && validDirections.has(p.direction)
      ? (p.direction as 'up' | 'down' | 'left' | 'right')
      : undefined;

  const deltaY = typeof p.delta_y === 'number' && Number.isFinite(p.delta_y) ? p.delta_y : undefined;
  const deltaX = typeof p.delta_x === 'number' && Number.isFinite(p.delta_x) ? p.delta_x : undefined;
  if (!direction && deltaY !== undefined && deltaY !== 0) {
    direction = deltaY > 0 ? 'down' : 'up';
  }
  if (!direction && deltaX !== undefined && deltaX !== 0) {
    direction = deltaX > 0 ? 'right' : 'left';
  }
  if (!direction) {
    throw new Error(t('tools.computerElementOrPixelRequired'));
  }

  const rawAmount =
    typeof p.scroll_amount === 'number' && Number.isFinite(p.scroll_amount)
      ? p.scroll_amount
      : typeof p.amount === 'number' && Number.isFinite(p.amount)
        ? p.amount
        : deltaY !== undefined
          ? Math.ceil(Math.abs(deltaY) / 120)
          : deltaX !== undefined
            ? Math.ceil(Math.abs(deltaX) / 120)
            : undefined;
  const amount =
    rawAmount === undefined
      ? undefined
      : Math.max(1, Math.min(50, Math.round(rawAmount)));

  const by = p.by === 'line' || p.by === 'page' ? p.by : undefined;
  return { direction, ...(amount !== undefined ? { amount } : {}), ...(by ? { by } : {}) };
}

/** run_steps 内的 scroll step：归一化并移除 cua 不认识的别名 */
function normalizeScrollStepArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeScrollParams({
    direction: typeof args.direction === 'string' ? args.direction : undefined,
    amount: typeof args.amount === 'number' ? args.amount : undefined,
    by: typeof args.by === 'string' ? args.by : undefined,
    delta_x: typeof args.delta_x === 'number' ? args.delta_x : undefined,
    delta_y: typeof args.delta_y === 'number' ? args.delta_y : undefined,
    scroll_amount: typeof args.scroll_amount === 'number' ? args.scroll_amount : undefined,
  });
  const out: Record<string, unknown> = { ...args };
  delete out.delta_x;
  delete out.delta_y;
  delete out.scroll_amount;
  delete out.by;
  out.direction = normalized.direction;
  if (normalized.amount !== undefined) out.amount = normalized.amount;
  if (normalized.by !== undefined) out.by = normalized.by;
  return out;
}

function imageDimension(p: ComputerParams, cfg: Record<string, unknown>): number | undefined {
  const value =
    typeof p.max_image_dimension === 'number'
      ? p.max_image_dimension
      : numberConfig(cfg, 'maxImageDimension', 1280);
  return value > 0 ? value : undefined;
}

function treeElements(p: ComputerParams, cfg: Record<string, unknown>): number {
  const value =
    typeof p.max_elements === 'number'
      ? p.max_elements
      : numberConfig(cfg, 'maxTreeElements', 250);
  return Math.max(1, Math.min(2000, value));
}

function deliveryMode(
  p: ComputerParams,
  cfg: Record<string, unknown>,
): 'background' | 'foreground' {
  const mode = p.delivery_mode ?? 'background';
  if (mode === 'foreground' && cfg.allowForeground === false) {
    throw new Error(t('tools.computerForegroundDisabled'));
  }
  return mode;
}

/**
 * 构造 cua 的 legacy 目标参数。
 * 不使用 target 对象：cua 的 target 与 legacy scope/pid/window_id 互斥，
 * 混用会直接报 "target cannot be combined with legacy scope, pid, or window_id fields"。
 * 桌面坐标优先级最高：scope=desktop 时忽略 pid/window_id。
 */
function targetArgs(p: ComputerParams): Record<string, unknown> {
  if (p.scope === 'desktop' || p.display_id) {
    return { scope: 'desktop' };
  }
  if (p.element_token) {
    return compact({ element_token: p.element_token, pid: p.pid });
  }
  if (typeof p.pid === 'number' && typeof p.window_id === 'number') {
    return { pid: p.pid, window_id: p.window_id };
  }
  if (typeof p.pid === 'number') {
    return { pid: p.pid };
  }
  return {};
}

function requireWindow(p: ComputerParams): void {
  if (typeof p.pid !== 'number' || typeof p.window_id !== 'number') {
    throw new Error(t('tools.computerWindowTargetRequired'));
  }
}

function clickArgs(
  p: ComputerParams,
  ctx: BuildContext,
  kind: 'click' | 'double_click' | 'right_click',
): Record<string, unknown> {
  const isDesktop = p.scope === 'desktop' || !!p.display_id;
  const hasElement = !!p.element_token && !isDesktop;
  const hasPixel = typeof p.x === 'number' && typeof p.y === 'number';
  if (!hasElement && !hasPixel && typeof p.pid !== 'number') {
    throw new Error(t('tools.computerElementOrPixelRequired'));
  }
  const target = targetArgs(p);
  return compact({
    ...target,
    ...(hasElement ? {} : { x: p.x, y: p.y }),
    ...(kind === 'click' && p.button ? { button: p.button } : {}),
    ...(kind === 'click' && typeof p.count === 'number' ? { count: p.count } : {}),
    ...(p.modifier ? { modifier: p.modifier } : {}),
    ...(p.from_zoom ? { from_zoom: true } : {}),
    delivery_mode: deliveryMode(p, ctx.toolConfig),
  });
}

/** 构造一次 cua 调用（工具名 + 参数） */
export function buildCuaCall(
  p: ComputerParams,
  ctx: BuildContext,
): { tool: string; args: Record<string, unknown> } {
  const tool = pickCuaTool(ctx.service, p.action);

  switch (p.action) {
    case 'list_apps':
      return { tool, args: {} };
    case 'list_windows':
      return {
        tool,
        args: compact({ pid: p.pid, on_screen_only: p.on_screen_only }),
      };
    case 'get_window_state': {
      requireWindow(p);
      // 窗口截图看不到窗口外的自绘浮层（Qt 弹层/浮动工具栏）；整屏截图请用 get_desktop_state
      return {
        tool,
        args: compact({
          pid: p.pid,
          window_id: p.window_id,
          include_screenshot: p.include_screenshot !== false,
          include_accessibility_tree: p.include_accessibility_tree !== false,
          tree_format: 'markdown',
          max_elements: treeElements(p, ctx.toolConfig),
          max_depth: p.max_depth,
          query: p.query,
          since: p.since,
          timeout_ms: p.timeout_ms,
          max_image_dimension: imageDimension(p, ctx.toolConfig),
          screenshot_out_file: p.include_screenshot === false ? undefined : ctx.screenshotPath,
        }),
      };
    }
    case 'get_desktop_state':
      return {
        tool,
        args: compact({
          max_image_dimension: imageDimension(p, ctx.toolConfig),
          screenshot_out_file: ctx.screenshotPath,
        }),
      };
    case 'get_screen_size':
    case 'get_cursor_position':
      return { tool, args: {} };
    case 'zoom':
      if (
        typeof p.window_id !== 'number' ||
        typeof p.x1 !== 'number' ||
        typeof p.y1 !== 'number' ||
        typeof p.x2 !== 'number' ||
        typeof p.y2 !== 'number'
      ) {
        throw new Error(t('tools.computerWindowTargetRequired'));
      }
      return {
        tool,
        args: compact({
          pid: p.pid,
          window_id: p.window_id,
          x1: p.x1,
          y1: p.y1,
          x2: p.x2,
          y2: p.y2,
        }),
      };
    case 'focus':
      if (typeof p.pid !== 'number') throw new Error(t('tools.computerPidRequired'));
      return {
        tool,
        args: compact({ pid: p.pid, window_id: p.window_id }),
      };
    case 'click':
    case 'double_click':
    case 'right_click':
      return { tool, args: clickArgs(p, ctx, p.action) };
    case 'drag': {
      if (
        typeof p.from_x !== 'number' ||
        typeof p.from_y !== 'number' ||
        typeof p.to_x !== 'number' ||
        typeof p.to_y !== 'number'
      ) {
        throw new Error(t('tools.computerElementOrPixelRequired'));
      }
      return {
        tool,
        args: compact({
          ...targetArgs(p),
          from_x: p.from_x,
          from_y: p.from_y,
          to_x: p.to_x,
          to_y: p.to_y,
          delivery_mode: deliveryMode(p, ctx.toolConfig),
        }),
      };
    }
    case 'scroll': {
      const normalized = normalizeScrollParams(p);
      return {
        tool,
        args: compact({
          ...targetArgs(p),
          direction: normalized.direction,
          amount: normalized.amount,
          ...(normalized.by && schemaHasProp(ctx.service, tool, 'by')
            ? { by: normalized.by }
            : {}),
          x: p.x,
          y: p.y,
          delivery_mode: deliveryMode(p, ctx.toolConfig),
        }),
      };
    }
    case 'type_text': {
      if (!p.text) throw new Error(t('tools.computerTextRequired'));
      const isDesktop = p.scope === 'desktop' || !!p.display_id;
      const hasElement = !!p.element_token && !isDesktop;
      return {
        tool,
        args: compact({
          ...targetArgs(p),
          text: p.text,
          ...(hasElement ? {} : { x: p.x, y: p.y }),
          delivery_mode: deliveryMode(p, ctx.toolConfig),
        }),
      };
    }
    case 'press_key': {
      if (!p.key) throw new Error(t('tools.computerKeyRequired'));
      const isDesktop = p.scope === 'desktop' || !!p.display_id;
      const hasElement = !!p.element_token && !isDesktop;
      return {
        tool,
        args: compact({
          ...targetArgs(p),
          key: p.key,
          modifiers: p.modifiers,
          ...(hasElement ? {} : { x: p.x, y: p.y }),
          delivery_mode: deliveryMode(p, ctx.toolConfig),
        }),
      };
    }
    case 'hotkey': {
      if (!Array.isArray(p.keys) || p.keys.length < 2) {
        throw new Error(t('tools.computerKeysRequired'));
      }
      const isDesktop = p.scope === 'desktop' || !!p.display_id;
      const hasElement = !!p.element_token && !isDesktop;
      return {
        tool,
        args: compact({
          ...targetArgs(p),
          keys: p.keys,
          ...(hasElement ? {} : { x: p.x, y: p.y }),
          delivery_mode: deliveryMode(p, ctx.toolConfig),
        }),
      };
    }
    case 'set_value': {
      if (p.value === undefined) throw new Error(t('tools.computerValueRequired'));
      if (typeof p.pid !== 'number') throw new Error(t('tools.computerPidRequired'));
      return {
        tool,
        args: compact({
          pid: p.pid,
          element_token: p.element_token,
          value: p.value,
        }),
      };
    }
    case 'launch_app': {
      if (!p.app) throw new Error(t('tools.computerAppRequired'));
      const schema = ctx.service.getToolSchema(tool) as
        | { properties?: Record<string, unknown> }
        | null;
      const props = schema?.properties ?? {};
      const args: Record<string, unknown> = {};
      // Windows 常用 name/path；macOS 用 bundle_id；按实际 schema 适配，避免版本漂移
      if (Object.prototype.hasOwnProperty.call(props, 'name')) args.name = p.app;
      else if (Object.prototype.hasOwnProperty.call(props, 'path')) args.path = p.app;
      else if (Object.prototype.hasOwnProperty.call(props, 'bundle_id')) args.bundle_id = p.app;
      else args.name = p.app;
      return { tool, args };
    }
    case 'kill_app': {
      if (typeof p.pid !== 'number') throw new Error(t('tools.computerPidRequired'));
      return { tool, args: { pid: p.pid } };
    }
    case 'clipboard_read':
      return { tool, args: { include_text: p.include_text === true } };
    case 'clipboard_write': {
      if (!p.text && !p.image_path && !p.file_path) {
        throw new Error(t('tools.computerClipboardValueRequired'));
      }
      return {
        tool,
        args: compact({
          text: p.text,
          image_path: p.image_path,
          file_path: p.file_path,
        }),
      };
    }
    case 'run_script': {
      if (!p.script || !p.script.trim()) throw new Error('run_script 需要 script（async 函数体）');
      return {
        tool,
        args: compact({
          script: p.script,
          max_calls: p.max_calls,
          timeout_ms: p.timeout_ms,
        }),
      };
    }
    case 'verify': {
      if (typeof p.pid !== 'number' || typeof p.window_id !== 'number') {
        throw new Error(t('tools.computerWindowTargetRequired'));
      }
      if (!Array.isArray(p.expect) || p.expect.length === 0) {
        throw new Error('verify 需要 expect 谓词数组');
      }
      return {
        tool,
        args: compact({
          pid: p.pid,
          window_id: p.window_id,
          expect: p.expect,
          stable_samples: p.stable_samples,
          timeout_ms: p.timeout_ms,
        }),
      };
    }
    case 'run_steps': {
      if (!Array.isArray(p.steps) || p.steps.length === 0) {
        throw new Error(t('tools.computerStepsRequired'));
      }
      if (p.steps.length > 32) throw new Error(t('tools.computerStepsRequired'));
      const allowed = new Set([
        'click',
        'double_click',
        'right_click',
        'set_value',
        'type_text',
        'press_key',
        'hotkey',
        'scroll',
        'drag',
      ]);
      const steps = p.steps.map((step, index) => {
        if (!step || typeof step.tool !== 'string' || !allowed.has(step.tool)) {
          throw new Error(
            t('tools.computerUnsupportedAction', {
              action: step?.tool ?? `steps[${index}]`,
              tools: Array.from(allowed).join(', '),
            }),
          );
        }
        const rawArgs = step.args && typeof step.args === 'object' ? step.args : {};
        const args = step.tool === 'scroll' ? normalizeScrollStepArgs(rawArgs) : rawArgs;
        const rawMode = args.delivery_mode;
        const rest: Record<string, unknown> = { ...args };
        delete rest.delivery_mode;
        // 只有用户显式指定 delivery_mode 时才写进 step；
        // 否则保留缺省，让 cua 的 foreground_fallback 能在 background_unavailable 时逐 step 升级。
        const stepMode =
          typeof rawMode === 'string'
            ? rawMode
            : p.delivery_mode
              ? deliveryMode(p, ctx.toolConfig)
              : undefined;
        return {
          tool: step.tool,
          args: compact({
            ...rest,
            ...(stepMode ? { delivery_mode: stepMode } : {}),
          }),
        };
      });
      // run_steps 的 steps 默认继承 run_steps 自身的 pid/window_id；
      // observe 缺省为 {}（cua 会继承同一个窗口），否则无 observe 时传空对象也不会报错。
      const observe =
        p.observe ??
        (typeof p.pid === 'number'
          ? { pid: p.pid, ...(typeof p.window_id === 'number' ? { window_id: p.window_id } : {}) }
          : undefined);
      const allowForeground = ctx.toolConfig.allowForeground !== false;
      return {
        tool,
        args: compact({
          steps,
          delay_ms: p.delay_ms,
          pid: p.pid,
          window_id: p.window_id,
          observe,
          // Electron/Chromium 的 scroll/keystroke 后台投递不可用时，由 cua 逐 step 升级 foreground
          ...(allowForeground && schemaHasProp(ctx.service, tool, 'foreground_fallback')
            ? { foreground_fallback: true }
            : {}),
          ...(p.delivery_mode && schemaHasProp(ctx.service, tool, 'delivery_mode')
            ? { delivery_mode: p.delivery_mode }
            : {}),
        }),
      };
    }
    case 'status':
    case 'wait':
      // 本地动作：由工具入口处理，不走 cua
      return { tool, args: {} };
    default:
      throw new Error(
        t('tools.computerUnsupportedAction', {
          action: String(p.action),
          tools: ctx.service.listToolNames().slice(0, 30).join(', ') || '—',
        }),
      );
  }
}

/** 动作摘要（不含输入的完整文本，避免敏感内容进入时间线） */
export function summarizeAction(p: ComputerParams): string {
  switch (p.action) {
    case 'focus':
      return `window ${p.pid ?? '?'}/${p.window_id ?? '?'}`;
    case 'get_window_state':
      return `window ${p.pid ?? '?'}/${p.window_id ?? '?'}`;
    case 'click':
    case 'double_click':
    case 'right_click':
      return p.element_token
        ? `element ${p.element_token}`
        : `(${p.x ?? '?'}, ${p.y ?? '?'})`;
    case 'type_text':
      return `${p.text?.length ?? 0} chars`;
    case 'press_key':
      return p.key ?? 'key';
    case 'hotkey':
      return (p.keys ?? []).join('+');
    case 'launch_app':
      return p.app ?? 'app';
    case 'run_steps':
      return `${p.steps?.length ?? 0} steps`;
    case 'run_script':
      return `script ${p.script?.length ?? 0} chars`;
    case 'verify':
      return `${Array.isArray(p.expect) ? p.expect.length : 0} predicates`;
    case 'scroll': {
      try {
        const normalized = normalizeScrollParams(p);
        return `scroll ${normalized.direction}${normalized.amount ? ` x${normalized.amount}` : ''}${
          normalized.by ? ` (${normalized.by})` : ''
        }`;
      } catch {
        return 'scroll';
      }
    }
    case 'wait':
      return `${p.wait_ms ?? 0}ms`;
    default:
      return p.action;
  }
}

/** 目标描述（时间线展示） */
export function describeTarget(p: ComputerParams): string {
  if (typeof p.pid === 'number' && typeof p.window_id === 'number') {
    return `window pid=${p.pid} id=${p.window_id}`;
  }
  if (typeof p.pid === 'number') return `pid=${p.pid}`;
  if (p.element_token) return `element ${p.element_token}`;
  if (p.scope === 'desktop' || p.display_id) return 'desktop';
  return '—';
}
