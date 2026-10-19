// src/modules/context/compiler/view-builder.test.ts
// 发送视图构建测试：ephemeral 尾部消息（L2 记忆召回）、锚定消息恒保留、
// breakdown 的 rules/memory 构成统计。

import { describe, test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequestView, ACTIVE_RULES_MSG_NAME, MEMORY_L1_MSG_NAME, MEMORY_RECALL_MSG_NAME } from './view-builder';
import type { ContextMessage, ContextSessionLike } from '../types';
import { DEFAULT_TOOL_PRUNING_CONFIG } from '../types';

function mkSession(messages: ContextMessage[]): ContextSessionLike {
  return {
    id: 'test-session',
    messages,
    updatedAt: new Date().toISOString(),
  };
}

describe('view-builder（ephemeral + breakdown 扩展）', () => {
  const baseMessages: ContextMessage[] = [
    { role: 'user', name: 'env-context', content: '[环境上下文]' },
    { role: 'user', content: '用户问题：如何优化缓存？' },
    { role: 'assistant', content: '我来分析', toolCalls: [{ id: 'tc1', name: 'read', arguments: '{"path":"a.ts"}' }] },
    { role: 'tool', toolCallId: 'tc1', name: 'read', content: '文件内容...' },
  ];

  test('ephemeral 消息追加在消息流末尾（不进 session）', () => {
    const session = mkSession(baseMessages);
    const ephemeral: ContextMessage[] = [
      { role: 'user', name: MEMORY_RECALL_MSG_NAME, content: '[记忆 | 相关记忆]\n- xxx' },
    ];
    const view = buildRequestView(session, 'SYSTEM', {
      toolPruning: DEFAULT_TOOL_PRUNING_CONFIG,
      ephemeralMessages: ephemeral,
    });
    // 最后一条对话消息是 ephemeral
    const last = view.messages[view.messages.length - 1];
    expect(last.name).toBe(MEMORY_RECALL_MSG_NAME);
    expect(last.content).toContain('相关记忆');
    // session 未被修改
    expect(session.messages).toHaveLength(4);
  });

  test('breakdown：rules/memory 段独立统计', () => {
    const session = mkSession([
      ...baseMessages,
      { role: 'user', name: ACTIVE_RULES_MSG_NAME, content: '[项目规则 | TS 规范] 内容内容内容' },
      { role: 'user', name: MEMORY_L1_MSG_NAME, content: '[记忆 | 关键事实] 事实事实' },
    ]);
    const view = buildRequestView(session, 'SYSTEM', {
      toolPruning: DEFAULT_TOOL_PRUNING_CONFIG,
      ephemeralMessages: [
        { role: 'user', name: MEMORY_RECALL_MSG_NAME, content: '[记忆 | 相关记忆] 召回召回' },
      ],
    });
    expect(view.breakdown.rules).toBeGreaterThan(0);
    expect(view.breakdown.memory).toBeGreaterThan(0);
    expect(view.breakdown.total).toBe(
      view.breakdown.system + view.breakdown.env + view.breakdown.summary +
      view.breakdown.history + view.breakdown.rules + view.breakdown.memory,
    );
  });

  test('无 ephemeral 时 breakdown.rules/memory = 0（零注入零开销）', () => {
    const session = mkSession(baseMessages);
    const view = buildRequestView(session, 'SYSTEM', {
      toolPruning: DEFAULT_TOOL_PRUNING_CONFIG,
    });
    expect(view.breakdown.rules).toBe(0);
    expect(view.breakdown.memory).toBe(0);
  });

  test('多模态：tool 消息的图片路径被实时读盘编码，且不落 session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-view-img-'));
    try {
      const p = join(dir, 'a.png');
      writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
      const session = mkSession([
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'read', arguments: '{"path":"a.png"}' }] },
        { role: 'tool', toolCallId: 'tc1', name: 'read', content: '[image: image/png]', images: [p] },
      ]);
      const view = buildRequestView(session, 'SYSTEM', { toolPruning: DEFAULT_TOOL_PRUNING_CONFIG });
      const toolMsg = view.messages.find(m => m.role === 'tool');
      expect(toolMsg?.images).toHaveLength(1);
      expect(toolMsg?.images?.[0].mimeType).toBe('image/png');
      expect(toolMsg?.images?.[0].path).toBe(p);
      expect(toolMsg?.images?.[0].data.length).toBeGreaterThan(0);
      // session 原文不含 base64（仅路径引用）
      expect(session.messages[1].images).toEqual([p]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('多模态：非图片附件与不可读路径被静默跳过', () => {
    const session = mkSession([
      { role: 'user', content: '看这个', attachments: ['D:\\nonexist\\x.mp4', 'D:\\nonexist\\y.png'] },
    ]);
    const view = buildRequestView(session, 'SYSTEM', { toolPruning: DEFAULT_TOOL_PRUNING_CONFIG });
    const userMsg = view.messages.find(m => m.role === 'user' && m.content === '看这个');
    expect(userMsg?.images).toBeUndefined();
  });

  test('图片留存：默认持续内联（不再“发一次即降级为路径”占位符）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-view-img-sent-'));
    try {
      const p = join(dir, 'a.png');
      writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
      const toolMsg: ContextMessage = { role: 'tool', toolCallId: 'tc1', name: 'read', content: '[image: image/png]', images: [p], imagesSentAt: '2026-01-01T00:00:00.000Z' };
      const session = mkSession([
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'read', arguments: '{"path":"a.png"}' }] },
        toolMsg,
      ]);
      const view = buildRequestView(session, 'SYSTEM', { toolPruning: DEFAULT_TOOL_PRUNING_CONFIG });
      const tool = view.messages.find(m => m.role === 'tool');
      // 图片持续内联（默认留存；仅在字节超预算时才淘汰）
      expect(tool?.images).toHaveLength(1);
      expect(tool?.content).not.toContain('占位符');
      // 已内联 → 进入待标记集合（原始对象）
      expect(view.imageMessagesToMark).toContain(toolMsg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('字节超预算：已看图优先淘汰，未看图保留且最新图恒内联', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-view-img-evict-'));
    try {
      const p1 = join(dir, 'a.png');
      const p2 = join(dir, 'b.png');
      writeFileSync(p1, Buffer.alloc(600_000)); // base64 ≈ 800_000 字节
      writeFileSync(p2, Buffer.alloc(600_000));
      const session = mkSession([
        { role: 'user', content: '旧图（已看过）', attachments: [p1], imagesSentAt: '2026-01-01T00:00:00.000Z' },
        { role: 'assistant', content: '好的' },
        { role: 'user', content: '新图（未看过）', attachments: [p2] },
      ]);
      const view = buildRequestView(session, 'SYSTEM', {
        toolPruning: DEFAULT_TOOL_PRUNING_CONFIG,
        budgetBytes: 900_000, // 仅容得下一张图
      });
      const oldMsg = view.messages.find(m => m.content.includes('旧图'));
      const newMsg = view.messages.find(m => m.content.includes('新图'));
      // 已看过的旧图被淘汰 → 占位符（保留路径，可 read 重看）
      expect(oldMsg?.images).toBeUndefined();
      expect(oldMsg?.content).toContain('占位符');
      expect(oldMsg?.content).toContain(p1);
      // 未看过的新图保留内联（不被“还没读就压掉”）
      expect(newMsg?.images).toHaveLength(1);
      expect(view.evictedImages).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('未发送的图片被内联，并回填原始 session 消息进 imageMessagesToMark', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-view-img-unsent-'));
    try {
      const p = join(dir, 'a.png');
      writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
      const toolMsg: ContextMessage = { role: 'tool', toolCallId: 'tc1', name: 'read', content: 'x', images: [p] };
      const session = mkSession([
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'read', arguments: '{}' }] },
        toolMsg,
      ]);
      const view = buildRequestView(session, 'SYSTEM', { toolPruning: DEFAULT_TOOL_PRUNING_CONFIG });
      expect(view.messages.find(m => m.role === 'tool')?.images).toHaveLength(1);
      // 必须是原始 session 对象（governor 才能把 imagesSentAt 落盘持久化）
      expect(view.imageMessagesToMark).toContain(toolMsg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bytes：图片按文件真实大小计入请求体字节估算（token 估算看不到它）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-view-bytes-'));
    try {
      const p = join(dir, 'big.png');
      writeFileSync(p, Buffer.alloc(3000)); // base64 ≈ ceil(3000/3)*4 = 4000 字节
      const session = mkSession([{ role: 'user', content: '看这个', attachments: [p] }]);
      const view = buildRequestView(session, 'SYSTEM', { toolPruning: DEFAULT_TOOL_PRUNING_CONFIG });
      expect(view.bytes).toBeGreaterThanOrEqual(4000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('budgetBytes：超字节预算时丢弃最旧的非锚定消息（锚定消息恒保留）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-view-budget-'));
    try {
      const p = join(dir, 'big.png');
      writeFileSync(p, Buffer.alloc(600_000)); // base64 ≈ 800_000 字节
      const session = mkSession([
        { role: 'user', name: 'env-context', content: '[环境上下文]' },
        { role: 'user', content: '第一条带图', attachments: [p] },
        { role: 'assistant', content: '收到' },
        { role: 'user', content: '最后一条问题' },
      ]);
      const view = buildRequestView(session, 'SYSTEM', {
        toolPruning: DEFAULT_TOOL_PRUNING_CONFIG,
        budgetBytes: 100 * 1024, // 远小于图片体积 → 触发字节裁剪
      });
      expect(view.tailDropped).toBeGreaterThan(0);
      // 图片消息被裁掉 → 视图内不再有内联图片
      expect(view.messages.some(m => (m.images?.length ?? 0) > 0)).toBe(false);
      // 锚定消息与最新消息仍保留
      expect(view.messages.some(m => m.name === 'env-context')).toBe(true);
      expect(view.messages.some(m => m.role === 'user' && m.content === '最后一条问题')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
