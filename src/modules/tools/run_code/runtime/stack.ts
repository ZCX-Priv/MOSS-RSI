// src/modules/tools/run_code/runtime/stack.ts
// 运行时错误栈改写：
//   - Bun.Transpiler 会剥离类型与注释，转译后的行号与原文行号不再一一对应；
//   - 这里用 new Function 的固定包装偏移 + 「转译行文本 → 原文行」归一化匹配，
//     给出尽量准确的程序行号；匹配不到时明确标注「转译后第 N 行」，不假装精确。

const SOURCE_URL = 'moss-run-code.js';

/** 程序源码启动标记（不写入源码，仅用于计算行号偏移） */
export const PROGRAM_SOURCE_URL = SOURCE_URL;

/**
 * 校准 `new Function` 包装带来的固定行号偏移。
 * 探针 body 只有 1 行 throw，V8/Bun 报出的行号 = 1 + wrapperExtra。
 */
export function calibrateWrapperExtraLines(): number {
  try {
    const probe = new Function(
      `throw new Error("__moss_calibrate__");\n//# sourceURL=moss-calibrate.js`,
    );
    probe();
  } catch (err) {
    const stack = err instanceof Error ? (err.stack ?? '') : '';
    const match = /moss-calibrate\.js:(\d+):\d+/.exec(stack);
    if (match) {
      const reported = Number(match[1]);
      if (Number.isFinite(reported)) return Math.max(0, reported - 1);
    }
  }
  return 2;
}

/** 去掉空白，便于比较（保留字符顺序） */
function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

/** 保守剥离 TS 类型注解（仅用于行匹配，不用于执行） */
function stripTypeAnnotations(line: string): string {
  let out = line;
  // `as Type` / `as const`
  out = out.replace(/\bas\s+[A-Za-z_$][A-Za-z0-9_$<>[\].| ,]*/g, 'as ');
  // 仅在明显是声明/参数/返回值的位置剥离 `: Type`
  const looksLikeDeclaration = /\b(const|let|var|function|=>|class|interface|type)\b/[Symbol.match](out);
  if (looksLikeDeclaration) {
    out = out.replace(/:[\s]*([A-Za-z_$][A-Za-z0-9_$.<>[\]]*(?:\s*\|[^=,;)}]*)?)\s*(?=[=,;)}])/g, '');
  }
  return out;
}

/** 在原文里定位与转译行等价的行号（1 基）；找不到返回 null */
function findOriginalLine(program: string, jsLine: string): number | null {
  const target = compact(jsLine);
  if (target === '' || target === '}' || target === '{' || target === ');' || target === '];') return null;

  const lines = program.split(/\r\n|\r|\n/);
  const exact: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (compact(lines[i] as string) === target) exact.push(i + 1);
  }
  if (exact.length === 1) return exact[0] ?? null;

  // 类型擦除后的近似匹配
  const strippedTarget = compact(stripTypeAnnotations(jsLine));
  if (strippedTarget !== '') {
    const near: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (compact(stripTypeAnnotations(lines[i] as string)) === strippedTarget) near.push(i + 1);
    }
    if (near.length === 1) return near[0] ?? null;
  }

  // 前缀匹配：转译行往往以声明关键字/调用名开头
  const prefix = target.slice(0, Math.min(16, target.length));
  if (prefix.length >= 8) {
    const hits = lines
      .map((text, index) => ({ text, line: index + 1 }))
      .filter(({ text }) => compact(text).startsWith(prefix));
    if (hits.length === 1) return hits[0]?.line ?? null;
  }
  return null;
}

/**
 * 把运行时错误栈改写成模型可读形式。
 * @param stack 原始 `err.stack`
 * @param js Bun.Transpiler 输出的 JS（用于取转译行文本）
 * @param program 原始程序源码
 * @param wrapperExtraLines calibrateWrapperExtraLines() 的结果
 */
export function rewriteRuntimeStack(
  stack: string,
  js: string,
  program: string,
  wrapperExtraLines: number,
): string {
  const jsLines = js.split('\n');
  const lines = stack
    .split(/\r\n|\r|\n/)
    .filter((raw) => !/\b(?:bootstrap|handleHostFrame|executeRun|main)\.?(?:ts|js)?:\d/.test(raw))
    .map((raw) => {
      if (!raw.trim().startsWith('at ')) return raw;
      if (!raw.includes(SOURCE_URL)) return raw.replace(/file:\/\/\/[^)\s]+/g, 'moss').trimEnd();
      const match = new RegExp(`${SOURCE_URL}:(\\d+):(\\d+)`).exec(raw);
      if (!match) return raw;

      const reported = Number(match[1]);
      const column = Number(match[2]);
      // new Function body: line 1 = "use strict"; js line J = body line J+1
      const jsLineNumber = reported - 1 - wrapperExtraLines;
      const jsLine = jsLines[Math.max(0, jsLineNumber - 1)]?.trim() ?? '';
      const original = jsLine.trim() === '' ? null : findOriginalLine(program, jsLine);

      if (original !== null) {
        const sourceLine = program.split(/\r\n|\r|\n/)[original - 1]?.trim() ?? '';
        return `    at 程序第 ${original} 行附近（第 ${column} 列）：${sourceLine}`;
      }
      if (jsLine !== '') {
        return `    at 程序第 ~${Math.max(1, jsLineNumber)} 行附近（转译后，第 ${column} 列）：${jsLine}`;
      }
      return `    at 程序（转译后第 ${Math.max(1, jsLineNumber)} 行，第 ${column} 列）`;
    });

  return lines.join('\n');
}
