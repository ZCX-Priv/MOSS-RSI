// 临时诊断脚本：扫描 ~/.moss/tasks 下所有会话，检测 tool_calls 配对破损
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = join(homedir(), '.moss', 'tasks');
const files = [];
function walk(dir) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.json') && e.name !== 'task.json' && e.name !== 'tasks.json') files.push(p);
  }
}
walk(root);

let total = 0, danglingSessions = 0, orphanSessions = 0, examples = [];
const detail = [];

for (const f of files) {
  let obj;
  try { obj = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
  const msgs = Array.isArray(obj.messages) ? obj.messages : null;
  if (!msgs) continue;
  total++;
  let hasDangling = false, hasOrphan = false;

  // 建立 id -> tool message 索引（按时间顺序）
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !Array.isArray(m.toolCalls) || m.toolCalls.length === 0) continue;
    const expected = new Set(m.toolCalls.map(tc => tc.id).filter(Boolean));
    // 收集紧随其后的连续 tool 消息
    const found = new Set();
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === 'tool') {
      if (msgs[j].toolCallId) found.add(msgs[j].toolCallId);
      j++;
    }
    const missing = [...expected].filter(id => !found.has(id));
    if (missing.length > 0) {
      hasDangling = true;
      detail.push({
        file: f.replace(root, ''),
        idx: i,
        expectedN: expected.size,
        foundN: found.size,
        missingN: missing.length,
        // 紧随连续 tool 数 vs 之后出现的非tool角色
        nextRole: msgs[j]?.role ?? 'EOF',
        contentSnippet: (m.content || '').slice(0, 60),
        toolNames: m.toolCalls.map(tc => tc.name),
      });
    }
  }
  // 孤立 tool（前一条不是覆盖它的 assistant）
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'tool') continue;
    let ok = false;
    for (let k = i - 1; k >= 0; k--) {
      const a = msgs[k];
      if (a.role === 'assistant' && a.toolCalls?.some(tc => tc.id === msgs[i].toolCallId)) { ok = true; break; }
      if (a.role !== 'tool') break;
    }
    if (!ok) { hasOrphan = true; break; }
  }
  if (hasDangling) danglingSessions++;
  if (hasOrphan) orphanSessions++;
}

console.log('扫描会话文件数:', total);
console.log('含悬挂 tool_calls 的会话数:', danglingSessions);
console.log('含孤立 tool 消息的会话数:', orphanSessions);
console.log('悬挂点总数:', detail.length);
console.log('\n--- 分布（缺失数 -> 次数）---');
const dist = {};
for (const d of detail) dist[d.missingN] = (dist[d.missingN] || 0) + 1;
console.log(dist);
console.log('\n--- 前 12 个悬挂样例 ---');
for (const d of detail.slice(0, 12)) console.log(JSON.stringify(d));