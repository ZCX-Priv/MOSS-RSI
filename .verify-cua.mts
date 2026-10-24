// 临时诊断：查看 Chrome/Edge 扩展页的 UIA 元素。
import { detectEnvironment } from './src/core/env';
import { writeFileSync } from 'node:fs';
import { createRootLogger } from './src/core/logger';
import { createEventBus } from './src/core/event-bus';
import { ComputerServiceImpl } from './src/modules/computer/service';
import type { ConfigService } from './src/core/types';

const env = detectEnvironment();
const root = createRootLogger(env, 'warn');
const config = {
  getAppConfig: () => ({
    tools: {
      computer: { maxImageDimension: 1280, maxTreeElements: 800, allowForeground: true },
    },
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
  await new Promise((r) => setTimeout(r, 1500));
  for (const call of [
    { tool: 'get_guide', args: { topic: 'browser' } },
    { tool: 'get_guide', args: { topic: 'overview' } },
  ]) {
    try {
      const res = await service.callTool(call.tool, call.args, { source: 'panel', timeoutMs: 20000 });
      if (call.tool === 'get_guide' && call.args.topic === 'browser') {
        writeFileSync('.verify-guide-browser.txt', res.text, 'utf8');
      }
      console.log(`GUIDE[${call.args.topic}]`, res.text.slice(0, 6000));
    } catch (err) {
      console.log(`GUIDE_ERR`, err instanceof Error ? err.message : String(err));
    }
  }
  for (const tool of ['install_extension', 'browser_prepare', 'browser_navigate']) {
    try {
      const res = await service.callTool(tool, {}, { source: 'panel', timeoutMs: 20000 });
      console.log(`TOOL[${tool}]`, res.text.slice(0, 2500));
    } catch (err) {
      console.log(`TOOL_ERR[${tool}]`, err instanceof Error ? err.message : String(err));
    }
  }
  try {
    const prep = await service.callTool(
      'browser_prepare',
      { pid: 13268, window_id: 8784496, strategy: { kind: 'existing_profile' } },
      { source: 'panel', timeoutMs: 30000 },
    );
    console.log('PREP_EDGE', prep.text.slice(0, 4000));
    console.log('PREP_STRUCT', JSON.stringify(prep.structured).slice(0, 5000));
  } catch (err) {
    console.log('PREP_ERR', err instanceof Error ? err.message : String(err));
  }  try {
    const bind = await service.callTool(
      'get_browser_state',
      { pid: 13268, window_id: 8784496, snapshot_format: 'semantic_v2' },
      { source: 'panel', timeoutMs: 30000 },
    );
    console.log('BIND_EDGE_EXT', bind.text.slice(0, 8000));
    console.log('BIND_STRUCT', JSON.stringify(bind.structured).slice(0, 5000));
  } catch (err) {
    console.log('BIND_ERR', err instanceof Error ? err.message : String(err));
  }
  const list = await service.callTool('list_windows', { on_screen_only: false }, { source: 'panel' });
  console.log('WINDOWS\n' + list.text.slice(0, 3000));
  const windows = list.text
    .split(/\r?\n/)
    .map((line) => {
      const m = /^-\s+(\S+)\s+\(pid\s+(\d+)\)\s+"(.*)"\s+\[window_id:\s*(\d+)\]/.exec(line.trim());
      return m ? { app: m[1], pid: Number(m[2]), title: m[3], id: Number(m[4]) } : null;
    })
    .filter((v): v is { app: string; pid: number; title: string; id: number } => v !== null)
    .filter((w) => /chrome\.exe|msedge\.exe/i.test(w.app));
  for (const win of windows) {
    console.log('WINDOW', win);
    try {
      const full = await service.callTool(
        'get_window_state',
        {
          pid: win.pid,
          window_id: win.id,
          include_screenshot: false,
          include_accessibility_tree: true,
          max_elements: 200,
        },
        { source: 'panel', timeoutMs: 30000 },
      );
      console.log('FULL_STATE', full.text.slice(0, 4000));
    } catch (err) {
      console.log('FULL_ERR', err instanceof Error ? err.message : String(err));
    }
    for (const query of ['开发者模式', '加载已解压', '扩展']) {
      try {
        const state = await service.callTool(
          'get_window_state',
          {
            pid: win.pid,
            window_id: win.id,
            include_screenshot: false,
            include_accessibility_tree: true,
            max_elements: 500,
            query,
          },
          { source: 'panel', timeoutMs: 30000 },
        );
        console.log(`STATE[${query}]`, state.text.slice(0, 1800));
      } catch (err) {
        console.log(`STATE_ERR[${query}]`, err instanceof Error ? err.message : String(err));
      }
    }
  }
}

main()
  .catch((err) => console.error('FAILED', err))
  .finally(async () => {
    await service.destroy().catch(() => {});
  });
