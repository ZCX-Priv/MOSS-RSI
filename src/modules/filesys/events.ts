// src/modules/filesys/events.ts
// filesys 变更事件总线：file-created/edited/deleted/moved/terminal-changed 的统一事件源。
// engine 订阅后转 WS 推送（补齐旧版 delete/move 无通知的割裂）。

import type { FileChangeEvent } from './types';

export type FileChangeHandler = (event: FileChangeEvent) => void;

export class FilesysEventBus {
  private readonly listeners = new Set<FileChangeHandler>();

  /** 订阅变更事件，返回取消订阅函数 */
  on(handler: FileChangeHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /** 发出事件（同步分发；单个监听器异常不阻断其他监听器） */
  emit(event: FileChangeEvent): void {
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch {
        // 监听器自身负责容错；此处吞掉避免事件链路被单个消费者破坏
      }
    }
  }
}
