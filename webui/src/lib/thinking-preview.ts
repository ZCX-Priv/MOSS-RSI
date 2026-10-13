// webui/src/lib/thinking-preview.ts
// 思考状态行显示辅助（纯函数，便于单测）：
// - 预览文本提取：取流式思考文本的最后一个非空行（最新片段），轻量清洗后交给 CSS truncate 单行截断
// - 耗时格式化：把毫秒转成状态行展示用的秒数文本

/**
 * 从思考文本中提取用于状态行的预览：
 * - 取最后一个非空行（流式场景 = 当前正在写的最新一行）
 * - 去行首 markdown 标记（标题 #、引用 >、无序列表符号、有序列表 1.）
 * - 去成对强调/代码标记（**、__、`），避免预览里出现原始符号
 * - 折叠连续空白为单空格
 * 无有效内容时返回空串（调用方据此不渲染预览）。
 */
export function thinkingPreview(text: string | undefined): string {
  if (!text) return '';
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed) return cleanup(trimmed);
  }
  return '';
}

function cleanup(line: string): string {
  let s = line;
  s = s.replace(/^#{1,6}\s+/, ''); // 标题
  s = s.replace(/^>\s*/, ''); // 引用
  s = s.replace(/^[-*+]\s+/, ''); // 无序列表
  s = s.replace(/^\d+[.)]\s+/, ''); // 有序列表
  s = s.replace(/\*\*|__|`/g, ''); // 加粗 / 代码标记
  s = s.replace(/\s+/g, ' '); // 折叠空白
  return s.trim();
}

/**
 * 思考耗时格式化：≥1s 显示整数秒（12s），<1s 显示一位小数（0.3s）。
 * 入参为毫秒；非有限值或负值按 0 处理。0.95–0.999s 归为 "1"，避免出现 "1.0"。
 */
export function formatThinkingSeconds(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe >= 1000) return String(Math.floor(safe / 1000));
  const tenths = Math.round(safe / 100);
  return tenths >= 10 ? '1' : (tenths / 10).toFixed(1);
}
