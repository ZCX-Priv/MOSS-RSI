// src/modules/browser/paths.ts
// 浏览器模块的目录布局、扩展播种、Chrome 可执行文件探测、Chrome for Testing 下载与截图文件管理。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  Browser as PuppeteerBrowser,
  BrowserTag,
  detectBrowserPlatform,
  install as installBrowser,
  resolveBuildId,
  type InstalledBrowser,
} from '@puppeteer/browsers';
import type { Environment } from '../../core/types';
import type { BrowserCftStatus, BrowserExtensionStatus } from './types';

/** 截图保留策略 */
const SCREENSHOT_RETAIN_DAYS = 7;
const SCREENSHOT_MAX_FILES = 300;

export interface BrowserDirs {
  root: string;
  /** 播种后的扩展目录（外部浏览器加载此目录；内置 Chrome 也加载它） */
  extension: string;
  /** 内置 Chrome 专用 user-data-dir */
  profile: string;
  screenshots: string;
  /** Chrome for Testing 下载缓存 */
  cft: string;
}

export interface CftMarker {
  buildId: string;
  executable: string;
  installedAt: number;
}

export interface ChromeExecutable {
  executable: string;
  source: 'config' | 'local' | 'chrome-for-testing';
}

/** 自动安装器使用的 Chromium 浏览器描述 */
export interface InstalledBrowserInfo {
  id: string;
  name: string;
  executable: string;
  imageName: string;
  extensionsUrl: string;
  /** 用户数据目录（读取扩展是否真实安装；未知浏览器为 null） */
  userDataDir: string | null;
  /** Opera 等浏览器的 profile 直接位于 userDataDir 根目录 */
  flatProfile?: boolean;
}

/** 浏览器 profile 中 MOSS 扩展的真实安装状态 */
export interface ExtensionPresence {
  installed: boolean;
  enabled: boolean;
  version: string | null;
  extensionId: string | null;
  profile: string | null;
}

export function getBrowserDirs(env: Environment): BrowserDirs {
  const root = join(env.dataDir, 'browser');
  return {
    root,
    extension: join(root, 'extension'),
    profile: join(root, 'profile'),
    screenshots: join(root, 'screenshots'),
    cft: join(root, 'chrome-for-testing'),
  };
}

export function ensureBrowserDirs(dirs: BrowserDirs): void {
  mkdirSync(dirs.root, { recursive: true });
  mkdirSync(dirs.screenshots, { recursive: true });
  mkdirSync(dirs.cft, { recursive: true });
}

/** 包内扩展源目录：开发态在仓库根，安装态在 dist/ */
export function resolveExtensionSource(env: Environment): string | null {
  const candidates = [
    join(env.packageRoot, 'browser-extension'),
    join(env.packageRoot, 'dist', 'browser-extension'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'manifest.json'))) return dir;
  }
  return null;
}

function readManifestVersion(dir: string): string | null {
  try {
    const raw = readFileSync(join(dir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** 扩展目录内容指纹：manifest 版本 + 全部文件内容哈希（开发期改动也能播种） */
function computeExtensionHash(dir: string): string | null {
  const hash = createHash('sha256');
  const files: string[] = [];
  const walk = (root: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(root).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(root, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      try {
        if (statSync(full).isDirectory()) {
          walk(full, rel);
        } else if (statSync(full).isFile()) {
          files.push(rel);
        }
      } catch {
        // ignore
      }
    }
  };
  walk(dir, '');
  if (files.length === 0) return null;
  for (const rel of files) {
    hash.update(rel);
    hash.update(readFileSync(join(dir, rel)));
  }
  return hash.digest('hex');
}

/**
 * 把包内扩展播种到 ~/.moss/browser/extension。
 * 内容指纹变化（版本升级或开发期改动）时覆盖；相同则保留。
 */
export function seedExtension(env: Environment, dirs: BrowserDirs): BrowserExtensionStatus {
  const source = resolveExtensionSource(env);
  if (!source) {
    return { dir: dirs.extension, version: null, seeded: false };
  }
  const sourceVersion = readManifestVersion(source);
  const sourceHash = computeExtensionHash(source);
  const seededHashFile = join(dirs.extension, '.moss-seed.json');
  let targetHash: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(seededHashFile, 'utf8')) as { hash?: unknown };
    if (typeof raw.hash === 'string') targetHash = raw.hash;
  } catch {
    targetHash = null;
  }
  if (!existsSync(join(dirs.extension, 'manifest.json')) || !sourceHash || sourceHash !== targetHash) {
    rmSync(dirs.extension, { recursive: true, force: true });
    mkdirSync(dirs.extension, { recursive: true });
    copyDirectory(source, dirs.extension);
    writeFileSync(seededHashFile, JSON.stringify({ hash: sourceHash, version: sourceVersion }, null, 2), 'utf8');
  }
  return { dir: dirs.extension, version: sourceVersion, seeded: true };
}

function copyDirectory(source: string, target: string): void {
  let entries: string[];
  try {
    entries = readdirSync(source);
  } catch {
    return;
  }
  for (const entry of entries) {
    const from = join(source, entry);
    const to = join(target, entry);
    const st = statSync(from);
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyDirectory(from, to);
    } else if (st.isFile()) {
      writeFileSync(to, readFileSync(from));
    }
  }
}

/** 在系统文件管理器中打开目录 */
export function openDirectory(env: Environment, dir: string): boolean {
  try {
    if (env.isWindows) {
      Bun.spawn(['explorer.exe', dir], { stdout: 'ignore', stderr: 'ignore' });
    } else if (env.isMac) {
      Bun.spawn(['open', dir], { stdout: 'ignore', stderr: 'ignore' });
    } else {
      Bun.spawn(['xdg-open', dir], { stdout: 'ignore', stderr: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

/** Chrome / Chromium / Edge 本机安装路径候选（按优先级） */
function localBrowserCandidates(env: Environment): string[] {
  const out: string[] = [];
  if (env.isWindows) {
    const local = process.env.LOCALAPPDATA;
    const pf = process.env.ProgramFiles;
    const pf86 = process.env['ProgramFiles(x86)'];
    if (local) {
      out.push(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      out.push(join(local, 'Chromium', 'Application', 'chrome.exe'));
      out.push(join(local, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'));
    }
    if (pf) out.push(join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (pf86) {
      out.push(join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      out.push(join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (pf) out.push(join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (env.isMac) {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    out.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    out.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    out.push('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary');
  } else {
    out.push('/usr/bin/google-chrome');
    out.push('/usr/bin/google-chrome-stable');
    out.push('/usr/bin/chromium');
    out.push('/usr/bin/chromium-browser');
    out.push('/usr/bin/microsoft-edge');
    out.push('/snap/bin/chromium');
  }
  return out;
}

// ============================================================================
// Chromium 浏览器探测（已知安装路径 + 注册表登记）
// ============================================================================

interface BrowserFamily {
  id: string;
  name: string;
  imageName: string;
  extensionsUrl: string;
  candidates: string[];
  userDataDirs: string[];
  flatProfile?: boolean;
}

const BROWSER_DETECTION_TTL_MS = 60_000;
let browserDetectionCache: { at: number; browsers: InstalledBrowserInfo[] } | null = null;

/** 安装器 run() 前调用，强制下次探测重新扫描 */
export function clearBrowserDetectionCache(): void {
  browserDetectionCache = null;
}

function windowsBrowserFamilies(): BrowserFamily[] {
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  const roaming = process.env.APPDATA;

  const chromeCandidates = (folder: string): string[] => [
    ...(local ? [join(local, 'Google', folder, 'Application', 'chrome.exe')] : []),
    ...(pf ? [join(pf, 'Google', folder, 'Application', 'chrome.exe')] : []),
    ...(pf86 ? [join(pf86, 'Google', folder, 'Application', 'chrome.exe')] : []),
  ];
  const edgeCandidates = (folder: string): string[] => [
    ...(local ? [join(local, 'Microsoft', folder, 'Application', 'msedge.exe')] : []),
    ...(pf86 ? [join(pf86, 'Microsoft', folder, 'Application', 'msedge.exe')] : []),
    ...(pf ? [join(pf, 'Microsoft', folder, 'Application', 'msedge.exe')] : []),
  ];

  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      imageName: 'chrome.exe',
      extensionsUrl: 'chrome://extensions',
      candidates: chromeCandidates('Chrome'),
      userDataDirs: local ? [join(local, 'Google', 'Chrome', 'User Data')] : [],
    },
    {
      id: 'chrome-beta',
      name: 'Google Chrome Beta',
      imageName: 'chrome.exe',
      extensionsUrl: 'chrome://extensions',
      candidates: chromeCandidates('Chrome Beta'),
      userDataDirs: local ? [join(local, 'Google', 'Chrome Beta', 'User Data')] : [],
    },
    {
      id: 'chrome-dev',
      name: 'Google Chrome Dev',
      imageName: 'chrome.exe',
      extensionsUrl: 'chrome://extensions',
      candidates: chromeCandidates('Chrome Dev'),
      userDataDirs: local ? [join(local, 'Google', 'Chrome Dev', 'User Data')] : [],
    },
    {
      id: 'chrome-canary',
      name: 'Google Chrome Canary',
      imageName: 'chrome.exe',
      extensionsUrl: 'chrome://extensions',
      candidates: chromeCandidates('Chrome SxS'),
      userDataDirs: local ? [join(local, 'Google', 'Chrome SxS', 'User Data')] : [],
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      imageName: 'msedge.exe',
      extensionsUrl: 'edge://extensions',
      candidates: edgeCandidates('Edge'),
      userDataDirs: local ? [join(local, 'Microsoft', 'Edge', 'User Data')] : [],
    },
    {
      id: 'edge-beta',
      name: 'Microsoft Edge Beta',
      imageName: 'msedge.exe',
      extensionsUrl: 'edge://extensions',
      candidates: edgeCandidates('Edge Beta'),
      userDataDirs: local ? [join(local, 'Microsoft', 'Edge Beta', 'User Data')] : [],
    },
    {
      id: 'edge-dev',
      name: 'Microsoft Edge Dev',
      imageName: 'msedge.exe',
      extensionsUrl: 'edge://extensions',
      candidates: edgeCandidates('Edge Dev'),
      userDataDirs: local ? [join(local, 'Microsoft', 'Edge Dev', 'User Data')] : [],
    },
    {
      id: 'edge-canary',
      name: 'Microsoft Edge Canary',
      imageName: 'msedge.exe',
      extensionsUrl: 'edge://extensions',
      candidates: edgeCandidates('Edge SxS'),
      userDataDirs: local ? [join(local, 'Microsoft', 'Edge SxS', 'User Data')] : [],
    },
    {
      id: 'brave',
      name: 'Brave',
      imageName: 'brave.exe',
      extensionsUrl: 'brave://extensions',
      candidates: [
        ...(local ? [join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')] : []),
        ...(pf ? [join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')] : []),
        ...(pf86 ? [join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')] : []),
      ],
      userDataDirs: local ? [join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')] : [],
    },
    {
      id: 'chromium',
      name: 'Chromium',
      imageName: 'chromium.exe',
      extensionsUrl: 'chrome://extensions',
      candidates: [
        ...(local ? [join(local, 'Chromium', 'Application', 'chrome.exe')] : []),
        ...(pf ? [join(pf, 'Chromium', 'Application', 'chrome.exe')] : []),
      ],
      userDataDirs: local ? [join(local, 'Chromium', 'User Data')] : [],
    },
    {
      id: 'vivaldi',
      name: 'Vivaldi',
      imageName: 'vivaldi.exe',
      extensionsUrl: 'vivaldi://extensions',
      candidates: [
        ...(local ? [join(local, 'Vivaldi', 'Application', 'vivaldi.exe')] : []),
        ...(pf ? [join(pf, 'Vivaldi', 'Application', 'vivaldi.exe')] : []),
      ],
      userDataDirs: local ? [join(local, 'Vivaldi', 'User Data')] : [],
    },
    {
      id: 'opera',
      name: 'Opera',
      imageName: 'opera.exe',
      extensionsUrl: 'opera://extensions',
      candidates: [
        ...(local ? [join(local, 'Programs', 'Opera', 'opera.exe')] : []),
        ...(pf ? [join(pf, 'Opera', 'opera.exe')] : []),
        ...(pf86 ? [join(pf86, 'Opera', 'opera.exe')] : []),
      ],
      userDataDirs: roaming ? [join(roaming, 'Opera Software', 'Opera Stable')] : [],
      flatProfile: true,
    },
  ];
}

const CHROMIUM_IMAGE_NAMES = new Set([
  'chrome.exe',
  'msedge.exe',
  'brave.exe',
  'chromium.exe',
  'vivaldi.exe',
  'opera.exe',
  'opera_gx.exe',
  '360chrome.exe',
  '360se.exe',
  'qqbrowser.exe',
  'sogouexplorer.exe',
  'yandex.exe',
  'thorium.exe',
]);

const EXCLUDED_IMAGE_NAMES = new Set(['iexplore.exe', 'firefox.exe', 'msedgewebview2.exe']);

function isChromiumBrowser(imageName: string, executable: string): boolean {
  if (EXCLUDED_IMAGE_NAMES.has(imageName)) return false;
  if (CHROMIUM_IMAGE_NAMES.has(imageName)) return true;
  return /(chrome|chromium|edge|brave|opera|vivaldi|360|qqbrowser|sogou|yandex|thorium)/i.test(
    executable,
  );
}

interface RegistryBrowserEntry {
  key: string;
  command: string;
}

/** 枚举 StartMenuInternet 注册的浏览器（HKLM + HKCU） */
function scanRegistryBrowsers(): RegistryBrowserEntry[] {
  try {
    const script = [
      "$roots = @('HKLM:\\SOFTWARE\\Clients\\StartMenuInternet','HKCU:\\SOFTWARE\\Clients\\StartMenuInternet');",
      '$out = @();',
      'foreach ($root in $roots) {',
      '  if (Test-Path $root) {',
      '    Get-ChildItem $root | ForEach-Object {',
      "      $cmdKey = Join-Path $_.PSPath 'shell\\open\\command';",
      '      if (Test-Path $cmdKey) {',
      "        $cmd = (Get-ItemProperty $cmdKey -ErrorAction SilentlyContinue).'(default)';",
      '        if ($cmd) { $out += [pscustomobject]@{ key = $_.PSChildName; command = [string]$cmd } }',
      '      }',
      '    }',
      '  }',
      '}',
      'if ($out.Count -gt 0) { $out | ConvertTo-Json -Compress }',
    ].join('\n');
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const raw = output.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const entries: RegistryBrowserEntry[] = [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.command !== 'string') continue;
      entries.push({
        key: typeof record.key === 'string' ? record.key : '',
        command: record.command,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/** 从 "C:\path\chrome.exe" --foo 或 C:\path\chrome.exe --foo 中提取 exe */
function parseCommandExecutable(command: string): string | null {
  const quoted = /"([^"]+\.exe)"/i.exec(command);
  if (quoted) return quoted[1];
  const bare = /([A-Za-z]:\\[^\r\n]*?\.exe)/i.exec(command);
  if (bare) return bare[1].trim();
  return null;
}

function prettyBrowserName(key: string, imageName: string): string {
  const trimmed = key.trim().replace(/\.exe$/i, '');
  if (trimmed && !/^[0-9a-f]{20,}$/i.test(trimmed)) return trimmed;
  return imageName.replace(/\.exe$/i, '');
}

function browserFromRegistry(entry: RegistryBrowserEntry): InstalledBrowserInfo | null {
  const executable = parseCommandExecutable(entry.command);
  if (!executable || !existsSync(executable)) return null;
  const imageName = basename(executable).toLowerCase();
  if (!isChromiumBrowser(imageName, executable)) return null;
  const installRoot = dirname(dirname(executable));
  const guessedDataDir = join(installRoot, 'User Data');
  const flatProfile = imageName.startsWith('opera');
  return {
    id: `extra:${imageName}`,
    name: prettyBrowserName(entry.key, imageName),
    executable,
    imageName,
    extensionsUrl: imageName.startsWith('vivaldi')
      ? 'vivaldi://extensions'
      : flatProfile
        ? 'opera://extensions'
        : 'chrome://extensions',
    userDataDir: existsSync(guessedDataDir) ? guessedDataDir : null,
    ...(flatProfile ? { flatProfile: true } : {}),
  };
}

/**
 * 探测本机所有 Chromium 系浏览器（Windows；用于自动安装扩展）。
 * 已知安装路径 + StartMenuInternet 注册表，结果缓存 60 秒。
 */
export function detectInstalledBrowsers(env: Environment, force = false): InstalledBrowserInfo[] {
  if (!env.isWindows) return [];
  if (
    !force &&
    browserDetectionCache &&
    Date.now() - browserDetectionCache.at < BROWSER_DETECTION_TTL_MS
  ) {
    return browserDetectionCache.browsers;
  }

  const installed: InstalledBrowserInfo[] = [];
  const seen = new Set<string>();
  const add = (browser: InstalledBrowserInfo): void => {
    const key = browser.executable.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    installed.push(browser);
  };

  for (const family of windowsBrowserFamilies()) {
    const executable = family.candidates.find((candidate) => existsSync(candidate));
    if (!executable) continue;
    const userDataDir =
      family.userDataDirs.find((dir) => existsSync(dir)) ?? family.userDataDirs[0] ?? null;
    add({
      id: family.id,
      name: family.name,
      executable,
      imageName: family.imageName,
      extensionsUrl: family.extensionsUrl,
      userDataDir,
      ...(family.flatProfile ? { flatProfile: true } : {}),
    });
  }

  for (const entry of scanRegistryBrowsers()) {
    const browser = browserFromRegistry(entry);
    if (browser) add(browser);
  }

  browserDetectionCache = { at: Date.now(), browsers: installed };
  return installed;
}

// ============================================================================
// 扩展真实安装状态（读取浏览器 profile 的 Secure Preferences）
// ============================================================================

const presenceCache = new Map<
  string,
  { mtimeMs: number; size: number; result: ExtensionPresence }
>();

function normalizeBrowserPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function statFile(file: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(file);
    return { mtimeMs: Number(stat.mtimeMs), size: Number(stat.size) };
  } catch {
    return null;
  }
}

function listProfileDirs(root: string, flat: boolean): string[] {
  if (flat) return [root];
  const out: string[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'Default' || entry.name.startsWith('Profile ')) {
        out.push(join(root, entry.name));
      }
    }
  } catch {
    // 目录不可读时返回空
  }
  return out;
}

function readExtensionPresence(
  file: string,
  extensionDir: string,
  profileDir: string,
): ExtensionPresence {
  const missing: ExtensionPresence = {
    installed: false,
    enabled: false,
    version: null,
    extensionId: null,
    profile: null,
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return missing;
  }
  if (typeof raw !== 'object' || raw === null) return missing;
  const extensions = (raw as Record<string, unknown>).extensions;
  if (typeof extensions !== 'object' || extensions === null) return missing;
  const settings = (extensions as Record<string, unknown>).settings;
  if (typeof settings !== 'object' || settings === null) return missing;

  const wanted = normalizeBrowserPath(extensionDir);
  const version = readManifestVersion(extensionDir);
  for (const [extensionId, value] of Object.entries(settings as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.path !== 'string') continue;
    if (normalizeBrowserPath(record.path) !== wanted) continue;
    const disableReasons = Array.isArray(record.disable_reasons)
      ? record.disable_reasons
      : [];
    const worker = record.service_worker_registration_info;
    const workerVersion =
      typeof worker === 'object' && worker !== null &&
      typeof (worker as Record<string, unknown>).version === 'string'
        ? ((worker as Record<string, unknown>).version as string)
        : null;
    return {
      installed: true,
      enabled: disableReasons.length === 0 && record.state !== 0,
      version: version ?? workerVersion,
      extensionId,
      profile: basename(profileDir),
    };
  }
  return missing;
}

/**
 * 判断扩展是否真的安装在浏览器 profile 中。
 * 只看 `path` 指向播种目录的条目；结果按文件 mtime/size 缓存。
 */
export function findExtensionInBrowserProfiles(
  browser: InstalledBrowserInfo,
  extensionDir: string,
): ExtensionPresence {
  const missing: ExtensionPresence = {
    installed: false,
    enabled: false,
    version: null,
    extensionId: null,
    profile: null,
  };
  if (!browser.userDataDir || !existsSync(browser.userDataDir)) return missing;

  let disabled: ExtensionPresence | null = null;
  for (const profileDir of listProfileDirs(browser.userDataDir, browser.flatProfile === true)) {
    for (const fileName of ['Secure Preferences', 'Preferences']) {
      const file = join(profileDir, fileName);
      const stat = statFile(file);
      if (!stat) continue;
      const cacheKey = `${file.toLowerCase()}|${extensionDir.toLowerCase()}`;
      const cached = presenceCache.get(cacheKey);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        if (cached.result.installed && cached.result.enabled) return cached.result;
        if (cached.result.installed) disabled ??= cached.result;
        continue;
      }
      const result = readExtensionPresence(file, extensionDir, profileDir);
      presenceCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, result });
      if (result.installed && result.enabled) return result;
      if (result.installed) disabled ??= result;
    }
  }
  return disabled ?? missing;
}

export function readCftMarker(dirs: BrowserDirs): CftMarker | null {
  try {
    const raw = readFileSync(join(dirs.cft, 'moss-cft.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CftMarker>;
    if (typeof parsed.executable !== 'string' || !existsSync(parsed.executable)) return null;
    return {
      buildId: typeof parsed.buildId === 'string' ? parsed.buildId : 'unknown',
      executable: parsed.executable,
      installedAt: typeof parsed.installedAt === 'number' ? parsed.installedAt : 0,
    };
  } catch {
    return null;
  }
}

export function getCftStatus(dirs: BrowserDirs): BrowserCftStatus {
  const marker = readCftMarker(dirs);
  return {
    installed: marker !== null,
    buildId: marker?.buildId ?? null,
    executable: marker?.executable ?? null,
    downloading: false,
    progress: null,
    error: null,
  };
}

/**
 * 解析内置浏览器可执行文件。
 * 顺序：配置路径 → 本机 Chrome/Chromium/Edge → 已安装的 Chrome for Testing。
 */
export function resolveBrowserExecutable(
  env: Environment,
  dirs: BrowserDirs,
  configuredPath: string,
): ChromeExecutable | null {
  const override = configuredPath.trim();
  if (override && existsSync(override)) {
    return { executable: override, source: 'config' };
  }
  for (const candidate of localBrowserCandidates(env)) {
    if (existsSync(candidate)) return { executable: candidate, source: 'local' };
  }
  const cft = readCftMarker(dirs);
  if (cft) return { executable: cft.executable, source: 'chrome-for-testing' };
  return null;
}

/**
 * 下载并安装 Chrome for Testing（stable）。
 * 失败抛错由调用方捕获写入状态。
 */
export async function downloadChromeForTesting(
  dirs: BrowserDirs,
  onProgress: (received: number, total: number) => void,
): Promise<CftMarker> {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error('无法识别当前平台，不能下载 Chrome for Testing');
  const buildId = await resolveBuildId(PuppeteerBrowser.CHROME, platform, BrowserTag.STABLE);
  const installed: InstalledBrowser = await installBrowser({
    browser: PuppeteerBrowser.CHROME,
    buildId,
    cacheDir: dirs.cft,
    downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
      onProgress(downloadedBytes, totalBytes);
    },
  });
  const marker: CftMarker = {
    buildId: installed.buildId,
    executable: installed.executablePath,
    installedAt: Date.now(),
  };
  mkdirSync(dirs.cft, { recursive: true });
  writeFileSync(join(dirs.cft, 'moss-cft.json'), JSON.stringify(marker, null, 2), 'utf8');
  return marker;
}

/** 截图日期目录（本地时区 yyyyMMdd） */
function screenshotDayDir(dirs: BrowserDirs): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dir = join(dirs.screenshots, `${y}${m}${d}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 新截图路径 */
export function newScreenshotPath(dirs: BrowserDirs, tag: string): string {
  const safe = tag.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'tab';
  return join(screenshotDayDir(dirs), `${safe}-${Date.now()}.png`);
}

/** 清理过期截图（失败静默） */
export function pruneScreenshots(dirs: BrowserDirs): void {
  const cutoff = Date.now() - SCREENSHOT_RETAIN_DAYS * 24 * 60 * 60 * 1000;
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && entry.endsWith('.png')) files.push({ path: full, mtimeMs: st.mtimeMs });
      } catch {
        // ignore
      }
    }
  };
  walk(dirs.screenshots);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  files.forEach((file, index) => {
    if (file.mtimeMs < cutoff || index >= SCREENSHOT_MAX_FILES) {
      try {
        unlinkSync(file.path);
      } catch {
        // ignore
      }
    }
  });
}
