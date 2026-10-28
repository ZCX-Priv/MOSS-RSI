// webui/src/render/genui/context.ts
// GenUI 渲染上下文：组件只通过它读状态/解析绑定/触发本地动作，不接触模型或网络。

import type { ReactNode } from 'react';
import type { GenUINode, GenUIStateValue } from './types';

export interface GenUIRenderContext {
  state: Record<string, GenUIStateValue>;
  /** 递归解析 $state / $expr（保留 $action 原样，供组件绑定事件） */
  resolve: (value: unknown) => unknown;
  /** 解析为展示文本（null/失败 → ''） */
  resolveText: (value: unknown) => string;
  /** 解析为有限数字（失败 → 0） */
  resolveToNumber: (value: unknown) => number;
  /** 解析为布尔（仅 true/1/'true' 为 true） */
  resolveToBoolean: (value: unknown) => boolean;
  /** 把 $action 绑定转成事件处理器；非动作绑定返回 undefined */
  action: (value: unknown) => ((eventValue?: GenUIStateValue) => void) | undefined;
}

export interface GenUIComponentProps {
  node: GenUINode;
  ctx: GenUIRenderContext;
  renderChildren: (children: GenUINode['children']) => ReactNode;
}

export type GenUIComponent = (props: GenUIComponentProps) => ReactNode;
