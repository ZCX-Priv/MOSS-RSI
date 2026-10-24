// 临时诊断：offscreen WebSocket 连接与 Origin。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ext = join(process.env.USERPROFILE ?? '', '.moss', 'browser', 'extension');
const profile = mkdtempSync(join(tmpdir(), 'moss-ext-ws-'));
let child: ReturnType<typeof spawn> | null = null;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 7799,
  fetch(req, srv) {
    const origin = req.headers.get('origin');
    console.log('HTTP', req.method, new URL(req.url).pathname, 'ORIGIN=', origin);
    if (srv.upgrade(req, { data: {} })) return undefined;
    return new Response('no', { status: 400 });
  },
  websocket: {
    open(ws) {
      console.log('WS_OPEN');
      ws.send(JSON.stringify({ type: 'welcome', protocol: 1, instanceId: 'probe' }));
    },
    message(ws, msg) {
      console.log('WS_MSG', String(msg).slice(0, 300));
    },
    close() {
      console.log('WS_CLOSE');
    },
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  child = spawn(
    'C:\\Users\\赵晨旭\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    [
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
  await sleep(6000);
  console.log('DONE_WAIT');
}

main()
  .finally(async () => {
    try {
      child?.kill();
    } catch {
      // ignore
    }
    await sleep(800);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // ignore
    }
    server.stop(true);
  })
  .catch((err) => console.log('ERR', err));
