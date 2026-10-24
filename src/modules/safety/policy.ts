// src/modules/safety/policy.ts
// 统一权限决策管线（按用户决策裁剪）。
//
// 九步流水线（短路返回）：
//   1. 工具 disabled            → DENY  {disabled}
//   1.5 终端命令 .moss 越界   → DENY  {mossAccess}（全局硬规则，skip 也拦）
//   2. mode === 'skip'          → ALLOW {mode}      （用户决策：真全放行，仅查禁用）
//   3. deny 规则命中(会话>全局)  → DENY  {rule}
//   4. ask 规则命中(会话>全局)   → ASK   {rule}
//   5. 沙箱检测：
//      a. 终端 BLOCK 级危险命令 → DENY {dangerousCommand}
//      b. 终端 CAUTION 级       → ASK/配 deny {cautionCommand}
//      c. 写类工具保护路径        → DENY {protectedPath}（含 ~/.moss/config 硬保护）
//   6. allow 规则命中(会话>全局) → ALLOW {rule}
//   7. mode === 'auto'          → L0/L1/L2 ? ALLOW : ASK {mode}
//   8. mode === 'ask'(默认)     → L0/L1 ? ALLOW : ASK {default}（fail-closed：未知工具归 L3）

import type {
  SafetyDecision,
  SafetyRequest,
  SafetyRules,
  RiskClass,
  PermissionMode,
} from './types';
import { matchRule } from './rules';
import { matchDangerousCommand, matchProtectedPath, isHardProtectedPath, matchMossTerminalAccess } from './patterns';
import { SYSTEM_SCOPE } from '../filesys/roots';

/** 内置工具风险分类表（按操作可恢复性；fail-closed：未知工具归 L3） */
const READONLY_TOOLS = new Set(['read', 'glob', 'grep']);
const STATE_TOOLS = new Set(['ask', 'todo']);
const RECOVERABLE_WRITE_TOOLS = new Set(['write', 'edit', 'move', 'delete', 'copy']);
const UNSAFE_TOOLS = new Set(['terminal']);

/**
 * computer 观察类动作：只读屏幕/UIA/窗口列表，不产生外部副作用 → L0。
 * 其余动作（点击/输入/启动/剪贴板写/批量）一律 L3（fail-closed）。
 */
const COMPUTER_OBSERVE_ACTIONS = new Set([
  'status',
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_desktop_state',
  'get_screen_size',
  'get_cursor_position',
  'zoom',
  'wait',
]);

/**
 * 风险分级：按工具名 + 注解综合判定。
 * 合并工具（memory/mcp/skill）按 params.action 分级，保持合并前的风险语义：
 *   memory: save=L3 / search|list_rooms=L0
 *   mcp:    list=L0 / call=L3（未标注 MCP 工具 fail-closed，保持合并前调用工具的风险等级）
 *   skill:  list|use=L0
 */
export function classifyRisk(
  req: Pick<SafetyRequest, 'toolName' | 'params' | 'annotations' | 'mcpAnnotations'>,
): RiskClass {
  const { toolName } = req;
  if (READONLY_TOOLS.has(toolName)) return 'L0';

  // 合并工具：按 action 分级（单工具单份 annotations 无法表达混合语义）
  const action = (req.params as { action?: string } | null | undefined)?.action;
  if (toolName === 'computer') {
    return COMPUTER_OBSERVE_ACTIONS.has(action ?? '') ? 'L0' : 'L3';
  }
  if (toolName === 'memory') return action === 'save' ? 'L3' : 'L0';
  if (toolName === 'mcp') return action === 'list' ? 'L0' : 'L3';
  if (toolName === 'skill') return 'L0';
  // context：会话级状态操作（压缩/历史检索），无文件或外部副作用 → L1（ask 模式放行）
  if (toolName === 'context') return 'L1';

  if (STATE_TOOLS.has(toolName)) return 'L1';
  if (RECOVERABLE_WRITE_TOOLS.has(toolName)) return 'L2';
  if (UNSAFE_TOOLS.has(toolName)) return 'L3';
  // MCP 直调工具（mcp__ 前缀）：按 MCP 注解
  const mcpAnno = req.mcpAnnotations;
  if (toolName.startsWith('mcp__')) {
    if (mcpAnno?.readOnlyHint === true && mcpAnno.destructiveHint !== true) return 'L0';
    if (mcpAnno?.destructiveHint === true) return 'L3';
    return 'L3'; // 未标注的 MCP 工具 fail-closed
  }
  // 其他工具（含 custom）：按注解兜底，未标注归 L3（fail-closed）
  const anno = req.annotations;
  if (anno?.readOnlyHint === true && anno.destructiveHint !== true) return 'L0';
  if (anno?.destructiveHint === true) return 'L3';
  return 'L3';
}

/** 空规则表（默认值） */
const EMPTY_RULES: SafetyRules = { allow: [], deny: [], ask: [] };

export interface PolicyEnv {
  /** 会话级规则（可 undefined） */
  sessionRules?: SafetyRules;
  /** 全局规则（config.safety.rules） */
  globalRules?: SafetyRules;
  /** 危险命令拦截开关 */
  blockDangerousCommands: boolean;
  /** CAUTION 级策略 */
  cautionPolicy: 'ask' | 'deny';
  /** 可配置保护路径（已展开 ~ 前缀的绝对路径列表） */
  protectedPaths: string[];
  /** 用户主目录 */
  home: string;
  /** 系统作用域（本机模式）的相对路径基准：Windows 为系统盘根（C:\），POSIX 为 / */
  systemRoot: string;
  /** MOSS 配置目录（~/.moss/config 硬保护） */
  configDir: string;
  /** MOSS 数据目录（~/.moss；终端命令 .moss 访问检测用） */
  dataDir: string;
}

/**
 * 统一决策入口（纯函数）。
 * 规则求值顺序：会话层 > 全局层（会话规则先查）。
 */
export function evaluate(req: SafetyRequest, env: PolicyEnv): SafetyDecision {
  // 1. 工具禁用
  if (!req.enabled) {
    return { action: 'deny', reason: { type: 'disabled' } };
  }

  // 1.5 终端命令 .moss 访问检测（全局硬规则，skip 模式也拦——用户明确要求；
  // 防止终端命令绕过 filesys 层 isMossAccessAllowed 读写 AI 自身配置/存储）
  if (req.toolName === 'terminal') {
    const cmd = (req.params as { command?: unknown } | null)?.command;
    if (typeof cmd === 'string' && cmd.trim()) {
      const hit = matchMossTerminalAccess(cmd, env.home, env.dataDir);
      if (hit) {
        return { action: 'deny', reason: { type: 'mossAccess', pattern: hit } };
      }
    }
  }

  // 2. skip：全放行（用户决策：仅查禁用）
  if (req.mode === 'skip') {
    return { action: 'allow', reason: { type: 'mode', mode: 'skip' } };
  }

  const sessionRules = env.sessionRules ?? EMPTY_RULES;
  const globalRules = env.globalRules ?? EMPTY_RULES;
  const isTerminal = req.toolName === 'terminal';
  // System 作用域哨兵下规则路径匹配以系统盘根为基准（与 filesys 相对路径解析一致）
  const ruleCwd = req.cwd === SYSTEM_SCOPE ? env.systemRoot : req.cwd;

  // 3. deny 规则（会话 > 全局）
  for (const rule of [...sessionRules.deny, ...globalRules.deny]) {
    if (matchRule(rule, req.toolName, req.params, ruleCwd, 'restrictive')) {
      return { action: 'deny', reason: { type: 'rule', rule } };
    }
  }

  // 4. ask 规则（会话 > 全局）
  for (const rule of [...sessionRules.ask, ...globalRules.ask]) {
    if (matchRule(rule, req.toolName, req.params, ruleCwd, 'restrictive')) {
      return { action: 'ask', reason: { type: 'rule', rule } };
    }
  }

  // 5a/5b. 危险命令智能拦截（仅 terminal）
  if (isTerminal && env.blockDangerousCommands) {
    const cmd = (req.params as { command?: unknown } | null)?.command;
    if (typeof cmd === 'string' && cmd.trim()) {
      const hit = matchDangerousCommand(cmd);
      if (hit) {
        if (hit.level === 'block') {
          return { action: 'deny', reason: { type: 'dangerousCommand', pattern: hit.label } };
        }
        // caution 级：按策略
        if (env.cautionPolicy === 'deny') {
          return { action: 'deny', reason: { type: 'cautionCommand', pattern: hit.label } };
        }
        return { action: 'ask', reason: { type: 'cautionCommand', pattern: hit.label } };
      }
    }
  }

  // 5c. 保护路径（写类工具；含 ~/.moss/config 硬保护）
  const risk = classifyRisk(req);
  if (risk === 'L2') {
    if (isHardProtectedPath(req.params, env.home, env.configDir)) {
      return { action: 'deny', reason: { type: 'protectedPath', pattern: env.configDir } };
    }
    const hitPath = matchProtectedPath(req.params, env.protectedPaths, env.home);
    if (hitPath) {
      return { action: 'deny', reason: { type: 'protectedPath', pattern: hitPath } };
    }
  }

  // 6. allow 规则（会话 > 全局）
  for (const rule of [...sessionRules.allow, ...globalRules.allow]) {
    if (matchRule(rule, req.toolName, req.params, ruleCwd, 'permissive')) {
      return { action: 'allow', reason: { type: 'rule', rule } };
    }
  }

  // 7/8. 模式语义（按风险分级决策矩阵）
  if (req.mode === 'auto') {
    // 自动审批：L0/L1/L2 放行（L2 有回收站/备份兜底），L3 仍确认
    if (risk === 'L0' || risk === 'L1' || risk === 'L2') {
      return { action: 'allow', reason: { type: 'mode', mode: 'auto' } };
    }
    return { action: 'ask', reason: { type: 'mode', mode: 'auto' } };
  }

  // ask（默认）：L0/L1 放行，其余确认（fail-closed）
  if (risk === 'L0' || risk === 'L1') {
    return { action: 'allow', reason: { type: 'default', mode: 'ask' } };
  }
  return { action: 'ask', reason: { type: 'default', mode: 'ask' } };
}

/** 模式合法性收窄（'ask'|'auto'|'skip'；非法值回退 'ask'） */
export function normalizeMode(mode: unknown): PermissionMode {
  return mode === 'auto' || mode === 'skip' ? mode : 'ask';
}
