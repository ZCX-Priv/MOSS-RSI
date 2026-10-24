// browser-extension/background.js
// MOSS Browser Bridge 命令执行端（MV3 Service Worker）。
// WebSocket 由常驻 offscreen 文档持有；本文件只负责：
//   1. chrome.tabs / chrome.tabGroups：建页、分组、聚焦、关闭、列表
//   2. chrome.debugger：CDP 中继（Page/Runtime/Accessibility/Input/DOM）
//   3. 把 debugger / tab 生命周期事件转发给 offscreen，再由其发往 MOSS

'use strict';

const PROTOCOL_VERSION = 1;
const DEFAULT_SETTINGS = { port: 7799, token: '', autoConnect: true, builtinTag: '' };
const OFFSCREEN_PATH = 'offscreen.html';

let cachedBridgeStatus = {
  connected: false,
  port: null,
  configuredPort: DEFAULT_SETTINGS.port,
  tokenConfigured: false,
  autoConnect: true,
};
/** 已 attach debugger 的标签页 */
const attachedTabs = new Set();
let creatingOffscreen = null;

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

async function getBridgeConfig() {
  const stored = await chrome.storage.local.get(['mossBridge', 'mossInstanceId']);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.mossBridge || {}) };
  let instanceId = typeof stored.mossInstanceId === 'string' ? stored.mossInstanceId : '';
  if (!instanceId) {
    instanceId = crypto.randomUUID();
    await chrome.storage.local.set({ mossInstanceId: instanceId });
  }
  return {
    ...settings,
    instanceId,
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

async function saveBridgeSettings(patch) {
  const stored = await chrome.storage.local.get(['mossBridge']);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.mossBridge || {}), ...patch };
  await chrome.storage.local.set({ mossBridge: settings });
  return settings;
}

function offscreenUrl() {
  return chrome.runtime.getURL(OFFSCREEN_PATH);
}

async function ensureOffscreen() {
  if (typeof chrome.offscreen === 'undefined') return false;
  const url = offscreenUrl();
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (contexts.length > 0) return true;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return true;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS'],
      justification: 'Keep the MOSS bridge WebSocket alive independently of the service worker',
    })
    .catch(() => {
      // 并发创建时可能已有文档存在，交由 getContexts 兜底
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
  const after = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  return after.length > 0;
}

/** 向 offscreen 文档发送消息（必要时先创建） */
async function sendToOffscreen(message) {
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
  } catch {
    // offscreen 正在重建或扩展正在 reload
  }
}

function forwardEvent(event, payload) {
  void sendToOffscreen({ type: 'event', event, ...payload });
}

// ============================================================================
// 命令执行
// ============================================================================

async function dispatch(method, params) {
  switch (method) {
    case 'system.info': {
      const cfg = await getBridgeConfig();
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        instanceId: cfg.instanceId,
        browser: parseBrowserInfo(),
      };
    }
    case 'windows.getLastFocused':
      return chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    case 'windows.ensureMoss':
      return ensureMossWindow(params);
    case 'tabs.create':
      return createTab(params);
    case 'tabs.get':
      return getTab(Number(params.tabId));
    case 'tabs.list':
      return listTabs();
    case 'tabs.activate':
      return activateTab(Number(params.tabId));
    case 'tabs.close':
      return closeTab(Number(params.tabId));
    case 'groups.query':
      return chrome.tabGroups.query({
        ...(typeof params.title === 'string' && params.title ? { title: params.title } : {}),
        ...(typeof params.windowId === 'number' ? { windowId: params.windowId } : {}),
      });
    case 'groups.ensure':
      return ensureGroup(params);
    case 'groups.update':
      return updateGroup(params);
    case 'debugger.attach':
      return attachDebugger(Number(params.tabId));
    case 'debugger.detach':
      return detachDebugger(Number(params.tabId));
    case 'debugger.send':
      return sendCdp(Number(params.tabId), String(params.method), params.params);
    case 'extension.reload':
      setTimeout(() => {
        try {
          chrome.runtime.reload();
        } catch {
          // ignore
        }
      }, 100);
      return { reloading: true };
    default:
      throw new Error(`Unknown command: ${method}`);
  }
}

async function createTab(params) {
  const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
  const active = params.active !== false;
  let windowId;
  if (typeof params.windowId === 'number') {
    windowId = params.windowId;
  } else {
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      windowId = win && typeof win.id === 'number' ? win.id : undefined;
    } catch {
      windowId = undefined;
    }
  }
  const tab = await chrome.tabs.create({ url, active, ...(windowId !== undefined ? { windowId } : {}) });
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || url,
    title: tab.title || '',
    active: tab.active === true,
  };
}

/**
 * 确保存在 MOSS 专属窗口：优先复用已有「MOSS」分组所在窗口；
 * 没有分组时新建后台窗口（focused:false），并把首个标签归入「MOSS」分组。
 * tabs.create 的 active 只影响窗口内活动标签，不影响窗口焦点。
 */
async function ensureMossWindow(params) {
  const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
  const title = typeof params.title === 'string' && params.title.trim() ? params.title.trim() : 'MOSS';
  const color = GROUP_COLORS.has(params.color) ? params.color : 'blue';
  const legacyTitles = Array.isArray(params.legacyTitles)
    ? params.legacyTitles.filter((value) => typeof value === 'string' && value.trim())
    : [];
  const active = params.active !== false;

  const groups = await chrome.tabGroups.query({ title });
  for (const legacyTitle of legacyTitles) {
    if (legacyTitle === title) continue;
    const legacy = await chrome.tabGroups.query({ title: legacyTitle });
    for (const group of legacy) {
      await chrome.tabGroups.update(group.id, { title, color });
      groups.push({ ...group, title, color });
    }
  }

  const existing = groups.find((group) => typeof group.windowId === 'number');
  if (existing) {
    const tab = await chrome.tabs.create({ url, active, windowId: existing.windowId });
    await chrome.tabs.group({ groupId: existing.id, tabIds: [tab.id] });
    if (existing.color !== color) {
      await chrome.tabGroups.update(existing.id, { color });
    }
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      groupId: existing.id,
      createdWindow: false,
    };
  }

  // focused:false 是核心：新窗口开在后台，不激活、不置顶，不抢用户当前焦点
  const win = await chrome.windows.create({ url, focused: false, type: 'normal' });
  const first = win.tabs && win.tabs[0];
  if (!first || typeof first.id !== 'number') throw new Error('新建窗口未返回标签页');
  const groupId = await chrome.tabs.group({ tabIds: [first.id] });
  await chrome.tabGroups.update(groupId, { title, color });
  return {
    tabId: first.id,
    windowId: win.id,
    groupId,
    createdWindow: true,
  };
}

async function getTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    url: tab.url || '',
    title: tab.title || '',
    active: tab.active === true,
    status: tab.status || '',
    pinned: tab.pinned === true,
  };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    tabId: tab.id,
    windowId: tab.windowId,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    url: tab.url || '',
    title: tab.title || '',
    active: tab.active === true,
    status: tab.status || '',
    pinned: tab.pinned === true,
  }));
}

async function activateTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (typeof tab.windowId === 'number') {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return { tabId, windowId: tab.windowId };
}

async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  attachedTabs.delete(tabId);
  return { tabId, closed: true };
}

const GROUP_COLORS = new Set([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

async function ensureGroup(params) {
  const tabId = Number(params.tabId);
  const title = typeof params.title === 'string' && params.title.trim() ? params.title.trim() : 'MOSS';
  const color = GROUP_COLORS.has(params.color) ? params.color : 'blue';
  const legacyTitles = Array.isArray(params.legacyTitles)
    ? params.legacyTitles.filter((value) => typeof value === 'string' && value.trim())
    : [];
  const tab = await chrome.tabs.get(tabId);
  let existing = (await chrome.tabGroups.query({ title, windowId: tab.windowId }))[0];
  if (!existing && legacyTitles.length > 0) {
    for (const legacyTitle of legacyTitles) {
      const legacy = (await chrome.tabGroups.query({ title: legacyTitle, windowId: tab.windowId }))[0];
      if (legacy) {
        await chrome.tabGroups.update(legacy.id, { title, color });
        existing = legacy;
        break;
      }
    }
  }
  if (existing) {
    await chrome.tabs.group({ groupId: existing.id, tabIds: [tabId] });
    if (existing.color !== color) {
      await chrome.tabGroups.update(existing.id, { color });
    }
    return { groupId: existing.id, created: false };
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title, color });
  return { groupId, created: true };
}

async function updateGroup(params) {
  const groupId = Number(params.groupId);
  const patch = {};
  if (typeof params.title === 'string' && params.title.trim()) patch.title = params.title.trim();
  if (GROUP_COLORS.has(params.color)) patch.color = params.color;
  if (typeof params.collapsed === 'boolean') patch.collapsed = params.collapsed;
  await chrome.tabGroups.update(groupId, patch);
  return { groupId, updated: true };
}

async function attachDebugger(tabId) {
  if (!Number.isFinite(tabId)) throw new Error('tabId is required');
  if (attachedTabs.has(tabId)) return { tabId, attached: true };
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
    return { tabId, attached: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already attached/i.test(message)) {
      attachedTabs.add(tabId);
      return { tabId, attached: true };
    }
    throw new Error(`无法附加调试器：${message}`);
  }
}

async function detachDebugger(tabId) {
  if (!Number.isFinite(tabId)) throw new Error('tabId is required');
  if (!attachedTabs.has(tabId)) return { tabId, detached: true };
  try {
    await chrome.debugger.detach({ tabId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/not attached/i.test(message)) throw new Error(message);
  }
  attachedTabs.delete(tabId);
  return { tabId, detached: true };
}

async function sendCdp(tabId, method, params) {
  if (!Number.isFinite(tabId)) throw new Error('tabId is required');
  if (typeof method !== 'string' || !method) throw new Error('CDP method is required');
  if (!attachedTabs.has(tabId)) {
    await attachDebugger(tabId);
  }
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params || {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not attached/i.test(message)) {
      attachedTabs.delete(tabId);
      await attachDebugger(tabId);
      return chrome.debugger.sendCommand({ tabId }, method, params || {});
    }
    throw new Error(`${method} 失败：${message}`);
  }
}

// ============================================================================
// 事件转发（debugger / tabs）
// ============================================================================

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || typeof source.tabId !== 'number') return;
  forwardEvent('debugger', { tabId: source.tabId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source || typeof source.tabId !== 'number') return;
  attachedTabs.delete(source.tabId);
  forwardEvent('debugger.detached', { tabId: source.tabId, reason });
});

function tabPayload(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    openerTabId: typeof tab.openerTabId === 'number' ? tab.openerTabId : undefined,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    url: tab.url || '',
    title: tab.title || '',
    active: tab.active === true,
    status: tab.status || '',
    pinned: tab.pinned === true,
  };
}

chrome.tabs.onCreated.addListener((tab) => {
  forwardEvent('tab.created', { tab: tabPayload(tab) });
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  attachedTabs.delete(tabId);
  forwardEvent('tab.removed', { tabId, windowId: info.windowId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' && !changeInfo.url && !changeInfo.title) return;
  forwardEvent('tab.updated', { tab: tabPayload(tab) });
});

// ============================================================================
// 消息：offscreen / popup
// ============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.target === 'sw') {
    if (message.type === 'bridge:getConfig') {
      getBridgeConfig()
        .then((cfg) => sendResponse({ ok: true, config: cfg }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (message.type === 'bridge:status') {
      cachedBridgeStatus = { ...cachedBridgeStatus, ...(message.status || {}) };
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'cmd') {
      dispatch(message.method, message.params || {})
        .then((result) => sendResponse({ ok: true, result: result === undefined ? null : result }))
        .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }
    if (message.type === 'sw:ping') {
      sendResponse({ ok: true, ts: Date.now() });
      return false;
    }
    return false;
  }

  if (message.type === 'moss:getStatus') {
    void (async () => {
      let status = cachedBridgeStatus;
      try {
        await ensureOffscreen();
        const reply = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'status:get' });
        if (reply && reply.ok && reply.status) status = { ...status, ...reply.status };
      } catch {
        // 使用缓存
      }
      sendResponse({
        ...status,
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
      });
    })();
    return true;
  }

  if (message.type === 'moss:saveSettings') {
    const patch = {};
    if (message.port !== undefined) patch.port = Number(message.port) || DEFAULT_SETTINGS.port;
    if (message.token !== undefined) patch.token = String(message.token || '');
    if (message.autoConnect !== undefined) patch.autoConnect = Boolean(message.autoConnect);
    saveBridgeSettings(patch)
      .then(async (settings) => {
        await sendToOffscreen({ type: 'config:changed', config: settings });
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === 'moss:reconnect') {
    sendToOffscreen({ type: 'bridge:reconnect' })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === 'moss:disconnect') {
    sendToOffscreen({ type: 'bridge:disconnect' })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});

chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen();
});
chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen();
});

void ensureOffscreen();
