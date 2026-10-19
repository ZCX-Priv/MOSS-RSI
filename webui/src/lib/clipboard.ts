// webui/src/lib/clipboard.ts
// 剪贴板复制工具：现代 async Clipboard API 优先，失败/不可用时回退到 execCommand。
//
// 背景：navigator.clipboard 仅在「安全上下文 + 文档聚焦 + 权限允许」下可用；
// 局域网 http（手机扫码）、部分 WebView 等非安全上下文里它可能不存在或被拒绝。
// document.execCommand('copy') 虽为废弃 API，但在上述场景仍被主流浏览器支持，
// 且不需授权，故作为兜底；两者都失败才返回 false（由调用方提示手动复制）。

/** 保存当前选区，兜底复制后恢复，避免破坏用户选择 */
function saveSelection(): { ranges: Range[] } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const ranges: Range[] = [];
  for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
  return { ranges };
}

function restoreSelection(saved: { ranges: Range[] } | null): void {
  if (!saved) return;
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  for (const r of saved.ranges) sel.addRange(r);
}

/** execCommand('copy') 兜底：临时 textarea + 选中 + 复制 */
function copyViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // position:fixed 避免插入后页面滚动跳动；极小且透明，不遮挡交互
  ta.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;outline:none;box-shadow:none;background:transparent;opacity:0;';
  document.body.appendChild(ta);
  const saved = saveSelection();
  let ok = false;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS 需要显式区间才可复制
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
    restoreSelection(saved);
  }
  return ok;
}

/**
 * 复制文本到剪贴板；成功返回 true。
 * 策略：async Clipboard API（安全上下文）→ execCommand 兜底。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  // 1) 现代 API
  if (
    typeof navigator !== 'undefined' &&
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    navigator.clipboard?.writeText
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限拒绝 / 失焦 → 落到兜底
    }
  }
  // 2) execCommand 兜底
  try {
    if (copyViaExecCommand(text)) return true;
  } catch {
    // 忽略
  }
  return false;
}
