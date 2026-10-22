// src/modules/terminal/output-store.ts
// 命令完整输出落盘：发给模型的是精简摘要，完整原文保存在这里，模型可按 ref 用 read 工具读取。
// 目录：<dataDir>/terminal-output/<sessionId>/<terminalId>/*.log
// - 单终端保留最近 MAX_FILES 个文件（每个命令一个），避免无限增长；
// - 任何失败都静默降级（不返回路径，不影响命令执行/结果返回）。

import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 单终端保留的完整输出文件数上限（每个文件对应一次命令） */
const MAX_FILES = 50;

/** 文件名安全化（terminalId 只含字母数字下划线，防御性处理） */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** 时间戳文件名（可排序） */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 清理目录中最旧的文件，只保留最近 MAX_FILES 个 */
async function prune(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.log')).sort();
    if (names.length <= MAX_FILES) return;
    for (const name of names.slice(0, names.length - MAX_FILES)) {
      await unlink(join(dir, name)).catch(() => undefined);
    }
  } catch {
    /* 清理失败不影响保存 */
  }
}

/**
 * 保存一次命令的完整输出，返回文件绝对路径；失败返回 null。
 * 只有大输出才需要调用（小输出直接返回摘要即可）。
 */
export async function saveTerminalOutput(
  dataDir: string,
  sessionId: string,
  terminalId: string,
  text: string,
): Promise<string | null> {
  try {
    const dir = join(dataDir, 'terminal-output', safeName(sessionId), safeName(terminalId));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${timestamp()}-${Math.random().toString(36).slice(2, 8)}.log`);
    await writeFile(file, text, 'utf8');
    void prune(dir);
    return file;
  } catch {
    return null;
  }
}
