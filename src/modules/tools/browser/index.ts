// src/modules/tools/browser/index.ts
// browser 工具：把 BrowserService 的扩展桥接/内置 Chrome/CDP 页面操作封装为单一 action 工具。
// 元数据见同目录 tool.json；服务由 browser 模块注册（ServiceNames.BROWSER）。

import { t } from '../../../core/i18n';
import { ServiceNames } from '../../../core/types';
import type {
  BrowserFrameInfo,
  BrowserMacroStep,
  BrowserPageInfo,
  BrowserRect,
  BrowserScreenshot,
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

/** 解析截图/等待用的区域（CSS 像素） */
function pickRegion(params: Record<string, unknown>): BrowserRect | undefined {
  const raw = params.region;
  if (!isObject(raw)) return undefined;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

/** 截图元信息文本：图像/视口/DPR/缩放/frame */
function formatShotMeta(shot: BrowserScreenshot): string {
  const parts: string[] = [];
  if (shot.width !== undefined && shot.height !== undefined) parts.push(`图像 ${shot.width}x${shot.height}`);
  if (shot.viewportWidth !== undefined && shot.viewportHeight !== undefined) {
    parts.push(`视口 ${shot.viewportWidth}x${shot.viewportHeight}`);
  }
  if (shot.dpr !== undefined) parts.push(`dpr ${shot.dpr}`);
  if (shot.scale !== undefined) parts.push(`缩放 ${Number(shot.scale.toFixed(3))}`);
  if (shot.frame) parts.push(`frame=${shot.frame}`);
  if (shot.region) {
    parts.push(`region=(${shot.region.x},${shot.region.y},${shot.region.width},${shot.region.height})`);
  }
  return parts.join(' · ');
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
    // 自动焦点：操作前把目标标签页/窗口带到前台；已在前台时扩展内部 no-op（不闪屏）
    const autoFocus =
      pickBoolean(params, 'auto_focus') ?? (ctx.toolConfig?.autoFocus !== false);

    try {
      // CDP 按次端点：先连接，再执行本次动作（后续调用沿用该连接）
      if (cdpEndpoint && (action === 'open' || action === 'status' || action === 'tabs')) {
        await service.connectCdp(cdpEndpoint);
      }

      // 自动聚焦（open 在服务内按 focus 参数处理；focus 动作本身即聚焦）
      if (autoFocus && !['status', 'setup', 'tabs', 'close', 'open', 'focus'].includes(action)) {
        const key = tab ?? service.getStatus().currentTab;
        if (key) {
          await service.ensureFocused(key).catch(() => undefined);
        }
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
            focus: autoFocus,
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
          const shot = await service.screenshot(tab, {
            fullPage: pickBoolean(params, 'full_page') === true,
            ...(pickString(params, 'frame') ? { frame: pickString(params, 'frame') } : {}),
            ...(pickRegion(params) ? { region: pickRegion(params) } : {}),
          });
          const meta = formatShotMeta(shot);
          const content: ToolResultContent[] = [
            {
              type: 'text',
              text: `${t('browserTool.screenshotLine', {
                path: shot.path,
                width: shot.width ?? '?',
                height: shot.height ?? '?',
              })}${meta ? `（${meta}）` : ''}${
                shot.scale !== undefined
                  ? `\n坐标换算：截图坐标 ÷ ${Number(shot.scale.toFixed(3))} = CSS 坐标`
                  : ''
              }`,
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
            ...(pickString(params, 'frame') ? { frame: pickString(params, 'frame') } : {}),
            ...(pickString(params, 'coord_space') === 'screenshot'
              ? { coordSpace: 'screenshot' as const }
              : {}),
          });
          if (autoFocus && info.openedTab) {
            await service.ensureFocused(info.openedTab.tab, { force: true }).catch(() => undefined);
          }
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
            ...(pickString(params, 'frame') ? { frame: pickString(params, 'frame') } : {}),
          });
          if (autoFocus && info.openedTab) {
            await service.ensureFocused(info.openedTab.tab, { force: true }).catch(() => undefined);
          }
          return textResult(`${t('browserTool.keyPressed', { key })}\n${formatPageInfo(info)}`);
        }

        case 'frames': {
          const frames = await service.listFrames(tab);
          if (frames.length === 0) {
            return textResult(
              '当前标签页没有可用的 iframe 子会话（可能没有跨域 iframe，或浏览器不支持子会话）。可先用 action=screenshot 查看页面。',
            );
          }
          const lines = [`iframe 子会话（${frames.length} 个；key=targetId，可传给 frame 参数）：`];
          for (const frame of frames) {
            const rect = frame.rect
              ? ` rect=(${Math.round(frame.rect.x)},${Math.round(frame.rect.y)},${Math.round(frame.rect.width)},${Math.round(frame.rect.height)})`
              : '';
            lines.push(
              `- ${frame.frame}${frame.active ? ' [active]' : ''}${rect}\n  ${frame.title || '(no title)'}\n  ${frame.url}`,
            );
          }
          lines.push('提示：游戏/画布优先用 frame=auto 或上述 key；frame 内坐标使用该 iframe 的 CSS 坐标。');
          return textResult(lines.join('\n'));
        }

        case 'key_down': {
          const key = requireString(params, 'key');
          const info = await service.keyDown(tab, key, {
            ...(pickString(params, 'frame') ? { frame: pickString(params, 'frame') } : {}),
            ...(pickStringArray(params, 'modifiers') ? { modifiers: pickStringArray(params, 'modifiers') } : {}),
          });
          return textResult(`已按下 ${key}\n${formatPageInfo(info)}`);
        }

        case 'key_up': {
          const key = requireString(params, 'key');
          const info = await service.keyUp(tab, key, {
            ...(pickString(params, 'frame') ? { frame: pickString(params, 'frame') } : {}),
            ...(pickStringArray(params, 'modifiers') ? { modifiers: pickStringArray(params, 'modifiers') } : {}),
          });
          return textResult(`已抬起 ${key}\n${formatPageInfo(info)}`);
        }

        case 'hold': {
          const keys = pickStringArray(params, 'keys') ?? (pickString(params, 'key') ? [pickString(params, 'key')!] : []);
          if (keys.length === 0) return errorResult('hold 需要 keys 或 key');
          const duration = pickNumber(params, 'duration_ms') ?? 500;
          const info = await service.hold(tab, {
            keys,
            durationMs: duration,
            ...(pickString(params, 'frame') ? { frame: pickString(params, 'frame') } : {}),
            ...(pickStringArray(params, 'modifiers') ? { modifiers: pickStringArray(params, 'modifiers') } : {}),
          });
          return textResult(`已按住 ${keys.join('+')} ${duration}ms\n${formatPageInfo(info)}`);
        }

        case 'macro': {
          const rawSteps = params.actions;
          if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
            return errorResult('macro 需要 actions 数组（1-32 步）');
          }
          const steps = rawSteps.filter(isObject) as unknown as BrowserMacroStep[];
          const result = await service.macro(tab, steps, {
            verify: pickBoolean(params, 'verify') !== false,
          });
          const lines = [
            `macro 完成（${result.elapsedMs}ms）：${result.steps.filter((step) => step.ok).length}/${result.steps.length} 步`,
          ];
          for (const step of result.steps) {
            lines.push(
              `- ${step.ok ? '✓' : '✗'} ${step.action}${step.detail ? `：${step.detail}` : ''}${step.error ? `：${step.error}` : ''}`,
            );
          }
          if (result.effect !== 'unknown') {
            lines.push(
              `effect=${result.effect}${result.diffPercent !== undefined ? ` diff=${result.diffPercent}%` : ''}${
                result.effect === 'no-change' ? '（未检测到画面变化，请确认动作是否真的生效）' : ''
              }`,
            );
          }
          const content: ToolResultContent[] = [{ type: 'text', text: lines.join('\n') }];
          if (result.lastScreenshot) {
            addImage(content, result.lastScreenshot.path, result.lastScreenshot.data, result.lastScreenshot.mimeType);
          }
          return { content, isError: result.steps.every((step) => step.ok) ? false : true };
        }

        case 'wait_stable':
        case 'wait_change': {
          const frame = pickString(params, 'frame');
          const region = pickRegion(params);
          const waitOptions = {
            ...(frame ? { frame } : {}),
            ...(region ? { region } : {}),
            ...(pickNumber(params, 'timeout_ms') !== undefined ? { timeoutMs: pickNumber(params, 'timeout_ms') } : {}),
            ...(pickNumber(params, 'interval_ms') !== undefined ? { intervalMs: pickNumber(params, 'interval_ms') } : {}),
            ...(pickNumber(params, 'threshold') !== undefined ? { threshold: pickNumber(params, 'threshold') } : {}),
            ...(pickNumber(params, 'stable_samples') !== undefined ? { stableSamples: pickNumber(params, 'stable_samples') } : {}),
          };
          const result =
            action === 'wait_stable'
              ? await service.waitStable(tab, waitOptions)
              : await service.waitChange(tab, waitOptions);
          return textResult(
            `wait_${result.reason}（${result.elapsedMs}ms，采样 ${result.samples} 次，diff=${result.diffPercent}%）${
              result.matched ? '' : '：超时未满足条件'
            }${result.frame ? ` · frame=${result.frame}` : ''}`,
          );
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
          const result = await service.evaluate(tab, {
            expression,
            ...(pickString(params, 'frame') ? { frame: pickString(params, 'frame') } : {}),
          });
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
