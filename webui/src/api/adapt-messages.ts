// webui/src/api/adapt-messages.ts
// 后端 AgentMessage[] → 前端 TaskMessage[] 的纯适配函数。
// 独立成模块的原因：http.ts 顶部 import i18n（模块加载时有 navigator 副作用），
// 纯函数抽离后可在 bun:test 环境下直接单测（不引入浏览器依赖）。

import type { TaskMessage, MessageRole, ToolResult } from '../types/api';

/**
 * 把后端 AgentMessage[] 适配为前端 TaskMessage[]：
 * - 过滤 system 消息（防御性，物理隔离后后端已不返回）
 * - 补 id / timestamp（后端 AgentMessage 无这两个字段）
 * - 把 role:'tool' 独立消息合并回前一条 assistant 的 toolResults
 *
 * id 策略（分页/虚拟列表的稳定标识）：
 * - 分页接口会为每条消息附带服务端绝对 index → id = `h<index>`，
 *   分页前后同一消息 id 恒定（避免上滑加载更早一页后 key 漂移导致整列表重挂载）。
 * - 旧的全量路径无 index → 退化为位置 id（与既有行为一致）。
 * - 重复 id 防御：历史数据中可能存在同 messageId 的多条消息（旧版本曾按
 *   `<sessionId>#<turn>` 落盘，跨 run 重复），重复 id 会让虚拟列表 key / mergeHistory
 *   索引冲突 → 渲染错位。这里按 seen 集合去重：冲突者回退 `h<index>`，再冲突加位置后缀。
 */
export function adaptAgentMessages(raw: unknown[]): TaskMessage[] {
  const result: TaskMessage[] = [];
  const list = Array.isArray(raw) ? raw : [];
  /**
   * 未能就近合并的工具结果（前一条不是 assistant）。
   * 典型场景：用户在长耗时工具（subagent）执行中又发了消息，
   * 结果消息的「前一条」变成 user —— 旧实现会直接丢弃它，
   * 导致刷新后卡片拿不到报告/会话 id。这里先挂起，循环结束后按 toolCallId
   * 回填到真正发起该调用的 assistant 消息上。
   */
  const orphanToolResults: Array<{ toolCallId: string; result: ToolResult }> = [];
  /** 已使用的消息 id（重复防御：见函数头注释） */
  const seenIds = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const m = list[i] as {
      role?: string;
      content?: string;
      /** 用户消息附带的附件绝对路径（后端结构化字段） */
      attachments?: string[];
      toolCalls?: Array<{ id: string; name: string; arguments: string }>;
      toolCallId?: string;
      name?: string;
      thinking?: string;
      /** 后端持久化的思考耗时（ms） */
      thinkingMs?: number;
      todoSnapshot?: TaskMessage['todoSnapshot'];
      isError?: boolean;
      metadata?: Record<string, unknown>;
      timestamp?: string;
      /** 服务端绝对下标（分页接口附带；全量接口无） */
      index?: number;
      /** 前端下发并由后端持久化的消息身份（仅 user 消息可能有） */
      clientMessageId?: string;
      /** 流式 assistant 消息的稳定身份（与本地流式草稿同 id） */
      messageId?: string;
    } | null;
    if (!m) continue;
    if (m.role === 'system') continue;
    // 稳定 id 优先级：
    // ① clientMessageId —— 用户消息的真实身份，与本地乐观副本一致（据此去重，避免渲染两份）
    // ② messageId —— assistant 消息的流式身份（服务端落盘时写入），与本地流式草稿
    //    同 id → 尾部补齐按 id 原位 patch 而非删旧插新，消除回复结束时的重挂载闪烁
    // ③ 服务端绝对下标（分页路径稳定）  ④ 位置 id（旧全量路径兜底）
    let msgId =
      (typeof m.clientMessageId === 'string' && m.clientMessageId) ||
      (m.role === 'assistant' && typeof m.messageId === 'string' && m.messageId) ||
      (typeof m.index === 'number' ? `h${m.index}` : `${i}-${m.role ?? 'msg'}`);
    // 重复 id 去重：回退绝对下标 id（同 index 恒唯一），再冲突加位置后缀兜底
    if (seenIds.has(msgId)) {
      msgId = typeof m.index === 'number' ? `h${m.index}` : `${i}-${m.role ?? 'msg'}`;
      if (seenIds.has(msgId)) msgId = `${msgId}#${i}`;
    }
    seenIds.add(msgId);
    // 压缩摘要消息（compaction-summary）与 day-rollover/env-context 不进消息流：
    // 压缩卡片由 getCompactions 历史恢复（TaskPage 合并），其余为引擎内部锚定消息
    // （active-rules = paths 规则注入锚定 / memory-l1 = 记忆关键事实锚定）
    if (
      m.name === 'compaction-summary' ||
      m.name === 'env-context' ||
      m.name === 'day-rollover' ||
      m.name === 'active-rules' ||
      m.name === 'memory-l1'
    ) {
      continue;
    }
    // 轮数触顶提示消息：转为提示卡（maxTurnsNotice 驱动卡片渲染 + 继续按钮）
    if (m.name === 'max-turns-notice') {
      const noticeMeta = m.metadata as { maxTurns?: number } | undefined;
      result.push({
        id: typeof m.index === 'number' ? `h${m.index}` : `${i}-max-turns-notice`,
        role: 'assistant',
        content: m.content ?? '',
        maxTurnsNotice: { maxTurns: typeof noticeMeta?.maxTurns === 'number' ? noticeMeta.maxTurns : 0 },
        timestamp: m.timestamp ?? new Date().toISOString(),
        ...(typeof m.index === 'number' ? { historyIndex: m.index } : {}),
      });
      continue;
    }
    // 系统错误消息（模型请求失败）：驱动红色错误卡片；保留原始 provider 错误文本供「诊断」用
    if (m.name === 'system-error') {
      const errMeta = m.metadata as { providerError?: string } | undefined;
      result.push({
        id: msgId,
        role: 'assistant',
        content: m.content ?? '',
        isError: true,
        errorDetail: errMeta?.providerError ?? m.content ?? '',
        timestamp: m.timestamp ?? new Date().toISOString(),
        ...(typeof m.index === 'number' ? { historyIndex: m.index } : {}),
      });
      continue;
    }
    if (m.role === 'tool') {
      const entry = {
        toolCallId: m.toolCallId ?? '',
        result: {
          content: [{ type: 'text' as const, text: m.content ?? '' }],
          ...(m.isError ? { isError: true } : {}),
          ...(m.metadata ? { metadata: m.metadata } : {}),
        },
      };
      // 优先就近合并到前一条 assistant；前一条不是 assistant 时挂起，稍后按 toolCallId 回填
      const prev = result[result.length - 1];
      if (prev && prev.role === 'assistant') {
        prev.toolResults = prev.toolResults ?? [];
        prev.toolResults.push(entry);
      } else {
        orphanToolResults.push(entry);
      }
      continue;
    }
    // user / assistant
    result.push({
      id: msgId,
      role: m.role as MessageRole,
      content: m.content ?? '',
      ...(typeof m.index === 'number' ? { historyIndex: m.index } : {}),
      // 附件结构化字段：仅 user 消息且为有效数组时透传（老会话无此字段 → 渲染端回退解析正文）
      ...(m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length > 0
        ? { attachments: m.attachments }
        : {}),
      // 消息身份（仅 user 消息可能有）：与 id 同源，便于调试与后续按身份合并
      ...(m.role === 'user' && typeof m.clientMessageId === 'string' && m.clientMessageId
        ? { clientMessageId: m.clientMessageId }
        : {}),
      // 流式身份（仅 assistant）：与本地流式草稿同 id 的服务端正式副本
      ...(m.role === 'assistant' && typeof m.messageId === 'string' && m.messageId
        ? { serverMessageId: m.messageId }
        : {}),
      thinking: m.thinking,
      ...(typeof m.thinkingMs === 'number' ? { thinkingMs: m.thinkingMs } : {}),
      toolCalls: m.toolCalls,
      todoSnapshot: m.todoSnapshot,
      // 历史恢复保留错误标记（否则刷新后错误消息变成普通正文渲染）
      ...(m.isError ? { isError: true } : {}),
      timestamp: m.timestamp ?? new Date().toISOString(),
    });
  }
  // 回填挂起的工具结果：按 toolCallId 找到真正发起该调用的 assistant 消息
  for (const entry of orphanToolResults) {
    const owner = result.find(
      (msg) => msg.role === 'assistant' && msg.toolCalls?.some((tc) => tc.id === entry.toolCallId),
    );
    if (!owner) continue; // 无归属（如已被截断）：丢弃，避免污染其他消息
    owner.toolResults = owner.toolResults ?? [];
    owner.toolResults.push(entry);
  }
  return result;
}
