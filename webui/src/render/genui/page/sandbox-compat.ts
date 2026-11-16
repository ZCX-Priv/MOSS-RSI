// webui/src/render/genui/page/sandbox-compat.ts
// 内嵌页面沙箱兼容层：
//   - iframe 不含 allow-same-origin（不透明源），直接访问 localStorage / sessionStorage /
//     document.cookie 会抛 SecurityError，页面脚本在初始化阶段即中断（按钮点不动 / TSX 报错）。
//   - 仅在「原生访问失败」时注入内存实现；新标签页等正常同源环境保持原生行为。
//   - 同时提供 HTML 完成态的内容高度上报脚本（与 TSX 共用 __mossPageHeight 协议）。

/** 仅当原生 storage 不可用时，注入内存实现（不改变正常同源环境的行为） */
export const SANDBOX_SHIM = `(function(){
  function make(){
    var m=Object.create(null);
    return {
      getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null;},
      setItem:function(k,v){m[String(k)]=String(v);},
      removeItem:function(k){delete m[String(k)];},
      clear:function(){m=Object.create(null);},
      key:function(i){var ks=Object.keys(m);return i>=0&&i<ks.length?ks[i]:null;},
      get length(){return Object.keys(m).length;}
    };
  }
  function def(target,name,getter,setter){
    try{
      Object.defineProperty(target,name,{get:getter,set:setter,configurable:true});
      return true;
    }catch(e){}
    try{
      var proto=Object.getPrototypeOf(target);
      if(proto){
        Object.defineProperty(proto,name,{get:getter,set:setter,configurable:true});
        return true;
      }
    }catch(e2){}
    return false;
  }
  var lsOk=false,ssOk=false,cookieOk=false;
  try{lsOk=!!window.localStorage;}catch(e){}
  try{ssOk=!!window.sessionStorage;}catch(e){}
  try{var probe=document.cookie;cookieOk=typeof probe==='string';}catch(e){}
  if(!lsOk){var ls=make();def(window,'localStorage',function(){return ls;},undefined);}
  if(!ssOk){var ss=make();def(window,'sessionStorage',function(){return ss;},undefined);}
  if(!cookieOk){def(document,'cookie',function(){return '';},function(){});}
})();`;

/** 内容高度上报：完成态 HTML 页面自适应高度（顶层/新标签页不发送） */
export const MEASURE_SCRIPT = `(function(){
  function report(){
    try{
      var d=document.documentElement,b=document.body;
      var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0,b?b.getBoundingClientRect().height:0);
      if(h>0&&window.parent!==window)window.parent.postMessage({__mossPageHeight:Math.ceil(h)},'*');
    }catch(e){}
  }
  var pending=false;
  function schedule(){if(pending)return;pending=true;requestAnimationFrame(function(){pending=false;report();});}
  if(window.ResizeObserver){
    var ro=new ResizeObserver(schedule);
    if(document.documentElement)ro.observe(document.documentElement);
    if(document.body)ro.observe(document.body);
  }
  window.addEventListener('load',schedule);
  setTimeout(schedule,0);setTimeout(schedule,200);setTimeout(schedule,800);
})();`;

/** 插到页面头部：<head> 后 → <!doctype> 后 → 文档最前 */
export function injectHeadHtml(html: string, chunk: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + chunk + html.slice(at);
  }
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype && doctype.index !== undefined) {
    const at = doctype.index + doctype[0].length;
    return html.slice(0, at) + chunk + html.slice(at);
  }
  return chunk + html;
}

/** 插到页面脚本之前 */
export function injectHeadScript(html: string, script: string): string {
  return injectHeadHtml(html, `<script>${script}</script>`);
}

/** 插到 </body> 前（没有 body 时追加到末尾） */
export function injectBodyScript(html: string, script: string): string {
  const tag = `<script>${script}</script>`;
  const lower = html.toLowerCase();
  const at = lower.lastIndexOf('</body>');
  if (at >= 0) return html.slice(0, at) + tag + html.slice(at);
  return html + tag;
}
