// src/modules/migration/manifest.ts
// 备份包内容清单与配置清洗规则。
//
// 剔除原则（不写入备份包）：
//   - 跨机器不可复用：browser/（浏览器二进制+扩展）、models/（语音模型权重）、
//     remote/bin（cloudflared）、agent/attachments（本机绝对路径引用）、computer/（截图）
//   - 运行时可再生：file-index/（索引缓存）、logs/、live/（流式草稿）、
//     terminals/、terminal-output/、terminal-cmds/、moss.pid、ui-state.json
//   - 绑定本机状态：file-history/（备份文件按绝对路径索引）、extensions.json（插件启停）、
//     automations-history.json（执行历史）
//   - 单列为「不支持的插件」一并剔除。

import type { AppConfig, ApiConfig } from '../../core/types';

/** 目录型条目（相对 dataDir）：整目录递归收集 */
export const BACKUP_DIRS = [
  'tasks',
  'todo',
  'commands',
  'skills',
  'mcps',
  'memory',
  'agenteam',
] as const;

/** 文件型条目（相对 dataDir）：单文件收集 */
export const BACKUP_FILES = ['task.json', 'automations.json'] as const;

/** 额外窄目录（相对 dataDir）：只收这些子目录，避免把 agent/attachments 带进包 */
export const BACKUP_SUBDIRS = ['agent/prompts'] as const;

/** 配置文件（经清洗后写入，不直接拷贝原文件） */
export const BACKUP_CONFIG_FILE = 'config/config.json';
export const BACKUP_API_FILE = 'config/api.json';

/** 递归收集时跳过的目录名（技能仓库/版本库等噪声） */
export const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.DS_Store']);

/** 备份包元信息（zip 内 manifest.json） */
export interface BackupManifest {
  formatVersion: number;
  createdAt: string;
  platform: string;
  /** 各资源条目数量（供导入前预览） */
  counts: Record<string, number>;
}

export const MANIFEST_ENTRY = 'manifest.json';
export const MANIFEST_FORMAT_VERSION = 1;

/** 备份包内文件统一前缀：data/<相对 ~/.moss 的路径> */
export const DATA_PREFIX = 'data/';

/**
 * 应用配置清洗：剔除所有本机绑定字段。
 * 这些值写入目标机后会造成端口冲突、token 失配、路径不存在或隧道凭据混用。
 */
export function sanitizeAppConfig(cfg: AppConfig): Record<string, unknown> {
  const out = { ...(cfg as unknown as Record<string, unknown>) };
  delete out.remote;
  delete out.voice;
  delete out.daemon;

  const server = cfg.server ? { ...(cfg.server as Record<string, unknown>) } : null;
  if (server) {
    delete server.host;
    delete server.port;
    delete server.autoPort;
    out.server = server;
  }
  const security = cfg.security ? { ...(cfg.security as Record<string, unknown>) } : null;
  if (security) {
    // 鉴权令牌与实例绑定，且回传/导入会破坏目标机前端 token
    delete security.authToken;
    out.security = security;
  }
  const agent = cfg.agent ? { ...(cfg.agent as Record<string, unknown>) } : null;
  if (agent) {
    delete agent.workingDirectory;
    out.agent = agent;
  }
  const filesys = cfg.filesys ? { ...(cfg.filesys as unknown as Record<string, unknown>) } : null;
  if (filesys) {
    delete filesys.roots;
    out.filesys = filesys;
  }
  return out;
}

/**
 * 服务商配置清洗：includeSecrets=false 时抹掉 apiKey。
 * 默认（用户已确认）包含密钥——备份包整体加密，泄露风险由加密容器兜住。
 */
export function sanitizeApiConfig(cfg: ApiConfig, includeSecrets: boolean): Record<string, unknown> {
  const out = { ...(cfg as unknown as Record<string, unknown>) };
  if (!includeSecrets) {
    out.providers = cfg.providers.map((p) => ({ ...p, apiKey: '' }));
  }
  return out;
}

/** 导入时可被合并的应用配置顶层键白名单（其余键（含未知键）一律忽略） */
export const MERGEABLE_CONFIG_KEYS = new Set([
  'logs',
  'update',
  'agent',
  'tools',
  'mcpServers',
  'mcp',
  'mcpServer',
  'skills',
  'commands',
  'fileHistory',
  'filesys',
  'safety',
  'context',
  'web',
]);

/** 解析 manifest.json；结构不合规返回 null */
export function parseManifest(raw: unknown): BackupManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const formatVersion = obj.formatVersion;
  if (typeof formatVersion !== 'number' || formatVersion < 1) return null;
  return {
    formatVersion,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : '',
    platform: typeof obj.platform === 'string' ? obj.platform : '',
    counts:
      obj.counts && typeof obj.counts === 'object'
        ? (obj.counts as Record<string, number>)
        : {},
  };
}
