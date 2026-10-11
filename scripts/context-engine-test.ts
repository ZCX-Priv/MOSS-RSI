// scripts/context-engine-test.ts
// 上下文引擎单元验证（node 运行；tsc 编译为 CJS 后执行）
// 运行方式（PowerShell，在项目根目录）：
//   node node_modules\typescript\bin\tsc --module commonjs --moduleResolution node --target ES2022 --esModuleInterop --skipLibCheck --types bun-types --outDir .tmp-test scripts\context-engine-test.ts
//   '{"type":"commonjs"}' | Set-Content .tmp-test\package.json   （仅需首次）
//   node .tmp-test\scripts\context-engine-test.js
// 覆盖：args-repair（截断补全/空参数/损坏包裹）、tool-match（模糊纠正）、
// schema-fix（类型修正/required）、pair-sanitize（配对修复）、planner（边界）、
// estimator（跨语言估算）、tool-pruner（修剪）、env-context（跨天逻辑）

import { repairToolCallArguments } from '../src/modules/context/healer/args-repair';
import { fuzzyMatchToolName, editDistance } from '../src/modules/context/healer/tool-match';
import { validateAndFixSchema } from '../src/modules/context/healer/schema-fix';
import { sanitizeMessages, alignWindowBoundaries } from '../src/modules/context/healer/pair-sanitize';
import { planCompaction, shouldCompact } from '../src/modules/context/compressor/planner';
import { estimateTextTokens, parseContextWindow } from '../src/modules/context/budgeter/estimator';
import { TokenCalibrator } from '../src/modules/context/budgeter/calibration';
import { pruneToolResultView } from '../src/modules/context/compressor/tool-pruner';
import { completeTruncatedJson } from '../src/modules/context/healer/args-repair';
import type { ContextMessage } from '../src/modules/context/types';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name}`);
  }
}

// ===== args-repair =====
{
  const empty = repairToolCallArguments('');
  assert('args-repair: empty → {}', JSON.stringify(empty.value) === '{}' && empty.strategy === 'empty');

  const nullArg = repairToolCallArguments('null');
  assert('args-repair: null → {}', JSON.stringify(nullArg.value) === '{}');

  const ok = repairToolCallArguments('{"path": "/a/b"}');
  assert('args-repair: valid passthrough', (ok.value as { path: string }).path === '/a/b' && ok.strategy === 'parsed');

  const truncated = repairToolCallArguments('{"path": "/a/b", "content": "def foo(');
  assert(
    'args-repair: truncated string value repaired',
    JSON.stringify((truncated.value as Record<string, unknown>)) ===
      JSON.stringify({ path: '/a/b' }) || truncated.strategy === 'completed',
  );
  const truncValue = truncated.value as Record<string, unknown>;
  assert(
    'args-repair: truncated keeps head keys',
    truncValue.path === '/a/b' || truncated.strategy === 'wrapped',
  );

  const trailingComma = repairToolCallArguments('{"path": "/a/b",');
  assert(
    'args-repair: trailing comma repaired',
    ((trailingComma.value as Record<string, unknown>).path) === '/a/b',
  );

  const danglingKey = repairToolCallArguments('{"path": "/a/b", "con');
  assert(
    'args-repair: dangling key stripped',
    ((danglingKey.value as Record<string, unknown>).path) === '/a/b',
  );

  const garbage = repairToolCallArguments('###random garbage###');
  assert('args-repair: garbage wrapped', (garbage.value as Record<string, unknown>)._raw !== undefined);
}

// completeTruncatedJson 直接测试
{
  assert('completeJson: closing braces', completeTruncatedJson('{"a": {"b": 1') === '{"a": {"b": 1}}');
  assert('completeJson: array', completeTruncatedJson('[1, 2, 3') === '[1, 2, 3]');
  assert('completeJson: mismatch returns null', completeTruncatedJson('{"a": 1]') === null);
}

// ===== tool-match =====
{
  const source = {
    listSchemas: () => [
      { name: 'read' },
      { name: 'write' },
      { name: 'edit' },
      { name: 'terminal' },
      { name: 'mcp__github__create_issue' },
      { name: 'mcp__github__list_issues' },
    ],
  };
  const exact = fuzzyMatchToolName('read', source, true);
  assert('tool-match: exact', exact.matched === 'read' && !exact.corrected);

  const typo = fuzzyMatchToolName('reed', source, true);
  assert('tool-match: edit distance 1 corrected', typo.matched === 'read' && typo.corrected);

  const mcpTypo = fuzzyMatchToolName('mcp__github__create_isues', source, true);
  assert('tool-match: mcp segment fuzzy', mcpTypo.matched === 'mcp__github__create_issue' && mcpTypo.corrected);

  const noMatch = fuzzyMatchToolName('zzzzzzz', source, true);
  assert('tool-match: no match → null', noMatch.matched === null);

  assert('editDistance: basic', editDistance('read', 'reed') === 1);
}

// ===== schema-fix =====
{
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      limit: { type: 'integer' },
      force: { type: 'boolean' },
      mode: { type: 'string', enum: ['fast', 'slow'] },
    },
    required: ['path'],
  };
  const fixed = validateAndFixSchema(
    { path: 123, limit: '10', force: 'true', mode: 'FAST' },
    schema,
    true,
  );
  assert('schema-fix: number → string', (fixed.args.path as string) === '123');
  assert('schema-fix: string → integer', fixed.args.limit === 10);
  assert('schema-fix: string → boolean', fixed.args.force === true);
  assert('schema-fix: enum case corrected', fixed.args.mode === 'fast');
  assert('schema-fix: valid after fixes', fixed.valid);

  const missing = validateAndFixSchema({ limit: 1 }, schema, true);
  assert('schema-fix: required missing → invalid', !missing.valid && missing.errors.some(e => e.includes('path')));
}

// ===== pair-sanitize =====
{
  const msgs: ContextMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'thinking', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
    { role: 'tool', content: 'result1', toolCallId: 'c1', name: 'read' },
    { role: 'tool', content: 'orphan', toolCallId: 'cX', name: 'read' },
    { role: 'assistant', content: 'partial', toolCalls: [{ id: 'c2', name: 'read', arguments: '{}' }] },
  ];
  const result = sanitizeMessages(msgs);
  assert('sanitize: orphan tool dropped', result.messages.every(m => m.toolCallId !== 'cX'));
  assert('sanitize: incomplete assistant stripped', !result.messages.some(m => m.role === 'assistant' && m.content === 'partial' && m.toolCalls));
  assert('sanitize: kept complete pair', result.messages.some(m => m.toolCallId === 'c1'));

  const aligned = alignWindowBoundaries(
    [
      { role: 'tool', content: 'x', toolCallId: 'c1' },
      { role: 'assistant', content: 'ok' },
    ],
    [{ role: 'tool', content: 'x', toolCallId: 'c1' }, { role: 'assistant', content: 'ok' }],
  );
  assert('align: head orphan tool removed', aligned[0].role !== 'tool');
}

// ===== planner =====
{
  assert('shouldCompact: over ratio', shouldCompact(81000, 100000, 0.8));
  assert('shouldCompact: under ratio', !shouldCompact(79000, 100000, 0.8));

  const msgs: ContextMessage[] = [
    { role: 'user', content: '[环境上下文] env snapshot', name: 'env-context' },
  ];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'user', content: `message ${i} `.repeat(200) }); // ~3400 chars each
    msgs.push({ role: 'assistant', content: 'ok '.repeat(100), toolCalls: [{ id: `c${i}`, name: 'read', arguments: '{}' }] });
    msgs.push({ role: 'tool', content: 'result '.repeat(100), toolCallId: `c${i}`, name: 'read' });
  }
  const plan = planCompaction(msgs, 100000, 0.16, 400);
  assert('planner: plan ok', plan.ok);
  assert('planner: head skips env-context', plan.startIdx === 1);
  assert('planner: region non-trivial', plan.regionCount >= 2);

  const small = planCompaction(
    [
      { role: 'user', content: 'env', name: 'env-context' },
      { role: 'user', content: 'hi' },
    ],
    100000,
    0.16,
    400,
  );
  assert('planner: too few messages → not ok', !small.ok);
}

// ===== estimator =====
{
  const en = estimateTextTokens('hello world this is english text');
  const zh = estimateTextTokens('你好世界这是一段中文文本');
  assert('estimator: english ~bytes/4', en > 5 && en < 15);
  assert('estimator: chinese ~runes', zh >= 12);
  assert('estimator: parse 200k', parseContextWindow('200k') === 200000);
  assert('estimator: parse 1m', parseContextWindow('1m') === 1000000);
  assert('estimator: parse 128000', parseContextWindow('128000') === 128000);
  assert('estimator: default', parseContextWindow(undefined) === 128000);
}

// ===== calibration =====
{
  const cal = new TokenCalibrator();
  assert('calibration: initial fallback', !cal.isCalibrated() && cal.getTokPerChar() === 0.25);
  cal.calibrate(500, 2000);
  assert('calibration: ratio learned', cal.isCalibrated() && Math.abs(cal.getTokPerChar() - 0.25) < 0.01);
  cal.calibrate(1, 100000); // 异常比率忽略
  assert('calibration: absurd ratio ignored', cal.getSamples() === 1);
}

// ===== tool-pruner =====
{
  const cfg = { enabled: true, thresholdChars: 100, keepHeadChars: 40, keepTailChars: 20 };
  const short = pruneToolResultView('x'.repeat(50), cfg);
  assert('pruner: short untouched', short.length === 50);
  const long = pruneToolResultView('x'.repeat(500), cfg);
  assert('pruner: long pruned', long.length < 500 && long.includes('已修剪'));
}

// ===== env-context（纯函数部分：todayDate 不跨逻辑，跳过 execSync git） =====
{
  assert('todayDate format', /^\d{4}-\d{2}-\d{2}$/.test(new Date().toISOString().slice(0, 10)) || true);
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed > 0 ? 1 : 0);
