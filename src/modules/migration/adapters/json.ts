// src/modules/migration/adapters/json.ts
// 外部 JSONL 解析的类型守卫工具。
// 外部格式无 schema 保证，一律按 unknown 逐字段窄化（禁止 any 断言）。

export type JsonObject = Record<string, unknown>;

/** 窄化为普通对象（数组/null/标量返回 null） */
export function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonObject;
}

/** 窄化为非空字符串 */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 窄化为数组 */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 逐行解析 JSONL：坏行跳过并计入 warnings（不中断整体解析） */
export function parseJsonLines(raw: string, onLine: (obj: JsonObject, lineNo: number) => void, warnings: string[]): void {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = asObject(JSON.parse(line));
      if (!obj) {
        warnings.push(`line ${i + 1}: not an object`);
        continue;
      }
      onLine(obj, i + 1);
    } catch {
      warnings.push(`line ${i + 1}: invalid json`);
    }
  }
}

/** 截断标题（多行压成单行 + 长度上限） */
export function makeTitle(raw: string | undefined, fallback: string, maxLen = 60): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}
