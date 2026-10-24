// 临时诊断：检查 0.2.0 扩展的 offscreen 创建状态。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = 'C:\\Users\\赵晨旭\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const ext = join(process.env.USERPROFILE ?? '', '.moss', 'browser', 'extension');
const profile = mkdtempSync(join(tmpdir(), 'moss-ext-probe-'));
const child = spawn(
  chrome,
  [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    `--load-extension=${ext}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const portFile = join(profile, 'DevToolsActivePort');
  let port = '';
  for (let i = 0; i < 60; i += 1) {
    try {
      port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
      if (port) break;
    } catch {
      // wait
    }
    await sleep(300);
  }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  const pending = new Map<number, (value: unknown) => void>();
  let seq = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)!;
      pending.delete(msg.id);
      resolve(msg);
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, any>>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve as (value: unknown) => void);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  await new Promise((resolve) => {
    ws.onopen = resolve;
  });
  await sleep(2500);
  const targets = await send('Target.getTargets');
  console.log(
    'TARGETS',
    targets.result.targetInfos.map((t: any) => [t.type, t.url.slice(0, 90)]),
  );
  const off = targets.result.targetInfos.find((t: any) => t.url.endsWith('/offscreen.html'));
  if (off) {
    const offAttached = await send('Target.attachToTarget', { targetId: off.targetId, flatten: true });
    const offSid = offAttached.result.sessionId;
    await send('Runtime.enable', {}, offSid);
    const offEval = async (expression: string) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, offSid);
      console.log('OFF_EVAL', expression.slice(0, 70), '=>', JSON.stringify(r.result).slice(0, 900));
    };
    await offEval("location.href");
    await offEval("typeof WebSocket");
    await offEval("typeof chrome.runtime.getManifest");
    await offEval("chrome.runtime.id");
    await offEval("JSON.stringify({connected, activePort, hasSocket: !!socket, cfg: typeof config !== 'undefined' ? config : null})");
    await offEval("connect().then(()=>'connected:'+connected).catch(e=>'ERR:'+e.message)");
    await sleep(2500);
    await offEval("JSON.stringify({connected, activePort, hasSocket: !!socket})");
  } else {
    console.log('NO_OFFSCREEN_TARGET');
  }
  const sw = targets.result.targetInfos.find(
    (t: any) => t.type === 'service_worker' && t.url.endsWith('/background.js'),
  );
  console.log('SW_TARGET', sw?.url);
  const attached = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const sid = attached.result.sessionId;
  await send('Runtime.enable', {}, sid);
  const evaluate = async (expression: string) => {
    const r = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sid,
    );
    console.log('EVAL', expression.slice(0, 70), '=>', JSON.stringify(r.result).slice(0, 600));
  };
  await evaluate('chrome.runtime.getManifest().version');
  await evaluate("typeof chrome.offscreen");
  await evaluate("chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(r=>JSON.stringify(r.map(c=>c.contextType)))");
  await evaluate('typeof ensureOffscreen');
  await evaluate("ensureOffscreen().then(v=>String(v)).catch(e=>'ERR:'+e.message)");
  await sleep(1500);
  await evaluate("chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(r=>JSON.stringify(r))");
  await evaluate("chrome.storage.local.get('mossBridge').then(v=>JSON.stringify(v))");
  await sleep(1000);
  ws.close();
  child.kill();
  await sleep(800);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.log('FATAL', err);
  try {
    child.kill();
  } catch {
    // ignore
  }
});
