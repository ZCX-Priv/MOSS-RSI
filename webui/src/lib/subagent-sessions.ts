// webui/src/lib/subagent-sessions.ts
// 临时 subagent 会话 id 的精确绑定表（parentToolCallId → subagent taskId）。
//
// 为什么不用 store：这只是「父会话某个工具调用 ↔ 子代理会话」的对应关系，
// 不是可展示状态；按父工具调用 id 精确隔离，避免同模板并发时按模板猜测导致串台。

type BindingListener = (toolCallId: string, taskId: string) => void;

/** parentToolCallId → subagent taskId（内存态；事件持续到达时会重建，刷新后由结果文本兜底） */
const bindings = new Map<string, string>();
const listeners = new Set<BindingListener>();

/** 记录绑定（重复绑定同值直接忽略，避免高频事件触发无谓监听回调） */
export function bindSubagentSession(toolCallId: string, taskId: string): void {
  if (!toolCallId || !taskId) return;
  if (bindings.get(toolCallId) === taskId) return;
  bindings.set(toolCallId, taskId);
  for (const fn of listeners) {
    try {
      fn(toolCallId, taskId);
    } catch {
      // 单个监听异常不影响其他订阅者
    }
  }
}

/** 读取已绑定会话 id（卡片挂载时可立即命中） */
export function getSubagentSession(toolCallId: string): string | undefined {
  return bindings.get(toolCallId);
}

/** 订阅绑定变化；返回取消订阅函数 */
export function subscribeSubagentSession(fn: BindingListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
