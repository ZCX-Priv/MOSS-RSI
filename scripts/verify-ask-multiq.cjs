// scripts/verify-ask-multiq.cjs
// 静态核验：ask 工具升级（单次多问题 + 双向附件 + 多次调用并发合并 + 完成态渲染保真）。
// 防编辑工具虚假成功，逐文件磁盘断言。用法：node scripts/verify-ask-multiq.cjs
const fs = require('fs');
const path = require('path');

const base = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(base, p), 'utf8');

let pass = 0;
let fail = 0;

function check(name, file, conditions) {
  let src;
  try {
    src = read(file);
  } catch {
    fail++;
    console.log(`FAIL ${file} :: ${name} :: 文件不存在`);
    return;
  }
  const missing = conditions.filter((c) => !src.includes(c));
  if (missing.length === 0) {
    pass++;
    console.log(`PASS ${file} :: ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${file} :: ${name} :: 缺失: ${JSON.stringify(missing)}`);
  }
}

function checkAbsent(name, file, absentConditions) {
  let src;
  try {
    src = read(file);
  } catch {
    fail++;
    console.log(`FAIL ${file} :: ${name} :: 文件不存在`);
    return;
  }
  const leaked = absentConditions.filter((c) => src.includes(c));
  if (leaked.length === 0) {
    pass++;
    console.log(`PASS ${file} :: ${name} (旧实现已移除)`);
  } else {
    fail++;
    console.log(`FAIL ${file} :: ${name} :: 残留: ${JSON.stringify(leaked)}`);
  }
}

console.log('===== 1. 后端数据模型 =====');
check('AskQuestion / answers / attachments', 'src/modules/tools/types.ts', [
  'export interface AskQuestion {',
  'export type AskAnswerType =',
  'questions: AskQuestion[];',
  'answers?: AskAnswer[];',
  'attachments?: string[];',
  'description?: string;',
]);

console.log('===== 2. ask 工具 schema 与执行 =====');
check('tool.json 多题 + 附件 + form', 'src/modules/tools/ask/tool.json', [
  '"questions":',
  '"attachments":',
  '"formSchema":',
  '"description":',
]);
check('index.ts 归一化 + 附件 + 结构化 metadata', 'src/modules/tools/ask/index.ts', [
  'normalizeQuestions',
  'formatAttachments',
  "t('tools.askAttachmentsLabel')",
  'metadata: { action: \'accept\', questions, answers, display }',
  'MAX_QUESTIONS',
]);

console.log('===== 3. 契约 / 引擎 / WS / 路由 =====');
check('contracts ask 事件带 questions', 'src/modules/contracts.ts', [
  'questions: AskQuestion[]; runId?: string }',
]);
check('engine：并发执行同轮多个 ask + 载荷 + elicitation', 'src/modules/agent/engine.ts', [
  'await Promise.all(askCalls.map((a) => runOne(a)))',
  'questions: payload.questions,',
  'abortedInTools',
  "payload: { questions: [elicitationQuestion] },",
  'outcome.answers?.[0]?.form',
]);
check('ws-handler：answers[] 回复 + 重连恢复 questions', 'src/modules/server/ws-handler.ts', [
  'payload.answers ?? (payload.answer ? [payload.answer] : undefined)',
  "{ answers }",
  'questions: ask.payload.questions,',
]);
check('session 路由：pendingAsks 透传 questions', 'src/modules/server/routes/session.ts', [
  'questions: a.payload.questions,',
  'payload: { questions: AskQuestion[] };',
]);

console.log('===== 4. 前端类型 / 接线 =====');
check('api.ts 类型对齐', 'webui/src/types/api.ts', [
  'export interface AskQuestion {',
  'export type AskAnswerType =',
  'answers?: AskAnswer[];',
  'questions: AskQuestion[];',
  'attachments?: string[];',
]);
check('ws-events 写入 questions（含旧后端兜底）', 'webui/src/lib/ws-events.ts', [
  'Array.isArray(event.questions)',
  'questions,',
  'addPendingAsk',
]);
check('useTask replyAsk 回传 answers', 'webui/src/hooks/useTask.ts', [
  'answers: outcome.answers',
]);
check('useSessionHistory 回填 questions', 'webui/src/hooks/useSessionHistory.ts', [
  'questions: ask.questions,',
]);

console.log('===== 5. 复用件 =====');
check('MentionEditor 触发白名单', 'webui/src/components/shared/MentionEditor.tsx', [
  'allowedTriggers?: MentionKind[];',
  'allowedTriggersRef',
  'allowedTriggersRef.current.includes(match.kind)',
]);
check('AskMentionInput 禁用 @ + 粘贴附件', 'webui/src/components/shared/AskMentionInput.tsx', [
  "allowedTriggers={['command', 'file']}",
  'onPasteAttachments',
  'api.saveAttachment',
  'setValue(initialValue)',
]);
check('AskMentionInput：内联紧凑模式 + 限高', 'webui/src/components/shared/AskMentionInput.tsx', [
  'inline?: boolean;',
  "inline ? 'min-h-0 min-w-0 py-1 max-h-24 text-sm' : 'max-h-28'",
  "cn('relative', inline && 'min-w-0 flex-1')",
]);
check('AskAttachmentStrip 左右箭头', 'webui/src/components/shared/AskAttachmentStrip.tsx', [
  'canScrollLeft',
  'canScrollRight',
  'ResizeObserver',
  'SendAttachmentCard',
  'MessageAttachmentCard',
]);

console.log('===== 6. 提问卡片（合并向导 + 双向附件）===== ');
check('AskPromptCard 向导 + 附件 + 提交', 'webui/src/components/shared/AskPromptCard.tsx', [
  'asks: PendingAsk[];',
  "t('task.askStepOf'",
  'buildAnswer',
  'isAnswered',
  'AskMentionInput',
  'AskAttachmentStrip',
  'replyAsk(a.toolCallId, { action: \'accept\', answers })',
]);
check('AskPromptCard：「其他」行内输入（输入即选中）+ 限高', 'webui/src/components/shared/AskPromptCard.tsx', [
  'd.otherText.trim()',
  'inline={inline}',
  "t('task.askOtherPlaceholder')",
]);
checkAbsent('AskPromptCard：旧「其他」展开开关已移除', 'webui/src/components/shared/AskPromptCard.tsx', [
  'otherOpen',
]);

console.log('===== 7. TaskPage 中控岛合并 + 完成态渲染保真 =====');
check('中控岛合并为一卡 + 完成态用 MentionTokenText', 'webui/src/components/pages/TaskPage.tsx', [
  'reduce((n, a) => n + a.questions.length, 0)',
  'asks={pendingAsks.filter((a) => a.sessionId === taskId)}',
  'onOpenAttachment={openAttachment}',
  '<MentionTokenText',
  'stripAttachmentBlock(blk.answer)',
]);
check('完成态：附件左对齐 + metadata.questions 取附件 + 默认折叠', 'webui/src/components/pages/TaskPage.tsx', [
  "import { AskAttachmentStrip } from '../shared/AskAttachmentStrip';",
  'items={blk.attachments.map((p) => ({ path: p, name: fileNameOf(p) }))}',
  'meta?.questions && meta.questions.length > 0',
  'attachments: args.attachments',
  '<details key={tc.id} className="group',
  "t('task.askQuestionCount'",
  'group-open:rotate-90',
  '<div className="flex flex-col gap-1">',
]);

console.log('===== 8. i18n =====');
check('zh i18n 新增键', 'webui/src/i18n/locales/zh.ts', [
  'askStepOf:',
  'askNext:',
  'askPrev:',
  'askSubmit:',
  'askAnswerPlaceholder:',
  'askCancelledInline:',
  'askQuestionCount:',
]);
check('en i18n 新增键', 'webui/src/i18n/locales/en.ts', [
  'askStepOf:',
  'askNext:',
  'askPrev:',
  'askSubmit:',
  'askAnswerPlaceholder:',
  'askCancelledInline:',
  'askQuestionCount:',
]);
check('后端 i18n 新增键', 'src/core/i18n/locales/zh.ts', [
  'askQuestionEmpty:',
  'askQuestionTooMany:',
  'askAttachmentsLabel:',
]);

console.log(`\npass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
