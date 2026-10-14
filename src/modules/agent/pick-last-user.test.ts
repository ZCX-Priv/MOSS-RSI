// src/modules/agent/pick-last-user.test.ts
// 「重新生成」重跑起点：在完整历史里挑选最后一条**真实用户消息**
// （排除 env-context / memory-l1 等带 name 的锚定消息，以及已软删除消息）。

import { describe, it, expect } from 'vitest';
import { pickLastUserMessage } from './engine';
import type { AgentMessage } from '../contracts';

function m(role: AgentMessage['role'], content: string, extra: Partial<AgentMessage> = {}): AgentMessage {
  return { role, content, ...extra };
}

describe('pickLastUserMessage', () => {
  it('CTF 长对话形态：锚定消息 + 1 条真实提问 + 大量 assistant/tool + 末尾错误 → 返回真实提问', () => {
    const messages: AgentMessage[] = [
      m('user', '[环境上下文] ...', { name: 'env-context', timestamp: 'T0' }),
      m('user', '现在，我在CTF靶场内，目标是找到admin地址', { timestamp: 'T1', attachments: ['D:\\a.png'] }),
      m('user', '[记忆 | 关键事实] ...', { name: 'memory-l1', timestamp: 'T2' }),
      m('assistant', '开始侦察', { toolCalls: [{ id: 't1', name: 'terminal', arguments: '{}' }] }),
      m('tool', 'terminal result', { toolCallId: 't1', name: 'terminal' }),
      m('assistant', '继续', { toolCalls: [{ id: 't2', name: 'read', arguments: '{}' }] }),
      m('tool', '[image]', { toolCallId: 't2', name: 'read' }),
      m('assistant', 'Error: HTTP 400: ...', { timestamp: 'T9' }),
    ];
    const got = pickLastUserMessage(messages);
    expect(got).toEqual({
      timestamp: 'T1',
      content: '现在，我在CTF靶场内，目标是找到admin地址',
      attachments: ['D:\\a.png'],
    });
  });

  it('真实用户消息被软删除时回退到更早的真实用户消息', () => {
    const messages: AgentMessage[] = [
      m('user', '第一条提问', { timestamp: 'T1' }),
      m('user', '第二条提问', { timestamp: 'T2', deletedAt: 'T3' }),
    ];
    expect(pickLastUserMessage(messages)?.content).toBe('第一条提问');
  });

  it('只有锚定消息（都带 name）→ null', () => {
    const messages: AgentMessage[] = [
      m('user', 'env', { name: 'env-context' }),
      m('user', '[规则]', { name: 'active-rules' }),
      m('user', '触顶提示', { name: 'max-turns-notice' }),
    ];
    expect(pickLastUserMessage(messages)).toBeNull();
  });

  it('空数组 → null；无 timestamp → 空字符串', () => {
    expect(pickLastUserMessage([])).toBeNull();
    expect(pickLastUserMessage([m('user', 'q')])).toEqual({ timestamp: '', content: 'q' });
  });

  it('attachments 为空数组时不附加该字段', () => {
    const got = pickLastUserMessage([m('user', 'q', { timestamp: 'T1', attachments: [] })]);
    expect(got).toEqual({ timestamp: 'T1', content: 'q' });
    expect(got && 'attachments' in got).toBe(false);
  });
});
