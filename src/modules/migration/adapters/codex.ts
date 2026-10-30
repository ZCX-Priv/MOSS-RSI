// src/modules/migration/adapters/codex.ts
// Codex CLI 会话适配器：~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//
// 每行 {timestamp, type, payload}，type ∈ session_meta / turn_context / response_item / event_msg
// response_item.payload.type：
//   message               → {role:'user'|'assistant', content:[{type:'input_text'|'output_text', text}]}
//   reasoning             → {summary:[{text}]} / {content:[{text}]}
//   function_call         → {name, arguments, call_id}
//   function_call_output  → {call_id, output}
// turn_context / event_msg 不参与对话重建（event_msg 是 UI 事件副本，与 response_item 重复）。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '../../contracts';
import type { ExternalSessionMeta, ExternalSourceId, ExternalTranscript, SessionAdapter } from './types';
import { asArray, asObject, asString, makeTitle, parseJsonLines } from './json';

/** Codex 注入的上下文块（开发指令/环境上下文）不属于用户对话，导入时剔除 */
const INJECTED_PREFIXES = ['<user_instructions>', '<environment_context>', '# AGENTS.md'];

function isInjected(text: string): boolean {
  const trimmed = text.trimStart();
  return INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** function_call_output.output 可能是字符串，也可能是 {content, success} 对象 */
function outputText(output: unknown): string {
  const direct = asString(output);
  if (direct) return direct;
  const obj = asObject(output);
  if (!obj) return '';
  const content = asString(obj.content);
  if (content) return content;
  const stdout = asString(obj.stdout);
  if (stdout) return stdout;
  try {
    return JSON.stringify(obj);
  } catch {
    return '';
  }
}

interface ScanResult {
  meta: ExternalSessionMeta;
  messages: AgentMessage[];
  warnings: string[];
}

export class CodexAdapter implements SessionAdapter {
  readonly id: ExternalSourceId = 'codex';
  readonly label = 'Codex';
  readonly rootDir: string;
  private readonly sessionsDir: string;

  constructor(rootDir?: string) {
    // CODEX_HOME 官方覆盖变量；rootDir 参数供测试注入
    this.rootDir = rootDir ?? (process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'));
    this.sessionsDir = join(this.rootDir, 'sessions');
  }

  available(): boolean {
    return existsSync(this.sessionsDir);
  }

  list(): ExternalSessionMeta[] {
    if (!this.available()) return [];
    const out: ExternalSessionMeta[] = [];
    for (const { sourceId, filePath } of this.collectFiles()) {
      const scan = this.scanFile(sourceId, filePath, false);
      if (scan) out.push(scan.meta);
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  read(sourceId: string): ExternalTranscript | null {
    const filePath = this.resolveSourceId(sourceId);
    if (!filePath) return null;
    const scan = this.scanFile(sourceId, filePath, true);
    if (!scan) return null;
    return { meta: scan.meta, messages: scan.messages, warnings: scan.warnings };
  }

  /** 递归枚举 sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl；sourceId = 相对 sessions 的路径（不含 .jsonl） */
  private collectFiles(): Array<{ sourceId: string; filePath: string }> {
    const out: Array<{ sourceId: string; filePath: string }> = [];
    const walk = (absDir: string, relDir: string, depth: number): void => {
      if (depth > 4) return; // 结构固定为 YYYY/MM/DD，留一层余量
      let entries: Array<{ name: string; isDir: boolean }>;
      try {
        entries = readdirSync(absDir, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isDir: d.isDirectory(),
        }));
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDir) {
          walk(join(absDir, entry.name), rel, depth + 1);
        } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          out.push({ sourceId: rel.slice(0, -'.jsonl'.length), filePath: join(absDir, entry.name) });
        }
      }
    };
    walk(this.sessionsDir, '', 0);
    return out;
  }

  /** sourceId → 绝对路径（拒绝路径穿越） */
  private resolveSourceId(sourceId: string): string | null {
    if (sourceId.includes('..') || sourceId.startsWith('/') || sourceId.startsWith('\\')) return null;
    const filePath = join(this.sessionsDir, `${sourceId}.jsonl`);
    if (!existsSync(filePath)) return null;
    try {
      if (!statSync(filePath).isFile()) return null;
    } catch {
      return null;
    }
    return filePath;
  }

  private scanFile(sourceId: string, filePath: string, buildMessages: boolean): ScanResult | null {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }

    const messages: AgentMessage[] = [];
    const warnings: string[] = [];
    let cwd: string | undefined;
    let firstUserText: string | undefined;
    let firstTs: string | undefined;
    let lastTs: string | undefined;
    let userCount = 0;
    let assistantCount = 0;
    /** reasoning 块悬挂到下一条 assistant 消息（Codex 把思考与回答拆成两行） */
    let pendingThinking: string[] = [];

    parseJsonLines(
      raw,
      (obj) => {
        const ts = asString(obj.timestamp);
        if (ts) {
          if (!firstTs) firstTs = ts;
          lastTs = ts;
        }
        const type = asString(obj.type);
        const payload = asObject(obj.payload);
        if (!payload) return;

        if (type === 'session_meta') {
          cwd = cwd ?? asString(payload.cwd);
          return;
        }
        if (type === 'turn_context') {
          cwd = cwd ?? asString(payload.cwd);
          return;
        }
        if (type !== 'response_item') return;

        const itemType = asString(payload.type);
        if (itemType === 'message') {
          const role = asString(payload.role);
          if (role !== 'user' && role !== 'assistant') return; // developer/system 注入
          const texts = asArray(payload.content)
            .map((entry) => {
              const block = asObject(entry);
              return block ? asString(block.text) ?? '' : '';
            })
            .filter((t) => t.length > 0);
          const text = texts.join('\n\n');
          if (!text) return;
          if (role === 'user' && isInjected(text)) return;

          if (role === 'user') {
            userCount++;
            firstUserText = firstUserText ?? text;
            if (buildMessages) {
              messages.push({ role: 'user', content: text, ...(ts ? { timestamp: ts } : {}) });
            }
          } else {
            assistantCount++;
            if (buildMessages) {
              messages.push({
                role: 'assistant',
                content: text,
                ...(pendingThinking.length > 0 ? { thinking: pendingThinking.join('\n\n') } : {}),
                ...(ts ? { timestamp: ts } : {}),
              });
            }
            pendingThinking = [];
          }
          return;
        }

        if (itemType === 'reasoning') {
          const parts = asArray(payload.summary)
            .map((entry) => {
              const block = asObject(entry);
              return block ? asString(block.text) ?? '' : '';
            })
            .filter((t) => t.length > 0);
          if (parts.length > 0) pendingThinking.push(parts.join('\n'));
          return;
        }

        if (itemType === 'function_call') {
          const name = asString(payload.name);
          const callId = asString(payload.call_id) ?? asString(payload.id);
          const args = payload.arguments;
          if (!name || !callId) {
            warnings.push('function_call missing name/call_id');
            return;
          }
          const argsText =
            typeof args === 'string' ? args : (() => {
              try {
                return JSON.stringify(args ?? {});
              } catch {
                return '{}';
              }
            })();
          if (buildMessages) {
            messages.push({
              role: 'assistant',
              content: '',
              toolCalls: [{ id: callId, name, arguments: argsText }],
              ...(pendingThinking.length > 0 ? { thinking: pendingThinking.join('\n\n') } : {}),
              ...(ts ? { timestamp: ts } : {}),
            });
          }
          pendingThinking = [];
          assistantCount++;
          return;
        }

        if (itemType === 'function_call_output') {
          const callId = asString(payload.call_id);
          if (!callId) {
            warnings.push('function_call_output missing call_id');
            return;
          }
          if (buildMessages) {
            messages.push({
              role: 'tool',
              toolCallId: callId,
              content: outputText(payload.output),
              ...(ts ? { timestamp: ts } : {}),
            });
          }
          return;
        }
      },
      warnings,
    );

    const now = new Date().toISOString();
    const meta: ExternalSessionMeta = {
      sourceId,
      title: makeTitle(firstUserText, `Codex · ${sourceId.split('/').pop() ?? sourceId}`),
      ...(cwd ? { cwd } : {}),
      createdAt: firstTs ?? now,
      updatedAt: lastTs ?? firstTs ?? now,
      messageCount: buildMessages
        ? messages.filter((m) => m.role === 'user' || m.role === 'assistant').length
        : userCount + assistantCount,
    };
    return { meta, messages, warnings };
  }
}
