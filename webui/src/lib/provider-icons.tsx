// UI/src/lib/provider-icons.tsx
// AI 供应商品牌图标映射（@lobehub/icons 精选清单，按需 import 控制 bundle）。
// - icon key 持久化在 provider.icon（如 'openai'）；空/未命中 = 默认 lucide Server 图标
// - 仅使用默认 Mono 变体（跟随 currentColor，自动适配明暗主题）

import type { ComponentType } from 'react';
// 深导入 Mono 组件（每图标默认导出即该组件）：与桶导入 `@lobehub/icons` 的 { X } 语义一致。
// 必须直达 components/Mono 的原因：
// 1) 桶导入会让 Vite dev 把整包 500+ 图标预构建成一个 ~25MB 依赖块（伴生 ~13MB sourcemap），
//    F12 打开时 DevTools 需解析该巨型产物 → 内容面板白屏/卡死；
// 2) 品牌 index 会连带引入 Avatar / Combine / Text，而它们依赖 @lobehub/ui（peer，本项目
//    不安装）与 antd-style→antd；只引 Mono 后整条依赖链消失（图标源码仅依赖 react）。
import OpenAI from '@lobehub/icons/es/OpenAI/components/Mono';
import Anthropic from '@lobehub/icons/es/Anthropic/components/Mono';
import Claude from '@lobehub/icons/es/Claude/components/Mono';
import Google from '@lobehub/icons/es/Google/components/Mono';
import Gemini from '@lobehub/icons/es/Gemini/components/Mono';
import DeepSeek from '@lobehub/icons/es/DeepSeek/components/Mono';
import Qwen from '@lobehub/icons/es/Qwen/components/Mono';
import Kimi from '@lobehub/icons/es/Kimi/components/Mono';
import Moonshot from '@lobehub/icons/es/Moonshot/components/Mono';
import Zhipu from '@lobehub/icons/es/Zhipu/components/Mono';
import ChatGLM from '@lobehub/icons/es/ChatGLM/components/Mono';
import Doubao from '@lobehub/icons/es/Doubao/components/Mono';
import ByteDance from '@lobehub/icons/es/ByteDance/components/Mono';
import Minimax from '@lobehub/icons/es/Minimax/components/Mono';
import Mistral from '@lobehub/icons/es/Mistral/components/Mono';
import Meta from '@lobehub/icons/es/Meta/components/Mono';
import XAI from '@lobehub/icons/es/XAI/components/Mono';
import Grok from '@lobehub/icons/es/Grok/components/Mono';
import Groq from '@lobehub/icons/es/Groq/components/Mono';
import Together from '@lobehub/icons/es/Together/components/Mono';
import Fireworks from '@lobehub/icons/es/Fireworks/components/Mono';
import Perplexity from '@lobehub/icons/es/Perplexity/components/Mono';
import Cohere from '@lobehub/icons/es/Cohere/components/Mono';
import OpenRouter from '@lobehub/icons/es/OpenRouter/components/Mono';
import Ollama from '@lobehub/icons/es/Ollama/components/Mono';
import SiliconCloud from '@lobehub/icons/es/SiliconCloud/components/Mono';
import Azure from '@lobehub/icons/es/Azure/components/Mono';
import Aws from '@lobehub/icons/es/Aws/components/Mono';
import Bedrock from '@lobehub/icons/es/Bedrock/components/Mono';
import HuggingFace from '@lobehub/icons/es/HuggingFace/components/Mono';
import AlibabaCloud from '@lobehub/icons/es/AlibabaCloud/components/Mono';
import Volcengine from '@lobehub/icons/es/Volcengine/components/Mono';
import ZeroOne from '@lobehub/icons/es/ZeroOne/components/Mono';
import Nvidia from '@lobehub/icons/es/Nvidia/components/Mono';
import Github from '@lobehub/icons/es/Github/components/Mono';
import LmStudio from '@lobehub/icons/es/LmStudio/components/Mono';
import Baidu from '@lobehub/icons/es/Baidu/components/Mono';
import Tencent from '@lobehub/icons/es/Tencent/components/Mono';
import Hunyuan from '@lobehub/icons/es/Hunyuan/components/Mono';
import SenseNova from '@lobehub/icons/es/SenseNova/components/Mono';
import Stepfun from '@lobehub/icons/es/Stepfun/components/Mono';
import Midjourney from '@lobehub/icons/es/Midjourney/components/Mono';
import Stability from '@lobehub/icons/es/Stability/components/Mono';
import Cloudflare from '@lobehub/icons/es/Cloudflare/components/Mono';
import Vercel from '@lobehub/icons/es/Vercel/components/Mono';
import DeepInfra from '@lobehub/icons/es/DeepInfra/components/Mono';
import Novita from '@lobehub/icons/es/Novita/components/Mono';
import Nebius from '@lobehub/icons/es/Nebius/components/Mono';
import GiteeAI from '@lobehub/icons/es/GiteeAI/components/Mono';

/** 图标清单条目：key 持久化用，name 供选择器显示与搜索 */
export interface ProviderIconEntry {
  key: string;
  name: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
}

/** 精选供应商图标清单（选择器数据源；名字与 @lobehub/icons 实际导出核对过） */
export const PROVIDER_ICON_LIST: ProviderIconEntry[] = [
  { key: 'openai', name: 'OpenAI', Icon: OpenAI },
  { key: 'anthropic', name: 'Anthropic', Icon: Anthropic },
  { key: 'claude', name: 'Claude', Icon: Claude },
  { key: 'google', name: 'Google', Icon: Google },
  { key: 'gemini', name: 'Gemini', Icon: Gemini },
  { key: 'deepseek', name: 'DeepSeek', Icon: DeepSeek },
  { key: 'qwen', name: 'Qwen', Icon: Qwen },
  { key: 'kimi', name: 'Kimi', Icon: Kimi },
  { key: 'moonshot', name: 'Moonshot', Icon: Moonshot },
  { key: 'zhipu', name: 'Zhipu', Icon: Zhipu },
  { key: 'chatglm', name: 'ChatGLM', Icon: ChatGLM },
  { key: 'doubao', name: 'Doubao', Icon: Doubao },
  { key: 'bytedance', name: 'ByteDance', Icon: ByteDance },
  { key: 'minimax', name: 'Minimax', Icon: Minimax },
  { key: 'mistral', name: 'Mistral', Icon: Mistral },
  { key: 'meta', name: 'Meta', Icon: Meta },
  { key: 'xai', name: 'xAI', Icon: XAI },
  { key: 'grok', name: 'Grok', Icon: Grok },
  { key: 'groq', name: 'Groq', Icon: Groq },
  { key: 'together', name: 'Together', Icon: Together },
  { key: 'fireworks', name: 'Fireworks', Icon: Fireworks },
  { key: 'perplexity', name: 'Perplexity', Icon: Perplexity },
  { key: 'cohere', name: 'Cohere', Icon: Cohere },
  { key: 'openrouter', name: 'OpenRouter', Icon: OpenRouter },
  { key: 'ollama', name: 'Ollama', Icon: Ollama },
  { key: 'siliconcloud', name: 'SiliconCloud', Icon: SiliconCloud },
  { key: 'azure', name: 'Azure', Icon: Azure },
  { key: 'aws', name: 'AWS', Icon: Aws },
  { key: 'bedrock', name: 'Bedrock', Icon: Bedrock },
  { key: 'huggingface', name: 'HuggingFace', Icon: HuggingFace },
  { key: 'alibabacloud', name: 'AlibabaCloud', Icon: AlibabaCloud },
  { key: 'volcengine', name: 'Volcengine', Icon: Volcengine },
  { key: 'zeroone', name: '01.AI', Icon: ZeroOne },
  { key: 'nvidia', name: 'Nvidia', Icon: Nvidia },
  { key: 'github', name: 'GitHub', Icon: Github },
  { key: 'lmstudio', name: 'LmStudio', Icon: LmStudio },
  { key: 'baidu', name: 'Baidu', Icon: Baidu },
  { key: 'tencent', name: 'Tencent', Icon: Tencent },
  { key: 'hunyuan', name: 'Hunyuan', Icon: Hunyuan },
  { key: 'sensenova', name: 'SenseNova', Icon: SenseNova },
  { key: 'stepfun', name: 'Stepfun', Icon: Stepfun },
  { key: 'midjourney', name: 'Midjourney', Icon: Midjourney },
  { key: 'stability', name: 'Stability', Icon: Stability },
  { key: 'cloudflare', name: 'Cloudflare', Icon: Cloudflare },
  { key: 'vercel', name: 'Vercel', Icon: Vercel },
  { key: 'deepinfra', name: 'DeepInfra', Icon: DeepInfra },
  { key: 'novita', name: 'Novita', Icon: Novita },
  { key: 'nebius', name: 'Nebius', Icon: Nebius },
  { key: 'giteeai', name: 'GiteeAI', Icon: GiteeAI },
];

const ICON_MAP = new Map(PROVIDER_ICON_LIST.map((e) => [e.key, e.Icon]));

/**
 * 按 key 取供应商图标组件；未命中返回 null（调用方 fallback lucide Server）。
 */
export function getProviderIcon(key?: string): ComponentType<{ size?: number; className?: string }> | null {
  if (!key) return null;
  return ICON_MAP.get(key) ?? null;
}
