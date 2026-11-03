// src/modules/server/routes/history-light.ts
// 分页历史轻量投影：工具结果的完整正文 / IntelligentUI spec / 嵌套调用富数据
// 不在首屏传输，WebUI 展开卡片时再调用 /api/session/:id/tool-result 按需加载。
//
// 注意：只处理 role=tool 消息；assistant 正文与用户消息保持原样（它们是气泡渲染必需）。
// 标记字段 __mossLazy 由前端识别，值为 true 时才触发按需拉取。

export const LAZY_RESULT_FLAG = '__mossLazy';
/** 首屏预览保留的正文长度（够看开头，不足以替代完整内容） */
const PREVIEW_CHARS = 800;

interface LooseMessage {
  role?: unknown;
  content?: unknown;
  isError?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** run_code metadata 轻量版：保留头部展示所需字段，删除大体积 UI/日志/完整调用结果 */
function lightenCodeRun(codeRun: Record<string, unknown>): Record<string, unknown> {
  const calls = Array.isArray(codeRun.calls)
    ? codeRun.calls.filter(isRecord).map((call) => ({
        id: call.id,
        name: call.name,
        argsPreview: call.argsPreview,
        resultPreview: call.resultPreview,
        durationMs: call.durationMs,
        ok: call.ok,
        ...(typeof call.error === 'string' ? { error: call.error } : {}),
      }))
    : [];
  return {
    version: codeRun.version,
    kind: codeRun.kind,
    description: codeRun.description,
    durationMs: codeRun.durationMs,
    // 保持类型契约（前端折叠态不会渲染日志；展开后完整结果会覆盖）
    logs: [],
    calls,
    ...(codeRun.callsTruncated ? { callsTruncated: true } : {}),
    ...(codeRun.truncated ? { truncated: true } : {}),
    // 折叠态只显示「含交互界面」徽标；真正 spec 在展开后拉取
    hasUi: codeRun.uiSpec !== undefined,
  };
}

/** 单条消息轻量化（非 tool 原样返回；不修改入参对象） */
export function lightenHistoryMessage(message: unknown): unknown {
  if (!isRecord(message) || message.role !== 'tool') return message;
  const content = typeof message.content === 'string' ? message.content : '';
  const preview =
    content.length > PREVIEW_CHARS
      ? `${content.slice(0, PREVIEW_CHARS)}\n…[完整内容将在展开时加载]`
      : content;
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  const codeRun = isRecord(metadata.codeRun) ? metadata.codeRun : null;
  const lightMetadata: Record<string, unknown> = {
    [LAZY_RESULT_FLAG]: true,
    ...(codeRun ? { codeRun: lightenCodeRun(codeRun) } : {}),
  };
  return {
    ...message,
    content: preview,
    metadata: lightMetadata,
  };
}

/** 批量轻量化分页历史 */
export function lightenHistoryMessages(messages: unknown[]): unknown[] {
  return messages.map((message) => lightenHistoryMessage(message));
}
