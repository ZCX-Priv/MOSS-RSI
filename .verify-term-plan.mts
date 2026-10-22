// 临时验证：计划验收项（cmd 标记路径 / PowerShell 错误退出码与完整性 / 双端无标记）
import { TerminalManager } from './src/modules/terminal/service.ts';
import type { Logger } from './src/core/types.ts';

const silent = (): Logger => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return l;
    },
    setLevel() {},
  } as unknown as Logger;
  return l;
};

const human: string[] = [];
const mgr = new TerminalManager({
  emitter: (_sid, msg) => {
    if (msg.type === 'terminal.data') human.push((msg.payload as { data: string }).data);
  },
  logger: silent(),
  isWindows: process.platform === 'win32',
  dataDir: './.verify-plan-data',
});

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

try {
  // ── cmd：标记路径 ──
  const cmd = await mgr.create({ sessionId: 'plan-cmd', interpreter: 'cmd', cwd: process.cwd(), creator: 'ai' });
  const c1 = await mgr.run(cmd.id, 'echo hi', 20_000);
  check(
    'cmd 正常命令：输出干净 + exit 0',
    c1.completed && c1.exitCode === 0 && c1.output.trim() === 'hi',
    JSON.stringify(c1.output),
  );
  const c2 = await mgr.run(cmd.id, 'cd C:\\definitely-not-exist-plan', 20_000);
  check(
    'cmd 错误命令：exit 1 + 有输出',
    c2.completed && c2.exitCode === 1 && c2.output.trim().length > 0,
    JSON.stringify({ code: c2.exitCode, out: c2.output.slice(0, 60) }),
  );
  check(
    'cmd AI 输出无标记',
    !c1.output.includes('__MOSS') && !/errorlevel/i.test(c1.output) && !c2.output.includes('__MOSS'),
  );

  // ── PowerShell：OSC 主路径 ──
  const ps = await mgr.create({ sessionId: 'plan-ps', interpreter: 'powershell', cwd: process.cwd(), creator: 'ai' });
  await mgr.run(ps.id, 'cd $env:TEMP', 20_000);
  const p1 = await mgr.run(ps.id, 'Write-Output "AAA"', 20_000);
  const p2 = await mgr.run(ps.id, 'Write-Output "BBB"', 20_000);
  const p3 = await mgr.run(ps.id, 'Write-Output "CCC"', 20_000);
  check(
    'PowerShell 连续短命令：结果完整且互不串台',
    p1.output.trim() === 'AAA' && p2.output.trim() === 'BBB' && p3.output.trim() === 'CCC',
    JSON.stringify({ p1: p1.output, p2: p2.output, p3: p3.output }),
  );
  const slow = await mgr.run(ps.id, 'Start-Sleep -Milliseconds 1200; Write-Output "SLOW"', 20_000);
  check('PowerShell 慢命令（>400ms）：输出完整', slow.completed && slow.output.trim() === 'SLOW', JSON.stringify(slow.output));
  const bad = await mgr.run(ps.id, 'Get-Item C:\\definitely-not-exist-plan', 20_000);
  const badComplete = bad.output.includes('PathNotFound') || bad.output.includes('FullyQualifiedErrorId');
  check(
    'PowerShell 错误命令：输出不截断 + exit 1',
    bad.completed && bad.exitCode === 1 && badComplete,
    JSON.stringify({ code: bad.exitCode, tail: bad.output.slice(-120) }),
  );
  check('PowerShell AI 输出无标记', !bad.output.includes('__MOSS') && !slow.output.includes('__MOSS'));

  // ── 人侧 / 快照 ──
  const humanAll = human.join('');
  check('人侧无标记泄漏', !humanAll.includes('__MOSS_DONE') && !/errorlevel/i.test(humanAll));
  const snapAll = [mgr.snapshot(cmd.id) ?? '', mgr.snapshot(ps.id) ?? ''].join('\n');
  check('人侧快照无标记', !snapAll.includes('__MOSS_DONE') && !/errorlevel/i.test(snapAll));

  mgr.disposeSession('plan-cmd');
  mgr.disposeSession('plan-ps');
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
