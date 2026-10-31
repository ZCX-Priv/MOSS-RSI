// tools/web/search/engines/common.ts
// 三个引擎解析器共用的小工具（纯函数，便于单测）。

/** 折叠空白 */
export function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** 从任意文本里提取 20xx-xx-xx 日期，统一输出 YYYY-MM-DD */
export function extractDate(text: string): string | undefined {
  const matched = /(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})/.exec(text);
  if (!matched) return undefined;
  const year = Number.parseInt(matched[1], 10);
  const month = Number.parseInt(matched[2], 10);
  const day = Number.parseInt(matched[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 截断到指定字符数（解析阶段先做第一道噪声控制） */
export function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** 引擎自指链接（搜索结果里混入的站内导航/广告跳板） */
export function isEngineSelfUrl(url: string, engineHosts: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return engineHosts.some((item) => host === item || host.endsWith(`.${item}`));
  } catch {
    return true;
  }
}

/** 常见日期换算：1970-01-01 起的天数（Bing filters 使用） */
export function epochDayNumber(date = new Date()): number {
  return Math.floor(date.getTime() / 86_400_000);
}
