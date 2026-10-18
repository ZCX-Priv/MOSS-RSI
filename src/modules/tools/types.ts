// src/modules/tools/types.ts
// 工具系统类型定义。

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /** 是否需要用户确认 */
  requireConfirmation?: boolean;
}

/** JSONSchema 简化表示 */
export interface JSONSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  additionalProperties?: boolean | JSONSchema;
  [key: string]: unknown;
}

/** tool.json 的 config.schema 简化字段类型描述 */
export interface ConfigFieldSchema {
  type: 'boolean' | 'integer' | 'string';
  min?: number;
  max?: number;
}

/** tool.json 的 config 段（工具运行时可配置参数声明） */
export interface ToolConfigManifest {
  defaults: Record<string, unknown>;
  schema?: Record<string, ConfigFieldSchema>;
}

export interface Tool {
  name: string;
  description: string;
  /** 英文描述（tool.json description_en；en locale 且存在时替代 description 暴露给 LLM/UI） */
  descriptionEn?: string;
  inputSchema: JSONSchema;
  annotations?: ToolAnnotations;
  /** 显示图标（lucide 图标 kebab-case 名，如 'file-text'；前端白名单映射，缺失回退扳手） */
  icon?: string;
  execute(params: unknown, ctx: ToolContext): Promise<ToolResult>;
  /** 工具来源目录绝对路径（热重载增量定位用，由加载器注入） */
  sourceDir?: string;
  /** 工具来源类型（builtin=内置，custom=用户自定义，由加载器注入） */
  source?: 'builtin' | 'custom';
  /** tool.json 的 config 段（defaults + schema，由加载器注入；供 API 暴露可编辑参数定义） */
  configManifest?: ToolConfigManifest;
}

/** ask 工具候选项 */
export interface AskOption {
  /** 选项标识（LLM 生成，如 "a"/"postgres"） */
  value: string;
  /** 选项显示文本 */
  label: string;
  /** 选项补充说明（可选，前端渲染为次行小字） */
  description?: string;
}

/** ask 回答类型：text=自由文本（缺省）、single=单选、multi=多选、boolean=是/否、form=动态表单 */
export type AskAnswerType = 'text' | 'single' | 'multi' | 'boolean' | 'form';

/** ask 工具单个问题（归一化后的最小单元） */
export interface AskQuestion {
  /** 稳定标识（q0/q1…，归一化时生成；供前端按题对齐回答） */
  id: string;
  /** 问题文本 */
  question: string;
  /** 回答类型（缺省 text） */
  answerType?: AskAnswerType;
  /** answerType 为 single/multi 时的候选项（2-6 个） */
  options?: AskOption[];
  /** 预填文本（可选） */
  defaultAnswer?: string;
  /** answerType=form 时的 JSON Schema（MCP elicitation Form 模式：string/number/boolean/enum） */
  formSchema?: Record<string, unknown>;
  /** agent 侧题面附件（文件绝对路径，前端渲染为附件卡片并可预览） */
  attachments?: string[];
}

/** ask 工具提问载荷（归一化后一律用 questions；旧扁平字段仅作单题兼容） */
export interface AskPayload {
  /** 归一化后的提问列表（至少 1 题） */
  questions: AskQuestion[];
  /** @deprecated 单题兼容：旧调用点传入的单题，工具内归一化为 questions[0] */
  question?: string;
  /** @deprecated 单题兼容 */
  answerType?: AskAnswerType;
  /** @deprecated 单题兼容 */
  options?: AskOption[];
  /** @deprecated 单题兼容 */
  defaultAnswer?: string;
  /** @deprecated 单题兼容 */
  formSchema?: Record<string, unknown>;
}

/** ask 工具用户回答结果（对应单个问题） */
export interface AskAnswer {
  /** 选中的选项 value 列表（single 为 0/1 个，multi 为 0-N 个） */
  selectedValues?: string[];
  /** 选中的选项显示文本列表（含用户编辑后的文本） */
  selectedLabels?: string[];
  /** 用户编辑过的选项：value → 编辑后的 label */
  editedLabels?: Record<string, string>;
  /** 「其他」自由输入文本 */
  otherText?: string;
  /** text 类型的自由回答文本（线格式：可能内联 `#<绝对路径>` 文件引用） */
  text?: string;
  /** form 类型的表单回答（字段名 → 值；MCP elicitation） */
  form?: Record<string, string | number | boolean>;
  /** 用户侧附件绝对路径（粘贴/选择的文件） */
  attachments?: string[];
}

/** ask 工具结局：accept=用户已回答，cancel=用户取消提问 */
export interface AskOutcome {
  action: 'accept' | 'cancel';
  /** 逐题回答（answers[i] 与当前 toolCall 的 questions[i] 按下标对齐；merge 场景每个 toolCall 仅 1 题） */
  answers?: AskAnswer[];
}

export interface ToolContext {
  sessionId: string;
  cwd: string;
  /** 工具调用 ID */
  toolCallId: string;
  /** 通过事件总线发送进度事件 */
  emit: (event: ToolEvent) => void;
  logger: import('../../core/types').Logger;
  /** 服务注册表（用于访问 MCPManager、SkillRegistry 等服务） */
  services: import('../../core/types').ServiceRegistry;
  /** 中断信号 */
  signal?: AbortSignal;
  /** 向用户提问并阻塞等待回复（若运行环境不支持交互则 undefined） */
  askUser?: (payload: AskPayload) => Promise<AskOutcome>;
  /** 请求用户确认（返回 boolean）。requireConfirmation 工具执行前会调用；未提供且需确认时保守拒绝。 */
  confirm?: (question: string) => Promise<boolean>;
  /** 当前工具的配置（从 config.tools[name] 读取，供工具消费如 timeout/requireConfirmation） */
  toolConfig?: Record<string, unknown>;
  /** safety 模块已放行标记：agent 链路决策 allow 或 ask 用户同意后置 'allowed'，registry 据此跳过内部 requireConfirmation（非 agent 链路仍走兜底确认） */
  permissionDecision?: 'allowed';
}

export type ToolEvent =
  | { type: 'progress'; message: string }
  | { type: 'confirm-required'; message: string; details?: unknown };

export type ToolResultContent =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { data: string; mimeType: string };
      /** 图片文件绝对路径（base64 不落库，会话仅记录路径，发送时按路径读盘编码） */
      path?: string;
    };

export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
  /** 工具执行的元信息（如耗时、退出码） */
  metadata?: Record<string, unknown>;
}

/** 帮助函数：构造文本结果 */
export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/** 帮助函数：构造错误结果 */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
