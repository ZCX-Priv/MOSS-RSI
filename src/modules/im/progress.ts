// src/modules/im/progress.ts
// 过程播报文案生成：把一次工具调用映射成一条可读的 IM 短句。
// 文案风格由产品定稿：以「已…」开头；文件路径相对会话工作目录；多文件操作分行列出。
// 纯函数、无 IO，便于单测。

import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolResult } from '../tools/types';

const PATH_LIMIT = 80;
const QUERY_LIMIT = 40;
const COMMAND_LIMIT = 60;
const TEXT_LIMIT = 30;
const TASK_LIMIT = 40;
const TOKEN_LIMIT = 20;
const MAX_CODE_CALLS = 6;
const FAILED_SUFFIX = '（失败）';

/** 一次工具调用的播报输入 */
export interface ToolProgressInput {
  toolName: string;
  args: Record<string, unknown>;
  /** 会话工作目录（绝对路径时才能相对化；__system__ 等逻辑作用域保持原样） */
  cwd: string;
  isError: boolean;
  result?: ToolResult;
}

/** 单个子智能体的播报条目 */
export interface SubagentEntry {
  /** 注册表显示名（缺失时已回退为 template id） */
  name: string;
  /** 自包含任务描述 */
  task: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberText(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() ?? '';
}

/** 解析工具参数文本；空串视为空参数，非法 JSON 返回 null（不播报） */
export function parseToolArguments(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 字符串数组取值：字符串 → 单项；数组 → 过滤字符串元素 */
function stringsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  const single = textOf(value);
  return single ? [single] : [];
}

/** cwd 内路径 → 相对路径（/ 分隔）；cwd 非绝对路径或路径在 cwd 外时保留原样 */
function displayPath(value: unknown, cwd: string): string {
  const raw = textOf(value);
  if (!raw) return '';
  if (!isAbsolute(cwd)) return truncate(raw, PATH_LIMIT);
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const rel = relative(cwd, abs);
  const shown = rel === '' ? '.' : rel.startsWith('..') || isAbsolute(rel) ? raw : rel.split(sep).join('/');
  return truncate(shown, PATH_LIMIT);
}

/** 单文件单行；多文件「已读取N个文件：」+ 每行一个路径 */
function fileListText(prefix: string, paths: string[], unit: string, isError: boolean): string | null {
  if (paths.length === 0) return null;
  // 单行由外层统一追加失败后缀；多行把后缀放在首行的数量后
  if (paths.length === 1) return `${prefix} ${paths[0]}`;
  const suffix = isError ? FAILED_SUFFIX : '';
  return [`${prefix}${paths.length}${unit}${suffix}：`, ...paths].join('\n');
}

/** 复制/移动：单源一行；多源分行「源 → 目标」 */
function transferText(prefix: string, sources: string[], dest: string, isError: boolean): string | null {
  if (!dest || sources.length === 0) return null;
  if (sources.length === 1) return `${prefix} ${sources[0]} → ${dest}`;
  const suffix = isError ? FAILED_SUFFIX : '';
  return [`${prefix}${sources.length}个文件${suffix}：`, ...sources.map(source => `${source} → ${dest}`)].join('\n');
}

/** run_code 内部调用 → 可读短语 */
function codeCallText(name: string, args: Record<string, unknown> | null, preview: string): string {
  const lower = name.toLowerCase();
  const argPath = textOf(args?.path) || textOf(args?.file_path);
  const argPattern = textOf(args?.pattern);
  const argQuery = textOf(args?.query);
  const argCommand = textOf(args?.command);
  const argUrl = textOf(args?.url);
  const argText = textOf(args?.text);

  if (lower === 'read' || lower === 'read_file') {
    const value = argPath || preview;
    return value ? `读取 ${truncate(value, QUERY_LIMIT)}` : '读取';
  }
  if (lower === 'write' || lower === 'write_file') {
    const value = argPath || preview;
    return value ? `写入 ${truncate(value, QUERY_LIMIT)}` : '写入';
  }
  if (lower === 'edit' || lower === 'edit_file') {
    const value = argPath || preview;
    return value ? `编辑 ${truncate(value, QUERY_LIMIT)}` : '编辑';
  }
  if (lower === 'grep' || lower === 'search') {
    const value = argPattern || argQuery || preview;
    return value ? `搜索「${truncate(value, QUERY_LIMIT)}」` : '搜索';
  }
  if (lower === 'glob' || lower === 'find') {
    const value = argPattern || preview;
    return value ? `查找 ${truncate(value, QUERY_LIMIT)}` : '查找';
  }
  if (lower === 'terminal' || lower === 'bash' || lower === 'shell' || lower === 'execute') {
    const value = argCommand || preview;
    return value ? `执行 ${truncate(value, COMMAND_LIMIT)}` : '执行';
  }
  if (lower === 'web' || lower === 'fetch' || lower === 'webfetch') {
    const value = argUrl || argQuery || preview;
    return value ? `获取 ${truncate(value, QUERY_LIMIT)}` : '获取';
  }
  if (argText) return `调用 ${name}「${truncate(argText, TEXT_LIMIT)}」`;
  return `调用 ${name || '工具'}`;
}

/** 从 run_code 结果的 metadata.codeRun.calls 提取内部调用短语 */
function codeRunItems(result?: ToolResult): string[] {
  if (!isRecord(result?.metadata)) return [];
  const codeRun = result.metadata.codeRun;
  if (!isRecord(codeRun) || !Array.isArray(codeRun.calls)) return [];

  const items: string[] = [];
  for (const call of codeRun.calls) {
    if (!isRecord(call)) continue;
    const name = textOf(call.name);
    const preview = textOf(call.argsPreview);
    items.push(codeCallText(name, parseToolArguments(preview), preview));
  }
  if (items.length > MAX_CODE_CALLS) {
    const rest = items.length - MAX_CODE_CALLS;
    return [...items.slice(0, MAX_CODE_CALLS), `等 ${rest} 项`];
  }
  return items;
}

/** 电脑操作目标：元素句柄 → 坐标 → 窗口 */
function computerTarget(args: Record<string, unknown>): string {
  const token = textOf(args.element_token);
  if (token) return `元素 ${truncate(token, TOKEN_LIMIT)}`;
  const x = numberText(args.x);
  const y = numberText(args.y);
  if (x && y) return `坐标 (${x}, ${y})`;
  return '窗口';
}

function computerText(args: Record<string, unknown>): string | null {
  const action = textOf(args.action);
  const target = computerTarget(args);
  switch (action) {
    case 'status': return '已检查驱动状态';
    case 'list_apps': return '已列出应用';
    case 'list_windows': return '已列出窗口';
    case 'get_window_state': return '已读取窗口内容';
    case 'get_desktop_state': return '已读取桌面内容';
    case 'get_screen_size': return '已获取屏幕尺寸';
    case 'get_cursor_position': return '已获取光标位置';
    case 'zoom': return '已放大查看';
    case 'click': return `已点击${target}`;
    case 'double_click': return `已双击${target}`;
    case 'right_click': return `已右键点击${target}`;
    case 'drag': return `已拖拽${target}`;
    case 'scroll': {
      const direction = textOf(args.direction);
      const label = direction === 'up' ? '上' : direction === 'left' ? '左' : direction === 'right' ? '右' : '下';
      return `已向${label}滚动`;
    }
    case 'type_text': {
      const text = textOf(args.text);
      return text ? `已输入「${truncate(text, TEXT_LIMIT)}」` : '已输入文字';
    }
    case 'press_key': {
      const key = textOf(args.key);
      return key ? `已按${key}` : '已按键';
    }
    case 'hotkey': {
      const keys = stringsOf(args.keys).join('+');
      return keys ? `已按${keys}` : '已按键组合';
    }
    case 'set_value': {
      const value = textOf(args.value);
      return value ? `已设置「${truncate(value, TEXT_LIMIT)}」` : '已设置元素值';
    }
    case 'launch_app': {
      const app = textOf(args.app);
      return app ? `已启动「${truncate(app, QUERY_LIMIT)}」` : '已启动应用';
    }
    case 'kill_app': {
      const app = textOf(args.app);
      return app ? `已关闭「${truncate(app, QUERY_LIMIT)}」` : '已关闭应用';
    }
    case 'clipboard_read': return '已读取剪贴板';
    case 'clipboard_write': return '已写入剪贴板';
    case 'run_steps': {
      const steps = Array.isArray(args.steps) ? args.steps.length : 0;
      return steps > 0 ? `已连续执行 ${steps} 步操作` : '已执行连续操作';
    }
    case 'wait': {
      const ms = numberText(args.wait_ms);
      return ms ? `已等待 ${ms} 毫秒` : '已等待';
    }
    default: return null;
  }
}

/** 浏览器操作目标：元素引用 → 选择器 → 坐标 */
function browserTarget(args: Record<string, unknown>): string {
  const ref = textOf(args.ref);
  if (ref) return `元素 ${truncate(ref, TOKEN_LIMIT)}`;
  const selector = textOf(args.selector);
  if (selector) return `选择器 ${truncate(selector, TOKEN_LIMIT)}`;
  const x = numberText(args.x);
  const y = numberText(args.y);
  if (x && y) return `坐标 (${x}, ${y})`;
  return '';
}

function browserText(args: Record<string, unknown>): string | null {
  const action = textOf(args.action);
  const target = browserTarget(args);
  switch (action) {
    case 'status': return '已检查浏览器状态';
    case 'setup': return '已安装浏览器扩展';
    case 'open': {
      const url = textOf(args.url);
      return url ? `已打开 ${truncate(url, PATH_LIMIT)}` : '已打开浏览器';
    }
    case 'tabs': return '已列出标签页';
    case 'focus': return '已切换标签页';
    case 'close': return '已关闭标签页';
    case 'navigate': {
      if (args.back === true) return '已后退';
      if (args.forward === true) return '已前进';
      if (args.reload === true) return '已刷新页面';
      const url = textOf(args.url);
      return url ? `已访问 ${truncate(url, PATH_LIMIT)}` : '已切换页面';
    }
    case 'snapshot': return '已读取页面结构';
    case 'screenshot': return '已截图';
    case 'click': return target ? `已点击${target}` : '已点击页面';
    case 'hover': return target ? `已悬停${target}` : '已悬停页面元素';
    case 'type': {
      const text = textOf(args.text);
      return text ? `已输入「${truncate(text, TEXT_LIMIT)}」` : '已输入文字';
    }
    case 'press_key': {
      const key = textOf(args.key);
      return key ? `已按${key}` : '已按键';
    }
    case 'select': {
      const values = stringsOf(args.values);
      return values.length > 0 ? `已选择「${truncate(values.join('、'), TEXT_LIMIT)}」` : '已选择选项';
    }
    case 'scroll': {
      const deltaX = typeof args.delta_x === 'number' ? args.delta_x : 0;
      const deltaY = typeof args.delta_y === 'number' ? args.delta_y : 0;
      if (Math.abs(deltaX) > Math.abs(deltaY)) return deltaX > 0 ? '已向右滚动' : '已向左滚动';
      return deltaY >= 0 ? '已向下滚动' : '已向上滚动';
    }
    case 'drag': return '已拖拽页面元素';
    case 'evaluate': return '已执行页面脚本';
    case 'wait': return '已等待页面就绪';
    case 'console': return '已读取控制台';
    default: return null;
  }
}

/** 工具调用 → 播报正文；null 表示不播报（todo/ask/agent 与无参数可读的工具） */
function buildProgressText(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  result: ToolResult | undefined,
  isError: boolean,
): string | null {
  // 实际 MCP 工具的事件名形如 mcp__server__tool
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const server = parts[1] ?? '';
    const tool = parts.slice(2).join('__');
    return `已调用 MCP 工具 ${server}/${tool}`.replace(/\/$/, '');
  }

  switch (toolName) {
    case 'read': {
      const paths = [...stringsOf(args.path), ...stringsOf(args.paths)]
        .map(path => displayPath(path, cwd))
        .filter(Boolean);
      return fileListText('已读取', paths, '个文件', isError);
    }
    case 'write': {
      const path = displayPath(args.path, cwd);
      return path ? `已写入 ${path}` : null;
    }
    case 'edit': {
      const files = Array.isArray(args.files)
        ? args.files.map(item => (isRecord(item) ? textOf(item.path) : textOf(item)))
        : [];
      const paths = [...stringsOf(args.path), ...files]
        .map(path => displayPath(path, cwd))
        .filter(Boolean);
      return fileListText('已编辑', paths, '个文件', isError);
    }
    case 'delete': {
      const paths = [...stringsOf(args.path), ...stringsOf(args.paths)]
        .map(path => displayPath(path, cwd))
        .filter(Boolean);
      return fileListText('已删除', paths, '项', isError);
    }
    case 'copy':
    case 'move': {
      const prefix = toolName === 'copy' ? '已复制' : '已移动';
      const sources = [...stringsOf(args.source), ...stringsOf(args.sources)]
        .map(source => displayPath(source, cwd))
        .filter(Boolean);
      return transferText(prefix, sources, displayPath(args.dest, cwd), isError);
    }
    case 'grep': {
      const pattern = textOf(args.pattern);
      if (!pattern) return null;
      const path = displayPath(args.path, cwd);
      return path
        ? `已在 ${path} 中搜索「${truncate(pattern, QUERY_LIMIT)}」`
        : `已搜索「${truncate(pattern, QUERY_LIMIT)}」`;
    }
    case 'glob': {
      const pattern = textOf(args.pattern);
      return pattern ? `已查找文件「${truncate(pattern, QUERY_LIMIT)}」` : null;
    }
    case 'web': {
      const mode = textOf(args.mode);
      if (mode === 'fetch') {
        const url = textOf(args.url);
        return url ? `已获取 ${truncate(url, PATH_LIMIT)}` : null;
      }
      const query = textOf(args.query);
      return query ? `已搜索「${truncate(query, QUERY_LIMIT)}」` : null;
    }
    case 'run_code': {
      const description = truncate(textOf(args.description) || '代码程序', QUERY_LIMIT);
      const items = codeRunItems(result);
      return items.length > 0
        ? `已执行代码「${description}」：${items.join('、')}`
        : `已执行代码「${description}」`;
    }
    case 'terminal': {
      const action = textOf(args.action);
      const command = truncate(textOf(args.command), COMMAND_LIMIT);
      switch (action) {
        case 'exec': return command ? `已执行命令：${command}` : '已执行命令';
        case 'create': return '已创建终端';
        case 'send': return command ? `已向终端发送：${command}` : '已向终端发送输入';
        case 'read': return '已读取终端输出';
        case 'list': return '已列出终端';
        case 'kill': return '已关闭终端';
        case 'restart': return '已重启终端';
        default: return '已操作终端';
      }
    }
    case 'computer': {
      const detail = computerText(args);
      return detail ? `操作电脑：${detail}` : null;
    }
    case 'browser': {
      const detail = browserText(args);
      return detail ? `操作浏览器：${detail}` : null;
    }
    case 'mcp': {
      const action = textOf(args.action);
      if (action === 'list') return '已列出 MCP 工具';
      const server = textOf(args.server);
      const tool = textOf(args.tool);
      if (server && tool) return `已调用 MCP 工具 ${server}/${tool}`;
      return '已调用 MCP 工具';
    }
    case 'skill': {
      const action = textOf(args.action);
      if (action === 'list') return '已列出技能';
      const skill = textOf(args.skill);
      return skill ? `已加载技能「${truncate(skill, QUERY_LIMIT)}」` : '已加载技能';
    }
    case 'memory': {
      const action = textOf(args.action);
      if (action === 'search') {
        const query = textOf(args.query);
        return query ? `已检索记忆「${truncate(query, QUERY_LIMIT)}」` : '已检索记忆';
      }
      if (action === 'list_rooms') return '已查看记忆房间';
      if (action === 'save') {
        const room = textOf(args.room);
        return room ? `已写入记忆「${truncate(room, QUERY_LIMIT)}」` : '已写入记忆';
      }
      return '已操作记忆';
    }
    case 'context': {
      const action = textOf(args.action);
      if (action === 'compact') return '已压缩上下文';
      const query = textOf(args.query);
      return query ? `已检索上下文「${truncate(query, QUERY_LIMIT)}」` : '已检索上下文';
    }
    case 'automation': {
      const action = textOf(args.action);
      const title = truncate(textOf(args.title), QUERY_LIMIT);
      switch (action) {
        case 'create': return title ? `已创建自动化任务「${title}」` : '已创建自动化任务';
        case 'update': return title ? `已更新自动化任务「${title}」` : '已更新自动化任务';
        case 'delete': return '已删除自动化任务';
        case 'trigger': return title ? `已触发自动化任务「${title}」` : '已触发自动化任务';
        case 'pause': return title ? `已暂停自动化任务「${title}」` : '已暂停自动化任务';
        case 'resume': return title ? `已恢复自动化任务「${title}」` : '已恢复自动化任务';
        default: return '已查看自动化任务';
      }
    }
    // todo 已有清单推送、ask 已有提问消息、agent 走子智能体批次播报
    case 'todo':
    case 'ask':
    case 'agent':
      return null;
    default:
      return `已执行 ${toolName}`;
  }
}

/**
 * 单次工具调用 → 播报文本。
 * 返回 null 表示该调用不产生播报（todo/ask/agent 或参数不足）。
 */
export function formatToolProgress(input: ToolProgressInput): string | null {
  const { toolName, args, cwd, isError, result } = input;
  const text = buildProgressText(toolName, args, cwd, result, isError);
  if (!text) return null;
  const suffix = isError ? FAILED_SUFFIX : '';
  // 多行文案的失败后缀已在首行的「N个…：」处写入
  return text.includes('\n') ? text : `${text}${suffix}`;
}

/** 同一批调起的子智能体 → 一条汇总文案 */
export function formatSubagentProgress(entries: SubagentEntry[]): string {
  const lines = [`已调起${entries.length}个子智能体：`];
  for (const [index, entry] of entries.entries()) {
    const summary = truncate(firstLine(entry.task), TASK_LIMIT) || '未提供任务描述';
    lines.push(`智能体${index + 1}（${entry.name}）：${summary}`);
  }
  return lines.join('\n');
}
