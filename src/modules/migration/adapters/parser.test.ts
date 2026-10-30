// src/modules/migration/adapters/parser.test.ts
// Claude Code / Codex 会话解析：用两家真实行格式验证角色序列与工具调用配对。

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from './claude-code';
import { CodexAdapter } from './codex';

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moss-migration-test-'));
  tempDirs.push(dir);
  return dir;
}

/** 把对象数组写成 JSONL 文件 */
function writeJsonl(filePath: string, lines: unknown[]): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================

describe('Claude Code 适配器', () => {
  const LINES = [
    { type: 'session-meta', isMeta: true, workDir: 'C:\\Users\\demo\\proj', timestamp: '2026-08-06T05:01:18.781Z' },
    { type: 'ai-title', aiTitle: '重构设置页', timestamp: '2026-08-06T05:02:16.907Z' },
    {
      type: 'user',
      isSidechain: false,
      message: { role: 'user', content: [{ type: 'text', text: '帮我修个 bug' }] },
      uuid: 'u1',
      timestamp: '2026-08-06T05:02:18.000Z',
      cwd: 'C:\\Users\\demo\\proj',
    },
    // 子代理轨迹：应被跳过
    {
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: [{ type: 'text', text: '子代理任务' }] },
      uuid: 'u-side',
      timestamp: '2026-08-06T05:02:18.500Z',
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先看看代码' },
          { type: 'text', text: '我来定位' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'src/a.ts' } },
        ],
      },
      uuid: 'a1',
      timestamp: '2026-08-06T05:02:19.000Z',
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file body' }],
      },
      uuid: 'u2',
      timestamp: '2026-08-06T05:02:20.000Z',
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '修好了' }] },
      uuid: 'a2',
      timestamp: '2026-08-06T05:02:21.000Z',
    },
  ];

  it('解析出正确的角色序列与工具调用配对', () => {
    const root = makeTempRoot();
    writeJsonl(join(root, 'projects', 'demo-project', 'sess-1.jsonl'), LINES);
    const adapter = new ClaudeCodeAdapter(root);

    const transcript = adapter.read('demo-project/sess-1');
    expect(transcript).not.toBeNull();
    if (!transcript) return;

    expect(transcript.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(transcript.messages[0].content).toBe('帮我修个 bug');
    expect(transcript.messages[1].thinking).toBe('先看看代码');
    expect(transcript.messages[1].toolCalls?.[0]?.id).toBe('call_1');
    expect(transcript.messages[1].toolCalls?.[0]?.name).toBe('read_file');
    expect(transcript.messages[2].toolCallId).toBe('call_1');
    expect(transcript.messages[2].content).toBe('file body');
    // 标题取 ai-title，cwd 取 session-meta.workDir
    expect(transcript.meta.title).toBe('重构设置页');
    expect(transcript.meta.cwd).toBe('C:\\Users\\demo\\proj');
    expect(transcript.meta.createdAt).toBe('2026-08-06T05:01:18.781Z');
  });

  it('列表与详情消息数口径一致（tool_result 行不计入）', () => {
    const root = makeTempRoot();
    writeJsonl(join(root, 'projects', 'demo-project', 'sess-1.jsonl'), LINES);
    const adapter = new ClaudeCodeAdapter(root);

    const list = adapter.list();
    expect(list).toHaveLength(1);
    const detail = adapter.read('demo-project/sess-1');
    const detailCount = detail?.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
    expect(list[0].messageCount).toBe(detailCount ?? -1);
  });
});

// ============================================================================

describe('Codex 适配器', () => {
  const LINES = [
    { timestamp: '2026-08-06T06:00:00.000Z', type: 'session_meta', payload: { id: 'cx-1', cwd: 'C:\\Users\\demo\\proj' } },
    { timestamp: '2026-08-06T06:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5', effort: 'high' } },
    {
      timestamp: '2026-08-06T06:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我查日志' }] },
    },
    {
      timestamp: '2026-08-06T06:00:03.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '需要看日志' }] },
    },
    {
      timestamp: '2026-08-06T06:00:04.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"dir"}', call_id: 'fc-1' },
    },
    {
      timestamp: '2026-08-06T06:00:05.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'fc-1', output: 'a b c' },
    },
    {
      timestamp: '2026-08-06T06:00:06.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '日志正常' }] },
    },
    { timestamp: '2026-08-06T06:00:07.000Z', type: 'event_msg', payload: { type: 'token_count' } },
    // 注入的环境上下文：应被剔除
    {
      timestamp: '2026-08-06T06:00:08.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>env' }] },
    },
  ];

  it('解析响应项并剔除注入内容', () => {
    const root = makeTempRoot();
    writeJsonl(join(root, 'sessions', '2026', '08', '06', 'rollout-2026-08-06T06-00-00-cx1.jsonl'), LINES);
    const adapter = new CodexAdapter(root);

    const list = adapter.list();
    expect(list).toHaveLength(1);
    const sourceId = list[0].sourceId;

    const transcript = adapter.read(sourceId);
    expect(transcript).not.toBeNull();
    if (!transcript) return;

    expect(transcript.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(transcript.messages[1].toolCalls?.[0]?.id).toBe('fc-1');
    expect(transcript.messages[1].thinking).toBe('需要看日志');
    expect(transcript.messages[2].toolCallId).toBe('fc-1');
    expect(transcript.messages[2].content).toBe('a b c');
    expect(transcript.messages[3].content).toBe('日志正常');
    expect(transcript.meta.title).toBe('帮我查日志');
    expect(transcript.meta.cwd).toBe('C:\\Users\\demo\\proj');
  });
});
