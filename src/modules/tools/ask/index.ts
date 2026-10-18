// tools/ask/index.ts
// ask 工具 execute 逻辑：向用户提问并阻塞等待回复（支持单次多题 + 双向附件）。
// 返回给 LLM 的固定格式为「问题 + 用户回答（+ 附件路径）」，保证上下文完整。
// 元数据见同目录 tool.json。

import { t } from '../../../core/i18n';
import type {
  AskAnswer,
  AskOption,
  AskOutcome,
  AskPayload,
  AskQuestion,
  ToolContext,
  ToolResult,
} from '../types';

const VALID_ANSWER_TYPES = new Set(['text', 'single', 'multi', 'boolean', 'form']);
const MAX_QUESTIONS = 6;

/** 单题回答 → 人类可读文本（不含附件行） */
function formatAnswer(answerType: AskQuestion['answerType'], a: AskAnswer): string {
  const other = a.otherText?.trim();
  switch (answerType) {
    case 'boolean': {
      // boolean 与 single 同构：前端回传 selectedValues=['yes'|'no']
      const v = a.selectedValues?.[0] ?? a.selectedLabels?.[0];
      return v === undefined || v === ''
        ? other
          ? t('tools.askOther', { text: other })
          : t('tools.askNoAnswer')
        : v === 'yes' || v === '是'
          ? t('tools.askYes')
          : v === 'no' || v === '否'
            ? t('tools.askNo')
            : String(v);
    }
    case 'single': {
      const label = a.selectedLabels?.[0];
      const value = a.selectedValues?.[0];
      const picked =
        label !== undefined
          ? value !== undefined && label !== value
            ? t('tools.askLabelValue', { label, value })
            : label
          : value !== undefined
            ? String(value)
            : undefined;
      let answerText = picked ?? (other ? t('tools.askOther', { text: other }) : t('tools.askNoAnswer'));
      if (picked && other) answerText = t('tools.askPickedWithOther', { picked, text: other });
      return answerText;
    }
    case 'multi': {
      const parts: string[] = [];
      const labels = a.selectedLabels ?? [];
      const values = a.selectedValues ?? [];
      const n = Math.max(labels.length, values.length);
      for (let i = 0; i < n; i++) {
        const l = labels[i];
        const v = values[i];
        parts.push(l !== undefined ? (v !== undefined && l !== v ? t('tools.askLabelValue', { label: l, value: v }) : l) : String(v));
      }
      if (other) parts.push(t('tools.askOther', { text: other }));
      return parts.length > 0 ? parts.join('、') : t('tools.askNoAnswer');
    }
    case 'form': {
      const form = a.form ?? {};
      const parts = Object.entries(form).map(([k, v]) => `${k}=${String(v)}`);
      return parts.length > 0 ? parts.join('、') : other ? t('tools.askOther', { text: other }) : t('tools.askNoAnswer');
    }
    default: {
      // text
      return a.text?.trim() || other || t('tools.askNoAnswer');
    }
  }
}

/** 用户侧附件路径 → 结果文本附加块（每行一个路径，便于 agent 直读） */
function formatAttachments(paths: string[] | undefined): string {
  if (!paths || paths.length === 0) return '';
  return `${t('tools.askAttachmentsLabel')}\n${paths.map((p) => `- ${p}`).join('\n')}`;
}

/** 入参单题形态（兼容旧扁平字段） */
interface RawQuestion {
  id?: unknown;
  question?: unknown;
  answerType?: unknown;
  options?: unknown;
  defaultAnswer?: unknown;
  formSchema?: unknown;
  attachments?: unknown;
}

type NormalizeResult =
  | { ok: true; questions: AskQuestion[] }
  | { ok: false; errorKey: string; params?: Record<string, string> };

/** 归一化入参 → AskQuestion[]（单题扁平字段自动包成 1 题） */
function normalizeQuestions(raw: RawQuestion[]): NormalizeResult {
  if (raw.length === 0) return { ok: false, errorKey: 'askQuestionRequired' };
  if (raw.length > MAX_QUESTIONS) {
    return { ok: false, errorKey: 'askQuestionTooMany', params: { max: String(MAX_QUESTIONS) } };
  }
  const questions: AskQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] ?? {};
    const question = typeof r.question === 'string' ? r.question.trim() : '';
    if (!question) return { ok: false, errorKey: 'askQuestionEmpty', params: { index: String(i + 1) } };

    const answerType = (typeof r.answerType === 'string' ? r.answerType : 'text') as NonNullable<AskQuestion['answerType']>;
    if (!VALID_ANSWER_TYPES.has(answerType)) {
      return { ok: false, errorKey: 'askInvalidAnswerType', params: { type: String(r.answerType) } };
    }

    let options: AskOption[] | undefined;
    if (answerType === 'single' || answerType === 'multi') {
      if (!Array.isArray(r.options) || r.options.length < 2 || r.options.length > 6) {
        return { ok: false, errorKey: 'askOptionsRequired' };
      }
      for (const opt of r.options as AskOption[]) {
        if (
          !opt ||
          typeof opt.value !== 'string' ||
          !opt.value.trim() ||
          typeof opt.label !== 'string' ||
          !opt.label.trim()
        ) {
          return { ok: false, errorKey: 'askOptionInvalid' };
        }
      }
      options = r.options as AskOption[];
    }

    let attachments: string[] | undefined;
    if (Array.isArray(r.attachments)) {
      const list = (r.attachments as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '');
      if (list.length > 0) attachments = list;
    }

    questions.push({
      id: typeof r.id === 'string' && r.id ? r.id : `q${i}`,
      question,
      answerType,
      ...(options ? { options } : {}),
      ...(typeof r.defaultAnswer === 'string' && r.defaultAnswer ? { defaultAnswer: r.defaultAnswer } : {}),
      ...(answerType === 'form' && r.formSchema && typeof r.formSchema === 'object'
        ? { formSchema: r.formSchema as Record<string, unknown> }
        : {}),
      ...(attachments ? { attachments } : {}),
    });
  }
  return { ok: true, questions };
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as {
      question?: unknown;
      answerType?: unknown;
      options?: unknown;
      defaultAnswer?: unknown;
      formSchema?: unknown;
      attachments?: unknown;
      questions?: unknown;
    };

    // 多题优先；否则用旧扁平字段包成单题（兼容）
    const raw: RawQuestion[] = Array.isArray(p.questions)
      ? (p.questions as RawQuestion[])
      : typeof p.question === 'string' && p.question
        ? [
            {
              question: p.question,
              answerType: p.answerType,
              options: p.options,
              defaultAnswer: p.defaultAnswer,
              formSchema: p.formSchema,
              attachments: p.attachments,
            },
          ]
        : [];

    const norm = normalizeQuestions(raw);
    if (!norm.ok) {
      return {
        content: [{ type: 'text', text: `Error: ${t(`tools.${norm.errorKey}`, norm.params)}` }],
        isError: true,
      };
    }
    const { questions } = norm;

    if (!ctx.askUser) {
      return {
        content: [{ type: 'text', text: `Error: ${t('tools.askNoChannel')}` }],
        isError: true,
      };
    }

    const payload: AskPayload = { questions };

    let outcome: AskOutcome;
    try {
      outcome = await ctx.askUser(payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${t('tools.askFailed', { message: msg })}` }],
        isError: true,
      };
    }

    if (outcome.action === 'cancel') {
      return {
        content: [{ type: 'text', text: t('tools.askCancelled') }],
        metadata: { action: 'cancel', questions, answers: [] },
      };
    }

    const answers = outcome.answers ?? [];
    const blocks = questions.map((q, i) => {
      const a = answers[i] ?? {};
      const answerText = formatAnswer(q.answerType, a);
      const attachments = formatAttachments(a.attachments);
      const head = `${t('tools.askQuestionLabel')}${q.question}\n${t('tools.askAnswerLabel')}${answerText}`;
      return attachments ? `${head}\n${attachments}` : head;
    });

    // metadata.display：结构化展示块（locale 由后端统一，前端直接渲染，避免重复拼装/locale 不一致）
    const display = questions.map((q, i) => ({
      question: q.question,
      answer: formatAnswer(q.answerType, answers[i] ?? {}),
      attachments: answers[i]?.attachments ?? [],
    }));

    return {
      content: [{ type: 'text', text: blocks.join('\n\n') }],
      metadata: { action: 'accept', questions, answers, display },
    };
  },
};
