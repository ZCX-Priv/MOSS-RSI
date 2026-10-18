// src/modules/remote/login-page.ts
// 远程访问拦截页（未认证的 HTML 导航请求由请求门卫直接返回本页）。
//
// 三个页面共用一套设计令牌与外壳：
//   - loginPageHtml            登录页（8 格分段密码 + POST /remote/login + 错误/锁定提示）
//   - lanDisabledPageHtml      局域网访问已关闭提示
//   - tunnelNotRunningPageHtml 公网隧道未开启提示
//
// 设计要点：
// - 无卡片极简版式：品牌图标 → 标题 → 副标题（居中）→ 左对齐标签「访问密码」→ 输入区 → 主按钮；
// - 明暗跟随 webui 设置：内联脚本复刻 webui/index.html 的主题判定（读 localStorage 快照
//   moss-theme-fast，system/无值时跟随系统；异常默认暗色），首帧前设置 <html data-theme>；
// - 移动端优先：100dvh、安全区、窄屏两行四格、触控尺寸达标、16px 字号防 iOS 缩放；
// - 品牌图标复用项目既有 MOSS.png，经请求门卫白名单放行（/MOSS.png，见 guard.ts）；
// - 密码输入为「单字段 + 8 格可视化」：真实 <input name="token"> 叠加在格子上，
//   承担聚焦/键盘/粘贴/校验/提交；无 JS 时经 <noscript> 回退为普通输入框。

export interface LoginPageOptions {
  /** false=首次打开 | true=密码错误 | 'locked'=锁定中（带剩余秒数） */
  error: false | true | 'locked';
  /** 作用域提示：局域网 / 公网 */
  isPublic: boolean;
  /** 锁定剩余秒数（error === 'locked' 时展示） */
  retryAfter?: number;
}

/** 与 webui 一致的系统字体栈（登录页无法加载站点字体，避免额外请求） */
const FONT_STACK =
  "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";

/**
 * 主题判定脚本：逐行复刻 webui/index.html 的启动主题逻辑，
 * 从而"跟随 webui 设置"（同设备上 webui 上一次选择的主题；无记录/异常回退系统）。
 * 须在 body 渲染前同步执行，保证首帧底色正确（无白→黑闪烁）。
 */
const THEME_SCRIPT =
  "(function(){var t='dark';try{var s=localStorage.getItem('moss-theme-fast');" +
  "var dark=s==='dark'||((s==='system'||!s)&&window.matchMedia('(prefers-color-scheme: dark)').matches);" +
  "t=dark?'dark':'light';}catch(e){}" +
  "document.documentElement.setAttribute('data-theme',t);" +
  "var tc=document.getElementById('tc');if(tc)tc.setAttribute('content',t==='dark'?'#0a0a0a':'#ffffff');})();";

/** 共享样式（设计令牌 + 组件样式，三页复用；明暗走 html[data-theme]） */
const SHARED_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
:root{
  color-scheme:light;
  --bg:#ffffff;
  --fg:#0a0a0a;
  --muted:#737373;
  --border:#e5e5e5;
  --cell-bg:#ffffff;
  --cell-border:#e5e5e5;
  --brand:#2563eb;
  --brand-hover:#1d4ed8;
  --ring:rgba(37,99,235,.35);
  --danger:#dc2626;
}
html[data-theme='dark']{
  color-scheme:dark;
  --bg:#0a0a0a;
  --fg:#fafafa;
  --muted:#a1a1aa;
  --border:rgba(255,255,255,.10);
  --cell-bg:#141416;
  --cell-border:rgba(255,255,255,.14);
  --ring:rgba(37,99,235,.5);
  --danger:#f87171;
}
html{background:var(--bg)}
body{
  min-height:100vh;
  min-height:100dvh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:
    max(28px,env(safe-area-inset-top))
    max(20px,env(safe-area-inset-right))
    max(28px,env(safe-area-inset-bottom))
    max(20px,env(safe-area-inset-left));
  background:var(--bg);
  color:var(--fg);
  font-family:${FONT_STACK};
  font-size:16px;
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}
.page{width:100%;max-width:360px;text-align:center}
.logo{display:block;width:56px;height:56px;margin:0 auto 20px;border-radius:14px}
h1{font-size:24px;font-weight:700;letter-spacing:-.01em;margin:0 0 10px}
.lead{font-size:14px;color:var(--muted);line-height:1.7;margin:0 0 28px}
.lead--last{margin-bottom:0}
.lead .en{display:block;font-size:12.5px;opacity:.85;margin-top:3px}
form{margin:0;text-align:left}
.field-label{display:block;font-size:13px;font-weight:600;margin:0 0 8px}
.pin{position:relative}
.cells{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px}
.cell{
  height:52px;display:flex;align-items:center;justify-content:center;
  background:var(--cell-bg);border:1px solid var(--cell-border);border-radius:10px;
  font-size:21px;font-weight:600;font-variant-numeric:tabular-nums;
  transition:border-color .15s ease,box-shadow .15s ease;
}
.cell.is-active{border-color:var(--brand);box-shadow:0 0 0 3px var(--ring)}
/* 真实输入：叠加覆盖在格子上，文字/光标透明（由格子可视化） */
#pin{
  position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;
  border:0;outline:0;background:transparent;
  color:transparent;-webkit-text-fill-color:transparent;caret-color:transparent;
  font-size:16px;
}
#pin::selection{background:transparent}
.err{display:none;font-size:13px;line-height:1.5;color:var(--danger);margin:10px 0 0}
.err.show{display:block}
.err b{font-variant-numeric:tabular-nums}
.btn{
  width:100%;height:50px;margin-top:16px;border:0;border-radius:11px;cursor:pointer;
  font-family:inherit;font-size:15px;font-weight:600;color:#fff;
  background:var(--brand);
  transition:background-color .15s ease,transform .1s ease,box-shadow .15s ease;
}
.btn:hover{background:var(--brand-hover)}
.btn:active{transform:translateY(1px)}
.btn:focus-visible{outline:0;box-shadow:0 0 0 3px var(--ring)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.hint{font-size:12px;color:var(--muted);line-height:1.7;margin:18px 0 0}
.hint .en{display:block;opacity:.8}
/* 窄屏：两行四格（格子更大、更好点按） */
@media (max-width:380px){
  .cells{grid-template-columns:repeat(4,minmax(0,1fr))}
}
`;

/** 无 JS 兜底：隐藏格子，还原为可见的普通输入框 */
const NOSCRIPT_CSS = `
.cells{display:none!important}
.pin{position:static}
#pin{
  position:static;color:var(--fg);-webkit-text-fill-color:var(--fg);caret-color:auto;
  background:var(--cell-bg);border:1px solid var(--cell-border);border-radius:10px;
  height:52px;text-align:center;font-size:20px;letter-spacing:.5em;padding-left:.5em;
}
`;

/** 页面外壳：统一 head（主题脚本先于渲染执行）+ 居中容器 */
function pageShell(title: string, inner: string, script = ''): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<meta id="tc" name="theme-color" content="#0a0a0a">
<script>${THEME_SCRIPT}</script>
<style>${SHARED_CSS}</style>
<noscript><style>${NOSCRIPT_CSS}</style></noscript>
</head><body><main class="page">${inner}</main>${
    script ? `<script>${script}</script>` : ''
  }</body></html>`;
}

/** 品牌图标（复用项目既有 MOSS.png；经门卫白名单放行） */
function logoHtml(): string {
  return '<img class="logo" src="/MOSS.png" alt="MOSS" width="56" height="56" draggable="false">';
}

/** 登录页 HTML（POST /remote/login 表单提交，成功后 302 回 /）。 */
export function loginPageHtml(opts: LoginPageOptions): string {
  const isPublic = opts.isPublic;
  const where = isPublic ? '此公网地址' : '此局域网地址';
  const whereEn = isPublic ? 'This public address' : 'This LAN address';
  const retry = opts.retryAfter ?? 60;

  const err =
    opts.error === 'locked'
      ? `<p class="err show" role="alert">尝试次数过多，请 <b id="cd">${retry}</b> 秒后再试 | Too many attempts — try again later</p>`
      : opts.error
        ? '<p class="err show" role="alert">密码错误，请重试 | Wrong PIN, try again</p>'
        : '';

  const cells = '<span class="cell"></span>'.repeat(8);

  const lockScript =
    opts.error === 'locked'
      ? `(function(){var left=${retry};var cd=document.getElementById('cd');var pin=document.getElementById('pin');var btn=document.getElementById('submitBtn');if(pin)pin.disabled=true;if(btn)btn.disabled=true;var t=setInterval(function(){left--;if(cd)cd.textContent=String(left<0?0:left);if(left<=0){clearInterval(t);if(pin){pin.disabled=false;pin.focus();}if(btn)btn.disabled=false;}},1000);})();`
      : '';

  const otpScript = `(function(){var input=document.getElementById('pin'),wrap=document.getElementById('pinWrap');if(!input||!wrap)return;var cells=[].slice.call(wrap.querySelectorAll('.cell'));function render(){var v=(input.value||'').replace(/\\D/g,'').slice(0,8);if(v!==input.value)input.value=v;var focused=document.activeElement===input;for(var i=0;i<cells.length;i++){var c=cells[i];c.textContent=v.charAt(i)||'';c.className='cell'+(i<v.length?' is-filled':'')+(focused&&i===v.length&&v.length<8?' is-active':'');}}input.addEventListener('input',render);input.addEventListener('focus',render);input.addEventListener('blur',render);input.addEventListener('paste',function(){setTimeout(render,0);});wrap.addEventListener('click',function(){input.focus();});render();})();`;

  const inner = `${logoHtml()}
<h1>MOSS</h1>
<p class="lead">${where}受访问密码保护，请输入 8 位数字密码<span class="en">${whereEn} is password-protected — enter the 8-digit PIN</span></p>
<form method="post" action="/remote/login">
<label class="field-label" for="pin">访问密码</label>
<div class="pin" id="pinWrap">
<input id="pin" name="token" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]{8}" autofocus required aria-label="8 位数字密码">
<div class="cells" aria-hidden="true">${cells}</div>
</div>
${err}
<button class="btn" type="submit" id="submitBtn">进入 / Enter</button>
</form>
<p class="hint">登录一次后长期免输（MOSS 重启后需重新输入）<span class="en">Log in once — re-enter after MOSS restarts</span></p>`;

  return pageShell('MOSS · 远程访问验证', inner, lockScript + otpScript);
}

/** 局域网访问已关闭的提示页（浏览器导航时显示；API 返回 403 JSON）。 */
export function lanDisabledPageHtml(): string {
  const inner = `${logoHtml()}
<h1>局域网访问已关闭</h1>
<p class="lead lead--last">扫码/链接均不可用，请在电脑上重新开启后再试。<span class="en">LAN access is disabled — re-enable it on the computer to continue.</span></p>`;
  return pageShell('MOSS · 局域网访问已关闭', inner);
}

/** 公网隧道未运行的提示页（伪造 trycloudflare Host 直连时显示）。 */
export function tunnelNotRunningPageHtml(): string {
  const inner = `${logoHtml()}
<h1>公网隧道未开启</h1>
<p class="lead lead--last">公网隧道未开启或已关闭。<span class="en">The public tunnel is not running.</span></p>`;
  return pageShell('MOSS · 公网隧道未开启', inner);
}
