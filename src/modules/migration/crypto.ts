// src/modules/migration/crypto.ts
// 备份包加解密：scrypt 派生密钥 + AES-256-GCM（node:crypto，Bun 原生支持）。
//
// 容器格式（.mossbak）：
//   0   8B   magic "MOSSBK01"
//   8   16B  salt（随机）
//   24  12B  iv（随机）
//   36  16B  authTag（GCM 认证标签）
//   52  ...  ciphertext（加密后的 zip 字节）
//
// 设计取舍：整包加密而非仅加密密钥字段——备份包内含 API 密钥，
// 任何字段级加密都无法防止包泄露后的完整还原。

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { ErrorCode } from '../../core/error-codes';
import { MigrationError } from './errors';

const MAGIC = 'MOSSBK01';
const MAGIC_BYTES = Buffer.from(MAGIC, 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** scrypt 参数：约 16MB 内存、数十毫秒，本地备份场景足够（兼顾暴力破解成本与响应速度） */
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;

/** 文件头长度（magic + salt + iv + tag） */
const HEADER_BYTES = MAGIC_BYTES.length + SALT_BYTES + IV_BYTES + TAG_BYTES;

/** 密码最短长度：低于该长度密钥强度不足，直接拒绝导出 */
export const MIN_PASSWORD_LENGTH = 8;

/** 是否为加密备份容器（否则按明文 zip 处理） */
export function isEncryptedBackup(data: Uint8Array): boolean {
  if (data.length < MAGIC_BYTES.length) return false;
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (data[i] !== MAGIC_BYTES[i]) return false;
  }
  return true;
}

/** 加密 zip 字节，返回 .mossbak 容器字节 */
export function encryptBackup(zip: Uint8Array, password: string): Uint8Array {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new MigrationError(ErrorCode.MIGRATION_PASSWORD_REQUIRED);
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = scryptSync(password, salt, KEY_BYTES, SCRYPT_OPTIONS);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(zip), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC_BYTES, salt, iv, tag, ciphertext]);
}

/** 解密 .mossbak 容器，返回原始 zip 字节；密码错误抛 MIGRATION_PASSWORD_WRONG */
export function decryptBackup(data: Uint8Array, password: string): Uint8Array {
  if (!isEncryptedBackup(data) || data.length < HEADER_BYTES) {
    throw new MigrationError(ErrorCode.MIGRATION_ARCHIVE_INVALID);
  }
  let offset = MAGIC_BYTES.length;
  const salt = data.subarray(offset, (offset += SALT_BYTES));
  const iv = data.subarray(offset, (offset += IV_BYTES));
  const tag = data.subarray(offset, (offset += TAG_BYTES));
  const ciphertext = data.subarray(offset);
  const key = scryptSync(password, salt, KEY_BYTES, SCRYPT_OPTIONS);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM 认证失败 = 密码错误或容器被篡改（两者对用户而言同一处理）
    throw new MigrationError(ErrorCode.MIGRATION_PASSWORD_WRONG);
  }
}

/** 把任意备份文件字节解出 zip：加密容器走解密，明文 zip 原样返回 */
export function unwrapBackup(data: Uint8Array, password: string | undefined): Uint8Array {
  if (!isEncryptedBackup(data)) return data;
  if (!password) throw new MigrationError(ErrorCode.MIGRATION_PASSWORD_REQUIRED);
  return decryptBackup(data, password);
}
