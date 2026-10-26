// src/modules/terminal/types.ts
// 终端模块契约：持久终端（原生 PTY，缺失时管道回退）服务。
// 由 terminal 模块实现并注册到 ServiceNames.TERMINAL；WS（人类交互）与 terminal 工具（agent）共用。

/** 终端解释器类型（与 terminal 工具 interpreter 参数对齐；值为真实可执行程序族） */
export type InterpreterKind = 'powershell' | 'cmd' | 'bash';

/** 终端创建者（'ai' = agent 经 terminal 工具创建；'user' = 人类经 WS 创建） */
export type TerminalCreator = 'user' | 'ai';

/** 公开的终端信息（前端 / 工具消费） */
export interface TerminalInfo {
  /** 终端唯一 id */
  id: string;
  /** 归属会话 id（事件按会话路由） */
  sessionId: string;
  /** 展示标题（AI 创建时带 `[AI] ` 前缀） */
  title: string;
  /** 解释器展示名（PowerShell / CMD / Git Bash …） */
  interpreterLabel: string;
  /** 解释器类型 */
  interpreterKind: InterpreterKind;
  /** 创建者 */
  creator: TerminalCreator;
  /** 启动时的工作目录（绝对路径） */
  cwd: string;
  /** 是否运行中 */
  running: boolean;
  /** 退出码（运行中为 null） */
  exitCode: number | null;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 是否使用原生 PTY（false = 管道降级） */
  pty: boolean;
  /**
   * Windows ConPTY 兼容信息（前端 xterm 的 `windowsPty` 参数；非 Windows / 非 PTY 不提供）。
   * 随 terminal.created 单帧下发，避免前端在 terminal.list 之前创建 xterm 时拿不到而
   * 退回错误的 reflow 行为（cmd 错位/重复的根因之一）。
   */
  ptyBackend?: { backend: 'conpty'; buildNumber: number };
  /** 仅剩历史（后端进程已重启，终端本体不存在）：只读回放，不可输入 */
  offline?: boolean;
}

export interface TerminalCreateOptions {
  sessionId: string;
  /** 工作目录（绝对路径；越界由调用方先经 filesys 校验） */
  cwd?: string;
  /** 终端列数（默认 80） */
  cols?: number;
  /** 终端行数（默认 24） */
  rows?: number;
  /** 自定义标题（缺省用解释器展示名 + 序号） */
  title?: string;
  /** 解释器类型（缺省用平台默认） */
  interpreter?: InterpreterKind;
  /** 创建者（缺省 'user'；AI 创建时标题加 `[AI] ` 前缀） */
  creator?: TerminalCreator;
}

/** 命令执行结果（terminal 工具 send 的返回） */
export interface TerminalRunResult {
  /** 该次命令的输出（已剥离完成标记行） */
  output: string;
  /** 执行后终端状态 */
  info: TerminalInfo;
  /** 是否在超时前等到完成标记 */
  completed: boolean;
  /** 完整清洗输出的落盘路径（仅大输出提供；模型可按 ref 用 read 工具读取全文） */
  outputRef?: string;
  /** 完整清洗输出的总行数 */
  totalLines?: number;
  /** 完整清洗输出的总字符数 */
  totalChars?: number;
  /** 命令退出状态（由标记行解析；解析不到时为 undefined） */
  exitCode?: number;
  /** 被调用方中止（AbortSignal / 工具取消）：命令已发 Ctrl+C，输出为中止前已产生的部分 */
  aborted?: boolean;
  /** shell 停在续行提示符（命令语法不完整，如缺少右括号/引号），已由看门狗取消 */
  syntaxIncomplete?: boolean;
  /** 连续超时后会话默认终端已被自动重启（下一次 exec 落在新终端） */
  restarted?: boolean;
}

/** 终端服务接口（ServiceNames.TERMINAL） */
export interface TerminalService {
  /** 新建持久终端 */
  create(opts: TerminalCreateOptions): Promise<TerminalInfo>;
  /** 会话默认终端：存在且未关闭则复用；否则按 opts 创建并记为默认 */
  ensureDefault(opts: TerminalCreateOptions): Promise<TerminalInfo>;
  /** 重启默认终端：关闭旧默认（若有）后重新创建，并记为默认 */
  restartDefault(opts: TerminalCreateOptions): Promise<TerminalInfo>;
  /** 会话默认终端 id（无则 undefined） */
  getDefaultId(sessionId: string): string | undefined;
  /** 广播 terminal.focus（前端据此同步聚焦终端标签） */
  focus(id: string): void;
  /** 写入原始输入（键盘/命令） */
  write(id: string, data: string): boolean;
  /** 调整终端尺寸 */
  resize(id: string, cols: number, rows: number): boolean;
  /** 关闭终端（结束进程 + 清理缓冲） */
  close(id: string): boolean;
  /** 查询单个终端 */
  get(id: string): TerminalInfo | undefined;
  /** 列出某会话全部终端 */
  list(sessionId: string): TerminalInfo[];
  /** 当前输出快照（等待 headless 解析完成后返回，供订阅/重连/读取全文） */
  snapshotAsync(id: string): Promise<string | undefined>;
  /** 在终端内执行一条命令并等待完成标记，返回该次输出（signal 中止 → Ctrl+C 并提前返回） */
  run(id: string, command: string, timeoutMs?: number, signal?: AbortSignal): Promise<TerminalRunResult>;
  /** 登记运行中的工具调用 → 终端 id（前端停止按钮用） */
  registerRun(toolCallId: string, terminalId: string): void;
  /** 注销运行登记 */
  unregisterRun(toolCallId: string): void;
  /** 向该 toolCall 对应的终端发送 Ctrl+C；找不到返回 false */
  interruptRun(toolCallId: string): boolean;
  /** 把一段文本保存为该终端的完整输出文件（返回路径；失败 null） */
  saveOutput(id: string, text: string): Promise<string | null>;
  /** 清理某会话全部终端（会话删除 / 进程退出时） */
  disposeSession(sessionId: string): void;
}

/** 终端模块运行参数（常量，暂不接入 config schema） */
export const TERMINAL_LIMITS = {
  /** 单会话最大终端数 */
  maxPerSession: 8,
  /** 每终端输出环形缓冲上限（字符） */
  bufferChars: 200_000,
  /** 命令默认超时（ms） */
  defaultTimeoutMs: 30_000,
  /** 默认终端尺寸 */
  defaultCols: 80,
  defaultRows: 24,
} as const;