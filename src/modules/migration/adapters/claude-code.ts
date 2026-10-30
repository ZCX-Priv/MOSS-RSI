// src/modules/migration/adapters/claude-code.ts
// Claude Code 会话适配器：~/.claude/projects/<project-slug>/<session-uuid>.jsonl
//
// 实测行格式（每行一个 JSON 对象）：
//   {type:"session-meta", workDir, permissionMode, timestamp}
//   {type:"ai-title", aiTitle, timestamp}
//   {type:"user", message:{role:"user", content:[{type:"text",text} | {type:"tool_result",tool_use_id,content}]}, uuid, timestamp, cwd, isSidechain}
//   {type:"assistant", message:{role:"assistant", content:[{type:"thinking",thinking} | {type:"text",text} | {type:"tool_use",id,name,input}]}, uuid, timestamp}
//   {type:"system"} / {type:"file-history-snapshot"} / {type:"queue-operation"} → 跳过
//
// 子代理轨迹（isSidechain:true）不导入：它们属于主会话的执行细节，
// 导入后会被当成用户可见对话，噪音大于价值。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentMessage } from '../../contracts';
import type { ExternalSessionMeta, ExternalSourceId, ExternalTranscript, SessionAdapter } from './types';
import { asArray, asObject, asString, makeTitle, parseJsonLines } from './json';

/** tool_result.content 可能是字符串，也可能是 [{type:'text',text}] 数组 */
function toolResultText(content: unknown): string {
  const direct = asString(content);
  if (direct) return direct;
  const parts = asArray(content)
    .map((item) => {
      const block = asObject(item);
      if (!block) return '';
      return asString(block.text) ?? '';
    })
    .filter((s) => s.length > 0);
  return parts.join('\n');
}

/** 单文件扫描结果 */
interface ScanResult {
  meta: ExternalSessionMeta;
  messages: AgentMessage[];
  warnings: string[];
}

export class ClaudeCodeAdapter implements SessionAdapter {
  readonly id: ExternalSourceId = 'claude-code';
  readonly label = 'Claude Code';
  readonly rootDir: string;
  private readonly projectsDir: string;

  constructor(rootDir?: string) {
    // CLAUDE_CONFIG_DIR 是 Claude Code 官方的配置目录覆盖变量；rootDir 参数供测试注入
    this.rootDir = rootDir ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'));
    this.projectsDir = join(this.rootDir, 'projects');
  }

  available(): boolean {
    return existsSync(this.projectsDir);
  }

  list(): ExternalSessionMeta[] {
    if (!this.available()) return [];
    const files = this.collectFiles();
    const out: ExternalSessionMeta[] = [];
    for (const { sourceId, filePath } of files) {
      // 列表阶段不构建消息体（大文件下避免一次性驻留全部消息）
      const scan = this.scanFile(sourceId, filePath, false);
      if (scan) out.push(scan.meta);
    }
    // 最近更新的在前（与用户直觉一致）
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

  /** 枚举 projects/<slug>/<uuid>.jsonl；sourceId = "<slug>/<uuid>"（防跨项目同名冲突） */
  private collectFiles(): Array<{ sourceId: string; filePath: string }> {
    const out: Array<{ sourceId: string; filePath: string }> = [];
    for (const projectDir of readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      const absDir = join(this.projectsDir, projectDir.name);
      let names: string[];
      try {
        names = readdirSync(absDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const filePath = join(absDir, name);
        out.push({
          sourceId: `${projectDir.name}/${name.slice(0, -'.jsonl'.length)}`,
          filePath,
        });
      }
    }
    return out;
  }

  /** sourceId → 绝对路径（拒绝路径穿越） */
  private resolveSourceId(sourceId: string): string | null {
    const parts = sourceId.split('/');
    if (parts.length !== 2) return null;
    const [slug, sessionId] = parts;
    if (!slug || !sessionId || slug.includes('..') || sessionId.includes('..')) return null;
    const filePath = join(this.projectsDir, slug, `${sessionId}.jsonl`);
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
    let title: string | undefined;
    let firstUserText: string | undefined;
    let firstTs: string | undefined;
    let lastTs: string | undefined;
    // 列表阶段（buildMessages=false）不驻留消息体，但标题/消息数仍需正确
    let userCount = 0;
    let assistantCount = 0;

    parseJsonLines(
      raw,
      (obj) => {
        const ts = asString(obj.timestamp);
        if (ts) {
          if (!firstTs) firstTs = ts;
          lastTs = ts;
        }
        const type = asString(obj.type);
        switch (type) {
          case 'session-meta':
            cwd = cwd ?? asString(obj.workDir);
            break;
          case 'ai-title':
            title = title ?? asString(obj.aiTitle);
            break;
          case 'user': {
            if (obj.isSidechain === true) break;
            // tool_result 行会转成 role=tool 消息，不计入「对话消息数」
            if (!this.isToolResultLine(obj)) userCount++;
            cwd = cwd ?? asString(obj.cwd);
            firstUserText = firstUserText ?? this.extractUserText(obj);
            if (buildMessages) {
              const parsed = this.parseUserLine(obj, ts, warnings);
              if (parsed) messages.push(...parsed);
            }
            break;
          }
          case 'assistant': {
            assistantCount++;
            cwd = cwd ?? asString(obj.cwd);
            if (buildMessages) {
              const parsed = this.parseAssistantLine(obj, ts, warnings);
              if (parsed) messages.push(parsed);
            }
            break;
          }
          default:
            // system / file-history-snapshot / queue-operation 等：非对话内容
            break;
        }
      },
      warnings,
    );

    const now = new Date().toISOString();
    const meta: ExternalSessionMeta = {
      sourceId,
      title: makeTitle(title ?? firstUserText, `Claude Code · ${basename(sourceId)}`),
      ...(cwd ? { cwd } : {}),
      createdAt: firstTs ?? now,
      updatedAt: lastTs ?? firstTs ?? now,
      messageCount: buildMessages
        ? messages.filter((m) => m.role === 'user' || m.role === 'assistant').length
        : userCount + assistantCount,
    };
    return { meta, messages, warnings };
  }

  /** 该 user 行是否只承载工具结果（列表阶段的计数口径据此排除） */
  private isToolResultLine(obj: Record<string, unknown>): boolean {
    const message = asObject(obj.message);
    if (!message) return false;
    return asArray(message.content).some((item) => asString(asObject(item)?.type) === 'tool_result');
  }

  /** 轻量提取该行首个用户文本（列表阶段仅用于生成标题，不构建消息） */
  private extractUserText(obj: Record<string, unknown>): string | undefined {
    const message = asObject(obj.message);
    if (!message) return undefined;
    const plain = asString(message.content);
    if (plain) return plain;
    for (const item of asArray(message.content)) {
      const block = asObject(item);
      if (!block) continue;
      if (asString(block.type) === 'text') {
        const text = asString(block.text);
        if (text) return text;
      }
    }
    return undefined;
  }

  /** user 行：text block 合并为一条用户消息；tool_result 各自成为一条 tool 消息 */
  private parseUserLine(
    obj: Record<string, unknown>,
    timestamp: string | undefined,
    warnings: string[],
  ): AgentMessage[] | null {
    const message = asObject(obj.message);
    if (!message) return null;
    const content = message.content;
    // 兼容字符串形态（部分老版本直接存纯文本）
    const plain = asString(content);
    if (plain) {
      return [{ role: 'user', content: plain, ...(timestamp ? { timestamp } : {}) }];
    }

    const texts: string[] = [];
    const out: AgentMessage[] = [];
    for (const item of asArray(content)) {
      const block = asObject(item);
      if (!block) continue;
      const blockType = asString(block.type);
      if (blockType === 'text') {
        const text = asString(block.text);
        if (text) texts.push(text);
      } else if (blockType === 'tool_result') {
        const toolCallId = asString(block.tool_use_id);
        if (!toolCallId) {
          warnings.push('tool_result without tool_use_id');
          continue;
        }
        out.push({
          role: 'tool',
          content: toolResultText(block.content),
          toolCallId,
          ...(timestamp ? { timestamp } : {}),
          ...(block.is_error === true ? { isError: true } : {}),
        });
      }
      // 其余 block（image 等）不属于文本对话，忽略
    }
    if (texts.length > 0) {
      out.unshift({ role: 'user', content: texts.join('\n\n'), ...(timestamp ? { timestamp } : {}) });
    }
    return out.length > 0 ? out : null;
  }

  /** assistant 行：thinking / text / tool_use 合并为一条 assistant 消息（保持单轮语义） */
  private parseAssistantLine(
    obj: Record<string, unknown>,
    timestamp: string | undefined,
    warnings: string[],
  ): AgentMessage | null {
    const message = asObject(obj.message);
    if (!message) return null;
    const plain = asString(message.content);
    if (plain) {
      return { role: 'assistant', content: plain, ...(timestamp ? { timestamp } : {}) };
    }

    const texts: string[] = [];
    const thinking: string[] = [];
    const toolCalls: NonNullable<AgentMessage['toolCalls']> = [];
    for (const item of asArray(message.content)) {
      const block = asObject(item);
      if (!block) continue;
      const blockType = asString(block.type);
      if (blockType === 'text') {
        const text = asString(block.text);
        if (text) texts.push(text);
      } else if (blockType === 'thinking') {
        const text = asString(block.thinking);
        if (text) thinking.push(text);
      } else if (blockType === 'tool_use') {
        const id = asString(block.id);
        const name = asString(block.name);
        if (!id || !name) {
          warnings.push('tool_use missing id/name');
          continue;
        }
        // MOSS 的 arguments 是 JSON 字符串（与 UnifiedToolCall.function.arguments 对齐）
        toolCalls.push({ id, name, arguments: JSON.stringify(block.input ?? {}) });
      }
    }

    if (texts.length === 0 && thinking.length === 0 && toolCalls.length === 0) return null;
    return {
      role: 'assistant',
      content: texts.join('\n\n'),
      ...(thinking.length > 0 ? { thinking: thinking.join('\n\n') } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(timestamp ? { timestamp } : {}),
    };
  }
}
