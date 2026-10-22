// .verify-term-abort.mts（临时诊断：中止后紧接着执行长输出命令为何空结算）
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalManager } from './src/modules/terminal/service';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
interface W {
  command: string;
  echoEnd?: number;
  cAt?: number;
  dCountAtSubmit: number;
  promptAt?: number;
  settled: boolean;
  settling?: boolean;
}
interface RtView {
  buffer: string;
  bufferBase: number;
  dCount: number;
  cCount: number;
  waiters: Set<W>;
  interpreter: { shell: string };
}
const mgr = new TerminalManager({
  emitter: () => {},
  logger: logger as never,
  isWindows: true,
  dataDir: mkdtempSync(join(tmpdir(), 'moss-term-abort-')),
});
const rt = (id: string): RtView =>
  (mgr as unknown as { runtimes: Map<string, RtView> }).runtimes.get(id) as RtView;

const info = await mgr.create({ sessionId: 'abort-diag', interpreter: 'powershell', creator: 'ai', cwd: process.cwd() });
await sleep(900);
await mgr.run(info.id, 'Write-Output warm', 8000);

const ac = new AbortController();
setTimeout(() => ac.abort(), 600);
const aborted = await mgr.run(info.id, 'Start-Sleep -Seconds 10', 15000, ac.signal);
let v = rt(info.id);
console.log('aborted', JSON.stringify({ aborted: aborted.aborted, d: v.dCount, c: v.cCount, tail: v.buffer.slice(-160) }));
await sleep(300);
v = rt(info.id);
console.log('after300', JSON.stringify({ d: v.dCount, c: v.cCount, tail: v.buffer.slice(-200) }));

const t0 = Date.now();
const p = mgr.run(info.id, '1..3000 | ForEach-Object { Write-Output ("line-" + $_) }', 20000);
for (let i = 0; i < 25; i++) {
  await sleep(100);
  const w = [...rt(info.id).waiters][0];
  if (!w) {
    console.log(`+${Date.now() - t0} no waiter`);
    break;
  }
  console.log(
    `+${Date.now() - t0}`,
    JSON.stringify({
      d: rt(info.id).dCount,
      c: rt(info.id).cCount,
      echoEnd: w.echoEnd,
      cAt: w.cAt,
      promptAt: w.promptAt,
      settled: w.settled,
      settling: w.settling,
      tail: rt(info.id).buffer.slice(-90),
    }),
  );
}
const res = await p;
console.log(
  'heavy',
  JSON.stringify({
    ms: Date.now() - t0,
    completed: res.completed,
    outLen: res.output.length,
    exit: res.exitCode,
    head: res.output.slice(0, 40),
  }),
);
mgr.disposeSession('abort-diag');
process.exit(0);
