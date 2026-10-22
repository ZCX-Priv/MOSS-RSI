// .verify-term-e2e.mts
// 真实 PTY 回归验证（不经 WS/UI，直接驱动 TerminalManager）：
//   1) PowerShell：OSC C/D 真正生效（不再走标记兜底）、连续命令不串台、退出码正确
//   2) cmd：提示符结算（不敲标记）、命令有输出/无输出都快速完成、人侧流无空提示符行
//   3) 多行命令脚本化：一次结算、输出完整
//   4) 语法不完整 → 续行看门狗快速取消；AbortSignal → 立即 Ctrl+C
//   5) 高频输出 → 人侧微批合并
//   6) 连续 2 次超时 → 默认终端自动重启
// 运行：bun .verify-term-e2e.mts

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalManager } from './src/modules/terminal/service';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const logger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

let frames = 0;
let frameChars = 0;
let markerLeaks = 0;
/** 每个终端的人侧可见输出（WS 收到的原文） */
const human = new Map<string, string>();
const mgr = new TerminalManager({
  emitter: (_sid, msg) => {
    if (msg.type === 'terminal.data') {
      frames++;
      const payload = msg.payload as { terminalId?: string; data?: string };
      frameChars += payload.data?.length ?? 0;
      if (!payload.terminalId) return;
      human.set(payload.terminalId, (human.get(payload.terminalId) ?? '') + (payload.data ?? ''));
      // 人侧可见流绝不能出现完成标记（否则终端页会看到内部协议）
      if ((payload.data ?? '').includes('__MOSS_DONE')) markerLeaks++;
    }
  },
  // 结构化 Logger 的最小可满足形态
  logger: logger as never,
  isWindows: process.platform === 'win32',
  dataDir: mkdtempSync(join(tmpdir(), 'moss-term-verify-')),
});

interface Case {
  name: string;
  ok: boolean;
  detail: string;
}
const cases: Case[] = [];
const record = (name: string, ok: boolean, detail: string): void => {
  cases.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};

interface RtView {
  cCount: number;
  dCount: number;
}
const rtView = (id: string): RtView =>
  (mgr as unknown as { runtimes: Map<string, RtView> }).runtimes.get(id) as RtView;

const sid = `verify-${Date.now()}`;

// ── 1) PowerShell：OSC 主路径 ──────────────────────────────────────────────
if (process.platform === 'win32') {
  const ps = await mgr.ensureDefault({ sessionId: sid, interpreter: 'powershell', creator: 'ai' });
  await sleep(900);
  const a = await mgr.run(ps.id, "Write-Output 'first-marker'", 8000);
  const b = await mgr.run(ps.id, "Write-Output 'second-marker'", 8000);
  const bad = await mgr.run(ps.id, 'Get-Item C:\\definitely-not-exist-plan', 8000);
  const view = rtView(ps.id);
  record(
    'PowerShell 连续命令不串台',
    a.completed && b.completed && a.output.trim() === 'first-marker' && b.output.trim() === 'second-marker',
    `a=${JSON.stringify(a.output)} b=${JSON.stringify(b.output)}`,
  );
  record(
    'PowerShell OSC 真正生效（C/D 增长）',
    view.cCount >= 3 && view.dCount >= 3,
    `c=${view.cCount} d=${view.dCount}`,
  );
  record(
    'PowerShell 错误命令 exitCode=1 且输出完整',
    bad.completed && bad.exitCode === 1 && /PathNotFound|FullyQualifiedErrorId/.test(bad.output),
    `code=${bad.exitCode} tail=${JSON.stringify(bad.output.slice(-80))}`,
  );

  // 多行 → 临时脚本（一次结算）
  const multi = await mgr.run(ps.id, "Write-Output 'ML-A'\nWrite-Output 'ML-B'", 8000);
  record(
    'PowerShell 多行命令脚本化',
    multi.completed && /ML-A/.test(multi.output) && /ML-B/.test(multi.output),
    JSON.stringify(multi.output),
  );

  // 续行看门狗
  const t0 = Date.now();
  const cont = await mgr.run(ps.id, 'if ($true) {', 8000);
  record(
    '续行看门狗',
    cont.syntaxIncomplete === true && Date.now() - t0 < 4000,
    `syntaxIncomplete=${cont.syntaxIncomplete} ms=${Date.now() - t0}`,
  );
  await sleep(300);

  // 中止
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 600);
  const t1 = Date.now();
  const aborted = await mgr.run(ps.id, 'Start-Sleep -Seconds 10', 15000, ac.signal);
  record('中止信号', aborted.aborted === true && Date.now() - t1 < 3000, `aborted=${aborted.aborted}`);

  // 高频输出
  frames = 0;
  frameChars = 0;
  const heavy = await mgr.run(
    ps.id,
    '1..3000 | ForEach-Object { Write-Output ("line-" + $_) }',
    20000,
  );
  record(
    '高频输出完整',
    heavy.completed && /line-3000/.test(heavy.output),
    `completed=${heavy.completed} outLen=${heavy.output.length} head=${JSON.stringify(heavy.output.slice(0, 40))} frames=${frames} chars=${frameChars}`,
  );

  // 人侧流：没有标记；提示符行不重复（PS）
  const psHuman = human.get(ps.id) ?? '';
  record(
    'PowerShell 人侧流无标记、无重复空提示符',
    !psHuman.includes('__MOSS_DONE') && !/\r?\nPS [^\r\n>]*>\s*\r?\nPS [^\r\n>]*>/.test(psHuman),
    `len=${psHuman.length}`,
  );
  mgr.disposeSession(sid);
}

// ── 2) cmd：提示符结算 ─────────────────────────────────────────────────────
if (process.platform === 'win32') {
  const csid = `verify-cmd-${Date.now()}`;
  const cmd = await mgr.create({ sessionId: csid, interpreter: 'cmd', cwd: process.cwd(), creator: 'ai' });
  await sleep(500);
  const t0 = Date.now();
  const c1 = await mgr.run(cmd.id, 'echo hi', 8000);
  const c2 = await mgr.run(cmd.id, 'cd', 8000);
  const c3 = await mgr.run(cmd.id, 'ver', 8000);
  const c4 = await mgr.run(cmd.id, 'cd .', 8000);
  const ms = Date.now() - t0;
  record(
    'cmd 命令输出与完成（echo/cd/ver/cd .）',
    c1.completed &&
      c1.output.trim() === 'hi' &&
      c2.completed &&
      /^[A-Za-z]:\\/.test(c2.output.trim()) &&
      c3.completed &&
      /Windows/.test(c3.output) &&
      c4.completed,
    `ms=${ms} c1=${JSON.stringify(c1.output)} c2=${JSON.stringify(c2.output)} c3=${JSON.stringify(c3.output.slice(0, 40))} c4=${JSON.stringify(c4.output)}`,
  );
  record('cmd 不注入标记（C 计数为 0）', rtView(cmd.id).cCount === 0, `c=${rtView(cmd.id).cCount}`);

  const multi = await mgr.run(cmd.id, 'echo ML-A\necho ML-B', 8000);
  record(
    'cmd 多行命令脚本化',
    multi.completed && /ML-A/.test(multi.output) && /ML-B/.test(multi.output),
    JSON.stringify(multi.output),
  );

  const cmdHuman = human.get(cmd.id) ?? '';
  // 空提示符行：<prompt>\r\n<prompt>（中间没有命令回显/输出）
  const blankPrompt = /\r?\n([A-Za-z]:\\[^\r\n>]*)>\r?\n\1>/.test(cmdHuman);
  record(
    'cmd 人侧流无标记、无空提示符行',
    !cmdHuman.includes('__MOSS_DONE') && !blankPrompt,
    `len=${cmdHuman.length} blankPrompt=${blankPrompt}`,
  );
  record('cmd 快照可用', typeof (await mgr.snapshotAsync(cmd.id)) === 'string');
  mgr.disposeSession(csid);
}

// ── 3) 连续 2 次超时 → 自动重启默认终端 ────────────────────────────────────
if (process.platform === 'win32') {
  const rsid = `verify-restart-${Date.now()}`;
  const info = await mgr.ensureDefault({ sessionId: rsid, interpreter: 'powershell', creator: 'ai' });
  await sleep(900);
  const first = await mgr.run(info.id, 'Start-Sleep -Seconds 5', 1200);
  const second = await mgr.run(info.id, 'Start-Sleep -Seconds 5', 1200);
  await sleep(1500);
  const newId = mgr.getDefaultId(rsid);
  record(
    '超时自愈',
    first.completed === false && second.restarted === true && !!newId && newId !== info.id,
    `firstCompleted=${first.completed} restarted=${second.restarted} old=${info.id} new=${newId}`,
  );
  mgr.disposeSession(rsid);
}

record('标记不泄漏到人侧', markerLeaks === 0, `leaks=${markerLeaks}`);
const failed = cases.filter((c) => !c.ok);
console.log(`\n${cases.length - failed.length}/${cases.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
