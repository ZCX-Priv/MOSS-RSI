// src/modules/migration/crypto.test.ts
// 备份包加解密往返与容错。

import { describe, expect, it } from 'bun:test';
import { decryptBackup, encryptBackup, isEncryptedBackup, unwrapBackup } from './crypto';
import { MigrationError } from './errors';

const PASSWORD = 'correct-horse-battery';
/** 模拟 zip 字节（PK 头 + 若干数据） */
const PAYLOAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 200 }, (_, i) => (i * 7) % 256)]);

describe('备份包加密', () => {
  it('加密后可解密还原原字节', () => {
    const sealed = encryptBackup(PAYLOAD, PASSWORD);
    expect(isEncryptedBackup(sealed)).toBe(true);
    const opened = decryptBackup(sealed, PASSWORD);
    expect(Array.from(opened)).toEqual(Array.from(PAYLOAD));
  });

  it('密码错误抛 MIGRATION_PASSWORD_WRONG', () => {
    const sealed = encryptBackup(PAYLOAD, PASSWORD);
    try {
      decryptBackup(sealed, 'wrong-password-x');
      expect(false).toBe(true); // 不应到达
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationError);
      expect((err as MigrationError).code).toBe('MIGRATION_PASSWORD_WRONG');
    }
  });

  it('密码过短拒绝加密', () => {
    try {
      encryptBackup(PAYLOAD, 'short');
      expect(false).toBe(true);
    } catch (err) {
      expect((err as MigrationError).code).toBe('MIGRATION_PASSWORD_REQUIRED');
    }
  });

  it('明文 zip 无需密码原样返回', () => {
    expect(unwrapBackup(PAYLOAD, undefined)).toBe(PAYLOAD);
  });

  it('加密包缺密码抛 MIGRATION_PASSWORD_REQUIRED', () => {
    const sealed = encryptBackup(PAYLOAD, PASSWORD);
    try {
      unwrapBackup(sealed, undefined);
      expect(false).toBe(true);
    } catch (err) {
      expect((err as MigrationError).code).toBe('MIGRATION_PASSWORD_REQUIRED');
    }
  });
});
