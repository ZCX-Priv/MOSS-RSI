// .verify-ws-e2e.mts —— 临时验证：上传事件能否经 WS 投递到订阅了该 session 的连接（验证完删除）
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WS_URL = 'ws://127.0.0.1:7766/ws';
const HTTP = 'http://127.0.0.1:7766';
const SESSION = 'verify-sess-e2e';

const dir = mkdtempSync(join(tmpdir(), 'moss-ws-'));
const received: Array<{ type?: string; sessionId?: string; payload?: unknown }> = [];

const ws = new WebSocket(WS_URL);

const done = (code: number): void => {
  console.log(`\n--- received message types (${received.length}) ---`);
  console.log(received.map((m) => `${m.type}${m.sessionId ? `#${m.sessionId}` : ''}`).join(', ') || '(none)');
  try { ws.close(); } catch { /* ignore */ }
  process.exit(code);
};

ws.onopen = async (): Promise<void> => {
  console.log('ws open');
  ws.send(JSON.stringify({ type: 'session.subscribe', sessionId: SESSION }));
  // 等订阅回执后上传
  await new Promise((r) => setTimeout(r, 300));

  const body = {
    dir,
    cwd: '__system__',
    name: 'ws-e2e.txt',
    dataBase64: Buffer.from('ws-e2e').toString('base64'),
    sessionId: SESSION,
  };
  const resp = await fetch(`${HTTP}/api/filesystem/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  console.log(`upload -> ${resp.status} ${JSON.stringify(json)}`);
};

ws.onmessage = (e: MessageEvent): void => {
  try {
    const msg = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
    received.push({ type: msg.type, sessionId: msg.sessionId, payload: msg.payload });
    if (msg.type === 'file-created' && msg.sessionId === SESSION) {
      console.log(`\nPASS: file-created 到达订阅连接 -> ${JSON.stringify(msg.payload)}`);
      done(0);
    }
  } catch { /* ignore */ }
};

ws.onerror = (): void => {
  console.log('ws error (后端未监听 7766？)');
  done(1);
};

setTimeout(() => {
  console.log('\nFAIL: 10s 内未收到 file-created');
  done(1);
}, 10_000);
