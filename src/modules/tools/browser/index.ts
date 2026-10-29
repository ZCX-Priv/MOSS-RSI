// src/modules/tools/browser/index.ts
// browser 工具：把 BrowserService 的扩展桥接/内置 Chrome/CDP 页面操作封装为单一 action 工具。
// 元数据见同目录 tool.json；服务由 browser 模块注册（ServiceNames.BROWSER）。

import { t } from '../../../core/i18n';
import { ServiceNames } from '../../../core/types';
import type {
  BrowserPageInfo,
  BrowserService,
  BrowserStatus,
  BrowserTabInfo,
} from '../../contracts';
import type { ToolContext, ToolResult, ToolResultContent } from '../types';
import { errorResult, textResult } from '../types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pickNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === 'boolean' ? value : undefined;
}

function pickStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return items.length > 0 ? items.map((item) => item.trim()) : undefined;
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = pickString(params, key);
  if (!value) throw new Error(t('browserTool.missingParam', { name: key }));
  return value;
}

function formatKind(kind: BrowserTabInfo['instanceKind']): string {
  if (kind === 'builtin') return t('browserTool.kindBuiltin');
  if (kind === 'cdp') return t('browserTool.kindCdp');
  return t('browserTool.kindExternal');
}

function formatMode(mode: BrowserStatus['mode']): string {
  if (mode === 'builtin') return t('browserTool.modeBuiltin');
  if (mode === 'cdp') return t('browserTool.modeCdp');
  return t('browserTool.modeExtension');
}

function formatTabLine(tab: BrowserTabInfo): string {
  return t('browserTool.tabLine', {
    tab: tab.tab,
    kind: formatKind(tab.instanceKind),
    title: tab.title || '(untitled)',
    url: tab.url || 'about:blank',
    group: tab.groupId ?? t('browserTool.groupNoneShort'),
  });
}

function formatPageInfo(info: BrowserPageInfo): string {
  const base = t('browserTool.pageLine', {
    tab: info.tab,
    url: info.url || 'about:blank',
    title: info.title || '(untitled)',
  });
  const loading = info.loading ? `\n${t('browserTool.loading')}` : '';
  const opened = info.openedTab
    ? `\n${t('browserTool.openedNewTab', {
        tab: info.openedTab.tab,
        url: info.openedTab.url,
        title: info.openedTab.title || '(untitled)',
      })}`
    : '';
  return `${base}${loading}${opened}`;
}

function formatInstaller(status: BrowserStatus['installer']): string {
  const lines = [t('browserTool.installerHeader')];
  if (status.browsers.length === 0) {
    lines.push(t('browserTool.installerNone'));
    return lines.join('\n');
  }
  for (const browser of status.browsers) {
    lines.push(
      t('browserTool.installerLine', {
        name: browser.name,
        state: t(`browserTool.installerState.${browser.state}`),
        detail: browser.detail ? ` · ${browser.detail}` : '',
      }),
    );
  }
  if (status.running && status.current) {
    lines.push(t('browserTool.installerRunning', { name: status.current }));
  }
  return lines.join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatStatus(status: BrowserStatus): string {
  const lines: string[] = [];
  lines.push(t('browserTool.statusTitle'));
  lines.push(t('browserTool.modeLine', { mode: formatMode(status.mode) }));

  const cdp = status.cdp;
  if (cdp.connected) {
    lines.push(
      t('browserTool.cdpConnectedLine', {
        url: cdp.resolvedUrl ?? cdp.endpoint,
        product: cdp.product ?? '-',
        targets: cdp.targetCount,
      }),
    );
  } else {
    lines.push(
      t('browserTool.cdpDisconnectedLine', {
        endpoint: cdp.endpoint,
        error: cdp.error ? ` · ${cdp.error}` : '',
      }),
    );
  }

  if (status.bridge.running) {
    lines.push(
      t('browserTool.bridgeRunning', {
        port: status.bridge.port ?? '-',
        token: status.bridge.tokenConfigured ? t('browserTool.tokenOn') : t('browserTool.tokenOff'),
      }),
    );
    if (status.bridge.port !== null && status.bridge.port !== status.bridge.configuredPort) {
      lines.push(
        t('browserTool.bridgePortMismatch', {
          configured: status.bridge.configuredPort,
          actual: status.bridge.port,
        }),
      );
    }
  } else {
    lines.push(t('browserTool.bridgeStopped', { error: status.bridge.error ?? '-' }));
  }
  lines.push(
    status.extension.seeded
      ? t('browserTool.extensionLine', {
          dir: status.extension.dir,
          version: status.extension.version ?? '-',
        })
      : t('browserTool.extensionMissing', { dir: status.extension.dir }),
  );

  const builtin = status.builtin;
  lines.push(
    t('browserTool.builtinLine', {
      state: builtin.running ? t('browserTool.builtinRunning') : t('browserTool.builtinStopped'),
      name: builtin.extensionLoaded ? t('browserTool.builtinExtLoaded') : t('browserTool.builtinExtMissing'),
      path: builtin.executable ?? '-',
    }),
  );
  if (builtin.running && builtin.version) {
    lines.push(t('browserTool.builtinVersion', { version: builtin.version, profile: builtin.profileDir }));
  }
  if (builtin.error) lines.push(t('browserTool.builtinError', { error: builtin.error }));

  const cft = status.cft;
  lines.push(
    t('browserTool.cftLine', {
      state: cft.downloading
        ? t('browserTool.cftDownloading', { percent: cft.progress?.percent ?? 0 })
        : cft.installed
          ? t('browserTool.cftInstalled', { build: cft.buildId ?? '-' })
          : t('browserTool.cftMissing'),
    }),
  );
  if (cft.error) lines.push(t('browserTool.cftError', { error: cft.error }));

  lines.push(t('browserTool.instancesHeader'));
  if (status.instances.length === 0) {
    lines.push(t('browserTool.instanceNone'));
  } else {
    for (const instance of status.instances) {
      lines.push(
        t('browserTool.instanceLine', {
          kind: instance.kind === 'builtin' ? t('browserTool.kindBuiltin') : t('browserTool.kindExternal'),
          name: instance.browserName,
          version: instance.browserVersion || '-',
          id: instance.id.slice(0, 8),
          tabs: instance.tabCount,
        }),
      );
    }
  }

  lines.push(t('browserTool.tabsHeader'));
  if (status.tabs.length === 0) {
    lines.push(t('browserTool.tabsNone'));
  } else {
    for (const tab of status.tabs) lines.push(formatTabLine(tab));
  }
  if (status.currentTab) lines.push(t('browserTool.currentTab', { tab: status.currentTab }));
  lines.push('');
  lines.push(formatInstaller(status.installer));
  return lines.join('\n');
}

function addImage(content: ToolResultContent[], path: string, data: string, mimeType: string): void {
  content.push({ type: 'image', source: { data, mimeType }, path });
}

export default {
  execute: async (params: unknown, ctx: ToolContext): Promise<ToolResult> => {
    if (!isObject(params)) return errorResult(t('browserTool.invalidParams'));
    const action = pickString(params, 'action');
    if (!action) return errorResult(t('browserTool.actionRequired'));

    const service = ctx.services.tryResolve<BrowserService>(ServiceNames.BROWSER);
    if (!service) return errorResult(t('browserTool.serviceUnavailable'));

    const tab = pickString(params, 'tab');
    const browser = pickString(params, 'browser');
    const cdpEndpoint = pickString(params, 'cdp_endpoint');
    const timeoutMs = pickNumber(params, 'timeout_ms');

    try {
      // CDP 按次端点：先连接，再执行本次动作（后续调用沿用该连接）
      if (cdpEndpoint && (action === 'open' || action === 'status' || action === 'tabs')) {
        await service.connectCdp(cdpEndpoint);
      }

      switch (action) {
        case 'status':
          return textResult(formatStatus(service.getStatus()));

        case 'setup': {
          const status = await service.ensureExtension();
          void service.autoInstallExtensions(true).catch(() => undefined);
          const lines = [
            t('browserTool.setupTitle'),
            t('browserTool.setupPath', { dir: status.dir }),
            t('browserTool.installerStarted'),
            formatInstaller(service.getInstallerStatus()),
            t('browserTool.setupSteps'),
          ];
          return textResult(lines.join('\n'));
        }

        case 'open': {
          const info = await service.openTab({
            target: cdpEndpoint ? 'cdp' : browser,
            ...(cdpEndpoint ? { cdpEndpoint } : {}),
            ...(pickString(params, 'url') ? { url: pickString(params, 'url') } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          const groupTitle = service.getStatus().config.tabGroupTitle;
          return textResult(
            t('browserTool.opened', {
              tab: info.tab,
              browser: `${info.browserName} ${info.browserVersion}`.trim(),
              group: info.groupId !== null ? `${groupTitle} (${info.groupId})` : t('browserTool.groupNone'),
              url: info.url,
            }),
          );
        }

        case 'tabs': {
          const all = pickBoolean(params, 'all') === true;
          const tabs = await service.listTabs(all, cdpEndpoint ? 'cdp' : browser);
          if (tabs.length === 0) {
            return textResult(all ? t('browserTool.nativeTabsEmpty') : t('browserTool.tabsNone'));
          }
          const lines = [
            all ? t('browserTool.nativeTabsTitle') : t('browserTool.tabsListTitle'),
            ...tabs.map((item) => formatTabLine(item)),
          ];
          if (all) lines.push(t('browserTool.nativeHint'));
          return textResult(lines.join('\n'));
        }

        case 'focus': {
          const key = resolveTabKey(service, tab);
          const info = await service.focusTab(key);
          return textResult(t('browserTool.focused', { tab: info.tab, url: info.url }));
        }

        case 'close': {
          const key = resolveTabKey(service, tab);
          await service.closeTab(key);
          return textResult(t('browserTool.closed', { tab: key }));
        }

        case 'navigate': {
          const url = pickString(params, 'url');
          const back = pickBoolean(params, 'back') === true;
          const forward = pickBoolean(params, 'forward') === true;
          const reload = pickBoolean(params, 'reload') === true;
          if (!url && !back && !forward && !reload) {
            return errorResult(t('browserTool.navigateNeedsOption'));
          }
          const info = await service.navigate(tab, {
            ...(url ? { url } : {}),
            ...(back ? { back: true } : {}),
            ...(forward ? { forward: true } : {}),
            ...(reload ? { reload: true } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return textResult(formatPageInfo(info));
        }

        case 'snapshot': {
          const maxNodes = pickNumber(params, 'max_nodes');
          const snapshot = await service.snapshot(tab, maxNodes);
          const footer = t('browserTool.snapshotDone', {
            tab: snapshot.tab,
            count: snapshot.refCount,
            truncated: snapshot.truncated ? t('browserTool.snapshotTruncated') : '',
          });
          return textResult(`${snapshot.text}\n\n${footer}`);
        }

        case 'screenshot': {
          const shot = await service.screenshot(tab, pickBoolean(params, 'full_page') === true);
          const content: ToolResultContent[] = [
            {
              type: 'text',
              text: t('browserTool.screenshotLine', {
                path: shot.path,
                width: shot.width ?? '?',
                height: shot.height ?? '?',
              }),
            },
          ];
          addImage(content, shot.path, shot.data, shot.mimeType);
          return { content };
        }

        case 'click': {
          const info = await service.click(tab, {
            ...(pickString(params, 'ref') ? { ref: pickString(params, 'ref') } : {}),
            ...(pickString(params, 'selector') ? { selector: pickString(params, 'selector') } : {}),
            ...(pickNumber(params, 'x') !== undefined ? { x: pickNumber(params, 'x') } : {}),
            ...(pickNumber(params, 'y') !== undefined ? { y: pickNumber(params, 'y') } : {}),
            ...(clickButton(params) ? { button: clickButton(params) } : {}),
            ...(pickNumber(params, 'click_count') !== undefined
              ? { clickCount: pickNumber(params, 'click_count') }
              : {}),
            ...(pickStringArray(params, 'modifiers') ? { modifiers: pickStringArray(params, 'modifiers') } : {}),
          });
          return textResult(`${t('browserTool.clicked')}\n${formatPageInfo(info)}`);
        }

        case 'hover': {
          const info = await service.hover(tab, {
            ...(pickString(params, 'ref') ? { ref: pickString(params, 'ref') } : {}),
            ...(pickString(params, 'selector') ? { selector: pickString(params, 'selector') } : {}),
          });
          return textResult(`${t('browserTool.hovered')}\n${formatPageInfo(info)}`);
        }

        case 'type': {
          const text = requireString(params, 'text');
          const info = await service.typeText(tab, {
            ...(pickString(params, 'ref') ? { ref: pickString(params, 'ref') } : {}),
            ...(pickString(params, 'selector') ? { selector: pickString(params, 'selector') } : {}),
            text,
            ...(pickBoolean(params, 'replace') !== undefined ? { replace: pickBoolean(params, 'replace') } : {}),
            ...(pickBoolean(params, 'submit') !== undefined ? { submit: pickBoolean(params, 'submit') } : {}),
          });
          return textResult(`${t('browserTool.typed')}\n${formatPageInfo(info)}`);
        }

        case 'press_key': {
          const key = requireString(params, 'key');
          const info = await service.pressKey(tab, {
            key,
            ...(pickStringArray(params, 'modifiers') ? { modifiers: pickStringArray(params, 'modifiers') } : {}),
          });
          return textResult(`${t('browserTool.keyPressed', { key })}\n${formatPageInfo(info)}`);
        }

        case 'select': {
          const values = pickStringArray(params, 'values');
          if (!values) return errorResult(t('browserTool.missingParam', { name: 'values' }));
          const info = await service.selectOption(tab, {
            ...(pickString(params, 'ref') ? { ref: pickString(params, 'ref') } : {}),
            ...(pickString(params, 'selector') ? { selector: pickString(params, 'selector') } : {}),
            values,
          });
          return textResult(`${t('browserTool.selected')}\n${formatPageInfo(info)}`);
        }

        case 'scroll': {
          const info = await service.scroll(tab, {
            ...(pickString(params, 'ref') ? { ref: pickString(params, 'ref') } : {}),
            ...(pickNumber(params, 'delta_x') !== undefined ? { deltaX: pickNumber(params, 'delta_x') } : {}),
            ...(pickNumber(params, 'delta_y') !== undefined ? { deltaY: pickNumber(params, 'delta_y') } : {}),
          });
          return textResult(`${t('browserTool.scrolled')}\n${formatPageInfo(info)}`);
        }

        case 'drag': {
          const fromX = pickNumber(params, 'from_x');
          const fromY = pickNumber(params, 'from_y');
          const toX = pickNumber(params, 'to_x');
          const toY = pickNumber(params, 'to_y');
          const info = await service.drag(tab, {
            ...(pickString(params, 'from_ref') ? { fromRef: pickString(params, 'from_ref') } : {}),
            ...(pickString(params, 'from_selector')
              ? { fromSelector: pickString(params, 'from_selector') }
              : {}),
            ...(fromX !== undefined ? { fromX } : {}),
            ...(fromY !== undefined ? { fromY } : {}),
            ...(pickString(params, 'to_ref') ? { toRef: pickString(params, 'to_ref') } : {}),
            ...(pickString(params, 'to_selector') ? { toSelector: pickString(params, 'to_selector') } : {}),
            ...(toX !== undefined ? { toX } : {}),
            ...(toY !== undefined ? { toY } : {}),
            ...(clickButton(params) ? { button: clickButton(params) } : {}),
            ...(pickNumber(params, 'steps') !== undefined ? { steps: pickNumber(params, 'steps') } : {}),
            ...(pickNumber(params, 'duration_ms') !== undefined
              ? { durationMs: pickNumber(params, 'duration_ms') }
              : {}),
          });
          return textResult(`${t('browserTool.dragged')}\n${formatPageInfo(info)}`);
        }

        case 'evaluate': {
          const expression = requireString(params, 'expression');
          const result = await service.evaluate(tab, { expression });
          return textResult(t('browserTool.evaluated', { type: result.type, result: result.result }));
        }

        case 'wait': {
          const waitMs = pickNumber(params, 'wait_ms');
          const selector = pickString(params, 'wait_selector');
          const text = pickString(params, 'wait_text');
          if (waitMs === undefined && !selector && !text) {
            return errorResult(t('browserTool.waitNeedsOption'));
          }
          const hasTab = Boolean(tab) || Boolean(service.getStatus().currentTab);
          if (!hasTab && !selector && !text) {
            // 无 AI 标签页时，纯等待退化为本地 sleep
            await sleep(Math.min(10_000, Math.max(0, waitMs ?? 0)));
            return textResult(t('browserTool.waited'));
          }
          const info = await service.waitFor(tab, {
            ...(waitMs !== undefined ? { waitMs } : {}),
            ...(selector ? { selector } : {}),
            ...(text ? { text } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return textResult(`${t('browserTool.waited')}\n${formatPageInfo(info)}`);
        }

        case 'console': {
          const clear = pickBoolean(params, 'clear') === true;
          const result = await service.consoleLogs(tab, clear);
          const lines = [t('browserTool.consoleTitle', { count: result.entries.length })];
          if (result.entries.length === 0) {
            lines.push(t('browserTool.consoleEmpty'));
          } else {
            for (const entry of result.entries) {
              const time = new Date(entry.ts).toLocaleTimeString();
              lines.push(`[${time}] ${entry.type}: ${entry.text}`);
            }
          }
          if (clear) lines.push(t('browserTool.consoleCleared'));
          return textResult(lines.join('\n'));
        }

        default:
          return errorResult(t('browserTool.unknownAction', { action }));
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

function resolveTabKey(service: BrowserService, tab: string | undefined): string {
  const key = tab ?? service.getStatus().currentTab;
  if (!key) throw new Error(t('browserTool.tabRequired'));
  return key;
}

function clickButton(params: Record<string, unknown>): 'left' | 'right' | 'middle' | undefined {
  const value = pickString(params, 'button');
  if (value === 'left' || value === 'right' || value === 'middle') return value;
  return undefined;
}
