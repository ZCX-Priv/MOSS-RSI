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
import {
  cleanRunOutput,
  findEchoEnd,
  findPromptTail,
  isContinuationTail,
  MarkerLineFilter,
  stripTerminalNoise,
} from './clean-output';
import { OscScanner } from './osc';

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

describe('MarkerLineFilter（人侧双端清洗）', () => {
  it('丢弃标记行与语法碎片行，保留真实输出与提示符', () => {
    const f = new MarkerLineFilter();
    const raw = [
      'C:\\work>echo hi',
      'hi',
      'C:\\work>echo __MOSS_DONE_ab12__ %errorlevel%',
      '__MOSS_DONE_ab12__ 0',
      'C:\\work>',
    ].join('\r\n');
    expect(f.push(`${raw}\r\n`)).toBe('C:\\work>echo hi\r\nhi\r\nC:\\work>\r\n');
  });

  it('标记行被分片切断时仍整体丢弃', () => {
    const f = new MarkerLineFilter();
    expect(f.push('out\r\n__MOSS_DO')).toBe('out\r\n');
    expect(f.push('NE_ab12__ 0\r\nnext\r\n')).toBe('next\r\n');
  });

  it('未以换行结尾的普通提示符立即输出（不被扣留）', () => {
    const f = new MarkerLineFilter();
    expect(f.push('C:\\work>')).toBe('C:\\work>');
    expect(f.push('dir\r\n')).toBe('dir\r\n');
  });

  it('硬换行后的续行碎片行被丢弃', () => {
    const f = new MarkerLineFilter();
    f.push('C:\\work>echo __MOSS_DONE_ab12__ %errorl');
    expect(f.push('evel%\r\nresult\r\n')).toBe('result\r\n');
  });
});

describe('findPromptTail（cmd / PowerShell 提示符结算）', () => {
  it('cmd：末尾提示符命中；命令回显不误判', () => {
    const raw = 'C:\\work>dir\r\nfile.txt\r\nC:\\work>';
    expect(findPromptTail(raw, 0, 'cmd')).toBe(raw.lastIndexOf('C:\\work>'));
    expect(findPromptTail('C:\\work>echo hi', 0, 'cmd')).toBe(-1);
  });

  it('cmd：输出无换行结尾时提示符紧随其后', () => {
    const raw = 'C:\\work>set /p x=hi\r\nhiC:\\work>';
    expect(findPromptTail(raw, 0, 'cmd')).toBe(raw.lastIndexOf('C:\\work>'));
  });

  it('cmd：提示符被硬换行（长 cwd）仍可识别', () => {
    const raw = 'C:\\work>x\r\nC:\\Users\\Very\\Long\\Path\\That\\Wra\r\nps>';
    expect(findPromptTail(raw, 0, 'cmd')).toBe(raw.lastIndexOf('C:\\Users'));
  });

  it('只从 from 之后寻找（排除上一条命令的提示符）', () => {
    const prompt = 'C:\\work>';
    const raw = `C:\\work>old\r\nout\r\n${prompt}`;
    expect(findPromptTail(raw, raw.length - prompt.length, 'cmd')).toBe(raw.lastIndexOf(prompt));
    expect(findPromptTail(raw, raw.length, 'cmd')).toBe(-1);
  });

  it('PowerShell / bash 的尾部提示符', () => {
    const ps = 'PS C:\\work> Write-Output hi\r\nhi\r\nPS C:\\work> ';
    expect(findPromptTail(ps, 0, 'powershell')).toBe(ps.lastIndexOf('PS C:\\work>'));
    const sh = 'user@host:~$ echo hi\r\nhi\r\nuser@host:~$ ';
    expect(findPromptTail(sh, 0, 'bash')).toBe(sh.lastIndexOf('user@host'));
  });
});

describe('findEchoEnd（OSC 回显门控）', () => {
  it('识别回显并返回结束下标', () => {
    const raw = 'C:\\work>dir\r\n Volume in drive C';
    expect(findEchoEnd(raw, 0, 'dir')).toBe(raw.indexOf('dir') + 'dir'.length);
  });

  it('多行命令：跨过 PowerShell 续行提示符（>>）定位整条回显', () => {
    const cmd = 'Get-ChildItem |\n  Where-Object { $_.Length -gt 0 }';
    const raw =
      'PS C:\\work> Get-ChildItem |\r\n>>   Where-Object { $_.Length -gt 0 }\r\nfoo.txt';
    const end = findEchoEnd(raw, 0, cmd);
    expect(end).toBeGreaterThan(0);
    // 回显区间覆盖到第二行末尾的右花括号
    expect(raw.slice(0, end)).toContain('$_.Length -gt 0 }');
    // 精确窗口从这里开始 → 只剩真实输出
    expect(raw.slice(end).replace(/^\r\n/, '')).toBe('foo.txt');
  });

  it('多行命令：硬换行切断时仍能拼回整条命令', () => {
    const cmd = 'echo "a"\nWrite-Output "b"';
    const raw = 'PS C:\\x> echo "a"\r\n>> Write-Outp\r\n>> ut "b"\r\nb';
    const end = findEchoEnd(raw, 0, cmd);
    expect(end).toBeGreaterThan(0);
    expect(raw.slice(end).replace(/^\r\n/, '')).toBe('b');
  });

  it('容忍硬换行与 ANSI 重绘', () => {
    const raw = 'PS C:\\x> pytho\u001b[0m\r\nn -c "print(1)"\r\n1';
    const end = findEchoEnd(raw, 0, 'python -c "print(1)"');
    expect(end).toBeGreaterThan(0);
    expect(raw.slice(0, end)).toContain('print(1)"');
  });

  it('无回显返回 -1', () => {
    expect(findEchoEnd('some output\r\n', 0, 'dir')).toBe(-1);
  });

  it('残留 D 位于回显之前（不得越过门控），完成 D 位于回显之后', () => {
    const nonce = 'n1';
    const intro = (payload: string): string => `\u001b]${payload}\u0007`;
    const residual = intro(`133;D;0;${nonce}`);
    const echo = 'C:\\work>echo hi';
    const head = residual + echo;
    const end = findEchoEnd(head, 0, 'echo hi');
    expect(end).toBeGreaterThan(0);
    const first = new OscScanner(nonce).push(head);
    expect(first.length).toBe(1);
    expect(first[0].kind).toBe('D');
    // 残留 D 的绝对位置早于回显结束 → 门控（at >= echoEnd）不会结算
    expect(first[0].at).toBeLessThan(end);
    const completion = new OscScanner(nonce).push(head + intro(`133;D;0;${nonce}`));
    expect(completion[completion.length - 1].at).toBeGreaterThanOrEqual(end);
  });
});

describe('isContinuationTail（续行看门狗）', () => {
  it('PowerShell 停在 >> 续行提示符 → 判定语法不完整', () => {
    expect(isContinuationTail('PS C:\\x> Get-ChildItem |\r\n>> ', 0, 'powershell')).toBe(true);
    expect(isContinuationTail('PS C:\\x> echo "unclosed\r\n>> ', 0, 'powershell')).toBe(true);
  });

  it('PowerShell 正常提示符（含裸 >> 开头的输出）不误判', () => {
    expect(isContinuationTail('PS C:\\x> ', 0, 'powershell')).toBe(false);
    expect(isContinuationTail('PS C:\\x> dir\r\nfile.txt\r\nPS C:\\x> ', 0, 'powershell')).toBe(false);
  });

  it('bash/zsh 停在 > 续行提示符 → true；cmd 永不判定', () => {
    expect(isContinuationTail('user@host:~$ echo "x\r\n> ', 0, 'bash')).toBe(true);
    expect(isContinuationTail('PS C:\\x>\r\n>> ', 0, 'cmd')).toBe(false);
  });

  it('只检查提交点之后的尾部', () => {
    const raw = 'PS C:\\x> old\r\n>> \r\nPS C:\\x> new';
    expect(isContinuationTail(raw, raw.indexOf('new'), 'powershell')).toBe(false);
  });
});

describe('stripTerminalNoise（OSC 精确窗口轻量清洗）', () => {
  it('去 ANSI / 标记行 / 纯提示符 / 纯续行行，仅留真实输出', () => {
    const raw = [
      '\u001b[32mline1\u001b[0m',
      'PS C:\\work>',
      '>> ',
      '__MOSS_DONE_ab12__ 0',
      'line2',
    ].join('\r\n');
    expect(stripTerminalNoise(raw)).toBe('line1\nline2');
  });

  it('保留含 > 的正常输出行（只删纯提示符行）', () => {
    const raw = 'a > b\r\nc';
    expect(stripTerminalNoise(raw)).toBe('a > b\nc');
  });
});
