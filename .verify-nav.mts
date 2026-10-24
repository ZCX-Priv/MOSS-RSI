// 临时诊断：用 cua 键盘在浏览器窗口导航到扩展页。
import { detectEnvironment } from './src/core/env';
import { createRootLogger } from './src/core/logger';
import { createEventBus } from './src/core/event-bus';
import { ComputerServiceImpl } from './src/modules/computer/service';
import type { ConfigService } from './src/core/types';

const env = detectEnvironment();
const root = createRootLogger(env, 'warn');
const config = {
  getAppConfig: () => ({
    tools: { computer: { maxImageDimension: 1280, maxTreeElements: 800, allowForeground: true } },
  }),
} as unknown as ConfigService;
const service = new ComputerServiceImpl({
  logger: root.logger,
  config,
  env,
  eventBus: createEventBus(root.logger),
  emitter: () => {},
});

async function main(): Promise<void> {
  await service.initialize();
  await new Promise((r) => setTimeout(r, 1200));
  const list = await service.callTool('list_windows', { on_screen_only: false }, { source: 'panel' });
  const target = list.text
    .split(/\r?\n/)
    .map((line) => /^-\s+(\S+)\s+\(pid\s+(\d+)\)\s+"(.*)"\s+\[window_id:\s*(\d+)\]/.exec(line.trim()))
    .find((m) => m && /msedge\.exe/.test(m[1]) && /新建标签页/.test(m[3]));
  if (!target) throw new Error('edge new tab window not found');
  const pid = Number(target[2]);
  const windowId = Number(target[4]);
  console.log('TARGET', pid, windowId, target[3]);
  const opts = { source: 'panel' as const, timeoutMs: 30000 };
  const hk = await service.callTool(
    'hotkey',
    { pid, window_id: windowId, keys: ['ctrl', 'l'], delivery_mode: 'foreground' },
    opts,
  );
  console.log('HOTKEY', hk.text.slice(0, 300));
  const typed = await service.callTool(
    'type_text',
    { pid, window_id: windowId, text: 'edge://extensions', delivery_mode: 'foreground' },
    opts,
  );
  console.log('TYPE', typed.text.slice(0, 300));
  const enter = await service.callTool(
    'press_key',
    { pid, window_id: windowId, key: 'return', delivery_mode: 'foreground' },
    opts,
  );
  console.log('ENTER', enter.text.slice(0, 300));
  await new Promise((r) => setTimeout(r, 2500));
  const list2 = await service.callTool('list_windows', { on_screen_only: false }, { source: 'panel' });
  console.log('WINDOWS2', list2.text.slice(0, 1200));
  const state = await service.callTool(
    'get_window_state',
    { pid, window_id: windowId, include_screenshot: false, max_elements: 400, query: '开发者模式' },
    opts,
  );
  console.log('DEV_STATE', state.text.slice(0, 2000));
  const state2 = await service.callTool(
    'get_window_state',
    { pid, window_id: windowId, include_screenshot: false, max_elements: 400, query: '加载已解压' },
    opts,
  );
  console.log('LOAD_STATE', state2.text.slice(0, 2000));
}

main()
  .catch((err) => console.error('FAILED', err))
  .finally(async () => {
    await service.destroy().catch(() => {});
  });
