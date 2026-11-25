// webui/src/lib/tool-copy.ts
// 工具操作文案：把「工具名 + 参数 + 状态」映射成完整的动作句子（i18n）。
// 纯函数，无 React 依赖。目标（路径/命令/查询/URL/元素）完整原样拼接，不在这里截断；
// 行内由 CSS 省略，悬停 title 查看全文。
//
// 文案键位于 task.toolCopy.*（zh/en），失败统一「动词失败：目标」。

import type { TFunction } from 'i18next';

export type ToolCopyState = 'running' | 'done' | 'error';

export interface ToolCopyInput {
  toolName: string;
  args: Record<string, unknown> | null;
  state: ToolCopyState;
}

type CopyParams = Record<string, string | number>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringsOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
  }
  const single = asString(value);
  return single ? [single] : [];
}

function numberText(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

/** 路径/字符串数组：按给定参数名收集（path / paths / files） */
function collectPaths(args: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) out.push(...stringsOf(args[key]));
  return out;
}

/** edit 的多文件入参：path + files（字符串或 { path }） */
function collectEditPaths(args: Record<string, unknown>): string[] {
  const out = collectPaths(args, ['path']);
  if (Array.isArray(args.files)) {
    for (const item of args.files) {
      if (typeof item === 'string') {
        const value = item.trim();
        if (value) out.push(value);
        continue;
      }
      const record = asRecord(item);
      const value = record ? asString(record.path) : '';
      if (value) out.push(value);
    }
  }
  return out;
}

function copy(t: TFunction, base: string, state: ToolCopyState, params?: CopyParams): string {
  return t(`task.toolCopy.${base}.${state}`, params);
}

function generic(t: TFunction, state: ToolCopyState): string {
  return copy(t, 'generic', state);
}

function joinTargets(t: TFunction, list: string[]): string {
  return list.join(t('task.toolCopy.separator'));
}

/** 浏览器元素目标：ref → selector → 坐标 → 页面 */
function browserTarget(t: TFunction, args: Record<string, unknown>): string {
  const ref = asString(args.ref);
  if (ref) return t('task.toolCopy.target.element', { value: ref });
  const selector = asString(args.selector);
  if (selector) return t('task.toolCopy.target.selector', { value: selector });
  const x = numberText(args.x);
  const y = numberText(args.y);
  if (x && y) return t('task.toolCopy.target.coord', { x, y });
  return t('task.toolCopy.target.page');
}

/** 电脑元素目标：element_token → 坐标 → 窗口 */
function computerTarget(t: TFunction, args: Record<string, unknown>): string {
  const token = asString(args.element_token);
  if (token) return t('task.toolCopy.target.element', { value: token });
  const x = numberText(args.x);
  const y = numberText(args.y);
  if (x && y) return t('task.toolCopy.target.coord', { x, y });
  return t('task.toolCopy.target.window');
}

/** 浏览器拖拽起点：from_ref → from_selector → from 坐标 → 页面 */
function browserDragTarget(t: TFunction, args: Record<string, unknown>): string {
  const ref = asString(args.from_ref);
  if (ref) return t('task.toolCopy.target.element', { value: ref });
  const selector = asString(args.from_selector);
  if (selector) return t('task.toolCopy.target.selector', { value: selector });
  const x = numberText(args.from_x);
  const y = numberText(args.from_y);
  if (x && y) return t('task.toolCopy.target.coord', { x, y });
  return t('task.toolCopy.target.page');
}

/** 电脑拖拽起点：element_token → from 坐标 → 窗口 */
function computerDragTarget(t: TFunction, args: Record<string, unknown>): string {
  const token = asString(args.element_token);
  if (token) return t('task.toolCopy.target.element', { value: token });
  const x = numberText(args.from_x);
  const y = numberText(args.from_y);
  if (x && y) return t('task.toolCopy.target.coord', { x, y });
  return t('task.toolCopy.target.window');
}

function directionKey(t: TFunction, value: string): string {
  if (value === 'up' || value === 'down' || value === 'left' || value === 'right') {
    return t(`task.toolCopy.direction.${value}`);
  }
  return t('task.toolCopy.direction.down');
}

/** 按 delta 选主方向（量级相同按纵向） */
function scrollDirection(
  t: TFunction,
  deltaX: unknown,
  deltaY: unknown,
  fallback = 'down',
): string {
  const dx = typeof deltaX === 'number' ? deltaX : Number(numberText(deltaX) || 0);
  const dy = typeof deltaY === 'number' ? deltaY : Number(numberText(deltaY) || 0);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return directionKey(t, fallback);
  if (Math.abs(dx) > Math.abs(dy)) return directionKey(t, dx > 0 ? 'right' : 'left');
  return directionKey(t, dy >= 0 ? 'down' : 'up');
}

/** wait 条件 → 可读目标（时间窗口单独走 waitTime） */
function waitConditionTarget(t: TFunction, args: Record<string, unknown>): string | null {
  const conditions = Array.isArray(args.conditions) ? args.conditions : [];
  if (conditions.length > 0) {
    const first = asRecord(conditions[0]);
    const kind = first ? asString(first.kind) || asString(first.type) : '';
    const key =
      kind === 'session'
        ? 'session'
        : kind === 'terminal'
          ? 'terminal'
          : kind === 'tool'
            ? 'tool'
            : kind === 'agent'
              ? 'agent'
              : 'fallback';
    return t(`task.toolCopy.waitTarget.${key}`);
  }
  return null;
}

function read(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const paths = collectPaths(args, ['path', 'paths']);
  if (paths.length === 0) return generic(t, state);
  if (paths.length === 1) return copy(t, 'read', state, { target: paths[0] });
  return copy(t, 'readMulti', state, {
    count: paths.length,
    targets: joinTargets(t, paths),
  });
}

function edit(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const paths = collectEditPaths(args);
  if (paths.length === 0) return generic(t, state);
  if (paths.length === 1) return copy(t, 'edit', state, { target: paths[0] });
  return copy(t, 'editMulti', state, {
    count: paths.length,
    targets: joinTargets(t, paths),
  });
}

function remove(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const paths = collectPaths(args, ['path', 'paths']);
  if (paths.length === 0) return generic(t, state);
  if (paths.length === 1) return copy(t, 'delete', state, { target: paths[0] });
  return copy(t, 'deleteMulti', state, {
    count: paths.length,
    targets: joinTargets(t, paths),
  });
}

function documents(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const action = asString(args.action);
  if (action === 'read') {
    const path = asString(args.path);
    return path ? copy(t, 'documentsRead', state, { target: path }) : generic(t, state);
  }
  if (action === 'list') return copy(t, 'documentsList', state);
  const query = asString(args.query);
  return query ? copy(t, 'documentsSearch', state, { target: query }) : generic(t, state);
}

function web(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const mode = asString(args.mode);
  const url = asString(args.url);
  if (mode === 'fetch' || (url && !asString(args.query))) {
    return url ? copy(t, 'webFetch', state, { target: url }) : generic(t, state);
  }
  const query = asString(args.query);
  return query ? copy(t, 'webSearch', state, { target: query }) : generic(t, state);
}

function terminal(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const action = asString(args.action) || 'exec';
  const command = asString(args.command);
  switch (action) {
    case 'exec':
      return command ? copy(t, 'terminalExec', state, { command }) : generic(t, state);
    case 'send':
      return command ? copy(t, 'terminalSend', state, { command }) : generic(t, state);
    case 'read':
      return copy(t, 'terminalRead', state);
    case 'list':
      return copy(t, 'terminalList', state);
    case 'create':
      return copy(t, 'terminalCreate', state);
    case 'kill':
      return copy(t, 'terminalKill', state);
    case 'restart':
      return copy(t, 'terminalRestart', state);
    default:
      return generic(t, state);
  }
}

function browser(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const action = asString(args.action);
  switch (action) {
    case 'status':
      return copy(t, 'browserStatus', state);
    case 'setup':
      return copy(t, 'browserSetup', state);
    case 'open': {
      const url = asString(args.url);
      return url ? copy(t, 'browserOpen', state, { target: url }) : generic(t, state);
    }
    case 'tabs':
      return copy(t, 'browserTabs', state);
    case 'focus':
      return copy(t, 'browserFocus', state);
    case 'close':
      return copy(t, 'browserClose', state);
    case 'navigate': {
      if (args.back === true) return copy(t, 'browserBack', state);
      if (args.forward === true) return copy(t, 'browserForward', state);
      if (args.reload === true) return copy(t, 'browserReload', state);
      const url = asString(args.url);
      return url ? copy(t, 'browserNavigate', state, { target: url }) : generic(t, state);
    }
    case 'snapshot':
      return copy(t, 'browserSnapshot', state);
    case 'screenshot':
      return copy(t, 'browserScreenshot', state);
    case 'frames':
      return copy(t, 'browserFrames', state);
    case 'click':
      return copy(t, 'browserClick', state, { target: browserTarget(t, args) });
    case 'hover':
      return copy(t, 'browserHover', state, { target: browserTarget(t, args) });
    case 'type': {
      const text = asString(args.text);
      return text ? copy(t, 'browserType', state, { target: text }) : generic(t, state);
    }
    case 'press_key': {
      const key = asString(args.key);
      return key ? copy(t, 'browserPressKey', state, { target: key }) : generic(t, state);
    }
    case 'key_down': {
      const key = asString(args.key);
      return key ? copy(t, 'browserKeyDown', state, { target: key }) : generic(t, state);
    }
    case 'key_up': {
      const key = asString(args.key);
      return key ? copy(t, 'browserKeyUp', state, { target: key }) : generic(t, state);
    }
    case 'hold': {
      const keys = stringsOf(args.keys).join('+') || asString(args.key);
      const ms = numberText(args.duration_ms);
      return keys ? copy(t, 'browserHold', state, { target: keys, ms: ms || '0' }) : generic(t, state);
    }
    case 'macro': {
      const steps = Array.isArray(args.actions)
        ? args.actions.length
        : Array.isArray(args.steps)
          ? args.steps.length
          : 0;
      return steps > 0 ? copy(t, 'browserMacro', state, { count: steps }) : generic(t, state);
    }
    case 'select': {
      const values = stringsOf(args.values);
      return values.length > 0
        ? copy(t, 'browserSelect', state, { target: joinTargets(t, values) })
        : generic(t, state);
    }
    case 'scroll':
      return copy(t, 'browserScroll', state, {
        target: scrollDirection(t, args.delta_x, args.delta_y),
      });
    case 'drag':
      return copy(t, 'browserDrag', state, { target: browserDragTarget(t, args) });
    case 'evaluate':
      return copy(t, 'browserEvaluate', state);
    case 'wait':
      return copy(t, 'browserWait', state);
    case 'wait_stable':
      return copy(t, 'browserWaitStable', state);
    case 'wait_change':
      return copy(t, 'browserWaitChange', state);
    case 'console':
      return copy(t, 'browserConsole', state);
    default:
      return generic(t, state);
  }
}

function computer(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const action = asString(args.action);
  switch (action) {
    case 'status':
      return copy(t, 'computerStatus', state);
    case 'list_apps':
      return copy(t, 'computerListApps', state);
    case 'list_windows':
      return copy(t, 'computerListWindows', state);
    case 'get_window_state':
      return copy(t, 'computerWindowState', state);
    case 'get_desktop_state':
      return copy(t, 'computerDesktopState', state);
    case 'get_screen_size':
      return copy(t, 'computerScreenSize', state);
    case 'get_cursor_position':
      return copy(t, 'computerCursor', state);
    case 'zoom':
      return copy(t, 'computerZoom', state, { target: computerTarget(t, args) });
    case 'focus':
      return copy(t, 'computerFocus', state, { target: computerTarget(t, args) });
    case 'click':
      return copy(t, 'computerClick', state, { target: computerTarget(t, args) });
    case 'double_click':
      return copy(t, 'computerDoubleClick', state, { target: computerTarget(t, args) });
    case 'right_click':
      return copy(t, 'computerRightClick', state, { target: computerTarget(t, args) });
    case 'drag':
      return copy(t, 'computerDrag', state, { target: computerDragTarget(t, args) });
    case 'scroll': {
      const raw = asString(args.direction);
      const target = raw
        ? directionKey(t, raw)
        : scrollDirection(t, args.delta_x, args.delta_y);
      return copy(t, 'computerScroll', state, { target });
    }
    case 'type_text': {
      const text = asString(args.text);
      return text ? copy(t, 'computerTypeText', state, { target: text }) : generic(t, state);
    }
    case 'press_key': {
      const key = asString(args.key);
      return key ? copy(t, 'computerPressKey', state, { target: key }) : generic(t, state);
    }
    case 'hotkey': {
      const keys = stringsOf(args.keys).join('+') || asString(args.keys);
      return keys ? copy(t, 'computerHotkey', state, { target: keys }) : generic(t, state);
    }
    case 'set_value': {
      const value = asString(args.value);
      return value ? copy(t, 'computerSetValue', state, { target: value }) : generic(t, state);
    }
    case 'launch_app': {
      const app = asString(args.app);
      return app ? copy(t, 'computerLaunchApp', state, { target: app }) : generic(t, state);
    }
    case 'kill_app': {
      const app = asString(args.app);
      return app ? copy(t, 'computerKillApp', state, { target: app }) : generic(t, state);
    }
    case 'clipboard_read':
      return copy(t, 'computerClipboardRead', state);
    case 'clipboard_write':
      return copy(t, 'computerClipboardWrite', state);
    case 'run_steps': {
      const steps = Array.isArray(args.steps) ? args.steps.length : 0;
      return steps > 0 ? copy(t, 'computerRunSteps', state, { count: steps }) : generic(t, state);
    }
    case 'run_script':
      return copy(t, 'computerRunScript', state);
    case 'verify':
      return copy(t, 'computerVerify', state);
    case 'wait': {
      const ms = numberText(args.wait_ms);
      return ms
        ? copy(t, 'computerWait', state, { target: t('task.toolCopy.durationMs', { ms }) })
        : generic(t, state);
    }
    default:
      return generic(t, state);
  }
}

function mcp(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const action = asString(args.action);
  if (action === 'list') return copy(t, 'mcpList', state);
  if (action === 'search') {
    const keyword = asString(args.keyword);
    return keyword ? copy(t, 'mcpSearch', state, { target: keyword }) : generic(t, state);
  }
  if (action === 'info') {
    const target = asString(args.server) || asString(args.name);
    return target ? copy(t, 'mcpInfo', state, { target }) : generic(t, state);
  }
  if (action === 'install') {
    const target = asString(args.name) || asString(args.server);
    return target ? copy(t, 'mcpInstall', state, { target }) : generic(t, state);
  }
  const server = asString(args.server);
  const tool = asString(args.tool);
  return server && tool ? copy(t, 'mcpCall', state, { server, tool }) : generic(t, state);
}

function skill(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const action = asString(args.action);
  const target = asString(args.skill) || asString(args.name) || asString(args.keyword);
  switch (action) {
    case 'list':
      return copy(t, 'skillList', state);
    case 'use':
      return target ? copy(t, 'skillUse', state, { target }) : generic(t, state);
    case 'create':
      return target ? copy(t, 'skillCreate', state, { target }) : generic(t, state);
    case 'update':
      return target ? copy(t, 'skillUpdate', state, { target }) : generic(t, state);
    case 'delete':
      return target ? copy(t, 'skillDelete', state, { target }) : generic(t, state);
    case 'search':
      return target ? copy(t, 'skillSearch', state, { target }) : generic(t, state);
    case 'install':
      return target ? copy(t, 'skillInstall', state, { target }) : generic(t, state);
    default:
      return generic(t, state);
  }
}

function memory(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const action = asString(args.action);
  switch (action) {
    case 'search': {
      const query = asString(args.query);
      return query ? copy(t, 'memorySearch', state, { target: query }) : generic(t, state);
    }
    case 'save': {
      const room = asString(args.room);
      return room ? copy(t, 'memorySave', state, { target: room }) : generic(t, state);
    }
    case 'update':
      return copy(t, 'memoryUpdate', state);
    case 'delete':
      return copy(t, 'memoryDelete', state);
    case 'pin':
      return copy(t, 'memoryPin', state);
    case 'list_rooms':
      return copy(t, 'memoryListRooms', state);
    default:
      return generic(t, state);
  }
}

function automation(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const action = asString(args.action);
  const title = asString(args.title);
  switch (action) {
    case 'create':
      return title ? copy(t, 'automationCreate', state, { target: title }) : generic(t, state);
    case 'update':
      return title ? copy(t, 'automationUpdate', state, { target: title }) : generic(t, state);
    case 'delete':
      return copy(t, 'automationDelete', state);
    case 'list':
      return copy(t, 'automationList', state);
    case 'get':
      return title ? copy(t, 'automationGet', state, { target: title }) : generic(t, state);
    case 'trigger':
      return title ? copy(t, 'automationTrigger', state, { target: title }) : generic(t, state);
    case 'pause':
      return title ? copy(t, 'automationPause', state, { target: title }) : generic(t, state);
    case 'resume':
      return title ? copy(t, 'automationResume', state, { target: title }) : generic(t, state);
    case 'history':
      return copy(t, 'automationHistory', state);
    default:
      return generic(t, state);
  }
}

function todo(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const action = asString(args.action);
  if (action === 'create') {
    const items = Array.isArray(args.items) ? args.items : [];
    const first = items.length > 0 ? asRecord(items[0]) : null;
    const target = asString(args.text) || (first ? asString(first.text) : '');
    return target ? copy(t, 'todoCreate', state, { target }) : generic(t, state);
  }
  if (action === 'update') {
    const target = asString(args.text) || asString(args.id);
    return target ? copy(t, 'todoUpdate', state, { target }) : generic(t, state);
  }
  if (action === 'list') return copy(t, 'todoList', state);
  if (action === 'reorder') return copy(t, 'todoReorder', state);
  if (action === 'batch_update') {
    const count = Array.isArray(args.updates) ? args.updates.length : 0;
    return count > 0 ? copy(t, 'todoBatch', state, { count }) : generic(t, state);
  }
  return generic(t, state);
}

function set(t: TFunction, args: Record<string, unknown>, state: ToolCopyState): string {
  const action = asString(args.action);
  const target = asString(args.name) || asString(args.id);
  switch (action) {
    case 'list':
      return copy(t, 'setList', state);
    case 'create':
      return target ? copy(t, 'setCreate', state, { target }) : generic(t, state);
    case 'update':
      return target ? copy(t, 'setUpdate', state, { target }) : generic(t, state);
    case 'delete':
      return target ? copy(t, 'setDelete', state, { target }) : generic(t, state);
    case 'set':
      return target ? copy(t, 'setSet', state, { target }) : generic(t, state);
    default:
      return generic(t, state);
  }
}

/**
 * 工具调用 → 动作文案。
 * 参数缺失（仍在流式生成/解析失败）时回退 generic，不显示半截目标。
 */
export function formatToolCopy(t: TFunction, input: ToolCopyInput): string {
  const { toolName, args, state } = input;
  if (!args) return generic(t, state);

  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const server = parts[1] ?? '';
    const tool = parts.slice(2).join('__');
    return server && tool
      ? copy(t, 'mcpTool', state, { server, tool })
      : generic(t, state);
  }

  switch (toolName) {
    case 'read':
      return read(t, args, state);
    case 'write': {
      const path = asString(args.path);
      return path ? copy(t, 'write', state, { target: path }) : generic(t, state);
    }
    case 'edit':
      return edit(t, args, state);
    case 'delete':
      return remove(t, args, state);
    case 'glob': {
      const pattern = asString(args.pattern);
      if (!pattern) return generic(t, state);
      const path = asString(args.path);
      return path
        ? copy(t, 'globIn', state, { target: pattern, path })
        : copy(t, 'glob', state, { target: pattern });
    }
    case 'grep': {
      const pattern = asString(args.pattern);
      if (!pattern) return generic(t, state);
      const path = asString(args.path);
      return path
        ? copy(t, 'grepIn', state, { target: pattern, path })
        : copy(t, 'grep', state, { target: pattern });
    }
    case 'documents':
      return documents(t, args, state);
    case 'web':
      return web(t, args, state);
    case 'terminal':
      return terminal(t, args, state);
    case 'run_code': {
      const description = asString(args.description) || t('task.runCode.code');
      return copy(t, 'runCode', state, { description });
    }
    case 'wait': {
      const time = asRecord(args.time);
      const duration = time ? asString(time.duration) : '';
      const condition = waitConditionTarget(t, args);
      if (duration) {
        const target = condition ? `${duration} · ${condition}` : duration;
        return copy(t, 'waitTime', state, { target });
      }
      return condition ? copy(t, 'waitCondition', state, { target: condition }) : generic(t, state);
    }
    case 'browser':
      return browser(t, args, state);
    case 'computer':
      return computer(t, args, state);
    case 'mcp':
      return mcp(t, args, state);
    case 'agent': {
      const name = asString(args.template) || asString(args.name) || asString(args.agentName);
      return name ? copy(t, 'agent', state, { name }) : copy(t, 'agentGeneric', state);
    }
    case 'ask':
      return copy(t, 'ask', state);
    case 'todo':
      return todo(t, args, state);
    case 'skill':
      return skill(t, args, state);
    case 'memory':
      return memory(t, args, state);
    case 'context': {
      if (asString(args.action) === 'compact') return copy(t, 'contextCompact', state);
      const query = asString(args.query);
      return query ? copy(t, 'contextSearch', state, { target: query }) : generic(t, state);
    }
    case 'automation':
      return automation(t, args, state);
    case 'set':
      return set(t, args, state);
    default:
      return generic(t, state);
  }
}
