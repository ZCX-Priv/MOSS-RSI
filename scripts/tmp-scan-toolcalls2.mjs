// 临时诊断脚本 2：定位 tool_calls 配对破损的机制
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = join(homedir(), '.moss', 'tasks');
const files = [];
function walk(dir) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.json') && e.name !== 'task.json') files.push(p);
  }
}
walk(root);

const roleStr = (m) => {
  if (!m) return 'N/A';
  const n = m.name ? `:${m.name}` : '';
  const tc = Array.isArray(m.toolCalls) && m.toolCalls.length ? `(calls:${m.toolCalls.map(t=>t.name).join(',')})` : '';
  return `${m.role}${n}${tc}`;
};

for (const f of files) {
  let obj; try { obj = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
  const msgs = Array.isArray(obj.messages) ? obj.messages : null;
  if (!msgs) continue;
  const dangling = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !Array.isArray(m.toolCalls) || !m.toolCalls.length) continue;
    const expected = m.toolCalls.map(tc => tc.id).filter(Boolean);
    const found = new Set();
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === 'tool') { if (msgs[j].toolCallId) found.add(msgs[j].toolCallId); j++; }
    const missing = expected.filter(id => !found.has(id));
    if (!missing.length) continue;
    // 缺失 id 是否出现在后续任意位置？
    for (const id of missing) {
      const laterIdx = msgs.findIndex((x, k) => k > i && x.role === 'tool' && x.toolCallId === id);
      dangling.push({ i, id, laterIdx, contiguousTools: found.size, expectedN: expected.length });
    }
  }
  if (!dangling.length) continue;
  console.log('\n==================', f.replace(root, ''), '==================');
  const idxs = [...new Set(dangling.map(d => d.i))];
  for (const i of idxs) {
    const lo = Math.max(0, i - 1), hi = Math.min(msgs.length - 1, i + 8);
    console.log(`-- 悬挂处 idx=${i} --`);
    for (let k = lo; k <= hi; k++) console.log(`   [${k}] ${roleStr(msgs[k])}`);
  }
  for (const d of dangling) {
    console.log(`   缺失 toolCallId=${d.id} 期望=${d.expectedN} 连续找到=${d.contiguousTools} 后续任意位置索引=${d.laterIdx}`);
  }
}