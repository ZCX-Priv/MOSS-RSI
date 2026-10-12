// tools/terminal/index.ts
// terminal 工具 execute 逻辑：缺省在会话「默认终端」内执行命令（持久终端，复用状态）；
// 另有 create/send/read/list/kill/restart 显式动作。
// - 缺省（exec）：复用同一持久终端执行命令（cwd/环境变量等状态在命令间保持），终端在终端页可见。
// - create 仅用于需要并行执行多个独立命令时；send 指定 terminalId 在额外终端内执行。
// - restart 重启默认终端（清空状态 / 卡死恢复）。
// filesys 统一化：
//   - cwd 解析走 filesys roots（与 read/write/edit 一致）
//   - 执行前后工作区快照检测（beginTerminalSnapshot/endTerminalSnapshot）：命令造成的文件变更纳入
//     file-history（缓存命中可 undo）+ terminal-changed 事件
// 元数据见同目录 tool.json。

import { t } from '../../../core/i18n';
import { ServiceNames } from '../../../core/types';
import { statSync } from 'node:fs';
import type { FilesysService, TerminalChangeReport, TerminalService } from '../../contracts';
import { SYSTEM_SCOPE, systemRoot } from '../../filesys/roots';
import { resolveInterpreter } from '../../terminal/interpreter';
import type { InterpreterKind, TerminalInfo } from '../../terminal/types';
import type { ToolContext, ToolResult } from '../types';

/** terminal 工具输入参数 */
interface TerminalParams {
  /** 操作类型（缺省 exec：在默认终端内执行 command） */
  action?: 'exec' | 'create' | 'send' | 'read' | 'list' | 'kill' | 'restart';
  command?: string;
  terminalId?: string;
  cwd?: string;
  timeout?: number;
  /** 解释器类型：实际可用性以 env-probe 实测为准（系统提示「终端环境」段），不可用时回退默认 */
  interpreter?: InterpreterKind;
}

/** 统一的工具结果文本 */
function textResult(text: string, isError = false, metadata?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError,
    ...(metadata ? { metadata } : {}),
  };
}

/** 错误信息归一 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 终端状态展示串 */
function statusLabel(info: TerminalInfo): string {
  return info.running ? t('tools.terminalStatusRunning') : t('tools.terminalStatusExited', { code: info.exitCode ?? 0 });
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as TerminalParams;
    const action = p.action ?? 'exec';

    // filesys 服务（cwd 越权语义与 read/write/edit 一致）
    const filesys = ctx.services.tryResolve<FilesysService>(ServiceNames.FILESYS);
    if (!filesys) {
      return textResult(`Error: ${t('filesys.serviceUnavailable')}`, true);
    }

    if (action === 'exec') {
      return handleRun(p, ctx, filesys);
    }
    return handlePersistent(action, p, ctx, filesys);
  },
};

/** cwd 解析：filesys roots 机制；System 作用域未指定时默认系统盘根 */
function resolveCwd(cwd: string | undefined, ctx: ToolContext, filesys: FilesysService): string | null {
  return cwd
    ? filesys.resolve(cwd, ctx.cwd)
    : ctx.cwd === SYSTEM_SCOPE
      ? systemRoot()
      : ctx.cwd || process.cwd();
}

/** 校验并解析工作目录（越界/不存在/非目录 → 返回错误文本，否则返回绝对路径） */
function resolveCwdOrError(
  cwd: string | undefined,
  ctx: ToolContext,
  filesys: FilesysService,
): { cwd: string } | { error: string } {
  const resolved = resolveCwd(cwd, ctx, filesys);
  if (resolved === null) {
    return { error: t('fs.pathOutsideRoots', { path: cwd ?? '', roots: '' }) };
  }
  try {
    if (!statSync(resolved).isDirectory()) {
      return { error: t('tools.terminalCwdNotDir', { path: resolved }) };
    }
  } catch {
    return { error: t('tools.terminalCwdNotExist', { path: resolved }) };
  }
  return { cwd: resolved };
}

/** 缺省动作：在会话默认终端内执行命令（复用持久终端，状态保持） */
async function handleRun(p: TerminalParams, ctx: ToolContext, filesys: FilesysService): Promise<ToolResult> {
  const command = p.command;
  if (!command || !command.trim()) {
    return textResult(`Error: ${t('tools.terminalCommandRequired')}`, true);
  }

  const svc = ctx.services.tryResolve<TerminalService>(ServiceNames.TERMINAL);
  if (!svc) {
    return textResult(`Error: ${t('tools.terminalServiceUnavailable')}`, true);
  }

  const cwdRes = resolveCwdOrError(p.cwd, ctx, filesys);
  if ('error' in cwdRes) return textResult(`Error: ${cwdRes.error}`, true);

  const rawTimeout = p.timeout ?? (ctx.toolConfig?.timeout as number | undefined) ?? 30_000;
  const timeoutMs = Math.max(1000, Math.min(600_000, rawTimeout));

  // 选择目标终端：默认复用会话默认终端；仅当请求了「另一种解释器」时才另起终端（不改默认）
  let info: TerminalInfo;
  let explicitNew = false;
  // 请求的解释器解析后的实际类型（不可用时回退默认）——据此判断是否与默认终端同类，避免误判导致反复新建
  const requestedKind = p.interpreter
    ? resolveInterpreter(process.platform === 'win32', p.interpreter).kind
    : undefined;
  try {
    const defaultId = svc.getDefaultId(ctx.sessionId);
    const defaultInfo = defaultId ? svc.get(defaultId) : undefined;
    const sameInterpreter = !requestedKind || !defaultInfo || defaultInfo.interpreterKind === requestedKind;
    if (!defaultInfo || sameInterpreter) {
      info = await svc.ensureDefault({
        sessionId: ctx.sessionId,
        cwd: cwdRes.cwd,
        interpreter: p.interpreter,
        creator: 'ai',
      });
    } else {
      info = await svc.create({
        sessionId: ctx.sessionId,
        cwd: cwdRes.cwd,
        interpreter: p.interpreter,
        creator: 'ai',
      });
      explicitNew = true;
    }
  } catch (err) {
    return textResult(`Error: ${t('tools.terminalActionFailed', { message: errText(err) })}`, true);
  }

  // 请求的解释器不可用而回退默认时，明确回告模型（避免其继续按错误语法/反复请求新建）
  const fallbackNote =
    p.interpreter && requestedKind !== p.interpreter
      ? `\n${t('tools.terminalInterpreterFallback', { requested: p.interpreter, actual: info.interpreterLabel })}`
      : '';

  const startedAt = Date.now();
  const snap = await filesys.beginTerminalSnapshot(info.cwd);
  try {
    const res = await svc.run(info.id, command, timeoutMs);
    const workspaceNote = await finishSnapshot(filesys, snap, ctx);

    const header = t('tools.terminalRunHeader', { title: info.title, status: statusLabel(res.info) });
    const explicitNote = explicitNew
      ? `\n${t('tools.terminalRunExplicitTerminal', { id: info.id, label: info.interpreterLabel })}`
      : '';
    const timeoutNote = res.completed ? '' : `\n${t('tools.terminalRunTimeoutInterrupted', { timeoutMs })}`;
    const body = res.output.trim() ? res.output : t('tools.terminalEmpty');

    const isError = res.exitCode !== undefined && res.exitCode !== 0;
    return textResult(`${header}${explicitNote}${fallbackNote}\n${body}${timeoutNote}${workspaceNote}`, isError, {
      terminalId: info.id,
      cwd: info.cwd,
      running: res.info.running,
      completed: res.completed,
      ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    return textResult(`Error: ${t('tools.terminalActionFailed', { message: errText(err) })}`, true);
  }
}

/** 显式动作（create/send/read/list/kill/restart） */
async function handlePersistent(
  action: 'create' | 'send' | 'read' | 'list' | 'kill' | 'restart',
  p: TerminalParams,
  ctx: ToolContext,
  filesys: FilesysService,
): Promise<ToolResult> {
  const svc = ctx.services.tryResolve<TerminalService>(ServiceNames.TERMINAL);
  if (!svc) {
    return textResult(`Error: ${t('tools.terminalServiceUnavailable')}`, true);
  }

  try {
    // list：列出本会话终端（标注默认终端）
    if (action === 'list') {
      const list = svc.list(ctx.sessionId);
      if (list.length === 0) return textResult(t('tools.terminalListEmpty'));
      const defaultId = svc.getDefaultId(ctx.sessionId);
      const header = t('tools.terminalListHeader', { count: list.length });
      const rows = list.map((it) => {
        const marker = it.id === defaultId ? `\t${t('tools.terminalDefaultMarker')}` : '';
        return `${it.id}\t${it.title}\t${statusLabel(it)}\t${it.cwd}${marker}`;
      });
      return textResult([header, ...rows].join('\n'), false, { terminals: list, defaultId });
    }

    // restart：重启会话默认终端（清空状态 / 卡死恢复）
    if (action === 'restart') {
      const cwdRes = resolveCwdOrError(p.cwd, ctx, filesys);
      if ('error' in cwdRes) return textResult(`Error: ${cwdRes.error}`, true);
      const info = await svc.restartDefault({
        sessionId: ctx.sessionId,
        cwd: cwdRes.cwd,
        interpreter: p.interpreter,
        creator: 'ai',
      });
      svc.focus(info.id);
      return textResult(
        t('tools.terminalRestartResult', { id: info.id, label: info.interpreterLabel, cwd: info.cwd }),
        false,
        { terminalId: info.id },
      );
    }

    const terminalId = p.terminalId?.trim();
    if (!terminalId) {
      return textResult(`Error: ${t('tools.terminalIdRequired', { action })}`, true);
    }

    if (action === 'kill') {
      const ok = svc.close(terminalId);
      if (!ok) return textResult(`Error: ${t('terminal.notFound', { id: terminalId })}`, true);
      return textResult(t('tools.terminalKillResult', { id: terminalId }), false, { terminalId });
    }

    if (action === 'read') {
      const info = svc.get(terminalId);
      if (!info) return textResult(`Error: ${t('terminal.notFound', { id: terminalId })}`, true);
      const snap = svc.snapshot(terminalId) ?? '';
      const recent = snap.length > 8000 ? snap.slice(-8000) : snap;
      const body = recent.trim() ? recent.trimEnd() : t('tools.terminalEmpty');
      return textResult(
        `${t('tools.terminalReadHeader', { id: terminalId, status: statusLabel(info) })}\n${body}`,
        false,
        { terminalId, running: info.running, exitCode: info.exitCode },
      );
    }

    if (action === 'create') {
      const cwdRes = resolveCwdOrError(p.cwd, ctx, filesys);
      if ('error' in cwdRes) return textResult(`Error: ${cwdRes.error}`, true);
      const info = await svc.create({
        sessionId: ctx.sessionId,
        cwd: cwdRes.cwd,
        interpreter: p.interpreter,
        creator: 'ai',
      });
      svc.focus(info.id);
      return textResult(
        t('tools.terminalCreateResult', { id: info.id, label: info.interpreterLabel, cwd: info.cwd }),
        false,
        { terminalId: info.id, interpreter: info.interpreterLabel, pty: info.pty },
      );
    }

    // action === 'send'：在指定终端内执行命令（含工作区快照）
    const command = p.command;
    if (!command || !command.trim()) {
      return textResult(`Error: ${t('tools.terminalCommandRequired')}`, true);
    }
    const info = svc.get(terminalId);
    if (!info) return textResult(`Error: ${t('terminal.notFound', { id: terminalId })}`, true);

    const rawTimeout = p.timeout ?? (ctx.toolConfig?.timeout as number | undefined) ?? 30_000;
    const timeoutMs = Math.max(1000, Math.min(600_000, rawTimeout));

    const snap = await filesys.beginTerminalSnapshot(info.cwd);
    const res = await svc.run(terminalId, command, timeoutMs);
    const workspaceNote = await finishSnapshot(filesys, snap, ctx);

    const header = t('tools.terminalSendHeader', { id: terminalId, status: statusLabel(res.info) });
    const timeoutNote = res.completed ? '' : `\n${t('tools.terminalRunTimeoutInterrupted', { timeoutMs })}`;
    const body = res.output.trim() ? res.output : t('tools.terminalEmpty');
    const isError = res.exitCode !== undefined && res.exitCode !== 0;
    return textResult(`${header}\n${body}${timeoutNote}${workspaceNote}`, isError, {
      terminalId,
      running: res.info.running,
      completed: res.completed,
      ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
    });
  } catch (err) {
    return textResult(
      `Error: ${t('tools.terminalActionFailed', { message: errText(err) })}`,
      true,
    );
  }
}

/** 执行后快照：diff 工作区变更 + 缓存回填备份 + terminal-changed 事件；返回可读的变更摘要 */
async function finishSnapshot(
  filesys: FilesysService,
  snap: Awaited<ReturnType<FilesysService['beginTerminalSnapshot']>>,
  ctx: ToolContext,
): Promise<string> {
  if (!snap) return '';
  const changes: TerminalChangeReport | null = await filesys.endTerminalSnapshot(
    snap,
    ctx.sessionId,
    ctx.toolCallId,
  );
  if (!changes) return '';
  const count = changes.created.length + changes.modified.length + changes.deleted.length;
  if (count === 0) return '';
  const brief = (items: string[], label: string): string =>
    items.length === 0 ? '' : `\n  ${label} (${items.length}): ${items.slice(0, 5).join(', ')}${items.length > 5 ? ', ...' : ''}`;
  return (
    `\n${t('tools.terminalWorkspaceChanges')}` +
    brief(changes.created, t('tools.terminalChangeCreated')) +
    brief(changes.modified, t('tools.terminalChangeModified')) +
    brief(changes.deleted, t('tools.terminalChangeDeleted')) +
    (changes.truncated
      ? t('tools.terminalUndoableTruncated', { undone: changes.undone, count })
      : t('tools.terminalUndoable', { undone: changes.undone, count }))
  );
}