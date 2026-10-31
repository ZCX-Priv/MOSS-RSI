// src/modules/im/progress.test.ts
// 过程播报文案纯函数单测：覆盖全部工具类别、多文件多行格式、失败后缀与子智能体汇总。

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ToolResult } from '../tools/types';
import { formatSubagentProgress, formatToolProgress, parseToolArguments } from './progress';

const CWD = process.cwd();
const abs = (relative: string): string => join(CWD, relative);

function single(toolName: string, args: Record<string, unknown>, isError = false): string | null {
  return formatToolProgress({ toolName, args, cwd: CWD, isError });
}

function withResult(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
  isError = false,
): string | null {
  return formatToolProgress({ toolName, args, cwd: CWD, isError, result });
}

describe('文件与代码', () => {
  test('read 单文件 → 相对路径单行', () => {
    expect(single('read', { path: abs('src/modules/im/gateway.ts') }))
      .toBe('已读取 src/modules/im/gateway.ts');
  });

  test('read 多文件 → 首行数量 + 每行一条路径', () => {
    const text = single('read', { paths: [abs('src/a.ts'), abs('src/b.ts'), abs('src/c.ts')] });
    expect(text).toBe('已读取3个文件：\nsrc/a.ts\nsrc/b.ts\nsrc/c.ts');
  });

  test('write 单文件', () => {
    expect(single('write', { path: abs('src/modules/im/progress.ts') }))
      .toBe('已写入 src/modules/im/progress.ts');
  });

  test('edit 单文件与多文件（files 数组）', () => {
    expect(single('edit', { path: abs('src/a.ts') })).toBe('已编辑 src/a.ts');
    expect(single('edit', { files: [{ path: abs('src/a.ts') }, { path: abs('src/b.ts') }] }))
      .toBe('已编辑2个文件：\nsrc/a.ts\nsrc/b.ts');
  });

  test('copy / move 单源与多源', () => {
    expect(single('copy', { source: abs('src/a.ts'), dest: abs('src/b.ts') }))
      .toBe('已复制 src/a.ts → src/b.ts');
    expect(single('copy', { sources: [abs('a.ts'), abs('b.ts')], dest: abs('dist') }))
      .toBe('已复制2个文件：\na.ts → dist\nb.ts → dist');
    expect(single('move', { source: abs('src/a.ts'), dest: abs('src/b.ts') }))
      .toBe('已移动 src/a.ts → src/b.ts');
  });

  test('delete 单项与多项', () => {
    expect(single('delete', { path: abs('src/a.ts') })).toBe('已删除 src/a.ts');
    expect(single('delete', { paths: [abs('a.ts'), abs('b.ts')] }))
      .toBe('已删除2项：\na.ts\nb.ts');
  });

  test('grep 带搜索范围与不带范围', () => {
    expect(single('grep', { pattern: 'renderTool', path: abs('src') }))
      .toBe('已在 src 中搜索「renderTool」');
    expect(single('grep', { pattern: 'renderTool' })).toBe('已搜索「renderTool」');
  });

  test('glob 与 web 两种模式', () => {
    expect(single('glob', { pattern: '**/*.ts' })).toBe('已查找文件「**/*.ts」');
    expect(single('web', { mode: 'search', query: '今天的新闻' })).toBe('已搜索「今天的新闻」');
    expect(single('web', { mode: 'fetch', url: 'https://example.com/article' }))
      .toBe('已获取 https://example.com/article');
  });

  test('terminal 各 action', () => {
    expect(single('terminal', { action: 'exec', command: 'npm run build' }))
      .toBe('已执行命令：npm run build');
    expect(single('terminal', { action: 'send', command: 'ls' })).toBe('已向终端发送：ls');
    expect(single('terminal', { action: 'read' })).toBe('已读取终端输出');
    expect(single('terminal', { action: 'kill' })).toBe('已关闭终端');
  });

  test('run_code 内部调用映射与超过 6 项省略', () => {
    const result: ToolResult = {
      content: [],
      metadata: {
        codeRun: {
          calls: [
            { name: 'read', argsPreview: JSON.stringify({ path: 'src/a.ts' }) },
            { name: 'grep', argsPreview: JSON.stringify({ pattern: 'renderTool' }) },
          ],
        },
      },
    };
    expect(withResult('run_code', { description: '构建测试脚本' }, result))
      .toBe('已执行代码「构建测试脚本」：读取 src/a.ts、搜索「renderTool」');
    expect(single('run_code', { description: '计算数据' })).toBe('已执行代码「计算数据」');

    const many: ToolResult = {
      content: [],
      metadata: {
        codeRun: {
          calls: Array.from({ length: 8 }, (_, index) => ({
            name: 'read',
            argsPreview: JSON.stringify({ path: `src/f${index}.ts` }),
          })),
        },
      },
    };
    const text = withResult('run_code', { description: '批量读取' }, many);
    expect(text).toContain('等 2 项');
    expect(text?.match(/读取 /g)?.length).toBe(6);
  });
});

describe('电脑与浏览器', () => {
  test('电脑操作按 action 细分', () => {
    expect(single('computer', { action: 'click', element_token: '1:23' }))
      .toBe('操作电脑：已点击元素 1:23');
    expect(single('computer', { action: 'type_text', text: '用户名' }))
      .toBe('操作电脑：已输入「用户名」');
    expect(single('computer', { action: 'press_key', key: 'Enter' }))
      .toBe('操作电脑：已按Enter');
    expect(single('computer', { action: 'hotkey', keys: ['ctrl', 's'] }))
      .toBe('操作电脑：已按ctrl+s');
    expect(single('computer', { action: 'scroll', direction: 'down' }))
      .toBe('操作电脑：已向下滚动');
    expect(single('computer', { action: 'run_steps', steps: [{}, {}, {}] }))
      .toBe('操作电脑：已连续执行 3 步操作');
    expect(single('computer', { action: 'launch_app', app: '微信' }))
      .toBe('操作电脑：已启动「微信」');
  });

  test('浏览器操作按 action 细分', () => {
    expect(single('browser', { action: 'open', url: 'https://example.com' }))
      .toBe('操作浏览器：已打开 https://example.com');
    expect(single('browser', { action: 'navigate', back: true })).toBe('操作浏览器：已后退');
    expect(single('browser', { action: 'click', ref: 'e3' }))
      .toBe('操作浏览器：已点击元素 e3');
    expect(single('browser', { action: 'select', values: ['A', 'B'] }))
      .toBe('操作浏览器：已选择「A、B」');
  });
});

describe('其他工具与兜底', () => {
  test('MCP 工具与 mcp 元工具', () => {
    expect(single('mcp__filesystem__read_file', {})).toBe('已调用 MCP 工具 filesystem/read_file');
    expect(single('mcp', { action: 'list' })).toBe('已列出 MCP 工具');
    expect(single('mcp', { action: 'call', server: 'filesystem', tool: 'read_file' }))
      .toBe('已调用 MCP 工具 filesystem/read_file');
  });

  test('技能、记忆、上下文与自动化', () => {
    expect(single('skill', { action: 'use', skill: 'frontend-design' }))
      .toBe('已加载技能「frontend-design」');
    expect(single('memory', { action: 'save', room: '部署配置' }))
      .toBe('已写入记忆「部署配置」');
    expect(single('context', { action: 'compact' })).toBe('已压缩上下文');
    expect(single('automation', { action: 'create', title: '每日报告' }))
      .toBe('已创建自动化任务「每日报告」');
  });

  test('todo / ask / agent 不产生播报', () => {
    expect(single('todo', { action: 'list' })).toBeNull();
    expect(single('ask', { question: '选择数据库' })).toBeNull();
    expect(single('agent', { template: 'agent_explorer', task: '探索' })).toBeNull();
  });

  test('未知工具兜底', () => {
    expect(single('custom_tool', {})).toBe('已执行 custom_tool');
  });

  test('失败后缀：单行句尾、多行首行（数量）后', () => {
    expect(single('read', { path: abs('src/a.ts') }, true)).toBe('已读取 src/a.ts（失败）');
    expect(single('read', { paths: [abs('a.ts'), abs('b.ts')] }, true))
      .toBe('已读取2个文件（失败）：\na.ts\nb.ts');
  });

  test('非绝对 cwd（__system__）保留原路径', () => {
    const text = formatToolProgress({
      toolName: 'read',
      args: { path: 'C:\\Users\\tester\\notes.md' },
      cwd: '__system__',
      isError: false,
    });
    expect(text).toBe('已读取 C:\\Users\\tester\\notes.md');
  });

  test('parseToolArguments 容错', () => {
    expect(parseToolArguments('')).toEqual({});
    expect(parseToolArguments('{"path":"a.ts"}')).toEqual({ path: 'a.ts' });
    expect(parseToolArguments('{"path":')).toBeNull();
  });
});

describe('子智能体汇总', () => {
  test('单个与多个子智能体', () => {
    expect(formatSubagentProgress([{ name: 'Explorer', task: '探索认证模块的实现' }]))
      .toBe('已调起1个子智能体：\n智能体1（Explorer）：探索认证模块的实现');

    expect(
      formatSubagentProgress([
        { name: 'Explorer', task: '探索认证模块的实现' },
        { name: 'Coder', task: '实现登录接口\n第二行' },
        { name: 'Reviewer', task: '审查登录接口' },
      ]),
    ).toBe(
      '已调起3个子智能体：\n'
      + '智能体1（Explorer）：探索认证模块的实现\n'
      + '智能体2（Coder）：实现登录接口\n'
      + '智能体3（Reviewer）：审查登录接口',
    );
  });

  test('任务概要取首行并截断到 40 字', () => {
    const long = '甲'.repeat(60);
    const text = formatSubagentProgress([{ name: 'Coder', task: long }]);
    const summary = text.split('\n')[1] ?? '';
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual('智能体1（Coder）：'.length + 40);
  });
});
