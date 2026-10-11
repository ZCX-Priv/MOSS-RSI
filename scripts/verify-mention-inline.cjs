// scripts/verify-mention-inline.cjs
// 静态核验：内联 token 输入框（含第二轮修复）——防编辑工具虚假成功，逐文件磁盘断言。
// 用法：node scripts/verify-mention-inline.cjs
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

console.log('===== 1. mention-data：线格式真源 + 名单带图标 =====');
check('token 类型与线格式', 'webui/src/components/shared/mention-data.ts', [
  'export type ComposerToken =',
  'export const FILE_TOKEN_RE =',
  'export function tokenWireText(',
  'export function parseMentionText(',
  'export function stripMentionTokens(',
  'export function computeFileLabels(',
  'export function buildMentionLookups(',
  'export function findCommandIcon(',
  'commands: Array<{ name: string; icon?: string }>;',
]);
check('第三轮：通用图标类型 + chip 视觉变体', 'webui/src/components/shared/mention-data.ts', [
  'export type MentionIconComponent = ComponentType<{ className?: string; size?: number }>;',
  'icon: MentionIconComponent;',
  'export function chipVariant(',
  "return token.source === 'skill' ? 'skill' : 'command';",
]);
checkAbsent('第三轮：mention-data 不再依赖 lucide 类型', 'webui/src/components/shared/mention-data.ts', [
  'LucideIcon',
]);

console.log('===== 2. MentionTokenIcon：复用附件检测与图标 =====');
check('图标真源', 'webui/src/components/shared/MentionTokenIcon.tsx', [
  'export function MentionTokenIcon(',
  'FileTypeIcon',
  'useFileThumbnail',
  'getAttachmentKind',
  'resolveSkillIcon',
  'findCommandIcon',
  'Bot',
]);
check('第三轮：# 菜单图标复用同源 FileTypeIcon', 'webui/src/components/shared/FileTypeIcon.tsx', [
  'export function fileTypeIconComponent(',
  'size = 16,',
]);

console.log('===== 3. MentionEditor：contenteditable 内联编辑器 =====');
check('contenteditable 容器与命令式 chip', 'webui/src/components/shared/MentionEditor.tsx', [
  'contentEditable',
  "setAttribute('data-kind'",
  "setAttribute('contenteditable', 'false')",
  'export function chipToToken(',
  'export function serializeRoot(',
]);
check('IME / 原子删除 / 剪贴板', 'webui/src/components/shared/MentionEditor.tsx', [
  'onCompositionStart',
  'onCompositionEnd',
  'isComposingRef',
  'deleteAdjacentChip',
  "clipboardData.setData('text/plain'",
  'onBeforeInput',
  'PLACEHOLDER_CHAR',
  'insertNodesAtCaret',
]);
check('第二轮修复：高度对齐旧 textarea + chip 图标 host', 'webui/src/components/shared/MentionEditor.tsx', [
  "'mention-editor min-h-16 min-w-40 basis-40 flex-1 overflow-y-auto px-1 py-2 text-base outline-none md:text-sm'",
  "icon.className = 'mchip-icon'",
  'createPortal',
  'syncIconHosts',
  'computeFileLabels',
  'fileNameOf',
]);
check('第三轮修复：口径收敛（触发词替换不再错位）', 'webui/src/components/shared/MentionEditor.tsx', [
  "type OffsetMode = 'wire' | 'placeholder';",
  "(start: number, end: number, token: ComposerToken, mode: OffsetMode = 'wire'): boolean =>",
  'const wireStart = boundaryToOffset(root, range.startContainer, range.startOffset,',
  "token, 'placeholder');",
  "span.className = `mchip mchip--${chipVariant(token)}`;",
]);
checkAbsent('第二轮修复：自建徽章/自算高度已移除', 'webui/src/components/shared/MentionEditor.tsx', [
  'minRows',
  'extBadge',
  'mchip-ext',
  'useMemo',
]);

console.log('===== 4. 样式 =====');
check('chip 图标宿主 + 占位符绝对定位', 'webui/src/styles/global.css', [
  '.mchip-icon',
  '.mchip-icon > *',
  "content: attr(data-placeholder)",
  '.mchip-inline--file',
]);
check('占位符不占文本流（光标回到 x=0）', 'webui/src/styles/global.css', [
  '.mention-editor[data-empty=\'true\']::before',
  'position: absolute',
  'padding: inherit',
]);
check('第三轮：skill chip 蓝色变体（编辑器 + 气泡，亮暗两套）', 'webui/src/styles/global.css', [
  '.mchip--skill',
  '.dark .mchip--skill',
  '.mchip-inline--skill',
  '.dark .mchip-inline--skill',
]);
checkAbsent('旧行高覆盖/旧徽章样式已移除', 'webui/src/styles/global.css', [
  'line-height: 1.7',
  '.mchip-ext',
]);

console.log('===== 5. 命令注入隐藏块 =====');
check('注入块真源', 'webui/src/lib/inject-block.ts', [
  'export const INJECT_SENTINEL',
  'export function buildInjectBlock(',
  'export function stripInjectBlock(',
]);
check('发送端接入（注入块在尾部）', 'webui/src/components/shared/TaskInput.tsx', [
  "import { buildInjectBlock } from '@/lib/inject-block';",
  'injectBlock = buildInjectBlock(renderPromptTemplate(prompt, args))',
  'renderPromptTemplate(prompt, args)',
  'editorRef.current?.clear()',
  'buildMentionLookups(commands, skills, agents)',
  "toast.info(t('taskInput.fileAlreadyReferenced'",
]);
checkAbsent('TaskInput：旧 variant/minRows 已移除', 'webui/src/components/shared/TaskInput.tsx', [
  '<Textarea',
  'chips.map',
  'minRows',
  "variant = 'home'",
]);
check('第三轮：# 菜单改用同源文件图标', 'webui/src/components/shared/TaskInput.tsx', [
  "import { fileTypeIconComponent } from './FileTypeIcon';",
  'icon: fileTypeIconComponent(f.name),',
]);
checkAbsent('第三轮：自建 fileIconForExt 已移除', 'webui/src/components/shared/TaskInput.tsx', [
  'fileIconForExt',
  'LucideIcon',
  'FileCode',
]);
check('渲染端剥离注入块（气泡/队列/复制）', 'webui/src/components/pages/TaskPage.tsx', [
  "import { stripInjectBlock } from '@/lib/inject-block';",
  'const visibleContent = stripInjectBlock(message.content);',
  'onCopy?.(visibleContent)',
  'stripAttachmentBlock(stripInjectBlock(msg.content))',
  '<MentionTokenText text={userBodyDisplay}',
]);
check('标题剥离注入块', 'webui/src/hooks/useTask.ts', [
  "import { stripInjectBlock } from '../lib/inject-block';",
  'stripInjectBlock(stripAttachmentBlock(content))',
  'buildMentionLookups(state.commands, state.skills, state.agents)',
]);
check('搜索结果剥离注入块', 'webui/src/components/overlays/SearchModal.tsx', [
  "import { stripInjectBlock } from '@/lib/inject-block';",
  'stripInjectBlock(msg.text)',
]);
checkAbsent('TaskPage：variant 传参已移除', 'webui/src/components/pages/TaskPage.tsx', ['variant="task"']);

console.log('===== 6. 消息气泡 token 渲染 =====');
check('气泡 token 渲染器（图标 + 名称，无触发符）', 'webui/src/components/shared/MentionTokens.tsx', [
  'export function MentionTokenText(',
  'export function useMentionLookups(',
  'MentionTokenIcon',
  'mchip-inline--file',
  'onOpenFile(token.path)',
  'computeFileLabels',
  'chipVariant(token)',
]);

console.log('===== 7. 附件链路未回归 =====');
check('TaskInput：+ 附件仍走附件块', 'webui/src/components/shared/TaskInput.tsx', [
  'buildAttachmentBlock(uniquePaths',
  'const uniquePaths = [...new Set(attachments.map((a) => a.path))];',
]);

console.log('===== 8. IME 组合期占位符不叠字 =====');
check('组合期隐藏占位符（data-composing 命令式标记）', 'webui/src/components/shared/MentionEditor.tsx', [
  'const setComposingFlag = (on: boolean) => {',
  "root.setAttribute('data-composing', 'true')",
  "root.removeAttribute('data-composing')",
  'const composing = isComposingRef.current || native.isComposing;',
  'setComposingFlag(composing);',
]);
check('组合期 CSS 隐藏 ::before', 'webui/src/styles/global.css', [
  ".mention-editor[data-composing='true']::before",
  'display: none',
]);

console.log(`\npass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);