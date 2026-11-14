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
/** MV3 offscreen 文档被回收后无人重建：用 alarms 周期唤醒 SW 并确保它存在 */
const KEEPALIVE_ALARM = 'moss-bridge-keepalive';

/** 创建/刷新保活闹钟（periodInMinutes 最小 1 分钟；重复 create 会覆盖为同一周期） */
function ensureKeepAliveAlarm() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  } catch {
    // alarms 不可用（旧浏览器）：忽略，仍有 sendToOffscreen 按需创建兜底
  }
}

let cachedBridgeStatus = {
  connected: false,
  port: null,
  configuredPort: DEFAULT_SETTINGS.port,
  tokenConfigured: false,
  autoConnect: true,
};
/** 已 attach debugger 的标签页（内存缓存；真实状态以 chrome.debugger.getTargets 为准） */
const attachedTabs = new Set();
let creatingOffscreen = null;

/**
 * MOSS 专属窗口登记表：windowId → 分组基名。
 * 只有登记过的窗口才允许复用/自动激活；用户窗口即使存在同名「MOSS」分组也绝不触碰。
 * 存本地存储（浏览器重启后窗口 id 可能失效，加载时会用「窗口内是否只有 MOSS 分组标签」重新校验）。
 */
const MOSS_WINDOWS_KEY = 'mossWindows';
let mossWindows = null;
let loadingMossWindows = null;

/** 判断分组标题是否属于某个 MOSS 会话分组（MOSS、MOSS-0、MOSS-1…） */
function isMossGroupTitle(title, base) {
  if (typeof title !== 'string' || !title || typeof base !== 'string' || !base) return false;
  if (title === base) return true;
  return title.startsWith(`${base}-`) && /^\d+$/.test(title.slice(base.length + 1));
}

/**
 * 校验窗口是否仍是 MOSS 专属窗口：
 * 有标签、无固定标签，且每个标签都属于该基名的 MOSS 分组。
 * 用户把个人标签拖进 MOSS 窗口后校验失败，下次会另建后台窗口，避免误激活用户标签。
 */
async function isDedicatedMossWindow(windowId, base) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    if (tabs.length === 0 || tabs.some((tab) => tab.pinned === true)) return false;
    const groups = await chrome.tabGroups.query({ windowId });
    const groupIds = new Set(
      groups.filter((group) => isMossGroupTitle(group.title, base)).map((group) => group.id),
    );
    if (groupIds.size === 0) return false;
    return tabs.every(
      (tab) => typeof tab.groupId === 'number' && tab.groupId >= 0 && groupIds.has(tab.groupId),
    );
  } catch {
    return false;
  }
}

async function persistMossWindows() {
  try {
    const list = Array.from((mossWindows ?? new Map()).entries()).map(([windowId, baseTitle]) => ({
      windowId,
      baseTitle,
    }));
    await chrome.storage.local.set({ [MOSS_WINDOWS_KEY]: list });
  } catch {
    // 存储不可用：仅保留内存态
  }
}

/** 加载并校验登记表（Service Worker 重启后从存储恢复） */
async function loadMossWindows() {
  if (mossWindows) return mossWindows;
  if (loadingMossWindows) return loadingMossWindows;
  loadingMossWindows = (async () => {
    let records = [];
    try {
      const stored = await chrome.storage.local.get(MOSS_WINDOWS_KEY);
      records = Array.isArray(stored[MOSS_WINDOWS_KEY]) ? stored[MOSS_WINDOWS_KEY] : [];
    } catch {
      records = [];
    }
    const valid = new Map();
    for (const record of records) {
      if (!record || typeof record.windowId !== 'number' || typeof record.baseTitle !== 'string') continue;
      if (await isDedicatedMossWindow(record.windowId, record.baseTitle)) {
        valid.set(record.windowId, record.baseTitle);
      }
    }
    mossWindows = valid;
    if (valid.size !== records.length) void persistMossWindows();
    return mossWindows;
  })().finally(() => {
    loadingMossWindows = null;
  });
  return loadingMossWindows;
}

async function rememberMossWindow(windowId, baseTitle) {
  if (typeof windowId !== 'number' || typeof baseTitle !== 'string' || !baseTitle) return;
  const owned = await loadMossWindows();
  owned.set(windowId, baseTitle);
  await persistMossWindows();
}

async function forgetMossWindow(windowId) {
  const owned = await loadMossWindows();
  if (!owned.delete(windowId)) return;
  await persistMossWindows();
}

chrome.windows.onRemoved.addListener((windowId) => {
  void forgetMossWindow(windowId);
});

void restoreAttachedTabs();

async function restoreAttachedTabs() {
  try {
    const stored = await chrome.storage.session.get('mossAttachedTabs');
    const list = Array.isArray(stored.mossAttachedTabs) ? stored.mossAttachedTabs : [];
    for (const id of list) {
      if (typeof id === 'number' && Number.isFinite(id)) attachedTabs.add(id);
    }
  } catch {
    // storage.session 不可用：忽略
  }
}

async function persistAttachedTabs() {
  try {
    await chrome.storage.session.set({ mossAttachedTabs: Array.from(attachedTabs) });
  } catch {
    // 忽略
  }
}

/** 真实附着状态：MV3 Service Worker 重启后内存集合会丢失，必须向浏览器查询 */
async function isDebuggerAttached(tabId) {
  try {
    const targets = await chrome.debugger.getTargets();
    const hit = targets.find((target) => target.tabId === tabId);
    return !!(hit && hit.attached);
  } catch {
    return false;
  }
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
      return activateTab(Number(params.tabId), params);
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
    case 'debugger.autoAttach':
      return autoAttachFrames(Number(params.tabId));
    case 'debugger.send':
      return sendCdp(
        Number(params.tabId),
        String(params.method),
        params.params,
        typeof params.sessionId === 'string' && params.sessionId ? params.sessionId : undefined,
      );
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
  // focus=false：后台建页，不激活标签/不前置窗口（避免闪屏）
  const active = params.focus !== undefined ? params.focus !== false : params.active !== false;
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
 * 确保存在 MOSS 专属窗口：只在登记过的 MOSS 窗口内复用分组/建页；
 * 用户窗口里的同名分组绝不复用，避免把 AI 标签页建到用户窗口并抢活动标签。
 * 建页一律 active:false：marker 加载完成前不切换标签，页面就绪后由后端显式激活。
 */
async function ensureMossWindow(params) {
  const markerUrl = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
  // 新窗口首个标签页必然 active：有目标网址时直接用它建窗，避免短暂显示 /blank#moss-...
  const initialUrl =
    typeof params.initialUrl === 'string' && /^https?:\/\//i.test(params.initialUrl)
      ? params.initialUrl
      : '';
  const title = typeof params.title === 'string' && params.title.trim() ? params.title.trim() : 'MOSS';
  // 窗口归属按「分组基名」判定（MOSS / MOSS-N 都属于同一个 MOSS 窗口），不能用会话分组名本身
  const baseTitle =
    typeof params.baseTitle === 'string' && params.baseTitle.trim()
      ? params.baseTitle.trim()
      : title;
  const color = GROUP_COLORS.has(params.color) ? params.color : 'blue';
  const legacyTitles = Array.isArray(params.legacyTitles)
    ? params.legacyTitles.filter((value) => typeof value === 'string' && value.trim())
    : [];
  const windowIdParam =
    typeof params.windowId === 'number' && Number.isFinite(params.windowId)
      ? params.windowId
      : undefined;
  const isolateWindow = params.isolateWindow !== false;

  // 兼容模式：在当前窗口建页 + 分组；不登记为 MOSS 窗口，也不会被自动激活
  if (!isolateWindow) {
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (win && typeof win.id === 'number') {
        const tab = await chrome.tabs.create({ url: markerUrl, active: false, windowId: win.id });
        const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
        await chrome.tabGroups.update(groupId, { title, color });
        return {
          tabId: tab.id,
          windowId: tab.windowId,
          groupId,
          createdWindow: false,
          createdWithUrl: false,
          windowOwned: false,
        };
      }
    } catch {
      // 回退到新建后台窗口
    }
  }

  // 只认登记表中仍存在的 MOSS 窗口；旧 windowId 不可信（可能已被用户窗口复用）
  const owned = await loadMossWindows();
  let normalWindows = [];
  try {
    normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  } catch {
    normalWindows = [];
  }
  const existingWindowIds = new Set(
    normalWindows.map((win) => win.id).filter((id) => typeof id === 'number'),
  );
  const staleWindowIds = Array.from(owned.keys()).filter((id) => !existingWindowIds.has(id));
  for (const id of staleWindowIds) owned.delete(id);
  if (staleWindowIds.length > 0) void persistMossWindows();
  let ownedWindowIds = new Set(owned.keys());
  // 升级/存储丢失后的兜底：扫描现存的「只含 MOSS 分组标签」窗口并接管，避免重复开窗
  if (ownedWindowIds.size === 0) {
    for (const win of normalWindows) {
      if (typeof win.id !== 'number') continue;
      if (await isDedicatedMossWindow(win.id, baseTitle)) {
        owned.set(win.id, baseTitle);
      }
    }
    if (owned.size > 0) {
      await persistMossWindows();
      ownedWindowIds = new Set(owned.keys());
    }
  }
  const preferredWindowId =
    typeof windowIdParam === 'number' && ownedWindowIds.has(windowIdParam)
      ? windowIdParam
      : undefined;

  const groups = await chrome.tabGroups.query({ title });
  for (const legacyTitle of legacyTitles) {
    if (legacyTitle === title) continue;
    const legacy = await chrome.tabGroups.query({ title: legacyTitle });
    for (const group of legacy) {
      // 只迁移 MOSS 窗口里的旧分组，绝不改用户窗口的分组
      if (!ownedWindowIds.has(group.windowId)) continue;
      await chrome.tabGroups.update(group.id, { title, color });
      groups.push({ ...group, title, color });
    }
  }

  const existing =
    groups.find(
      (group) =>
        typeof group.windowId === 'number' &&
        ownedWindowIds.has(group.windowId) &&
        (preferredWindowId === undefined || group.windowId === preferredWindowId),
    ) ??
    groups.find(
      (group) => typeof group.windowId === 'number' && ownedWindowIds.has(group.windowId),
    );
  if (existing) {
    const tab = await chrome.tabs.create({
      url: markerUrl,
      active: false,
      windowId: existing.windowId,
    });
    await chrome.tabs.group({ groupId: existing.id, tabIds: [tab.id] });
    if (existing.color !== color) {
      await chrome.tabGroups.update(existing.id, { color });
    }
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      groupId: existing.id,
      createdWindow: false,
      createdWithUrl: false,
      windowOwned: true,
    };
  }

  // 已有 MOSS 窗口但没有目标分组：在该窗口内建页 + 新建分组（不新建窗口）
  const targetWindowId = preferredWindowId ?? Array.from(ownedWindowIds)[0];
  if (targetWindowId !== undefined) {
    const tab = await chrome.tabs.create({
      url: markerUrl,
      active: false,
      windowId: targetWindowId,
    });
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title, color });
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      groupId,
      createdWindow: false,
      createdWithUrl: false,
      windowOwned: true,
    };
  }

  // 没有任何 MOSS 窗口：新开后台窗口（focused:false），登记后供后续复用
  const createWindow = (url) => chrome.windows.create({ url, focused: false, type: 'normal' });
  let createdWithUrl = Boolean(initialUrl);
  let win;
  try {
    win = await createWindow(initialUrl || markerUrl);
  } catch (err) {
    if (!initialUrl) throw err;
    // 目标网址建窗失败（非法 URL 等）：回退 marker，由后端导航重试
    createdWithUrl = false;
    win = await createWindow(markerUrl);
  }
  const first = win.tabs && win.tabs[0];
  if (!first || typeof first.id !== 'number') throw new Error('新建窗口未返回标签页');
  const groupId = await chrome.tabs.group({ tabIds: [first.id] });
  await chrome.tabGroups.update(groupId, { title, color });
  if (typeof win.id === 'number') {
    await rememberMossWindow(win.id, baseTitle);
  }
  return {
    tabId: first.id,
    windowId: win.id,
    groupId,
    createdWindow: true,
    createdWithUrl,
    windowOwned: true,
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

/**
 * 组内焦点：只有目标标签与当前活动标签属于同一个「本会话 MOSS 分组」时才切换。
 * - 未分组 / 被用户拖到其它分组 → skipped
 * - 当前活动标签不在同组（用户正在用其它分组或未分组标签）→ skipped
 * - 永不调用 windows.update({focused:true})：不抬窗口、不抢用户焦点
 */
async function activateTab(tabId, params) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab) throw new Error(`标签页不存在：${tabId}`);
  const skipped = (reason) => ({
    tabId,
    windowId: tab.windowId,
    focused: false,
    activated: false,
    noop: true,
    skipped: true,
    reason,
  });
  const groupTitle = params && typeof params.groupTitle === 'string' ? params.groupTitle.trim() : '';
  if (typeof tab.groupId !== 'number' || tab.groupId < 0) {
    return skipped('目标标签页未分组');
  }
  if (!groupTitle) return skipped('目标标签页缺少所属分组信息');
  let group;
  try {
    group = await chrome.tabGroups.get(tab.groupId);
  } catch {
    return skipped('无法读取目标标签页所在分组');
  }
  if (!group || group.title !== groupTitle) {
    return skipped('目标标签页不在本会话的 MOSS 分组内');
  }
  if (tab.active === true) {
    return { tabId, windowId: tab.windowId, focused: false, activated: false, noop: true };
  }
  let activeTab;
  try {
    [activeTab] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
  } catch {
    activeTab = undefined;
  }
  if (!activeTab) return skipped('未找到窗口的活动标签页');
  if (activeTab.id === tab.id) {
    return { tabId, windowId: tab.windowId, focused: false, activated: false, noop: true };
  }
  if (activeTab.groupId !== tab.groupId) {
    return skipped('当前活动标签不在同一分组，保持用户手动焦点');
  }
  const updated = await chrome.tabs.update(tabId, { active: true });
  return {
    tabId,
    windowId: updated.windowId,
    focused: false,
    activated: true,
    noop: false,
  };
}

async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  attachedTabs.delete(tabId);
  void persistAttachedTabs();
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
  // 以浏览器真实状态为准：避免 SW 重启后重复 attach 导致调试提示条反复出现/页面闪白
  if (await isDebuggerAttached(tabId)) {
    attachedTabs.add(tabId);
    void persistAttachedTabs();
    return { tabId, attached: true };
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
    void persistAttachedTabs();
    return { tabId, attached: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already attached/i.test(message)) {
      attachedTabs.add(tabId);
      void persistAttachedTabs();
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
  void persistAttachedTabs();
  return { tabId, detached: true };
}

async function sendCdp(tabId, method, params, sessionId) {
  if (!Number.isFinite(tabId)) throw new Error('tabId is required');
  if (typeof method !== 'string' || !method) throw new Error('CDP method is required');
  // 热路径只查内存集合；集合缺失时再向浏览器确认真实附着状态（SW 重启后）
  if (!attachedTabs.has(tabId)) {
    if (await isDebuggerAttached(tabId)) {
      attachedTabs.add(tabId);
      void persistAttachedTabs();
    } else {
      await attachDebugger(tabId);
    }
  }
  // 子会话（跨域 iframe / OOPIF）：chrome.debugger 目标支持 { tabId, sessionId }
  const target = sessionId ? { tabId, sessionId } : { tabId };
  try {
    return await chrome.debugger.sendCommand(target, method, params || {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not attached/i.test(message)) {
      attachedTabs.delete(tabId);
      void persistAttachedTabs();
      await attachDebugger(tabId);
      return chrome.debugger.sendCommand(target, method, params || {});
    }
    throw new Error(`${method} 失败：${message}`);
  }
}

/**
 * 自动附着跨域 iframe 子目标（OOPIF）。
 * chrome.debugger 自 Chrome 125 起支持 sessionId；子会话命令走 sendCdp 的 sessionId 参数。
 * 单个 target 失败不阻断其余 frame。
 */
async function autoAttachFrames(tabId) {
  if (!Number.isFinite(tabId)) throw new Error('tabId is required');
  if (!attachedTabs.has(tabId)) {
    await attachDebugger(tabId);
  }
  const frames = [];
  let autoAttachError = '';
  try {
    await sendCdp(tabId, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch (err) {
    autoAttachError = err instanceof Error ? err.message : String(err);
  }
  let targets = [];
  try {
    const result = await sendCdp(tabId, 'Target.getTargets', {});
    targets = Array.isArray(result && result.targetInfos) ? result.targetInfos : [];
  } catch (err) {
    autoAttachError = autoAttachError || (err instanceof Error ? err.message : String(err));
  }
  for (const info of targets) {
    if (!info || info.type !== 'iframe' || typeof info.targetId !== 'string') continue;
    try {
      const attached = await sendCdp(tabId, 'Target.attachToTarget', {
        targetId: info.targetId,
        flatten: true,
      });
      frames.push({
        targetId: info.targetId,
        sessionId: attached && typeof attached.sessionId === 'string' ? attached.sessionId : '',
        url: typeof info.url === 'string' ? info.url : '',
        title: typeof info.title === 'string' ? info.title : '',
      });
    } catch (err) {
      frames.push({
        targetId: info.targetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    tabId,
    attached: true,
    frames,
    ...(autoAttachError ? { autoAttachError } : {}),
  };
}

// ============================================================================
// 事件转发（debugger / tabs）
// ============================================================================

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || typeof source.tabId !== 'number') return;
  // source.sessionId：子会话（OOPIF）事件；父会话为 undefined
  forwardEvent('debugger', {
    tabId: source.tabId,
    ...(typeof source.sessionId === 'string' && source.sessionId ? { sessionId: source.sessionId } : {}),
    method,
    params,
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source || typeof source.tabId !== 'number') return;
  attachedTabs.delete(source.tabId);
  void persistAttachedTabs();
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

// 手动切换标签不会触发 tabs.onUpdated：单独同步 active 状态，避免 MOSS 用过期焦点做判断
chrome.tabs.onActivated.addListener((info) => {
  if (!info || typeof info.tabId !== 'number') return;
  chrome.tabs
    .get(info.tabId)
    .then((tab) => forwardEvent('tab.updated', { tab: tabPayload(tab) }))
    .catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  attachedTabs.delete(tabId);
  void persistAttachedTabs();
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
  ensureKeepAliveAlarm();
  void ensureOffscreen();
});
chrome.runtime.onInstalled.addListener(() => {
  ensureKeepAliveAlarm();
  void ensureOffscreen();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // offscreen 文档持有 WebSocket；被浏览器回收后靠这里重建并触发自动重连
  void ensureOffscreen();
});

ensureKeepAliveAlarm();
void ensureOffscreen();
