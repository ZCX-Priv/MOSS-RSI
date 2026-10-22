// webui/src/components/shared/AskPromptCard.tsx
// 提问卡片（合并向导）：把一个 session 内全部 pending ask 合并为一张卡，逐题（一屏一题）作答，
// 最后一题统一提交。支持：
//   - 多题（单次 ask 的 questions 数组，或一轮内多次 ask 调用合并）
//   - 双向附件：agent 题面附件（附件卡片，多附件左右箭头，点击预览）；
//     用户回答附件（粘贴落盘）+ 自由输入内联 `/`、`#` token（禁用 `@`）
//   - 五类回答：text / single / multi / boolean / form
// 提交时按 toolCallId 归组逐条回复（answers[i] 与 questions[i] 对齐）。

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  HelpCircle,
  Pencil,
  CircleCheck,
  Circle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Send,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useTask } from '../../hooks/useTask';
import { fileNameOf } from '../../render/file/detector';
import { AskAttachmentStrip, type AskAttachmentItem } from './AskAttachmentStrip';
import { AskMentionInput, type AskMentionInputHandle } from './AskMentionInput';
import type { AskAnswer, AskOption, AskQuestion, PendingAsk } from '../../types/api';

interface AskPromptCardProps {
  /** 同一 session 的全部待答提问（按 createdAt 合并为一个向导） */
  asks: PendingAsk[];
  /** 点击附件卡片 → 打开右侧边栏预览 */
  onOpenAttachment: (path: string) => void;
  className?: string;
}

/** form 模式：JSON Schema 字段描述（简化解析） */
interface FormField {
  key: string;
  type: 'string' | 'number' | 'boolean';
  title?: string;
  description?: string;
  required: boolean;
}

/** 从 formSchema 提取扁平字段列表（仅支持顶层 properties） */
function parseFormFields(schema: Record<string, unknown> | undefined): FormField[] {
  if (!schema) return [];
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props || typeof props !== 'object') return [];
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return Object.entries(props)
    .filter(([, def]) => {
      const t = (def as { type?: unknown })?.type;
      return t === 'string' || t === 'number' || t === 'integer' || t === 'boolean';
    })
    .map(([key, def]) => ({
      key,
      type: def.type === 'number' || def.type === 'integer' ? 'number' : (def.type as 'string' | 'boolean'),
      title: typeof def.title === 'string' ? def.title : undefined,
      description: typeof def.description === 'string' ? def.description : undefined,
      required: required.includes(key),
    }));
}

/** 单题作答草稿 */
interface Draft {
  /** text 类型线格式文本 */
  text: string;
  /** 选中项 value（single 0/1，multi 0-N，boolean 0/1） */
  selected: string[];
  /** 用户编辑过的选项 label：value → 新 label */
  editedLabels: Record<string, string>;
  /** 「其他」线格式文本（非空即视为已选「其他」） */
  otherText: string;
  /** form 字段值 */
  formValues: Record<string, string | number | boolean>;
  /** 用户侧附件（粘贴落盘） */
  attachments: AskAttachmentItem[];
}

const EMPTY_DRAFT: Draft = {
  text: '',
  selected: [],
  editedLabels: {},
  otherText: '',
  formValues: {},
  attachments: [],
};

/** 扁平化后的单步 */
interface Step {
  key: string;
  toolCallId: string;
  q: AskQuestion;
}

/** boolean 类型的固定是/否选项 */
function baseOptions(q: AskQuestion, yes: string, no: string): AskOption[] {
  if (q.answerType === 'boolean') {
    return [
      { value: 'yes', label: yes },
      { value: 'no', label: no },
    ];
  }
  return q.options ?? [];
}

export function AskPromptCard({ asks, onOpenAttachment, className }: AskPromptCardProps) {
  const { t } = useTranslation();
  const { replyAsk } = useTask();
  const [sending, setSending] = useState(false);
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // 选项 label 内联编辑态（value → 编辑草稿）
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const otherRef = useRef<AskMentionInputHandle>(null);

  const steps = useMemo<Step[]>(() => {
    const sorted = [...asks].sort((a, b) => a.createdAt - b.createdAt);
    const out: Step[] = [];
    for (const a of sorted) {
      a.questions.forEach((q, i) => {
        out.push({ key: `${a.toolCallId}::${q.id || i}`, toolCallId: a.toolCallId, q });
      });
    }
    return out;
  }, [asks]);

  // steps 收缩时收敛当前步（如断线后某题被超时移除）
  useEffect(() => {
    if (step > steps.length - 1) setStep(Math.max(0, steps.length - 1));
  }, [steps.length, step]);

  const patch = useCallback((key: string, p: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_DRAFT), ...p } }));
  }, []);

  const draftOf = useCallback((key: string): Draft => drafts[key] ?? EMPTY_DRAFT, [drafts]);

  const yesLabel = t('task.askYes');
  const noLabel = t('task.askNo');

  const labelOf = (q: AskQuestion, d: Draft, value: string): string => {
    if (d.editedLabels[value] !== undefined) return d.editedLabels[value];
    return baseOptions(q, yesLabel, noLabel).find((o) => o.value === value)?.label ?? value;
  };

  const formMissing = (q: AskQuestion, d: Draft): boolean =>
    parseFormFields(q.formSchema).some(
      (f) => f.required && (d.formValues[f.key] === undefined || d.formValues[f.key] === ''),
    );

  const isAnswered = (q: AskQuestion, d: Draft): boolean => {
    switch (q.answerType) {
      case 'text':
        return d.text.trim() !== '' || d.otherText.trim() !== '';
      case 'single':
      case 'boolean':
        return d.selected.length === 1 || d.otherText.trim() !== '';
      case 'multi':
        return d.selected.length > 0 || d.otherText.trim() !== '';
      case 'form':
        return !formMissing(q, d);
      default:
        return d.text.trim() !== '';
    }
  };

  const buildAnswer = (q: AskQuestion, d: Draft): AskAnswer => {
    const answer: AskAnswer = {};
    if (d.attachments.length > 0) answer.attachments = d.attachments.map((a) => a.path);
    const other = d.otherText.trim();
    const edited = Object.keys(d.editedLabels).length > 0 ? d.editedLabels : undefined;
    switch (q.answerType) {
      case 'single':
        if (d.selected.length > 0) {
          answer.selectedValues = [d.selected[0]];
          answer.selectedLabels = [labelOf(q, d, d.selected[0])];
        }
        if (other) answer.otherText = other;
        if (edited) answer.editedLabels = edited;
        return answer;
      case 'multi':
        if (d.selected.length > 0) {
          answer.selectedValues = [...d.selected];
          answer.selectedLabels = d.selected.map((v) => labelOf(q, d, v));
        }
        if (other) answer.otherText = other;
        if (edited) answer.editedLabels = edited;
        return answer;
      case 'boolean':
        if (d.selected.length > 0) {
          answer.selectedValues = [d.selected[0]];
          answer.selectedLabels = [d.selected[0] === 'yes' ? yesLabel : noLabel];
        }
        if (other) answer.otherText = other;
        return answer;
      case 'form':
        answer.form = d.formValues;
        return answer;
      default:
        answer.text = d.text.trim();
        return answer;
    }
  };

  const submit = useCallback(() => {
    if (sending || steps.length === 0) return;
    if (!steps.every((s) => isAnswered(s.q, drafts[s.key] ?? EMPTY_DRAFT))) return;
    setSending(true);
    // 按 toolCallId 归组逐条回复（answers[i] 与 questions[i] 对齐）
    for (const a of asks) {
      const answers: AskAnswer[] = a.questions.map((q, i) =>
        buildAnswer(q, drafts[`${a.toolCallId}::${q.id || i}`] ?? EMPTY_DRAFT),
      );
      replyAsk(a.sessionId, a.toolCallId, { action: 'accept', answers });
    }
  }, [asks, drafts, sending, steps, replyAsk]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = useCallback(() => {
    if (sending) return;
    setSending(true);
    for (const a of asks) replyAsk(a.sessionId, a.toolCallId, { action: 'cancel' });
  }, [asks, sending, replyAsk]);

  // ESC = 取消整卡（挂在卡片容器，避免全局 ESC 误伤其他弹窗；
  // 提及菜单打开时由 MentionEditor 先 handle 并 preventDefault，这里通过 defaultPrevented 跳过）
  const onCardKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !editingValue) {
      e.preventDefault();
      cancel();
    }
  };

  if (steps.length === 0) return null;

  const cur = steps[Math.min(step, steps.length - 1)];
  const d = draftOf(cur.key);
  const answerType = cur.q.answerType ?? 'text';
  const isLast = step >= steps.length - 1;
  const curAnswered = isAnswered(cur.q, d);
  const options = baseOptions(cur.q, yesLabel, noLabel);
  const isChoice = answerType === 'single' || answerType === 'multi' || answerType === 'boolean';
  const isMulti = answerType === 'multi';
  const isForm = answerType === 'form';
  const agentAttachments: AskAttachmentItem[] = (cur.q.attachments ?? []).map((p) => ({
    path: p,
    name: fileNameOf(p),
  }));

  const goNext = () => {
    if (!curAnswered || sending) return;
    if (isLast) submit();
    else setStep((s) => s + 1);
  };
  const goPrev = () => {
    if (sending) return;
    setStep((s) => Math.max(0, s - 1));
  };

  const toggle = (value: string) => {
    if (isMulti) {
      patch(cur.key, {
        selected: d.selected.includes(value)
          ? d.selected.filter((v) => v !== value)
          : [...d.selected, value],
      });
    } else {
      patch(cur.key, { selected: [value] });
    }
  };

  const startEdit = (value: string, label: string) => {
    setEditingValue(value);
    setEditingDraft(label);
  };
  const commitEdit = () => {
    if (editingValue && editingDraft.trim()) {
      patch(cur.key, { editedLabels: { ...d.editedLabels, [editingValue]: editingDraft.trim() } });
    }
    setEditingValue(null);
    setEditingDraft('');
  };

  const addUserAttachments = (items: AskAttachmentItem[]) =>
    patch(cur.key, { attachments: [...d.attachments, ...items] });
  const removeUserAttachment = (path: string) =>
    patch(cur.key, { attachments: d.attachments.filter((a) => a.path !== path) });

  /** 自由输入区（text 正文 / 「其他」），复用发送框内联 token 渲染 */
  const renderMentionInput = (
    ref: RefObject<AskMentionInputHandle | null>,
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
    inline = false,
  ) => (
    <AskMentionInput
      key={`${cur.key}:${placeholder}`}
      ref={ref}
      inline={inline}
      initialValue={value}
      placeholder={placeholder}
      onChange={onChange}
      onPasteAttachments={addUserAttachments}
      onSend={goNext}
    />
  );

  return (
    <div
      onKeyDown={onCardKeyDown}
      className={cn(
        'flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3 shadow-sm',
        className,
      )}
    >
      {/* 头部：标题 + 进度 + 取消 */}
      <div className="flex items-center gap-1.5">
        <HelpCircle className="size-3.5 text-primary-strong" />
        <span className="text-xs font-medium text-foreground">{t('task.askTitle')}</span>
        {steps.length > 1 && (
          <span className="text-[11px] text-muted-foreground">
            {t('task.askStepOf', { current: step + 1, total: steps.length })}
          </span>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={cancel}
          disabled={sending}
          className="ml-auto h-6 gap-1 px-1.5 text-muted-foreground"
          title={t('task.askCancel')}
        >
          <X className="size-3" />
          <span className="text-[10px]">{t('task.askCancel')}</span>
        </Button>
      </div>

      {/* 题面 */}
      <p className="whitespace-pre-wrap text-sm text-foreground">{cur.q.question}</p>

      {/* agent 题面附件（只读，多附件左右箭头） */}
      {agentAttachments.length > 0 && (
        <AskAttachmentStrip items={agentAttachments} onOpen={onOpenAttachment} />
      )}

      {/* text 类型自由输入 */}
      {answerType === 'text' && renderMentionInput(otherRef, d.text, (v) => patch(cur.key, { text: v }), t('task.askAnswerPlaceholder'))}

      {/* form 类型动态表单 */}
      {isForm && (
        <div className="flex flex-col gap-2.5">
          {parseFormFields(cur.q.formSchema).length === 0 && (
            <p className="text-xs text-muted-foreground">{t('task.askFormEmpty')}</p>
          )}
          {parseFormFields(cur.q.formSchema).map((f) => (
            <div key={f.key} className="flex flex-col gap-1">
              <label className="flex items-center gap-1 text-xs font-medium text-foreground">
                {f.title ?? f.key}
                {f.required && <span className="text-destructive">*</span>}
              </label>
              {f.description && (
                <span className="text-[11px] leading-tight text-muted-foreground">{f.description}</span>
              )}
              {f.type === 'boolean' ? (
                <div className="flex items-center gap-2 py-0.5">
                  <Switch
                    checked={d.formValues[f.key] === true}
                    onCheckedChange={(v) => patch(cur.key, { formValues: { ...d.formValues, [f.key]: v } })}
                    disabled={sending}
                  />
                  <span className="text-xs text-muted-foreground">
                    {d.formValues[f.key] === true ? yesLabel : noLabel}
                  </span>
                </div>
              ) : (
                <Input
                  type={f.type === 'number' ? 'number' : 'text'}
                  value={String(d.formValues[f.key] ?? '')}
                  onChange={(e) =>
                    patch(cur.key, {
                      formValues: {
                        ...d.formValues,
                        [f.key]:
                          f.type === 'number'
                            ? e.target.value === ''
                              ? ''
                              : Number(e.target.value)
                            : e.target.value,
                      },
                    })
                  }
                  disabled={sending}
                  className="h-8 text-sm"
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* single / multi / boolean：选项按钮组（label 可编辑）+ 固定「其他」项 */}
      {isChoice && (
        <div className="flex flex-col gap-1.5">
          {options.map((opt) => {
            const checked = d.selected.includes(opt.value);
            const editing = editingValue === opt.value;
            const label = labelOf(cur.q, d, opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggle(opt.value)}
                disabled={sending}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors',
                  checked
                    ? 'border-primary-strong bg-primary-strong/10 text-foreground'
                    : 'border-border text-foreground hover:bg-muted/50',
                )}
              >
                {checked ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary-strong" />
                ) : (
                  <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  {editing ? (
                    <Input
                      autoFocus
                      value={editingDraft}
                      onChange={(e) => setEditingDraft(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitEdit();
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          setEditingValue(null);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="h-6 text-sm"
                    />
                  ) : (
                    <>
                      <span className="break-words">{label}</span>
                      {opt.description && (
                        <span className="text-[11px] leading-tight text-muted-foreground">
                          {opt.description}
                        </span>
                      )}
                    </>
                  )}
                </span>
                {!editing && (
                  <span
                    role="button"
                    tabIndex={0}
                    title={t('task.askEditOption')}
                    onClick={(e) => {
                      e.stopPropagation();
                      startEdit(opt.value, label);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation();
                        startEdit(opt.value, label);
                      }
                    }}
                    className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-foreground [button:hover>&]:opacity-100"
                  >
                    <Pencil className="size-3" />
                  </span>
                )}
              </button>
            );
          })}

          {/* 「其他」行内输入（固定最后一项）：点击不选中，输入内容即视为已选；
              支持 `/`、`#` 与粘贴附件；输入区限高避免撑爆卡片 */}
          <div
            className={cn(
              'flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors',
              d.otherText.trim()
                ? 'border-primary-strong bg-primary-strong/5'
                : 'border-border',
            )}
          >
            {d.otherText.trim() ? (
              <CircleCheck className="size-4 shrink-0 text-primary-strong" />
            ) : (
              <Circle className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="shrink-0 text-sm">{t('task.askOther')}</span>
            {renderMentionInput(
              otherRef,
              d.otherText,
              (v) => patch(cur.key, { otherText: v }),
              t('task.askOtherPlaceholder'),
              true,
            )}
          </div>
        </div>
      )}

      {/* 用户回答附件（可移除；粘贴/选择后落盘） */}
      {d.attachments.length > 0 && (
        <AskAttachmentStrip
          items={d.attachments}
          onOpen={onOpenAttachment}
          onRemove={removeUserAttachment}
        />
      )}

      {/* 底部：提示 + 上一步 / 下一步（末题提交） */}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-[10px] text-muted-foreground">
          {answerType === 'text'
            ? 'Ctrl+Enter'
            : isMulti
              ? t('task.askMultiHint')
              : isChoice
                ? t('task.askOtherHint')
                : ''}
        </span>
        {step > 0 && (
          <Button variant="ghost" size="sm" onClick={goPrev} disabled={sending} className="h-8 shrink-0 gap-1">
            <ChevronLeft className="size-3.5" />
            <span>{t('task.askPrev')}</span>
          </Button>
        )}
        <Button
          size="sm"
          onClick={goNext}
          disabled={sending || !curAnswered}
          className="h-8 shrink-0 gap-1"
        >
          {sending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : isLast ? (
            <Send className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <span>{isLast ? (sending ? t('task.askSending') : t('task.askSubmit')) : t('task.askNext')}</span>
        </Button>
      </div>
    </div>
  );
}
