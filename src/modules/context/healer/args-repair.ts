// src/modules/context/healer/args-repair.ts
// 工具调用参数 JSON 确定性修复：
//   空/null → {}；完整 JSON → 原样；截断 JSON → 前缀扫描闭合补全；
//   彻底损坏 → {"_raw": ...} 包裹（配合 schema-fix/错误回传兜底）。

export type ArgsRepairStrategy = 'empty' | 'parsed' | 'completed' | 'wrapped';

export interface ArgsRepairResult {
  /** 修复后的参数对象（wrapped 时为 { _raw: 原文 }） */
  value: unknown;
  strategy: ArgsRepairStrategy;
  /** 修复说明（进 healLog，供模型感知） */
  note?: string;
}

/**
 * 修复工具调用参数 JSON。
 * @param raw 模型输出的 arguments 原始字符串
 */
export function repairToolCallArguments(raw: string): ArgsRepairResult {
  const trimmed = raw.trim();

  // 1. 空 / null / "null" → 空对象
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') {
    return { value: {}, strategy: 'empty', note: 'empty arguments normalized to {}' };
  }

  // 2. 直接解析成功
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: parsed, strategy: 'parsed' };
    }
    // 顶层非对象（字符串/数字/数组）：包一层（工具参数一律为对象）
    return {
      value: { _value: parsed },
      strategy: 'completed',
      note: 'top-level non-object arguments wrapped as { "_value": ... }',
    };
  } catch {
    // 落入截断修复
  }

  // 3. 截断补全（含悬挂 token 剥离重试）
  let work = trimmed;
  for (let attempt = 0; attempt < 3; attempt++) {
    const completed = completeTruncatedJson(work);
    if (completed !== null) {
      try {
        const parsed = JSON.parse(completed) as unknown;
        return {
          value: parsed,
          strategy: 'completed',
          note: `truncated JSON repaired (attempt ${attempt + 1})`,
        };
      } catch {
        // 补全结果仍非法：剥掉末尾悬挂 token 再试
        const stripped = stripDanglingToken(work);
        if (stripped === null || stripped === work) break;
        work = stripped;
      }
    } else {
      break;
    }
  }

  // 4. 彻底损坏：_raw 包裹（后续 schema-fix 大概率报错回传，模型自纠）
  return {
    value: { _raw: work },
    strategy: 'wrapped',
    note: 'unrepairable arguments wrapped as { "_raw": ... }',
  };
}

// ============================================================================
// 截断 JSON 确定性补全
// ============================================================================

/**
 * 前缀扫描补全被截断的 JSON：
 * 1. 单趟扫描记录「最后一个完整 value 的结束位置」（valueEnd）与未闭合括号栈；
 *    - 完整 value：闭合字符串且前一个有效字符是 `:`、字面量（数字/true/false/null）、
 *      闭合的 `}`/`]`、或逗号处对前一 value 的确认
 *    - 悬挂 key（字符串闭合但处于 key 位置）不推进 valueEnd——补全时被自然丢弃
 *    期间检测结构性错误（括号错配 → null，不可修复）。
 * 2. 取安全前缀，剥除尾部悬挂分隔符（, : 空白）。
 * 3. 按栈逆序闭合括号。
 * @returns 补全后的 JSON 字符串；结构性损坏返回 null
 */
export function completeTruncatedJson(raw: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let valueEnd = 0;
  let prevSignificant = ''; // 上一个非空白字符（判断字符串处于 key/value 位置）

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        // 字符串闭合：仅当处于 value 位置（前一个有效字符是 `:` 或在数组中）才推进 valueEnd
        const inArray = stack[stack.length - 1] === '[';
        if (prevSignificant === ':' || inArray) {
          valueEnd = i + 1;
        }
        prevSignificant = '"';
      }
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        break;
      case '{':
      case '[':
        stack.push(ch);
        prevSignificant = ch;
        break;
      case '}':
      case ']': {
        const top = stack.pop();
        if (top === undefined || (ch === '}' ? top !== '{' : top !== '[')) {
          return null; // 括号错配：非截断问题，放弃
        }
        valueEnd = i + 1;
        prevSignificant = ch;
        break;
      }
      case ',':
        // 逗号确认前一个 value/key 完成（valueEnd 已在 value 结束时推进）
        prevSignificant = ',';
        break;
      case ':':
        prevSignificant = ':';
        break;
      default:
        if (!/\s/.test(ch)) {
          // 字面量字符（数字/true/false/null）：只出现在 value 位置，直接推进
          valueEnd = i + 1;
          prevSignificant = ch;
        }
    }
  }

  let prefix = raw.slice(0, valueEnd).replace(/[\s,:]+$/, '');
  if (prefix === '') {
    // 无任何完整 value：若最外层是单一未闭合结构则给空结构
    if (stack.length === 1 && stack[0] === '{') return '{}';
    if (stack.length === 1 && stack[0] === '[') return '[]';
    return null;
  }

  let result = prefix;
  for (let i = stack.length - 1; i >= 0; i--) {
    result += stack[i] === '{' ? '}' : ']';
  }
  return result;
}

/**
 * 剥除字符串末尾的一个悬挂 token（补全后仍非法时重试用）：
 * 尾部完整字符串 / 字面量 / 平衡括号组。
 * @returns 剥离后的串；无可剥内容返回 null
 */
function stripDanglingToken(raw: string): string | null {
  let s = raw.replace(/[\s,:]+$/, '');
  if (s === '') return null;

  const last = s[s.length - 1];

  // 末尾是闭合括号：回剥整个平衡组
  if (last === '}' || last === ']') {
    const open = last === '}' ? '{' : '[';
    let depth = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      const ch = s[i];
      if (ch === last) depth++;
      else if (ch === open) {
        depth--;
        if (depth === 0) {
          const stripped = s.slice(0, i).replace(/[\s,:]+$/, '');
          return stripped === '' ? null : stripped;
        }
      }
    }
    return null;
  }

  // 末尾是字符串结尾：回剥整个字符串（含转义）
  if (last === '"') {
    for (let i = s.length - 2; i >= 0; i--) {
      if (s[i] !== '"') continue;
      // 统计前置反斜杠（偶数为真闭合）
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 0) {
        const stripped = s.slice(0, i).replace(/[\s,:]+$/, '');
        return stripped === '' ? null : stripped;
      }
    }
    return null;
  }

  // 末尾是字面量字符：回剥连续字面量段
  const literalMatch = /[A-Za-z0-9._+-]+$/.exec(s);
  if (literalMatch && literalMatch.index > 0) {
    const stripped = s.slice(0, literalMatch.index).replace(/[\s,:]+$/, '');
    return stripped === '' ? null : stripped;
  }

  return null;
}
