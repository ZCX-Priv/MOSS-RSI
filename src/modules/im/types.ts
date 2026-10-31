// src/modules/im/types.ts
// IM 连接模块的类型定义：渠道描述符、存储结构、归一化消息、适配器接口、状态快照。
// 设计原则：适配器只负责「平台协议 ↔ 归一化消息」，业务准入与 agent 执行全部收敛在 gateway。

import type { Logger } from '../../core/types';

/** 支持的 IM 渠道（与前端 webui/src/types/api.ts 保持一致） */
export type ImChannelId =
  | 'wechat-ilink'
  | 'qq-official';

/** 通用表单字段（设置页按此渲染，避免每个渠道写一套表单组件） */
export interface ImFormField {
  key: string;
  label: string;
  /** text=普通输入；password=密文（编辑时留空保留旧值）；number=数字；select=下拉 */
  type: 'text' | 'password' | 'number' | 'select';
  required: boolean;
  placeholder?: string;
  /** select 选项 */
  options?: Array<{ value: string; label: string }>;
  /** 默认值（新增时预填） */
  defaultValue?: string;
}

/** 渠道描述符：设置页表单 + 能力声明 + 凭据校验 */
export interface ImChannelDescriptor {
  id: ImChannelId;
  label: string;
  /** 接入指引（设置页展示，中文直接可读；前端 i18n 未覆盖时原样显示） */
  guide: string;
  fields: ImFormField[];
  capabilities: {
    /** 是否支持 markdown 发送（否则走纯文本化） */
    markdown: boolean;
    /** 是否支持群聊 */
    group: boolean;
    /** 是否支持扫码接入 */
    qrLogin: boolean;
  };
  /** 校验凭据并返回平台身份（新增/编辑保存前调用） */
  verify(credentials: Record<string, string>): Promise<ImVerifiedIdentity>;
}

export interface ImVerifiedIdentity {
  /** 平台侧稳定身份（用于派生 botId 与去重） */
  platformId: string;
  /** 展示名（优先平台返回的机器人名） */
  name: string;
  /** 附加信息（如平台连接地址） */
  extra?: Record<string, string>;
}

/** 机器人配置（持久化到 ~/.moss/im/bots.json） */
export interface StoredImBot {
  botId: string;
  channel: ImChannelId;
  name: string;
  platformId: string;
  /** 平台凭据（明文仅存 bots.json；接口返回时脱敏） */
  credentials: Record<string, string>;
  enabled: boolean;
  /** 6 位配对码（用户在 IM 私聊发送 /bind <码> 完成绑定） */
  pairingCode: string;
  options: ImBotOptions;
  createdAt: string;
  updatedAt: string;
}

export interface ImBotOptions {
  /** 工作目录；缺省/空串 = '__system__'（本机全盘） */
  cwd: string;
  /** 权限模式：unset=首次任务时询问（默认）；auto=自动审批；skip=完全访问；ask=需要人工确认 */
  permissionMode: 'unset' | 'auto' | 'skip' | 'ask';
  /** 群聊触发：mention=仅 @机器人；all=群内全部消息 */
  groupTrigger: 'mention' | 'all';
  /** 过程播报：把工具调用逐条推送为 IM 消息（默认开启） */
  progress: boolean;
  /** 指定 agent 配置；空 = 默认 agent */
  agentId?: string;
}

/** 回复目标：渠道自有字段的透明容器（由适配器读写） */
export interface ImReplyTarget {
  channel: ImChannelId;
  kind: 'direct' | 'group';
  [key: string]: unknown;
}

/**
 * 统一媒体引用：各渠道适配器负责实现 load（带鉴权/解密），gateway 统一暂存。
 * 闭包不进入任何 API/持久化，只活在后端内存。
 */
export interface ImMediaRef {
  kind: 'image' | 'file' | 'video' | 'audio';
  name?: string;
  size?: number;
  mimeType?: string;
  load(signal?: AbortSignal): Promise<Buffer>;
}

/** 统一消息段（跨渠道消息链模型） */
export type ImSegment =
  | { type: 'text'; text: string }
  | { type: 'at'; userId: string; displayName?: string }
  | { type: 'image'; media: ImMediaRef }
  | { type: 'file'; media: ImMediaRef; name: string; size?: number }
  | { type: 'video'; media: ImMediaRef }
  | { type: 'audio'; media: ImMediaRef; transcript?: string }
  | { type: 'reply'; messageId: string; senderName?: string }
  | { type: 'face'; id: string }
  | { type: 'forward'; title?: string; nodes: ImSegment[][] }
  | { type: 'unknown'; raw: unknown };

/** 归一化入站消息 */
export interface ImInboundMessage {
  botId: string;
  channel: ImChannelId;
  messageId: string;
  /** direct:<senderId> | group:<chatId> */
  conversationKey: string;
  kind: 'direct' | 'group';
  senderId: string;
  senderName: string;
  /** 统一消息段（文本/媒体/引用等） */
  segments: ImSegment[];
  /** 由 segments 派生的纯文本（命令解析与无附件时的 prompt） */
  text: string;
  /** 群聊是否 @ 机器人 */
  addressed: boolean;
  replyTo?: { messageId: string; senderName?: string };
  replyTarget: ImReplyTarget;
  receivedAt: string;
}

/** 适配器上报的运行状态 */
export interface ImRuntimeStatus {
  connected: boolean;
  lastError: string | null;
  lastMessageAt: string | null;
  received: number;
  replied: number;
  /** 需要展示连接地址的渠道 */
  extra?: Record<string, string>;
}

export interface ImAdapterContext {
  bot: StoredImBot;
  logger: Logger;
  signal: AbortSignal;
  onMessage(message: ImInboundMessage): void;
  /** 适配器连接态变化（connected / error 等） */
  onStatus(patch: Partial<ImRuntimeStatus>): void;
  /** 长轮询类渠道的持久化游标（如微信 get_updates_buf），重启后可续接 */
  cursor?: { get(): string; set(value: string): void };
}

export interface ImChannelAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(target: ImReplyTarget, text: string): Promise<void>;
  /** 切换「正在输入」状态；不支持的渠道/会话直接 no-op */
  setTyping?(target: ImReplyTarget, active: boolean): Promise<void>;
}

/** 前端状态快照（不含凭据） */
export interface ImBotStatusSnapshot {
  botId: string;
  channel: ImChannelId;
  name: string;
  enabled: boolean;
  state: 'connected' | 'connecting' | 'offline' | 'error';
  platformIdMasked: string;
  hasCredentials: boolean;
  lastError: string | null;
  lastMessageAt: string | null;
  stats: { received: number; replied: number };
  options: ImBotOptions;
  pairingCode: string;
  boundUsers: Array<{ id: string; name: string; boundAt: string }>;
  /** 非密文字段回显（AppId / 端口等，便于编辑时预填；不含 secret/token） */
  credentialPreview: Record<string, string>;
  extra?: Record<string, string>;
}

export interface ImStatusSnapshot {
  bots: ImBotStatusSnapshot[];
  totals: { configured: number; connected: number };
}

/** 绑定关系 */
export interface ImBinding {
  id: string;
  name: string;
  boundAt: string;
}

/** 会话映射（一聊天一任务） */
export interface ImConversation {
  taskId: string;
  sessionId: string;
  title: string;
  updatedAt: string;
}
