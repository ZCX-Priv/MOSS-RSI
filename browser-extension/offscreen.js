// browser-extension/offscreen.js
// 常驻离屏文档：持有到 MOSS 的 WebSocket，负责握手、心跳与断线重连。
// Service Worker 只负责执行 chrome.tabs/debugger 命令，二者通过 runtime 消息互转。

'use strict';

const PROTOCOL_VERSION = 1;
const PORT_SCAN_COUNT = 10;
const KEEPALIVE_MS = 20000;
const RECONNECT_MS = 2000;
const CONNECT_TIMEOUT_MS = 1200;
const WELCOME_TIMEOUT_MS = 1500;
const COMMAND_TIMEOUT_MS = 25000;

/** @type {{port:number, token:string, autoConnect:boolean, builtinTag:string, instanceId:string, extensionId:string, extensionVersion:string}} */
let config = {
  port: 7799,
  token: '',
  autoConnect: true,
  builtinTag: '',
  instanceId: '',
  extensionId: chrome.runtime.id,
  extensionVersion: '',
};
/** @type {WebSocket|null} */
let socket = null;
let connected = false;
let connecting = false;
let manuallyDisconnected = false;
/** @type {number|null} */
let activePort = null;
/** @type {Record<string, unknown>|null} */
let serverInfo = null;
let wsKeepAliveTimer = null;
let swKeepAliveTimer = null;
let reconnectTimer = null;
let connectSeq = 0;

function log(...args) {
  console.log('[MOSS Bridge offscreen]', ...args);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBrowserInfo() {
  const ua = navigator.userAgent || '';
  let name = 'Chromium';
  let version = '';
  const patterns = [
    [/Edg\/([\d.]+)/, 'Microsoft Edge'],
    [/OPR\/([\d.]+)/, 'Opera'],
    [/Brave\/([\d.]+)/, 'Brave'],
    [/Chrome\/([\d.]+)/, 'Google Chrome'],
    [/Chromium\/([\d.]+)/, 'Chromium'],
  ];
  for (const [re, label] of patterns) {
    const m = re.exec(ua);
    if (m) {
      name = label;
      version = m[1];
      break;
    }
  }
  return { name, version, userAgent: ua };
}

function statusSnapshot() {
  return {
    connected,
    port: activePort,
    configuredPort: Number(config.port) || 7799,
    tokenConfigured: Boolean(config.token),
    autoConnect: config.autoConnect !== false,
    instanceId: config.instanceId,
    server: serverInfo,
  };
}

async function reportStatus() {
  try {
    await chrome.runtime.sendMessage({ target: 'sw', type: 'bridge:status', status: statusSnapshot() });
  } catch {
    // SW 可能正在重启
  }
}

async function loadConfig() {
  try {
    const reply = await chrome.runtime.sendMessage({ target: 'sw', type: 'bridge:getConfig' });
    if (reply && reply.ok && reply.config) {
      config = { ...config, ...reply.config };
    }
  } catch {
    // 使用默认配置
  }
}

function post(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function candidatePorts() {
  const base = Math.max(1024, Math.min(65535, Number(config.port) || 7799));
  const ports = [];
  if (activePort) ports.push(activePort);
  for (let i = 0; i < PORT_SCAN_COUNT; i += 1) {
    const port = base + i;
    if (port <= 65535 && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

function stopTimers() {
  if (wsKeepAliveTimer !== null) {
    clearInterval(wsKeepAliveTimer);
    wsKeepAliveTimer = null;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function startWsKeepAlive() {
  if (wsKeepAliveTimer !== null) clearInterval(wsKeepAliveTimer);
  wsKeepAliveTimer = setInterval(() => {
    post({ type: 'ping' });
  }, KEEPALIVE_MS);
}

/** 保持 Service Worker 活跃（debugger 附着不丢）；失败不影响 WS */
function startSwKeepAlive() {
  if (swKeepAliveTimer !== null) return;
  swKeepAliveTimer = setInterval(() => {
    void chrome.runtime.sendMessage({ target: 'sw', type: 'sw:ping' }).catch(() => {});
  }, KEEPALIVE_MS);
}

/** 尝试连接单个端口：open 后发送 hello，等待 welcome */
function tryPort(port, seq) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/browser`);
    } catch {
      resolve(false);
      return;
    }

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      clearTimeout(welcomeTimer);
      if (!ok) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      resolve(ok ? ws : false);
    };

    const openTimer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    let welcomeTimer = null;

    ws.onopen = () => {
      clearTimeout(openTimer);
      if (seq !== connectSeq) {
        finish(false);
        return;
      }
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          extensionId: config.extensionId || chrome.runtime.id,
          extensionVersion: config.extensionVersion || '',
          instanceId: config.instanceId,
          browser: parseBrowserInfo(),
          token: config.token || '',
          builtinTag: config.builtinTag || '',
        }),
      );
      welcomeTimer = setTimeout(() => finish(false), WELCOME_TIMEOUT_MS);
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg && msg.type === 'welcome') {
        if (socket && socket !== ws) {
          finish(false);
          return;
        }
        serverInfo = msg;
        clearTimeout(welcomeTimer);
        socket = ws;
        activePort = port;
        ws.onmessage = onServerMessage;
        finish(true);
        return;
      }
      if (msg && msg.type === 'rejected') {
        finish(false);
      }
    };

    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}

async function connect() {
  if (connecting || manuallyDisconnected) return;
  if (socket && socket.readyState === WebSocket.OPEN) return;
  if (config.autoConnect === false) {
    await reportStatus();
    return;
  }
  connecting = true;
  const seq = ++connectSeq;
  try {
    const results = await Promise.all(candidatePorts().map((port) => tryPort(port, seq)));
    if (seq !== connectSeq || manuallyDisconnected) {
      for (const result of results) {
        if (result) {
          try {
            result.close();
          } catch {
            /* ignore */
          }
        }
      }
      return;
    }
    const won = results.find((result) => result);
    if (!won) {
      scheduleReconnect();
      return;
    }
    for (const result of results) {
      if (result && result !== won) {
        try {
          result.close();
        } catch {
          /* ignore */
        }
      }
    }
    socket = won;
    if (won.readyState !== WebSocket.OPEN) {
      socket = null;
      scheduleReconnect();
      return;
    }
    socket.onmessage = onServerMessage;
    socket.onclose = onSocketClose;
    socket.onerror = () => {};
    connected = true;
    activePort = Number(new URL(socket.url).port);
    startWsKeepAlive();
    startSwKeepAlive();
    log(`connected on port ${activePort}`);
    await reportStatus();
  } catch (err) {
    log('connect failed', err instanceof Error ? err.message : String(err));
    scheduleReconnect();
  } finally {
    if (seq === connectSeq) connecting = false;
  }
}

function scheduleReconnect() {
  connected = false;
  stopTimers();
  void reportStatus();
  if (manuallyDisconnected) return;
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, RECONNECT_MS);
}

function onSocketClose() {
  socket = null;
  serverInfo = null;
  stopTimers();
  scheduleReconnect();
}

function disconnect() {
  manuallyDisconnected = true;
  ++connectSeq;
  stopTimers();
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
  socket = null;
  connected = false;
  serverInfo = null;
  void reportStatus();
}

async function reconnectNow() {
  manuallyDisconnected = false;
  ++connectSeq;
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
  connected = false;
  await connect();
}

async function forwardCommandToServiceWorker(id, method, params) {
  try {
    const reply = await Promise.race([
      chrome.runtime.sendMessage({ target: 'sw', type: 'cmd', id, method, params }),
      delay(COMMAND_TIMEOUT_MS).then(() => ({ ok: false, error: '命令超时（Service Worker 未响应）' })),
    ]);
    if (reply && reply.ok) {
      post({ type: 'reply', id, ok: true, result: reply.result ?? null });
    } else {
      post({
        type: 'reply',
        id,
        ok: false,
        error: { message: (reply && reply.error) || '命令执行失败' },
      });
    }
  } catch (err) {
    post({
      type: 'reply',
      id,
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  }
}

function onServerMessage(event) {
  let msg;
  try {
    msg = JSON.parse(String(event.data));
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'cmd') {
    void forwardCommandToServiceWorker(msg.id, msg.method, msg.params || {});
    return;
  }
  if (msg.type === 'ping') {
    post({ type: 'pong' });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || message.target !== 'offscreen') return false;
  if (message.type === 'status:get') {
    sendResponse({ ok: true, status: statusSnapshot() });
    return false;
  }
  if (message.type === 'event') {
    const { target: _target, type: _type, ...payload } = message;
    post({ type: 'event', ...payload });
    return false;
  }
  if (message.type === 'config:changed') {
    if (message.config) config = { ...config, ...message.config };
    manuallyDisconnected = false;
    void reconnectNow();
    return false;
  }
  if (message.type === 'bridge:reconnect') {
    void reconnectNow();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'bridge:disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

async function init() {
  await loadConfig();
  await reportStatus();
  void connect();
}

void init();
