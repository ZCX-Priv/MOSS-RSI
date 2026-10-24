// 临时验证：offscreen 长连接 + 新标签页接管。
import { detectEnvironment } from './src/core/env';
import { createRootLogger } from './src/core/logger';
import { BrowserServiceImpl } from './src/modules/browser/service';
import type { ConfigService } from './src/core/types';

const env = detectEnvironment();
const root = createRootLogger(env, 'warn');
const config = {
  getAppConfig: () => ({
    tools: {
      browser: {
        enabled: true,
        timeoutMs: 20000,
        bridgePort: 7799,
        bridgeToken: '',
        tabGroupTitle: 'MOSS',
        tabGroupColor: 'blue',
        maxSnapshotNodes: 300,
        maxImageDimension: 1000,
        browserPath: '',
        autoDownloadChromeForTesting: false,
        autoInstallExtensions: false,
        allowEvaluate: true,
      },
    },
  }),
} as unknown as ConfigService;

const service = new BrowserServiceImpl({ env, logger: root.logger, config, computer: null });
let tab: string | null = null;

async function main(): Promise<void> {
  await service.initialize();
  const builtin = await service.launchBuiltin();
  if (!builtin.running) throw new Error('builtin launch failed');
  await new Promise((r) => setTimeout(r, 800));
  const opened = await service.openTab({ target: 'builtin' });
  tab = opened.tab;
  console.log('OPEN', { tab: opened.tab, group: opened.groupId });
  await service.evaluate(tab, {
    expression:
      `document.body.innerHTML = '<a id="l" target="_blank" href="https://example.com">go</a>'; 'ok'`,
  });
  const snap = await service.snapshot(tab, 100);
  const ref = /- link "go"[^\n]*\[ref=(e\d+)\]/.exec(snap.text)?.[1];
  console.log('REF', ref);
  if (!ref) throw new Error('link ref missing');

  console.log('WAITING_70S...');
  await new Promise((r) => setTimeout(r, 70_000));
  const status = service.getStatus();
  console.log('ALIVE', {
    instances: status.instances.map((i) => [i.kind, i.extensionVersion, i.browserName]),
    tabs: status.tabs.map((x) => [x.tab, x.title]),
  });
  if (!status.instances.some((i) => i.kind === 'builtin')) throw new Error('builtin instance lost after idle');
  await service.snapshot(tab, 50);

  const clicked = await service.click(tab, { ref });
  console.log('CLICK', clicked);
  await new Promise((r) => setTimeout(r, 1200));
  const tabs = service.getStatus().tabs;
  console.log('TABS_AFTER_CLICK', tabs.map((x) => [x.tab, x.url, x.title, x.groupId]));
  if (tabs.length < 2) throw new Error('new tab was not adopted');
  const newTab = tabs.find((x) => x.tab !== tab);
  if (newTab) await service.closeTab(newTab.tab);
}

main()
  .catch((err) => {
    console.error('FAILED', err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (tab) await service.closeTab(tab);
    } catch {
      // ignore
    }
    await service.closeBuiltin().catch(() => {});
    await service.destroy().catch(() => {});
  });
