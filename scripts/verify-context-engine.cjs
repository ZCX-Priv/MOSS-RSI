// scripts/verify-context-engine.cjs
// 上下文引擎落实核验脚本：直接读取磁盘文件逐项断言（不信任任何工具缓存）。
// 覆盖：A 模块文件存在 / B 后端接线正向 / C 后端旧代码已删（负向）/
//       D 提示词文件 / E 配置 / F 前端正向 / G 前端死代码已删（负向）/
//       H 中英 i18n 键对齐。
// 用法：node scripts\verify-context-engine.cjs

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}
/** 正向断言：文件存在且包含所有片段 */
function ok(name, rel, snippets) {
  if (!exists(rel)) {
    failed++;
    console.error(`FAIL ${name} —— 文件不存在: ${rel}`);
    return;
  }
  const c = read(rel);
  const missing = snippets.filter((s) => !c.includes(s));
  if (missing.length === 0) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name} —— ${rel} 缺少: ${missing.map((m) => JSON.stringify(m.slice(0, 60))).join(', ')}`);
  }
}
/** 负向断言：文件存在且不含任何片段（旧代码/死代码清除验证） */
function gone(name, rel, snippets) {
  if (!exists(rel)) {
    failed++;
    console.error(`FAIL ${name} —— 文件不存在: ${rel}`);
    return;
  }
  const c = read(rel);
  const found = snippets.filter((s) => c.includes(s));
  if (found.length === 0) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name} —— ${rel} 仍残留: ${found.map((m) => JSON.stringify(m.slice(0, 60))).join(', ')}`);
  }
}
/** 文件存在性断言 */
function file(name, rel) {
  if (exists(rel)) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name} —— 缺文件: ${rel}`);
  }
}
/** 路径不存在断言（负向：废弃文件/目录已清理） */
function absent(name, rel) {
  if (!exists(rel)) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name} —— 仍存在: ${rel}`);
  }
}

console.log('===== A. context 模块文件（24 个） =====');
const moduleFiles = [
  'src/modules/context/index.ts',
  'src/modules/context/types.ts',
  'src/modules/context/prompt-loader.ts',
  'src/modules/context/compiler/index.ts',
  'src/modules/context/compiler/system-prompt.ts',
  'src/modules/context/compiler/env-context.ts',
  'src/modules/context/compiler/view-builder.ts',
  'src/modules/context/compressor/index.ts',
  'src/modules/context/compressor/planner.ts',
  'src/modules/context/compressor/summarizer.ts',
  'src/modules/context/compressor/tool-pruner.ts',
  'src/modules/context/healer/index.ts',
  'src/modules/context/healer/args-repair.ts',
  'src/modules/context/healer/tool-match.ts',
  'src/modules/context/healer/schema-fix.ts',
  'src/modules/context/healer/pair-sanitize.ts',
  'src/modules/context/budgeter/index.ts',
  'src/modules/context/budgeter/estimator.ts',
  'src/modules/context/budgeter/calibration.ts',
  'src/modules/context/governor/index.ts',
  'src/modules/context/governor/triggers.ts',
  'src/modules/context/api/service.ts',
  'src/modules/context/api/routes.ts',
  'src/modules/context/api/events.ts',
];
for (const f of moduleFiles) file(`存在 ${f}`, f);

console.log('\n===== B. 后端接线（正向） =====');
ok('kernel 注册 context 模块（先于 agent）', 'src/core/kernel.ts', [
  "import context from '../modules/context';",
  "{ name: 'context', create: context },",
]);
{
  // 顺序校验：context 行必须在 agent 行之前
  const c = read('src/core/kernel.ts');
  const ctxIdx = c.indexOf("{ name: 'context', create: context }");
  const agentIdx = c.indexOf("{ name: 'agent', create: agent }");
  if (ctxIdx !== -1 && agentIdx !== -1 && ctxIdx < agentIdx) {
    passed++;
    console.log('PASS kernel: context 先于 agent 初始化');
  } else {
    failed++;
    console.error('FAIL kernel: context 未先于 agent 初始化');
  }
}
ok('core/types 服务名与配置类型', 'src/core/types.ts', [
  "CONTEXT_ENGINE: 'context.engine'",
  'context?: ContextEngineConfig;',
  "import type { ContextEngineConfig } from '../modules/context/types';",
]);
ok('contracts ContextEngine 契约', 'src/modules/contracts.ts', [
  'export interface ContextEngine {',
  'prepareRequest(session: ContextSessionLike, opts: ContextPrepareOptions): Promise<PreparedRequest>;',
  'healToolCall(toolName: string, args: string): HealResult;',
  'bindSessionStore(bridge: SessionStoreBridge): void;',
  'markBusy(sessionId: string): void;',
  'markIdle(sessionId: string): void;',
  'onTurnUsage(sessionId: string, usage: { promptTokens: number; cachedTokens: number }): void;',
  'manualCompact(sessionId: string, focus?: string): Promise<ManualCompactResult>;',
  'getStats(sessionId: string): ContextStats | null;',
]);
ok('config-service schema + 默认值', 'src/core/config-service.ts', [
  'const contextSchema = z.object({',
  'compactRatio: z.number().min(0.5).max(0.95).default(0.80),',
  'summaryModel: z.string().default(\'inherit\'),',
  'context: contextSchema.optional(),',
  "import { DEFAULT_CONTEXT_CONFIG } from \'../modules/context/types\';",
  'compaction: { ...DEFAULT_CONTEXT_CONFIG.compaction },',
]);
ok('server 路由 5 条', 'src/modules/server/index.ts', [
  "pattern: '/api/context/summary-models'",
  "pattern: '/api/context/:sessionId/stats'",
  "pattern: '/api/context/:sessionId/compactions'",
  "pattern: '/api/context/:sessionId/compact-preview'",
  "pattern: '/api/context/:sessionId/compact'",
]);
ok('server 路由转发文件', 'src/modules/server/routes/context.ts', [
  "from '../../context/api/routes'",
  'createManualCompactHandler',
]);
ok('context 模块入口注册服务', 'src/modules/context/index.ts', [
  'ctx.services.register(ServiceNames.CONTEXT_ENGINE, this.engine,',
  "scope: 'context',",
]);
ok('context service 核心实现', 'src/modules/context/api/service.ts', [
  'export class ContextEngineServiceImpl {',
  'bindSessionStore(bridge: SessionStoreBridge): void',
  'markBusy(sessionId: string): void',
  'markIdle(sessionId: string): void',
  'onTurnUsage(sessionId: string, usage: { promptTokens: number; cachedTokens: number }): void',
  'TELEMETRY_BUFFER_SIZE',
  'TokenCalibrator',
]);

console.log('\n===== B2. agent 模块接线（正向） =====');
ok('engine.ts 引擎调用', 'src/modules/agent/engine.ts', [
  "import { buildStaticSystemPrompt, buildRequestView } from '../context/compiler';",
  "import { DEFAULT_TOOL_PRUNING_CONFIG } from '../context/types';",
  'contextEngine?.markBusy(sessionId);',
  'await contextEngine.prepareRequest(session, {',
  'contextEngine?.onTurnUsage(sessionId, {',
  'contextEngine?.markIdle(sessionId);',
  'contextEngine.healToolCall(tc.name, tc.arguments || \'\')',
  'this.notifyHealed(sessionId, toolCallId, heal.healLog);',
  'private buildFallbackMessages(',
  'getSessionForContext(sessionId: string): Session | null',
  'persistSessionForContext(session: import(\'../context/types\').ContextSessionLike): void',
  'type UnifiedMessage',
]);
ok('session.ts 新字段与加载兼容', 'src/modules/agent/session.ts', [
  'envContext?: EnvContextInfo;',
  'compactions?: CompactionRecord[];',
  "import type { CompactionRecord, EnvContextInfo } from '../context/types';",
  '...(parsed.envContext ? { envContext: parsed.envContext } : {})',
  '...(Array.isArray(parsed.compactions) ? { compactions: parsed.compactions } : {})',
]);
ok('agent/index.ts 会话桥注入', 'src/modules/agent/index.ts', [
  'contextEngine?.bindSessionStore({',
  'this.engine.getSessionForContext(id)',
  'persistSessionForContext',
]);
ok('agent/context.ts 仅保留 buildTools', 'src/modules/agent/context.ts', [
  'export function buildTools(',
]);

console.log('\n===== C. 后端旧代码已删（负向） =====');
gone('session.ts 旧视图构建已迁出', 'src/modules/agent/session.ts', [
  'toUnifiedMessages',
  'computeContextWindow',
  'function sanitizeMessages',
  'trimContext',
]);
gone('agent/context.ts 旧系统提示构建已迁出', 'src/modules/agent/context.ts', [
  'buildSystemPrompt',
  'loadBasePrompt',
  'collectPromptVars',
  'cur_datetime',
]);
gone('engine.ts 旧三连已替换', 'src/modules/agent/engine.ts', [
  'buildSystemPrompt(this.env',
  'toUnifiedMessages',
  'sessions.trimContext',
  "import { buildSystemPrompt, buildTools }",
]);

console.log('\n===== D. 提示词文件（外部化 + 播种源） =====');
// main/ 下直接放扁平 .md（加载器只读 main/*.md，子目录内容不会生效）
file('存在 agent/prompts/main/system.md', 'agent/prompts/main/system.md');
file('存在 agent/prompts/main/identity.md', 'agent/prompts/main/identity.md');
file('存在 agent/prompts/compact/compaction.md', 'agent/prompts/compact/compaction.md');
file('存在 agent/prompts/heal/tool-error.md', 'agent/prompts/heal/tool-error.md');
absent('废弃子目录 main/system 已删除', 'agent/prompts/main/system');
absent('废弃子目录 main/base 已删除', 'agent/prompts/main/base');
absent('废弃子目录 main/rule 已删除', 'agent/prompts/main/rule');
absent('已移除功能目录 main/spec 已删除', 'agent/prompts/main/spec');
absent('已更名的 main/base.md 已删除', 'agent/prompts/main/base.md');
absent('已并入 system.md 的 main/rules.md 已删除', 'agent/prompts/main/rules.md');
ok('system.md 内容特征（环境指向 + 工具/指令/审美/专业场景 + 零动态变量）', 'agent/prompts/main/system.md', [
  '# 运行环境',
  '[环境上下文]',
  '# 工具调用与操作协议',
  '# 能力使用纪律',
  '# 约束分层与工作哲学',
  'L1 任务契约',
  '苏格拉底式提问',
  '# 平衡点',
  '双旋钮',
  '两阶段',
  '冒进熔断',
  '创作许可证',
  '发散期',
  '收敛期',
  '# 任务尺度与执行策略',
  '模块级',
  '# 指令遵循与精度保真',
  '事实源',
  '# 任务适应、质量标准与验证预算',
  '任务特征',
  '验证预算',
  '# 审美与设计质量',
  '# 专业场景优先',
  '# 执行纪律',
  '# 输出渲染',
  '第一性原理',
  '保留 completed 状态',
]);
gone('system.md 已无动态替换变量（环境信息迁往 env-context）', 'agent/prompts/main/system.md', [
  '{{PLATFORM}}',
  '{{CWD}}',
  '{{shell_info}}',
]);
ok('identity.md 内容特征（身份/延续性/知识边界）', 'agent/prompts/main/identity.md', [
  '# 身份',
  '# 延续性',
  '# Harness',
  '# 行为倾向',
  '# 知识边界',
]);
ok('compact/compaction.md 七段式 + FOCUS 变量', 'agent/prompts/compact/compaction.md', [
  '## 持续事实与约束',
  '## 目标',
  '## 决策与理由',
  '## 文件与代码',
  '## 命令与结果',
  '## 错误与修复',
  '## 待办与下一步',
  '{{FOCUS}}',
]);
ok('heal/tool-error.md 模板变量', 'agent/prompts/heal/tool-error.md', [
  '{{TOOL_NAME}}',
  '{{ISSUES}}',
  '{{USAGE}}',
  '{{CANDIDATES}}',
  '连续失败两次',
]);
ok('coder.md 验证预算与事实源', 'agent/prompts/agenteam/templates/coder.md', ['验证预算', '事实源']);
ok('explorer.md 事实源纪律', 'agent/prompts/agenteam/templates/explorer.md', ['文档与实现冲突']);
ok('reviewer.md 指令遵循', 'agent/prompts/agenteam/templates/reviewer.md', ['指令遵循']);
ok('skill 播种 v2 哈希清单', 'src/modules/tools/shared/skill-registry.ts', ['version: 2', 'userOwned', 'sha256']);
ok('skill 附属文件递归收集', 'src/modules/tools/shared/skill-registry.ts', ['collectSkillFiles', 'walk', 'SKILL.md']);
ok('prompt-loader 播种清单（compact/heal）', 'src/modules/context/prompt-loader.ts', [
  "'compact/compaction.md'",
  "'heal/tool-error.md'",
]);
gone('prompt-loader 已移除嵌套 main/ 播种路径', 'src/modules/context/prompt-loader.ts', [
  "'main/system/soul.md'",
  "'main/base/identity.md'",
  "'main/rule/rules.md'",
]);
ok('agent-seed 废弃路径清理清单 + rules.md 旧版指纹', 'src/modules/tools/shared/agent-seed.ts', [
  'DEPRECATED_SEED_PATHS',
  "'prompts/main/spec'",
  '9a80c5af645cf3feffacf6cfe936349424c19085fa0cfff09c1659c799b91928',
  'cleanupDeprecatedSeedPaths',
]);

console.log('\n===== E. 配置文件 =====');
{
  const raw = read('config/config.json');
  const cfg = JSON.parse(raw);
  const c = cfg.context;
  const checks = [
    ['compaction 段', c && c.compaction],
    ['compactRatio=0.8', c && c.compaction && c.compaction.compactRatio === 0.8],
    ['tailKeepRatio=0.16', c && c.compaction && c.compaction.tailKeepRatio === 0.16],
    ['summaryMaxTokens=8192', c && c.compaction && c.compaction.summaryMaxTokens === 8192],
    ['summaryModel=inherit', c && c.compaction && c.compaction.summaryModel === 'inherit'],
    ['toolPruning 段', c && c.toolPruning],
    ['healer 段', c && c.healer],
    ['telemetry 段', c && c.telemetry],
  ];
  for (const [name, cond] of checks) {
    if (cond) {
      passed++;
      console.log(`PASS config.json ${name}`);
    } else {
      failed++;
      console.error(`FAIL config.json ${name}`);
    }
  }
}

console.log('\n===== F. 前端落实（正向） =====');
ok('types/api.ts 上下文类型', 'webui/src/types/api.ts', [
  'export interface ContextEngineConfig {',
  'export interface CompactionRecord {',
  'export interface ContextStats {',
  'export interface CompactPreview {',
  'export interface ManualCompactResult {',
  'export interface SystemSection {',
  'compaction?: CompactionRecord;',
  'context?: ContextEngineConfig;',
]);
ok('types/index.ts 导航项', 'webui/src/types/index.ts', ["| 'context'"]);
ok('api/http.ts 5 个新接口 + 消息过滤', 'webui/src/api/http.ts', [
  'getContextStats:',
  'getCompactions:',
  'compactPreview:',
  'manualCompact:',
  'getSummaryModels:',
  'm.name === \'compaction-summary\'',
  'ContextStats,',
]);
ok('store 新状态', 'webui/src/store/index.ts', [
  'contextStatsBySession: Record<string, ContextStats | undefined>;',
  'setContextStats: (sessionId: string, stats: ContextStats) => void;',
  'contextStatsBySession: {},',
  'setContextStats: (sessionId, stats) =>',
]);
ok('useWebSocket 4 类事件消费', 'webui/src/hooks/useWebSocket.ts', [
  "case 'context-stats-updated':",
  "case 'compaction-started':",
  "case 'compaction-completed':",
  "case 'context-healed':",
  // 白屏修复：合并式写入（部分形状 payload 不得整体覆盖完整对象）
  'setContextStats(sessionId, {',
  'payload.systemSections ?? cur?.systemSections ?? []',
  'compaction_${compaction.id}',
]);
ok('CompactionCard 组件', 'webui/src/components/shared/CompactionCard.tsx', [
  'export const CompactionCard',
  'compaction.beforeTokens',
  'compaction.summary',
]);
// ===== 白屏修复回归断言（AI 回复完成后崩溃缺陷：三层防御） =====
ok('白屏修复: 后端 onTurnUsage 推送完整 getStats', 'src/modules/context/api/service.ts', [
  'const stats = this.getStats(sessionId);',
  "this.emitWs(sessionId, { type: 'context-stats-updated', sessionId, payload: stats })",
]);
gone('白屏修复: ContextStatsEventPayload 部分形状类型已删除', 'src/modules/context/types.ts', [
  'export interface ContextStatsEventPayload',
]);
ok('白屏修复: TaskPage 渲染层可选链', 'webui/src/components/pages/TaskPage.tsx', [
  'contextStats?.systemSections?.length',
  'contextStats?.compaction?.lastCompaction &&',
  'contextStats?.breakdown?.summary ? (',
  "contextStats.compaction?.lastCompaction?.summary ?? ''",
]);
ok('白屏修复: CompactionCard 数值防御', 'webui/src/components/shared/CompactionCard.tsx', [
  'const beforeTokens = compaction.beforeTokens ?? 0;',
  'const afterTokens = compaction.afterTokens ?? 0;',
  'compaction.compactedCount ?? 0',
  'compaction.durationMs ?? 0',
]);
ok('TaskPage 重构落实', 'webui/src/components/pages/TaskPage.tsx', [
  'const [compactDialogOpen, setCompactDialogOpen] = useState(false);',
  'const handleCompactClick = useCallback(',
  'const handleCompactConfirm = useCallback(',
  'function ContextStackedBar(',
  'function SystemSectionItem(',
  '<CompactionCard compaction={message.compaction} />',
  'api.getContextStats(taskId)',
  '.getCompactions(taskId)',
  'api.compactPreview(taskId)',
  'contextStats?.avgHitRate',
  'disabled={isGenerating || compacting || !taskId}',
  "import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';",
]);
ok('SettingsPage 上下文引擎设置区', 'webui/src/components/pages/SettingsPage.tsx', [
  'export function ContextSettings() {',
  'const CONTEXT_FALLBACK: ContextEngineConfig = {',
  "{ id: 'context', labelKey: 'settings.nav.context', Icon: Database },",
  "patchCompaction({ summaryModel: v })",
]);
ok('App.tsx 路由', 'webui/src/App.tsx', [
  'ContextSettings,',
  '<Route path="context" element={<ContextSettings />} />',
]);

console.log('\n===== G. 前端死代码已删（负向） =====');
{
  // 死代码特征1：无 onClick 的压缩按钮（原样三行 JSX）
  const deadButton = ['<Button variant="ghost" size="xs">', "{t('task.compress')}", '</Button>'].join('\n');
  const tp = read('webui/src/components/pages/TaskPage.tsx');
  const hasDeadButton = tp.includes(deadButton.replace(/\n/g, '\r\n')) || tp.includes(deadButton);
  if (!hasDeadButton) {
    passed++;
    console.log('PASS TaskPage 死代码压缩按钮已激活（带 onClick/disabled）');
  } else {
    failed++;
    console.error('FAIL TaskPage 仍存在无 onClick 的压缩按钮');
  }
  // 死代码特征2：others 空标签页
  if (!tp.includes("value=\"others\"") && !tp.includes('task.noOthers')) {
    passed++;
    console.log('PASS TaskPage others 空标签页已移除（动态分类替代）');
  } else {
    failed++;
    console.error('FAIL TaskPage 仍残留 others 空标签页');
  }
}

console.log('\n===== H. 中英 i18n 键对齐 =====');
/** 按精确缩进提取对象段的一级键（indent=4 + name='context' 匹配 settings 内段；indent=2 匹配顶层段） */
function extractSectionKeys(rel, indent, name) {
  const lines = read(rel).split(/\r?\n/);
  const keys = new Set();
  const pad = ' '.repeat(indent);
  const keyPad = ' '.repeat(indent + 2);
  const header = pad + name + ':';
  const closer = pad + '},';
  let inSection = false;
  for (const line of lines) {
    if (!inSection) {
      if (line.startsWith(header)) inSection = true;
      continue;
    }
    if (line.startsWith(closer)) break; // 段结束
    if (line.startsWith(keyPad)) {
      const m = /^(\w+):/.exec(line.slice(keyPad.length));
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}
function compareKeys(label, zhKeys, enKeys) {
  const zhOnly = [...zhKeys].filter((k) => !enKeys.has(k));
  const enOnly = [...enKeys].filter((k) => !zhKeys.has(k));
  if (zhKeys.size > 0 && zhOnly.length === 0 && enOnly.length === 0) {
    passed++;
    console.log(`PASS i18n 键对齐 ${label}（${zhKeys.size} 键）`);
  } else {
    failed++;
    console.error(
      `FAIL i18n 键不对齐 ${label}（zh=${zhKeys.size} 键, en=${enKeys.size} 键）—— 仅中文: [${zhOnly.join(', ')}] 仅英文: [${enOnly.join(', ')}]`,
    );
  }
}
compareKeys(
  'settings.context',
  extractSectionKeys('webui/src/i18n/locales/zh.ts', 4, 'context'),
  extractSectionKeys('webui/src/i18n/locales/en.ts', 4, 'context'),
);
compareKeys(
  '顶层 context',
  extractSectionKeys('webui/src/i18n/locales/zh.ts', 2, 'context'),
  extractSectionKeys('webui/src/i18n/locales/en.ts', 2, 'context'),
);
// modelSelector 完整性（此前编辑事故的回归检查）
ok('en.ts modelSelector 完整', 'webui/src/i18n/locales/en.ts', [
  "modelSelector: {",
  "title: 'Select Model'",
  'promoBanner',
  "contextWindow: 'Context Window'",
  "thinkingMode: 'Thinking Mode'",
]);

console.log(`\n===== 核验汇总: ${passed} passed, ${failed} failed =====`);
process.exit(failed > 0 ? 1 : 0);
