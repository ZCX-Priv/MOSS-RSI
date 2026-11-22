// src/modules/agent-bus/types.ts
// 多智能体总线契约：成员树、消息、收件箱、审计快照。
// 供 AgentEngine / SubagentRunner / tools / server 与前端共享（前端有独立副本）。

export type AgentBusMemberKind = 'main' | 'subagent';
export type AgentBusMemberStatus = 'running' | 'completed' | 'failed' | 'aborted';

/** 总线成员（一次运行 = 一个成员；完成/失败后保留供面板回看） */
export interface AgentBusMember {
  /** 树内短 id：主代理固定 'main'，子代理 'a1'/'a2'... */
  agentId: string;
  sessionId: string;
  kind: AgentBusMemberKind;
  template?: string;
  name: string;
  /** 任务摘要（≤200 字符） */
  task: string;
  cwd: string;
  depth: number;
  parentSessionId?: string;
  parentAgentId?: string;
  /** 父会话中触发本次运行的 agent 工具调用 id（前端卡片精确关联） */
  parentToolCallId?: string;
  rootSessionId: string;
  status: AgentBusMemberStatus;
  startedAt: string;
  finishedAt?: string;
  finishReason?: string;
  error?: string;
}

/** 总线消息（chat=协作对话；result=子代理完成回执；system=系统通知） */
export interface AgentBusMessage {
  id: string;
  rootSessionId: string;
  fromAgentId: string;
  fromSessionId: string;
  fromName: string;
  /** null = 频道广播 */
  toAgentId: string | null;
  toSessionId: string | null;
  channel: string;
  kind: 'chat' | 'result' | 'system';
  content: string;
  createdAt: string;
  delivered: boolean;
  /** 白板消息类型（历史审计可能缺失） */
  boardKind?: AgentBoardNoteKind;
}

export interface AgentBusSnapshot {
  members: AgentBusMember[];
  messages: AgentBusMessage[];
  /** 白板规则（讨论已进入 messages；历史审计可能缺失） */
  board?: { rules: AgentBoardNote[] };
}

/** 共享白板条目类型：rule=主代理设定的根本性原则；discussion=大群讨论 */
export type AgentBoardNoteKind = 'rule' | 'discussion';

/** 共享白板条目（任务树级持久化；进程重启后可恢复） */
export interface AgentBoardNote {
  id: string;
  rootSessionId: string;
  kind: AgentBoardNoteKind;
  /** rule 必填：按标题覆盖（upsert） */
  title?: string;
  content: string;
  authorAgentId: string;
  authorSessionId: string;
  authorName: string;
  createdAt: string;
  updatedAt?: string;
}

/** 共享白板快照（rules=全部规则；discussion=最近 N 条讨论） */
export interface AgentBoardSnapshot {
  rootSessionId: string;
  rules: AgentBoardNote[];
  discussion: AgentBoardNote[];
}

/** 写入白板输入 */
export interface PostBoardNoteInput {
  fromSessionId: string;
  kind: AgentBoardNoteKind;
  title?: string;
  content: string;
}

/** 写入白板结果 */
export interface PostBoardNoteResult {
  note?: AgentBoardNote;
  /** 本次实时投递到收件箱的运行中成员数 */
  delivered: number;
  error?: string;
}

/** 注册/更新成员输入（同 sessionId 为 upsert） */
export interface RegisterAgentInput {
  sessionId: string;
  kind: AgentBusMemberKind;
  template?: string;
  name: string;
  task: string;
  cwd: string;
  parentSessionId?: string;
  parentToolCallId?: string;
  depth?: number;
}

/** 发送消息输入 */
export interface SendAgentMessageInput {
  fromSessionId: string;
  /** 'all' | 'parent' | agentId（main/a1/a2） | sessionId */
  to: string;
  content: string;
  kind?: 'chat' | 'result';
}

export interface SendAgentMessageResult {
  delivered: number;
  recipients: AgentBusMember[];
  error?: string;
}

/** 多智能体总线服务契约（ServiceNames.AGENT_BUS） */
export interface AgentBus {
  register(input: RegisterAgentInput): AgentBusMember;
  update(
    sessionId: string,
    patch: Partial<Pick<AgentBusMember, 'status' | 'finishedAt' | 'finishReason' | 'error'>>,
  ): void;
  get(sessionId: string): AgentBusMember | null;
  getByParentToolCall(toolCallId: string): AgentBusMember | null;
  list(rootSessionId?: string): AgentBusMember[];
  send(input: SendAgentMessageInput): SendAgentMessageResult;
  /** 取出并标记已投递（引擎在 run 开始 / 每轮工具后调用） */
  drainInbox(sessionId: string): AgentBusMessage[];
  /** 内存 + 审计文件合并快照（按 id 去重；成员账本仅在指定 root 时合并） */
  snapshot(rootSessionId?: string, opts?: { limit?: number }): AgentBusSnapshot;
  /** 读取任务树共享白板（规则全量 + 最近讨论） */
  readBoard(rootSessionId: string): AgentBoardSnapshot;
  /** 写入白板：rule 仅主代理；discussion 所有成员 */
  postBoard(input: PostBoardNoteInput): PostBoardNoteResult;
  /** 删除白板规则（仅主代理） */
  removeBoardNote(input: { fromSessionId: string; id: string }): { ok: boolean; error?: string };
}
