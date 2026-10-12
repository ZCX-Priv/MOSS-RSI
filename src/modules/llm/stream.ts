// src/modules/llm/stream.ts
// SSE 流式响应统一解析。
// 把 HTTP 响应的 ReadableStream 解析为 SSE 事件序列。

/**
 * 把 ReadableStream<Uint8Array> 转换为 SSE 事件字符串的异步迭代器。
 * SSE 协议：
 *  - 事件以 \n\n 分隔
 *  - 每行格式 "data: <text>" 或 "event: <name>" 或 ":comment"
 *  - "data: [DONE]" 表示流结束
 *
 * @param opts.idleTimeoutMs 空闲超时（毫秒）。响应头已返回但流中途停滞（弱网半开连接 /
 *   推理型模型长思考 / 代理空档）超过该时长即取消读取并抛错。默认 15 分钟，
 *   可由 config.agent.llmStreamIdleTimeoutMs 覆盖（长程 CTF 任务需放宽）；
 *   上限 1 小时（防止极端值把弱网半开连接无限挂起）。
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  opts?: { idleTimeoutMs?: number },
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let timedOut = false;

  /**
   * 从 buffer 头部切出一个完整 SSE 事件。
   * 兼容 \n\n 与 \r\n\r\n 两种分隔符（不同供应商实现各异），取先出现者。
   * 返回事件文本；无完整事件返回 null。
   */
  const shiftEvent = (): string | null => {
    const idxLF = buffer.indexOf('\n\n');
    const idxCRLF = buffer.indexOf('\r\n\r\n');
    if (idxLF === -1 && idxCRLF === -1) return null;
    const idx = idxCRLF === -1 ? idxLF : idxLF === -1 ? idxCRLF : Math.min(idxLF, idxCRLF);
    const sepLen = buffer[idx] === '\r' ? 4 : 2;
    const eventText = buffer.slice(0, idx);
    buffer = buffer.slice(idx + sepLen);
    return eventText;
  };

  // 空闲超时：响应头已返回但流中途停滞（弱网半开连接）时取消读取，
  // 并向上游抛出明确错误（而非静默截断——静默会让 engine 当作流正常结束，
  // 用户侧表现为「回复莫名断掉且无任何提示」）。默认 15 分钟容忍思考型模型的长停顿
  // （长推理 / 长 prefill / 代理空档）；过激的阈值会在模型仍在思考时误切断
  // 与模型 API 的连接，表现为「后端莫名断开与模型的通信」。
  const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
  /** 硬上限：即使配置写错也不让弱网半开连接无限挂起 */
  const MAX_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
  const rawIdle = opts?.idleTimeoutMs;
  const IDLE_TIMEOUT_MS =
    typeof rawIdle === 'number' && Number.isFinite(rawIdle) && rawIdle > 0
      ? Math.min(rawIdle, MAX_IDLE_TIMEOUT_MS)
      : DEFAULT_IDLE_TIMEOUT_MS;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      try {
        reader.cancel();
      } catch {
        // 忽略
      }
    }, IDLE_TIMEOUT_MS);
  };

  try {
    while (true) {
      resetIdle();
      const { done, value } = await reader.read();
      // cancel() 使 read 以 done 收尾：此时按超时错误上抛（engine 侧已生成内容仍会保留）
      if (timedOut) {
        throw new Error(`SSE stream idle timeout: no data received for ${IDLE_TIMEOUT_MS}ms`);
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let eventText: string | null;
      while ((eventText = shiftEvent()) !== null) {
        const data = extractDataField(eventText);
        if (data !== null) {
          if (data === '[DONE]') return;
          yield data;
        }
      }
    }
    // 处理剩余 buffer
    if (buffer.trim()) {
      const data = extractDataField(buffer);
      if (data !== null && data !== '[DONE]') yield data;
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    reader.releaseLock();
  }
}

/**
 * 从 SSE 事件文本中提取 data: 字段内容。
 * 多行 data: 用 \n 连接（按 SSE 规范）。
 */
function extractDataField(eventText: string): string | null {
  const lines = eventText.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.startsWith(':')) continue; // 注释
    if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).replace(/^\s/, ''));
    }
    // 忽略 event: id: retry: 等其他字段（多数 LLM API 只用 data:）
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}
