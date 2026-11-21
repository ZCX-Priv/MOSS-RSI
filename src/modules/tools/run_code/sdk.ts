// 代码模式的系统提示附加段：静态指令从 agent/code-mode/ 加载，运行时只拼接工具签名与条件片段。
// 输出必须字节稳定（工具按名字排序、固定格式），否则会破坏前缀缓存。

import type { Environment } from '../../../core/types';
import { loadPromptFileOrNull, renderTemplate } from '../../context/prompt-loader';
import { buildUiDeclarations } from './ui/catalog';
import { isPtcForbiddenTool, PTC_FORBIDDEN_TOOL_LABEL } from './forbidden';
import { buildToolSignature } from './runtime/schema';

export interface CodeModeToolSchema {
  name: string;
  description: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

/** 与 context/compiler 的 PromptExtraSection 结构兼容（避免 tools → context 的运行时依赖） */
export interface CodeModePromptSection {
  id: string;
  title: string;
  content: string;
}

export interface BuildCodeModePromptInput {
  env: Environment;
  uiEnabled: boolean;
  /** 是否允许内嵌页面引用外部 CDN 资源（决定提示词与运行时拦截口径） */
  allowCdn: boolean;
  tools: CodeModeToolSchema[];
}

/** 生成系统提示附加段；提示词文件缺失或不该出现代码模式时返回 null。 */
export function buildCodeModePromptExtras(input: BuildCodeModePromptInput): CodeModePromptSection | null {
  const template = loadPromptFileOrNull(input.env, 'code-mode/ptc.md');
  if (!template) return null;

  const tools = input.tools
    .filter((tool) => tool.name !== 'run_code' && !isPtcForbiddenTool(tool.name))
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const signatures = tools.length > 0
    ? tools.map((tool) => `- \`${buildToolSignature(tool.name, tool.inputSchema)}\``).join('\n')
    : '（当前没有可用工具）';

  const inlinePage = input.uiEnabled
    ? (loadPromptFileOrNull(
        input.env,
        input.allowCdn ? 'code-mode/inline-page-cdn.md' : 'code-mode/inline-page-local.md',
      ) ?? '').trim()
    : '';

  const hasWeb = tools.some((tool) => tool.name === 'web');
  const hasTerminal = tools.some((tool) => tool.name === 'terminal');
  let toolReturnShape = '';
  if (hasWeb || hasTerminal) {
    const parts = [loadPromptFileOrNull(input.env, 'code-mode/tool-returns-header.md') ?? ''];
    if (hasWeb) parts.push(loadPromptFileOrNull(input.env, 'code-mode/tool-returns-web.md') ?? '');
    if (hasTerminal) parts.push(loadPromptFileOrNull(input.env, 'code-mode/tool-returns-terminal.md') ?? '');
    parts.push(loadPromptFileOrNull(input.env, 'code-mode/tool-returns-tail.md') ?? '');
    toolReturnShape = parts.filter((part) => part.trim() !== '').join('\n').trimEnd();
  }

  let uiSection = '';
  if (input.uiEnabled) {
    const uiTemplate = loadPromptFileOrNull(input.env, 'code-mode/ui-sdk.md');
    if (uiTemplate) {
      uiSection = renderTemplate(uiTemplate, { UI_DECLARATIONS: buildUiDeclarations() }).trimEnd();
      const footer = loadPromptFileOrNull(input.env, 'code-mode/ui-footer.md');
      if (footer) uiSection += `\n\n${footer.trim()}`;
    }
  } else {
    uiSection = loadPromptFileOrNull(input.env, 'code-mode/ui-disabled.md')?.trim() ?? '';
  }

  return {
    id: 'code-mode-sdk',
    title: '代码模式（PTC）',
    content: renderTemplate(template, {
      TOOL_SIGNATURES: signatures,
      INLINE_PAGE: inlinePage,
      PTC_FORBIDDEN_LABEL: PTC_FORBIDDEN_TOOL_LABEL,
      TOOL_RETURN_SHAPE: toolReturnShape,
      UI_SECTION: uiSection,
    }).trimEnd(),
  };
}
