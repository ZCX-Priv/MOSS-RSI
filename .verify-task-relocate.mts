// 会话归类回归验证：
//   1) createTask 同 id 幂等（不产生幽灵任务）
//   2) 会话文件错落在 default 时，运行期读写会自动归位到索引分组目录
// 运行：bun .verify-task-relocate.mts

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from './src/modules/agent/task-store';
import { SessionStore } from './src/modules/agent/session';

const dataDir = mkdtempSync(join(tmpdir(), 'moss-task-verify-'));
const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const env = { dataDir } as never;

const tasks = new TaskStore(env, logger as never);
const group = tasks.createGroup('TokenBank', 'folder', { id: 'cb3d57ef-159b-42f6-bbb3-99fba40916f8' });
const sid = '2eb01b82-7131-4cea-8bbd-e1eb4cfe1427';
const task = tasks.createTask('t', group.id, sid);
const again = tasks.createTask('t2', group.id, sid);

const checks: Array<[string, boolean, string]> = [];
checks.push(['createTask 沿用预分配 id', task.id === sid, task.id]);
checks.push(['createTask 同 id 幂等（返回同一任务）', again.id === sid, again.id]);
checks.push([
  'createTask 幂等不发生移组/重排污染',
  again.groupId === group.id && tasks.listGroupTasks(group.id).total === 1,
  `group=${again.groupId} total=${tasks.listGroupTasks(group.id).total}`,
]);

// 模拟历史 bug：会话文件被兜底写进 default 目录
mkdirSync(join(dataDir, 'tasks', 'default'), { recursive: true });
const sessionPayload = {
  id: sid,
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  totalTokens: 0,
  contextFiles: [],
};
writeFileSync(join(dataDir, 'tasks', 'default', `${sid}.json`), JSON.stringify(sessionPayload), 'utf8');

const sessions = new SessionStore(env, logger as never, {
  resolveSessionDir: (id) => tasks.getDirOf(id),
});
sessions.getOrCreate(sid);
sessions.persistSession(sessions.get(sid)!);

const inGroup = existsSync(join(dataDir, 'tasks', group.id, `${sid}.json`));
const stillDefault = existsSync(join(dataDir, 'tasks', 'default', `${sid}.json`));
checks.push(['运行期归位到索引分组目录', inGroup, `inGroup=${inGroup}`]);
checks.push(['原 default 文件已移走', !stillDefault, `stillDefault=${stillDefault}`]);

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
