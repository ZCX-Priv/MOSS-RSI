// webui/src/render/genui/expr.ts
// 受限表达式解释器：手写词法 + 递归下降 + 白名单求值。
// 不使用 eval / new Function；只允许标量、state 顶层键、四则/比较/逻辑/三元与少量函数。
// 单表达式错误返回 null（界面显示占位），不会炸掉整棵树。

import { GENUI_LIMITS, type GenUIStateValue } from './types';

export type ExprNode =
  | { kind: 'literal'; value: GenUIStateValue }
  | { kind: 'ident'; name: string }
  | { kind: 'unary'; op: '!' | '-'; operand: ExprNode }
  | { kind: 'binary'; op: string; left: ExprNode; right: ExprNode }
  | { kind: 'ternary'; cond: ExprNode; consequent: ExprNode; alternate: ExprNode }
  | { kind: 'call'; name: string; args: ExprNode[] };

export interface CompiledExpr {
  source: string;
  ast: ExprNode;
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' }
  | { kind: 'eof' };

/** 表达式语法/词法错误 */
export class ExprSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprSyntaxError';
  }
}

const MAX_TOKENS = 256;
const MAX_NESTING = 32;

/** 编译表达式；失败抛 ExprSyntaxError（调用方转成诊断/占位） */
export function compileExpr(source: string): CompiledExpr {
  if (typeof source !== 'string' || source.trim() === '') throw new ExprSyntaxError('empty expression');
  if (source.length > GENUI_LIMITS.maxExprChars) {
    throw new ExprSyntaxError(`expression exceeds ${GENUI_LIMITS.maxExprChars} chars`);
  }
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  const ast = parser.parse();
  return { source, ast };
}

/** 求值已编译表达式；任何错误 → null + onError 诊断 */
export function evaluateCompiled(
  compiled: CompiledExpr,
  state: Record<string, GenUIStateValue>,
  onError?: (message: string) => void,
): GenUIStateValue {
  try {
    const value = evalNode(compiled.ast, state, onError);
    if (value === undefined) return null;
    if (typeof value === 'number' && !Number.isFinite(value)) {
      onError?.(`expression produced a non-finite number: ${compiled.source}`);
      return null;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      return value;
    }
    onError?.(`expression produced a non-scalar value: ${compiled.source}`);
    return null;
  } catch (err) {
    onError?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** 便捷入口：编译 + 求值（编译失败也返回 null） */
export function evaluateExpr(
  source: string,
  state: Record<string, GenUIStateValue>,
  onError?: (message: string) => void,
): GenUIStateValue {
  try {
    return evaluateCompiled(compileExpr(source), state, onError);
  } catch (err) {
    onError?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ============================================================================
// 词法
// ============================================================================

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const push = (token: Token): void => {
    tokens.push(token);
    if (tokens.length > MAX_TOKENS) throw new ExprSyntaxError(`expression has more than ${MAX_TOKENS} tokens`);
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }

    // 数字：整数/小数/指数
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
      if (!match) throw new ExprSyntaxError(`invalid number at ${i}`);
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new ExprSyntaxError(`invalid number at ${i}`);
      push({ kind: 'number', value });
      i += match[0].length;
      continue;
    }

    // 字符串：单引号/双引号，支持常见转义
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      let out = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') {
          const next = source[i + 1];
          if (next === undefined) throw new ExprSyntaxError('unterminated string escape');
          out += decodeEscape(next);
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }
        out += c;
        i += 1;
      }
      if (!closed) throw new ExprSyntaxError('unterminated string literal');
      push({ kind: 'string', value: out });
      continue;
    }

    // 标识符/关键字
    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && isIdentPart(source[i])) i += 1;
      const word = source.slice(start, i);
      if (word === 'true') push({ kind: 'boolean', value: true });
      else if (word === 'false') push({ kind: 'boolean', value: false });
      else if (word === 'null') push({ kind: 'null' });
      else push({ kind: 'ident', value: word });
      continue;
    }

    // 双字符运算符
    const two = source.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      push({ kind: 'op', value: two });
      i += 2;
      continue;
    }

    if (ch === '(') {
      push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === ',') {
      push({ kind: 'comma' });
      i += 1;
      continue;
    }
    if ('+-*/%<>!?:'.includes(ch)) {
      push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }

    throw new ExprSyntaxError(`unsupported character "${ch}" at ${i}`);
  }

  push({ kind: 'eof' });
  return tokens;
}

function decodeEscape(ch: string): string {
  switch (ch) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case '\\':
      return '\\';
    case "'":
      return "'";
    case '"':
      return '"';
    default:
      return ch;
  }
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

// ============================================================================
// 递归下降
// ============================================================================

class Parser {
  private pos = 0;
  private nesting = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ExprNode {
    const expr = this.parseExpr();
    this.expectEof();
    return expr;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: 'eof' };
  }

  private next(): Token {
    const token = this.peek();
    this.pos += 1;
    return token;
  }

  private expectEof(): void {
    if (this.peek().kind !== 'eof') throw new ExprSyntaxError('unexpected trailing tokens');
  }

  private expect(kind: Token['kind']): Token {
    const token = this.next();
    if (token.kind !== kind) throw new ExprSyntaxError(`expected ${kind}, got ${token.kind}`);
    return token;
  }

  private parseExpr(): ExprNode {
    return this.parseTernary();
  }

  private parseTernary(): ExprNode {
    const cond = this.parseOr();
    if (this.isOp('?')) {
      this.next();
      const consequent = this.parseExpr();
      if (!this.isOp(':')) throw new ExprSyntaxError('expected ":" in ternary');
      this.next();
      const alternate = this.parseExpr();
      return { kind: 'ternary', cond, consequent, alternate };
    }
    return cond;
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.isOp('||')) {
      this.next();
      left = { kind: 'binary', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseCmp();
    while (this.isOp('&&')) {
      this.next();
      left = { kind: 'binary', op: '&&', left, right: this.parseCmp() };
    }
    return left;
  }

  private parseCmp(): ExprNode {
    let left = this.parseAdd();
    while (['==', '!=', '<', '<=', '>', '>='].some((op) => this.isOp(op))) {
      const op = (this.next() as { kind: 'op'; value: string }).value;
      left = { kind: 'binary', op, left, right: this.parseAdd() };
    }
    return left;
  }

  private parseAdd(): ExprNode {
    let left = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.next() as { kind: 'op'; value: string }).value;
      left = { kind: 'binary', op, left, right: this.parseMul() };
    }
    return left;
  }

  private parseMul(): ExprNode {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.next() as { kind: 'op'; value: string }).value;
      left = { kind: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    if (this.isOp('!') || this.isOp('-')) {
      const op = (this.next() as { kind: 'op'; value: string }).value as '!' | '-';
      return { kind: 'unary', op, operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const token = this.peek();
    if (token.kind === 'number' || token.kind === 'string' || token.kind === 'boolean') {
      this.next();
      return { kind: 'literal', value: token.value };
    }
    if (token.kind === 'null') {
      this.next();
      return { kind: 'literal', value: null };
    }
    if (token.kind === 'ident') {
      this.next();
      if (this.peek().kind === 'lparen') {
        this.enterNesting();
        this.next();
        const args: ExprNode[] = [];
        if (this.peek().kind !== 'rparen') {
          args.push(this.parseExpr());
          while (this.peek().kind === 'comma') {
            this.next();
            args.push(this.parseExpr());
          }
        }
        this.expect('rparen');
        this.leaveNesting();
        return { kind: 'call', name: token.value, args };
      }
      return { kind: 'ident', name: token.value };
    }
    if (token.kind === 'lparen') {
      this.enterNesting();
      this.next();
      const expr = this.parseExpr();
      this.expect('rparen');
      this.leaveNesting();
      return expr;
    }
    throw new ExprSyntaxError(`unexpected token ${token.kind}`);
  }

  private enterNesting(): void {
    this.nesting += 1;
    if (this.nesting > MAX_NESTING) throw new ExprSyntaxError(`expression nesting exceeds ${MAX_NESTING}`);
  }

  private leaveNesting(): void {
    this.nesting -= 1;
  }

  private isOp(value: string): boolean {
    const token = this.peek();
    return token.kind === 'op' && token.value === value;
  }
}

// ============================================================================
// 求值
// ============================================================================

function evalNode(
  node: ExprNode,
  state: Record<string, GenUIStateValue>,
  onError?: (message: string) => void,
): GenUIStateValue | undefined {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'ident': {
      if (!Object.prototype.hasOwnProperty.call(state, node.name)) {
        onError?.(`unknown state key "${node.name}"`);
        return undefined;
      }
      return state[node.name];
    }
    case 'unary': {
      const value = evalNode(node.operand, state, onError);
      if (value === undefined) return undefined;
      if (node.op === '!') return !truthy(value);
      return -toNumber(value);
    }
    case 'binary':
      return evalBinary(node, state, onError);
    case 'ternary': {
      const cond = evalNode(node.cond, state, onError);
      if (cond === undefined) return undefined;
      return truthy(cond)
        ? evalNode(node.consequent, state, onError)
        : evalNode(node.alternate, state, onError);
    }
    case 'call':
      return evalCall(node, state, onError);
    default:
      return null;
  }
}

function evalBinary(
  node: Extract<ExprNode, { kind: 'binary' }>,
  state: Record<string, GenUIStateValue>,
  onError?: (message: string) => void,
): GenUIStateValue | undefined {
  // 逻辑运算短路：返回操作数本身（与 JS 一致），便于 `a || '默认值'` 之类写法
  if (node.op === '&&') {
    const left = evalNode(node.left, state, onError);
    if (left === undefined) return undefined;
    return truthy(left) ? evalNode(node.right, state, onError) : left;
  }
  if (node.op === '||') {
    const left = evalNode(node.left, state, onError);
    if (left === undefined) return undefined;
    return truthy(left) ? left : evalNode(node.right, state, onError);
  }

  const left = evalNode(node.left, state, onError);
  const right = evalNode(node.right, state, onError);
  if (left === undefined || right === undefined) return undefined;

  switch (node.op) {
    case '+':
      if (typeof left === 'string' || typeof right === 'string') return `${scalarToString(left)}${scalarToString(right)}`;
      return toNumber(left) + toNumber(right);
    case '-':
      return toNumber(left) - toNumber(right);
    case '*':
      return toNumber(left) * toNumber(right);
    case '/': {
      const divisor = toNumber(right);
      if (divisor === 0) {
        onError?.('division by zero');
        return undefined;
      }
      return toNumber(left) / divisor;
    }
    case '%': {
      const divisor = toNumber(right);
      if (divisor === 0) {
        onError?.('modulo by zero');
        return undefined;
      }
      return toNumber(left) % divisor;
    }
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
      return compare(left, right) < 0;
    case '<=':
      return compare(left, right) <= 0;
    case '>':
      return compare(left, right) > 0;
    case '>=':
      return compare(left, right) >= 0;
    default:
      onError?.(`unsupported operator ${node.op}`);
      return null;
  }
}

const FUNCTIONS: Record<
  string,
  (...args: Array<GenUIStateValue | undefined>) => GenUIStateValue
> = {
  round: (v) => Math.round(toNumber(v)),
  floor: (v) => Math.floor(toNumber(v)),
  ceil: (v) => Math.ceil(toNumber(v)),
  abs: (v) => Math.abs(toNumber(v)),
  min: (...args) => {
    if (args.length === 0) return null;
    return Math.min(...args.map(toNumber));
  },
  max: (...args) => {
    if (args.length === 0) return null;
    return Math.max(...args.map(toNumber));
  },
  len: (v) => scalarToString(v).length,
  number: (v) => toNumber(v),
  string: (v) => scalarToString(v),
  contains: (haystack, needle) => scalarToString(haystack).includes(scalarToString(needle)),
  indexOf: (haystack, needle) => scalarToString(haystack).indexOf(scalarToString(needle)),
  lastIndexOf: (haystack, needle) => scalarToString(haystack).lastIndexOf(scalarToString(needle)),
  slice: (value, start, end) => {
    const text = scalarToString(value);
    const length = text.length;
    const from = clampIndex(toNumber(start), length);
    const to = end === undefined || end === null ? length : clampIndex(toNumber(end), length);
    return text.slice(from, Math.max(from, to));
  },
  part: (value, separator, index) => {
    const text = scalarToString(value);
    const sep = scalarToString(separator);
    if (sep === '') return '';
    const parts = text.split(sep);
    const position = Math.trunc(toNumber(index));
    return position >= 0 && position < parts.length ? (parts[position] ?? '') : '';
  },
  charAt: (value, index) => {
    const text = scalarToString(value);
    const position = Math.trunc(toNumber(index));
    return position >= 0 && position < text.length ? text.charAt(position) : '';
  },
};

/** 索引夹取到 [0, length]；非有限数按 0 处理 */
function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(length, Math.trunc(value)));
}

function evalCall(
  node: Extract<ExprNode, { kind: 'call' }>,
  state: Record<string, GenUIStateValue>,
  onError?: (message: string) => void,
): GenUIStateValue | undefined {
  const fn = FUNCTIONS[node.name];
  if (!fn) {
    onError?.(`unknown function "${node.name}"`);
    return undefined;
  }
  const args: GenUIStateValue[] = [];
  for (const arg of node.args) {
    const value = evalNode(arg, state, onError);
    if (value === undefined) return undefined;
    args.push(value);
  }
  const value = fn(...args);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    onError?.(`function "${node.name}" produced a non-finite number`);
    return undefined;
  }
  return value;
}

function truthy(value: GenUIStateValue | undefined): boolean {
  return !!value;
}

function toNumber(value: GenUIStateValue | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scalarToString(value: GenUIStateValue | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function compare(a: GenUIStateValue | undefined, b: GenUIStateValue | undefined): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = scalarToString(a);
  const sb = scalarToString(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
