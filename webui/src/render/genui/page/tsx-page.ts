// webui/src/render/genui/page/tsx-page.ts
// TSX 内嵌页面运行时：
//   - TSX 已由后端编译为 CJS（见 run_code/index.ts），前端只负责在沙箱 iframe 内执行；
//   - React / ReactDOM 的 CJS production 源码由 Vite 虚拟模块注入（不依赖网络）；
//   - 允许 CDN 时，外部 import 经 esm.sh 加载；React 通过 Blob 模块 shim + importmap 共享，
//     避免 CDN 里的 React 系库拿到第二份 React；
//   - 渲染错误、内容高度都会回传给宿主（不再出现空白 iframe）。

import cjsSources from 'virtual:react-cjs-raw';
import { SANDBOX_SHIM } from './sandbox-compat';

const BASE_CSS = [
  '*,*::before,*::after{box-sizing:border-box}',
  'html,body{margin:0;padding:0}',
  'body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif;-webkit-font-smoothing:antialiased}',
  'button,input,select,textarea{font:inherit}',
].join('');

/** react 家族由内置 CJS 运行时提供，不当作 CDN 依赖 */
const REACT_MODULES = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
]);

let cachedRuntime: string | null = null;

/** 内联脚本转义：避免源码里的 </script> 提前闭合标签 */
function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

/** 从编译后的 CJS 里提取外部 import（sucrase 的静态 import 会变成 require("…")） */
function collectExternalSpecs(compiled: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (spec: string): void => {
    if (!spec || REACT_MODULES.has(spec) || seen.has(spec)) return;
    seen.add(spec);
    out.push(spec);
  };
  for (const re of [/\brequire\(\s*(["'])([^"']+)\1\s*\)/g, /\bimport\(\s*(["'])([^"']+)\1\s*\)/g]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(compiled)) !== null) push(match[2]);
  }
  return out;
}

/** 极简 CJS 加载器 + React 运行时（模块级缓存，只构建一次） */
function buildRuntimeScript(): string {
  if (cachedRuntime !== null) return cachedRuntime;
  const parts = [
    '(function(){',
    'var __mods={},__cache={};',
    'function __def(n,s){__mods[n]=s;}',
    'function __req(n){',
    'if(__cache[n])return __cache[n].exports;',
    "var src=__mods[n];if(src===undefined)throw new Error('Cannot find module: '+n);",
    'var m={exports:{}};__cache[n]=m;',
    "var f=new Function('require','module','exports','process',src);",
    "f(__req,m,m.exports,{env:{NODE_ENV:'production'}});",
    'return m.exports;',
    '}',
    `__def('react',${JSON.stringify(cjsSources.react)});`,
    `__def('scheduler',${JSON.stringify(cjsSources.scheduler)});`,
    `__def('react-dom',${JSON.stringify(cjsSources['react-dom'])});`,
    `__def('react-dom-client',${JSON.stringify(cjsSources['react-dom-client'])});`,
    "window.React=__req('react');",
    "window.ReactDOM=__req('react-dom');",
    "window.ReactDOMClient=__req('react-dom-client');",
    '})();',
  ];
  cachedRuntime = parts.join('\n');
  return cachedRuntime;
}

/**
 * 挂载脚本：
 * - require 只允许 react 家族 + 已预加载的 CDN 模块；
 * - CDN 关闭时拒绝任何外部 import；
 * - ErrorBoundary + 全局错误监听 → 红色错误层（不再空白）；
 * - 内容高度通过 postMessage 回传宿主，用于 iframe 自适应高度。
 */
function buildHarness(compiled: string, allowCdn: boolean, externals: string[]): string {
  return [
    '(function(){',
    'var __module={exports:{}};',
    'var __external=Object.create(null);',
    `var __allowCdn=${allowCdn ? 'true' : 'false'};`,
    `var __externalSpecs=${JSON.stringify(externals)};`,
    'function __isValidName(k){return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)&&k!=="default"&&k!=="__esModule";}',
    'function __reactShim(globalName,extra){',
    'var R=window[globalName]||{};',
    'var parts=["const R=window["+JSON.stringify(globalName)+"];"];',
    'var names=Object.keys(R);',
    'for(var i=0;i<names.length;i++){var k=names[i];if(__isValidName(k))parts.push("export const "+k+"=R["+JSON.stringify(k)+"];");}',
    'parts.push("export default R.default||R;");',
    'if(extra)parts.push(extra);',
    'return URL.createObjectURL(new Blob([parts.join("\\n")],{type:"text/javascript"}));',
    '}',
    'function __installImportMap(){',
    'var jsxExtra="export const jsx=(type,props,key)=>R.createElement(type,key===undefined?props:Object.assign({},props,{key:key}));export const jsxs=jsx;export const jsxDEV=jsx;";',
    'var imports={',
    '"react":__reactShim("React"),',
    '"react-dom":__reactShim("ReactDOM"),',
    '"react-dom/client":__reactShim("ReactDOMClient"),',
    '"react/jsx-runtime":__reactShim("React",jsxExtra),',
    '"react/jsx-dev-runtime":__reactShim("React",jsxExtra)',
    '};',
    'for(var i=0;i<__externalSpecs.length;i++){var spec=__externalSpecs[i];if(/^https?:\\/\\//i.test(spec))continue;try{imports[spec]=__resolveCdn(spec);}catch(e){}}',
    'var s=document.createElement("script");s.type="importmap";s.textContent=JSON.stringify({imports:imports});document.head.appendChild(s);',
    '}',
    'function __resolveCdn(spec){',
    'if(/^https?:\\/\\//i.test(spec))return spec;',
    'if(spec.charAt(0)==="."||spec.charAt(0)==="/"||spec.indexOf("node:")===0)throw new Error("不支持的 import 路径："+spec+"（请使用 npm 包名或完整 https ESM URL）");',
    'return "https://esm.sh/"+spec+"?external=react,react-dom";',
    '}',
    'function __toCjs(ns){',
    'var out={};var keys=Object.keys(ns||{});',
    'for(var i=0;i<keys.length;i++)out[keys[i]]=ns[keys[i]];',
    'try{Object.defineProperty(out,"__esModule",{value:true});}catch(e){out.__esModule=true;}',
    'if(!("default" in out))out.default=ns;',
    'return out;',
    '}',
    'function __loadExternals(){',
    'if(__externalSpecs.length===0)return Promise.resolve();',
    'if(!__allowCdn)return Promise.reject(new Error("CDN 资源已禁用（设置 → 工具 → 代码模式 → 允许 CDN 资源）"));',
    '__installImportMap();',
    'return Promise.all(__externalSpecs.map(function(spec){',
    'try{',
    'var url=__resolveCdn(spec);',
    'return import(url).then(function(ns){__external[spec]=__toCjs(ns);});',
    '}catch(err){return Promise.reject(err);}',
    '}));',
    '}',
    'function __req(id){',
    "if(id==='react')return window.React;",
    "if(id==='react-dom')return window.ReactDOM;",
    "if(id==='react-dom/client')return window.ReactDOMClient;",
    "if(id==='react/jsx-runtime'||id==='react/jsx-dev-runtime')return window.React;",
    'if(__external[id])return __external[id];',
    'throw new Error(__allowCdn?"TSX 内嵌页面无法加载 CDN 模块："+id:"TSX 内嵌页面只允许 import react / react-dom（CDN 资源已禁用；收到："+id+"）");',
    '}',
    'function __fail(err){',
    "var pre=document.createElement('pre');",
    "pre.style.cssText='margin:0;padding:16px;color:#f87171;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap';",
    "pre.textContent='TSX 渲染失败：\\n'+(err&&err.stack?err.stack:String(err));",
    "document.body.innerHTML='';document.body.appendChild(pre);",
    'report();',
    '}',
    'function report(){',
    'try{',
    "var root=document.getElementById('root');",
    "var h=root?Math.ceil(root.getBoundingClientRect().height):0;",
    "if(!h&&document.body)h=Math.ceil(document.body.getBoundingClientRect().height);",
    "var max=Math.ceil((document.documentElement&&document.documentElement.scrollHeight)||0);",
    'if(h<=0)h=max;',
    "if(window.parent!==window)window.parent.postMessage({__mossPageHeight:h},'*');",
    '}catch(e){}',
    '}',
    'var __pending=false;',
    'function schedule(){if(__pending)return;__pending=true;requestAnimationFrame(function(){__pending=false;report();});}',
    "window.addEventListener('error',function(e){__fail(e&&e.error?e.error:(e&&e.message)||'unknown error');});",
    "window.addEventListener('unhandledrejection',function(e){__fail(e&&e.reason?e.reason:'unhandled rejection');});",
    'function __start(){',
    'try{',
    `var factory=new Function('require','module','exports','React','ReactDOM',${JSON.stringify(compiled)}+'\\n; return (module.exports&&(module.exports.default||module.exports.App))||(typeof App!=="undefined"?App:null);');`,
    'var App=factory(__req,__module,__module.exports,window.React,window.ReactDOM);',
    "if(!App)throw new Error('TSX 需要 export default 一个 React 组件');",
    'var Boundary=class extends window.React.Component{',
    'constructor(p){super(p);this.state={err:null};}',
    'static getDerivedStateFromError(err){return {err:err};}',
    'render(){',
    'if(this.state.err){',
    "return window.React.createElement('pre',{style:{margin:0,padding:16,color:'#f87171',font:'12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',whiteSpace:'pre-wrap'}},'TSX 渲染失败：\\n'+((this.state.err&&this.state.err.stack)||String(this.state.err)));",
    '}',
    'return this.props.children;',
    '}',
    '};',
    "window.ReactDOMClient.createRoot(document.getElementById('root')).render(window.React.createElement(Boundary,null,window.React.createElement(App)));",
    '}catch(err){__fail(err);}',
    'if(window.ResizeObserver){var ro=new ResizeObserver(schedule);var rootEl=document.getElementById("root");if(rootEl)ro.observe(rootEl);if(document.body)ro.observe(document.body);}',
    "window.addEventListener('load',schedule);",
    'requestAnimationFrame(schedule);',
    'setTimeout(schedule,120);',
    '}',
    '__loadExternals().then(__start).catch(__fail);',
    '})();',
  ].join('\n');
}

/** 生成可直接放进 iframe srcdoc 的完整 HTML 文档 */
export function buildTsxDocument(js: string, dark: boolean, allowCdn: boolean): string {
  const theme = dark
    ? 'color-scheme:dark;background:#0b0b0c;color:#e5e5e5;'
    : 'color-scheme:light;background:#ffffff;color:#18181b;';
  return [
    '<!doctype html><html><head><meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    // 主题必须落在选择器内，否则是无效声明（旧实现的白色空白根因）
    `<style>${BASE_CSS}html,body{${theme}}</style>`,
    // 沙箱不透明源下 storage 访问会抛错：先装兼容层，再执行页面代码
    `<script>${escapeInlineScript(SANDBOX_SHIM)}</script></head><body><div id="root"></div>`,
    `<script>${escapeInlineScript(buildRuntimeScript())}</script>`,
    `<script>${escapeInlineScript(buildHarness(js, allowCdn, collectExternalSpecs(js)))}</script>`,
    '</body></html>',
  ].join('');
}
