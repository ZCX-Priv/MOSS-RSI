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
        // seq 是调用开始序号：轻量投影必须保留，前端据此保持代码调用顺序
        ...(typeof call.seq === 'number' ? { seq: call.seq } : {}),
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
  // agentRun 体积极小（id/名称/状态），历史轻投影必须保留：
  // SubagentCard 依赖它显示自定义 Agent 名称，而不是回退成模板 id。
  const agentRun = isRecord(metadata.agentRun) ? metadata.agentRun : null;
  const lightMetadata: Record<string, unknown> = {
    [LAZY_RESULT_FLAG]: true,
    ...(codeRun ? { codeRun: lightenCodeRun(codeRun) } : {}),
    ...(agentRun ? { agentRun } : {}),
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

/**
 * 实时 WS 事件的工具结果轻量化。
 *
 * run_code 取消长度裁剪后，单次调用的 metadata（完整返回值 + 全量日志 + 每个嵌套调用的
 * 完整正文/metadata）可达数 MB；整帧推给 WebUI 会让主线程 JSON.parse/React 渲染长时间卡住，
 * 表现为「PTC 很久不结束 / 状态更新滞后」。
 *
 * 超过 maxBytes 时：正文截断为预览、codeRun 走 lightenCodeRun（保留头部与 calls 预览）、
 * 打 __mossLazy 标记；前端展开卡片时经 /api/session/:id/tool-result 拉取完整内容。
 * 落库结果不受影响。
 */
export function lightenToolResultForEvent<T>(result: T, maxBytes: number): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(result) ?? '';
  } catch {
    return result;
  }
  if (serialized.length <= maxBytes) return result;

  const shaped = result as {
    content?: unknown;
    metadata?: unknown;
  };
  const content = Array.isArray(shaped.content) ? shaped.content.filter(isRecord) : [];
  const text = content
    .filter((part) => part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n');
  const preview =
    text.length > PREVIEW_CHARS
      ? `${text.slice(0, PREVIEW_CHARS)}\n…[完整内容将在展开时加载]`
      : text;
  const metadata = isRecord(shaped.metadata) ? shaped.metadata : {};
  const codeRun = isRecord(metadata.codeRun) ? metadata.codeRun : null;
  return {
    ...(result as object),
    content: [
      ...(preview ? [{ type: 'text' as const, text: preview }] : []),
      // 非文本内容原样保留（图片已由上游剥离为文本占位）
      ...content.filter((part) => part.type !== 'text'),
    ],
    metadata: {
      ...metadata,
      [LAZY_RESULT_FLAG]: true,
      ...(codeRun ? { codeRun: lightenCodeRun(codeRun) } : {}),
    },
  } as T;
}
