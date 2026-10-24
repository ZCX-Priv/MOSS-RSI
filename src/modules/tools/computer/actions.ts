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
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  delivery_mode?: 'background' | 'foreground';
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

/** 构造 cua 的 target / legacy 目标参数 */
function targetArgs(p: ComputerParams): Record<string, unknown> {
  if (p.element_token) {
    return compact({ element_token: p.element_token, pid: p.pid });
  }
  if (typeof p.pid === 'number' && typeof p.window_id === 'number') {
    return { target: { kind: 'window', pid: p.pid, window_id: p.window_id } };
  }
  if (typeof p.pid === 'number') {
    return { pid: p.pid };
  }
  if (p.scope === 'desktop' || p.display_id) {
    return { target: { kind: 'desktop', display_id: p.display_id ?? 'primary' } };
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
  const target = targetArgs(p);
  const hasElement = !!p.element_token;
  const hasPixel = typeof p.x === 'number' && typeof p.y === 'number';
  if (!hasElement && !hasPixel && typeof p.pid !== 'number') {
    throw new Error(t('tools.computerElementOrPixelRequired'));
  }
  return compact({
    ...target,
    ...(hasElement ? {} : { x: p.x, y: p.y }),
    ...(kind === 'click' && p.button ? { button: p.button } : {}),
    ...(kind === 'click' && typeof p.count === 'number' ? { count: p.count } : {}),
    ...(p.modifier ? { modifier: p.modifier } : {}),
    ...(p.from_zoom ? { from_zoom: true } : {}),
    ...(p.scope ? { scope: p.scope } : {}),
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
      if (!p.direction) throw new Error(t('tools.computerElementOrPixelRequired'));
      return {
        tool,
        args: compact({
          ...targetArgs(p),
          direction: p.direction,
          amount: p.amount,
          x: p.x,
          y: p.y,
          delivery_mode: deliveryMode(p, ctx.toolConfig),
        }),
      };
    }
    case 'type_text': {
      if (!p.text) throw new Error(t('tools.computerTextRequired'));
      return {
        tool,
        args: compact({
          ...targetArgs(p),
          text: p.text,
          ...(p.element_token ? {} : { x: p.x, y: p.y }),
          delivery_mode: deliveryMode(p, ctx.toolConfig),
        }),
      };
    }
    case 'press_key': {
      if (!p.key) throw new Error(t('tools.computerKeyRequired'));
      return {
        tool,
        args: compact({
          ...targetArgs(p),
          key: p.key,
          modifiers: p.modifiers,
          ...(p.element_token ? {} : { x: p.x, y: p.y }),
          delivery_mode: deliveryMode(p, ctx.toolConfig),
        }),
      };
    }
    case 'hotkey': {
      if (!Array.isArray(p.keys) || p.keys.length < 2) {
        throw new Error(t('tools.computerKeysRequired'));
      }
      return {
        tool,
        args: compact({
          ...targetArgs(p),
          keys: p.keys,
          ...(p.element_token ? {} : { x: p.x, y: p.y }),
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
        const args = step.args && typeof step.args === 'object' ? step.args : {};
        return {
          tool: step.tool,
          args: compact({ ...args, delivery_mode: args.delivery_mode ?? deliveryMode(p, ctx.toolConfig) }),
        };
      });
      return {
        tool,
        args: compact({
          steps,
          delay_ms: p.delay_ms,
          observe: p.observe,
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
