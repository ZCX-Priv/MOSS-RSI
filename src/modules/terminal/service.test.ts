// src/modules/terminal/service.test.ts
// cleanRunOutput 单测：以真实会话记录为夹具，验证终端工具返回给模型的输出已被洗净。
//
// 夹具来源（第一性原理：直接取自真实记录，非臆造）：
//   会话 ~/.moss/tasks/af3c0e97-a736-40a3-a707-6a489a53da5f/95b28dc8-a60b-4331-94e8-2fed67f162e8.json
//   - 行 226：PIL 检查（exitCode 1）—— 旧清洗后仍残留「提示符回显 + 编码初始化回显 + 命令回显 +
//     被硬换行切断的标记语法碎片 $(if ($?) {0} else {1})」，是 AI 误判的直接原因；
//   - 行 257：pip 安装（--quiet 无输出）—— 旧清洗后残留 `c` 碎片 + 命令回显 + `{0} else {1})"`。
// 断言：清洗后仅剩本次命令的真实输出，不含回显命令、提示符、`__MOSS_DONE`、标记语法碎片。
// 运行：bun test src/modules/terminal/service.test.ts

import { describe, it, expect } from 'bun:test';
import { cleanRunOutput } from './clean-output';

/** 会话记录行 226 的原始切片（重绘/硬换行形态，真实记录经旧清洗后的残留） */
const RAW_PIL = [
  'PS C:\\Users\\赵晨旭\\Desktop\\math> PS C:\\Users\\赵晨旭\\Desktop\\math> [Console]::OutputEncoding=[System.Text.Encoding',
  ']::UTF8',
  'PS C:\\Users\\赵晨旭\\Desktop\\math> cd C:\\Users\\赵晨旭\\Desktop\\math\\26-10-19; pytho',
  'n -c "from PIL import Image; import glob; [print(f, Image.open(f).size) for f in',
  " glob.glob('*.jpg')]\"",
  'Traceback (most recent call last):',
  '  File "<string>", line 1, in <module>',
  '    from PIL import Image; import glob; [print(f, Image.open(f).size) for f in g',
  "lob.glob('*.jpg')]",
  '    ^^^^^^^^^^^^^^^^^^^^^',
  "ModuleNotFoundError: No module named 'PIL'",
  '(if ($?) {0} else {1})"',
].join('\n');

const CMD_PIL =
  'cd C:\\Users\\赵晨旭\\Desktop\\math\\26-10-19; python -c "from PIL import Image; import glob; [print(f, Image.open(f).size) for f in glob.glob(\'*.jpg\')]"';
const ENCODING_INIT = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8';

/** 会话记录行 257 的原始切片（pip --quiet，正常无输出，但被回显污染） */
const RAW_PIP = [
  'c',
  'PS C:\\Users\\赵晨旭\\Desktop\\math\\26-10-19> cd C:\\Users\\赵晨旭\\Desktop\\math; pytho',
  'n -m pip install pillow --quiet 2>&1 | Select-Object -Last 3',
  '{0} else {1})"',
].join('\n');

const CMD_PIP =
  'cd C:\\Users\\赵晨旭\\Desktop\\math; python -m pip install pillow --quiet 2>&1 | Select-Object -Last 3';

describe('cleanRunOutput', () => {
  it('剔除回显命令/编码初始化/标记碎片，只留真实输出（真实样本：PIL 失败）', () => {
    const out = cleanRunOutput(RAW_PIL, [CMD_PIL, ENCODING_INIT]);
    // 真实输出保留（Python traceback）
    expect(out).toContain('Traceback (most recent call last):');
    expect(out).toContain("ModuleNotFoundError: No module named 'PIL'");
    // 回显与噪声全部消失
    expect(out).not.toContain('PS C:');
    expect(out).not.toContain('OutputEncoding');
    expect(out).not.toContain('__MOSS_DONE');
    expect(out).not.toContain('if ($?)');
    expect(out).not.toContain('else {1}');
    expect(out).not.toContain('python -c'); // 回显的命令行
    // 首行即真实输出
    expect(out.startsWith('Traceback (most recent call last):')).toBe(true);
  });

  it('命令无输出时清洗后为空（真实样本：pip --quiet）', () => {
    const out = cleanRunOutput(RAW_PIP, [CMD_PIP, ENCODING_INIT]);
    expect(out).toBe('');
  });

  it('中止标记结果行（__MOSS_DONE）', () => {
    const raw = [
      'PS C:\\work> run-cmd',
      'some real output',
      '__MOSS_DONE_abc123__ 0',
      'echo __MOSS_DONE_abc123__ %errorlevel%',
    ].join('\r\n');
    const out = cleanRunOutput(raw, ['run-cmd']);
    expect(out).toBe('some real output');
  });

  it('无回显（管道模式）时保持原输出不变', () => {
    const raw = 'hello\nworld\n';
    expect(cleanRunOutput(raw, ['dir'])).toBe('hello\nworld');
  });

  it('空输入返回空串', () => {
    expect(cleanRunOutput('', ['dir', null, undefined])).toBe('');
  });

  it('ANSI 转义被去除', () => {
    const raw = '\u001b[32mOK\u001b[0m\r\n\u001b[1;1Hdone';
    expect(cleanRunOutput(raw, [])).toBe('OK\ndone');
  });
});
