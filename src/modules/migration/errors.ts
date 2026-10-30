// src/modules/migration/errors.ts
// 迁移模块统一错误：带错误码（路由层直接映射为 HTTP 响应，前端按 `errors.{code}` 翻译）。

export class MigrationError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'MigrationError';
  }
}
