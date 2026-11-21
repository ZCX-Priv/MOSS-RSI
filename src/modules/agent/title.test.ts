// src/modules/agent/title.test.ts
// 会话标题解析单测：标签提取、清理、回答特征拦截。

import { describe, it, expect } from 'bun:test';
import { parseTitle } from './title';

describe('parseTitle', () => {
  it('提取 <title> 标签内容', () => {
    expect(parseTitle('<title>MOSS 身份说明</title>')).toBe('MOSS 身份说明');
  });

  it('拦截自我介绍式回答', () => {
    expect(parseTitle('I am Moss, an AI assistant created by the Moss team.')).toBeNull();
  });

  it('拦截以第一人称开头的回答', () => {
    expect(parseTitle("I'm Moss, an AI assistant")).toBeNull();
    expect(parseTitle('我是 MOSS，一个 AI 助手')).toBeNull();
  });

  it('拦截道歉/客套式回答', () => {
    expect(parseTitle('Sure, here is a title for you')).toBeNull();
    expect(parseTitle('当然可以，以下是标题')).toBeNull();
  });

  it('纯标题无标签时兼容采用', () => {
    expect(parseTitle('登录接口500错误修复')).toBe('登录接口500错误修复');
    expect(parseTitle('Fix login API 500 error')).toBe('Fix login API 500 error');
  });

  it('版本号中的点不触发"多句"误判', () => {
    expect(parseTitle('v1.2.3 发布说明')).toBe('v1.2.3 发布说明');
  });

  it('清理标签内的引号与结尾标点', () => {
    expect(parseTitle('<title>“登录接口 500 错误修复”。</title>')).toBe('登录接口 500 错误修复');
  });

  it('空输出返回 null', () => {
    expect(parseTitle('')).toBeNull();
    expect(parseTitle('   ')).toBeNull();
    expect(parseTitle('<title></title>')).toBeNull();
  });
});
