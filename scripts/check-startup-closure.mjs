// scripts/check-startup-closure.mjs
// 启动闭包预算检查：从 dist/main.js 出发递归跟踪静态 import，统计可达 JS 体积，
// 并禁止 zod / iconv-lite / readable-stream 等重依赖出现在启动闭包里。
//
// 用法：node scripts/check-startup-closure.mjs [--budget=1468006]
// 默认预算 1.4MB（minified 产物）。超预算或命中禁止依赖时退出码 1。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const ENTRY = 'main.js';
const DEFAULT_BUDGET = 1_400_000;

const argBudget = process.argv.find((a) => a.startsWith('--budget='));
const BUDGET = argBudget ? Number(argBudget.split('=')[1]) : DEFAULT_BUDGET;

/** 启动闭包里不允许出现的依赖标记 */
const FORBIDDEN = [
  'node_modules/zod/',
  'node_modules/iconv-lite/',
  'node_modules/readable-stream/',
  'node_modules/string_decoder/',
  'node_modules/safer-buffer/',
];

if (!existsSync(join(DIST, ENTRY))) {
  console.error(`[closure] 找不到 dist/${ENTRY}，请先 npm run build`);
  process.exit(1);
}

const seen = new Set();
const sizes = new Map();
const forbiddenHits = [];

function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const full = join(DIST, file);
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    return;
  }
  sizes.set(file, text.length);
  for (const marker of FORBIDDEN) {
    if (text.includes(marker)) forbiddenHits.push({ file, marker });
  }
  // 仅跟踪相对静态 import（动态 import 会拆成独立 chunk，不属于启动闭包）
  const re = /(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g;
  let m;
  while ((m = re.exec(text)) !== null) walk(m[1]);
}

walk(ENTRY);

const total = Array.from(sizes.values()).reduce((a, b) => a + b, 0);
const list = Array.from(sizes.entries()).sort((a, b) => b[1] - a[1]);

console.log('[closure] 启动静态闭包：');
for (const [file, bytes] of list) {
  console.log(`  ${file.padEnd(28)} ${(bytes / 1024).toFixed(0)}KB`);
}
console.log(`[closure] 合计 ${list.length} 个 chunk / ${(total / 1024).toFixed(0)}KB（预算 ${(BUDGET / 1024).toFixed(0)}KB）`);

let failed = false;
if (forbiddenHits.length > 0) {
  failed = true;
  console.error('[closure] 禁止依赖进入启动闭包：');
  for (const hit of forbiddenHits) console.error(`  - ${hit.marker} in ${hit.file}`);
}
if (total > BUDGET) {
  failed = true;
  console.error(`[closure] 超出预算 ${(total - BUDGET) / 1024}KB`);
}

process.exit(failed ? 1 : 0);
