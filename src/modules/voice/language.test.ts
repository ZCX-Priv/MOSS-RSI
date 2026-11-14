// src/modules/voice/language.test.ts
import { describe, expect, test } from 'bun:test';
import { detectScript, normalizeAsrText, resolveLanguage } from './language';

describe('voice/language（脚本检测 + 文本后处理）', () => {
  test('detectScript：中文/日文/韩文/英文', () => {
    expect(detectScript('今天天气不错')).toBe('zh');
    expect(detectScript('これはテストです')).toBe('ja');
    expect(detectScript('안녕하세요')).toBe('ko');
    expect(detectScript('hello world')).toBe('latin');
  });

  test('resolveLanguage：模型 lang 与脚本一致时采用模型值', () => {
    expect(resolveLanguage('zh', '请打开文件夹')).toBe('zh');
    expect(resolveLanguage('en', 'open the folder')).toBe('en');
  });

  test('resolveLanguage：短文本复用之上一段稳定语言', () => {
    expect(resolveLanguage('en', '好', 'zh')).toBe('zh');
    expect(resolveLanguage(undefined, 'OK', 'en')).toBe('en');
  });

  test('resolveLanguage：脚本与模型 lang 冲突时以脚本为准', () => {
    expect(resolveLanguage('ja', '这是中文内容')).toBe('zh');
  });

  test('normalizeAsrText：清除控制标签与非语音标记', () => {
    expect(normalizeAsrText('<|zh|><|NEUTRAL|><|Speech|>你好')).toBe('你好');
    expect(normalizeAsrText('  [BLANK_AUDIO] ')).toBe('');
    expect(normalizeAsrText('hello (music) world')).toBe('hello world');
  });

  test('normalizeAsrText：中英混排与重复标点', () => {
    expect(normalizeAsrText('请打开 m oss 文件夹')).toBe('请打开 m oss 文件夹');
    expect(normalizeAsrText('真的吗？？？')).toBe('真的吗？');
    expect(normalizeAsrText('好的，，继续')).toBe('好的，继续');
  });
});
