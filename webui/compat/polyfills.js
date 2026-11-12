/* MOSS WebUI 兼容补丁（Chrome 80+）
 * 仅补缺失的标准 API，全部为 feature-detect + Object.defineProperty，
 * 重复执行无副作用；不包含任何业务逻辑。
 * 由 webui/compat/vite-plugin-compat.ts 在 index.html 头部内联注入，先于 module 脚本执行。
 */
(function () {
  'use strict';

  var g =
    typeof globalThis !== 'undefined'
      ? globalThis
      : typeof self !== 'undefined'
        ? self
        : Function('return this')();

  function define(obj, name, value) {
    if (!obj || obj[name]) return;
    try {
      Object.defineProperty(obj, name, {
        value: value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch (e) {
      try {
        obj[name] = value;
      } catch (e2) {
        /* 只读宿主对象，忽略 */
      }
    }
  }

  // ---------------------------------------------------------------- Promise
  if (typeof Promise !== 'undefined') {
    define(Promise, 'withResolvers', function () {
      var resolve;
      var reject;
      var promise = new Promise(function (res, rej) {
        resolve = res;
        reject = rej;
      });
      return { promise: promise, resolve: resolve, reject: reject };
    });

    define(Promise, 'try', function (fn) {
      var args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (resolve) {
        resolve(fn.apply(undefined, args));
      });
    });

    if (!Promise.any) {
      define(Promise, 'any', function (iterable) {
        return new Promise(function (resolve, reject) {
          var list;
          try {
            list = Array.prototype.slice.call(iterable);
          } catch (e) {
            reject(e);
            return;
          }
          var total = list.length;
          if (total === 0) {
            var empty = new Error('All promises were rejected');
            empty.name = 'AggregateError';
            empty.errors = [];
            reject(empty);
            return;
          }
          var errors = [];
          var settled = false;
          var failed = 0;
          list.forEach(function (item, index) {
            Promise.resolve(item).then(
              function (value) {
                if (settled) return;
                settled = true;
                resolve(value);
              },
              function (err) {
                if (settled) return;
                errors[index] = err;
                failed += 1;
                if (failed === total) {
                  settled = true;
                  var agg = new Error('All promises were rejected');
                  agg.name = 'AggregateError';
                  agg.errors = errors;
                  reject(agg);
                }
              },
            );
          });
        });
      });
    }
  }

  if (typeof AggregateError === 'undefined') {
    g.AggregateError = function AggregateError(errors, message) {
      var err = new Error(message || 'All promises were rejected');
      err.name = 'AggregateError';
      err.errors = errors;
      return err;
    };
  }

  // ---------------------------------------------------- Array / String 新方法
  define(Array.prototype, 'at', function (index) {
    var len = this.length >>> 0;
    var k = Math.trunc(index) || 0;
    if (k < 0) k += len;
    return k < 0 || k >= len ? undefined : this[k];
  });

  define(String.prototype, 'at', function (index) {
    var str = String(this);
    var len = str.length;
    var k = Math.trunc(index) || 0;
    if (k < 0) k += len;
    return k < 0 || k >= len ? undefined : str.charAt(k);
  });

  define(Array.prototype, 'findLast', function (predicate, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) {
      if (predicate.call(thisArg, this[i], i, this)) return this[i];
    }
    return undefined;
  });

  define(Array.prototype, 'findLastIndex', function (predicate, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) {
      if (predicate.call(thisArg, this[i], i, this)) return i;
    }
    return -1;
  });

  define(Array.prototype, 'toSorted', function (compareFn) {
    return Array.prototype.slice.call(this).sort(compareFn);
  });

  define(Array.prototype, 'toSpliced', function (start, deleteCount) {
    var copy = Array.prototype.slice.call(this);
    var rest = Array.prototype.slice.call(arguments, 2);
    copy.splice.apply(copy, [start, deleteCount].concat(rest));
    return copy;
  });

  define(Array.prototype, 'with', function (index, value) {
    var copy = Array.prototype.slice.call(this);
    var k = Math.trunc(index) || 0;
    var len = copy.length;
    if (k < 0) k += len;
    if (k < 0 || k >= len) throw new RangeError('Invalid index');
    copy[k] = value;
    return copy;
  });

  define(Object, 'hasOwn', function (obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  });

  define(Object, 'groupBy', function (items, callback) {
    var out = Object.create(null);
    var index = 0;
    for (var item of items) {
      var key = callback(item, index++);
      if (!out[key]) out[key] = [];
      out[key].push(item);
    }
    return out;
  });

  define(String.prototype, 'replaceAll', function (search, replacement) {
    var str = String(this);
    if (search instanceof RegExp) {
      if (!search.global) throw new TypeError('replaceAll requires a global RegExp');
      return str.replace(search, replacement);
    }
    var needle = String(search);
    var parts = str.split(needle);
    if (typeof replacement !== 'function') {
      return parts.join(replacement);
    }
    var result = parts[0];
    for (var i = 1; i < parts.length; i++) {
      result += String(replacement(needle, i - 1, str)) + parts[i];
    }
    return result;
  });

  // ------------------------------------------------------------ structuredClone
  define(g, 'structuredClone', function (value) {
    var seen = [];
    function clone(input) {
      if (input === null || typeof input !== 'object') return input;
      for (var s = 0; s < seen.length; s++) {
        if (seen[s][0] === input) return seen[s][1];
      }
      if (input instanceof Date) return new Date(input.getTime());
      if (input instanceof RegExp) return new RegExp(input.source, input.flags);
      if (typeof Map !== 'undefined' && input instanceof Map) {
        var mapOut = new Map();
        seen.push([input, mapOut]);
        input.forEach(function (v, k) {
          mapOut.set(clone(k), clone(v));
        });
        return mapOut;
      }
      if (typeof Set !== 'undefined' && input instanceof Set) {
        var setOut = new Set();
        seen.push([input, setOut]);
        input.forEach(function (v) {
          setOut.add(clone(v));
        });
        return setOut;
      }
      if (typeof ArrayBuffer !== 'undefined') {
        if (input instanceof ArrayBuffer) return input.slice(0);
        if (ArrayBuffer.isView(input)) return new input.constructor(input);
      }
      var out = Array.isArray(input) ? [] : {};
      seen.push([input, out]);
      for (var key in input) {
        if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = clone(input[key]);
      }
      return out;
    }
    return clone(value);
  });

  // -------------------------------------------------------------- crypto
  if (g.crypto && !g.crypto.randomUUID && g.crypto.getRandomValues) {
    define(g.crypto, 'randomUUID', function () {
      var bytes = new Uint8Array(16);
      g.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      var hex = '';
      for (var i = 0; i < 16; i++) hex += (bytes[i] + 0x100).toString(16).slice(1);
      return (
        hex.slice(0, 8) +
        '-' +
        hex.slice(8, 12) +
        '-' +
        hex.slice(12, 16) +
        '-' +
        hex.slice(16, 20) +
        '-' +
        hex.slice(20)
      );
    });
  }

  // ------------------------------------------------------------------ DOM
  if (typeof Element !== 'undefined' && !Element.prototype.replaceChildren) {
    define(Element.prototype, 'replaceChildren', function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (var i = 0; i < arguments.length; i++) {
        var node = arguments[i];
        this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
      }
    });
  }

  if (typeof URL !== 'undefined' && !URL.parse) {
    define(URL, 'parse', function (url, base) {
      try {
        return new URL(url, base);
      } catch (e) {
        return null;
      }
    });
  }

  if (typeof AbortSignal !== 'undefined') {
    if (!AbortSignal.timeout) {
      define(AbortSignal, 'timeout', function (ms) {
        var controller = new AbortController();
        setTimeout(function () {
          var reason =
            typeof DOMException === 'function'
              ? new DOMException('The operation timed out.', 'TimeoutError')
              : new Error('TimeoutError');
          controller.abort(reason);
        }, ms);
        return controller.signal;
      });
    }
    if (!AbortSignal.any) {
      define(AbortSignal, 'any', function (signals) {
        var controller = new AbortController();
        var list = Array.prototype.slice.call(signals);
        function abortWith(signal) {
          if (controller.signal.aborted) return;
          controller.abort(signal.reason);
        }
        for (var i = 0; i < list.length; i++) {
          if (list[i].aborted) {
            abortWith(list[i]);
            break;
          }
          list[i].addEventListener('abort', abortWith.bind(null, list[i]));
        }
        return controller.signal;
      });
    }
  }

  // --------------------------------------------------- 弱引用/段分割/报错兜底
  if (typeof WeakRef === 'undefined') {
    g.WeakRef = function WeakRef(target) {
      this.deref = function () {
        return target;
      };
    };
  }

  if (typeof FinalizationRegistry === 'undefined') {
    g.FinalizationRegistry = function FinalizationRegistry() {
      this.register = function () {};
      this.unregister = function () {};
    };
  }

  if (typeof Intl !== 'undefined' && !Intl.Segmenter) {
    Intl.Segmenter = function Segmenter() {};
    Intl.Segmenter.prototype.segment = function (input) {
      var str = String(input);
      var segments = Array.from(str).map(function (ch, index) {
        return { segment: ch, index: index, input: str };
      });
      segments.containing = function (index) {
        return segments[index];
      };
      return segments;
    };
  }

  define(g, 'reportError', function (error) {
    setTimeout(function () {
      throw error;
    });
  });

  if (!g.queueMicrotask) {
    define(g, 'queueMicrotask', function (callback) {
      Promise.resolve().then(callback);
    });
  }

  // ------------------------------------------------ flex gap 布局补丁（Chrome < 84）
  // Chrome 80 支持 grid gap，但不支持 flex gap；CSS.supports('gap') 对 grid 为真，
  // 因此必须做真实布局探测。仅在缺失时启用，现代浏览器直接返回。
  (function () {
    if (typeof document === 'undefined' || !document.createElement) return;

    function supportsFlexGap() {
      var probe = document.createElement('div');
      probe.style.cssText =
        'display:flex;gap:10px;position:absolute;top:-9999px;left:-9999px;visibility:hidden;pointer-events:none';
      var first = document.createElement('div');
      var second = document.createElement('div');
      first.style.cssText = 'width:10px;height:10px;flex:0 0 auto';
      second.style.cssText = 'width:10px;height:10px;flex:0 0 auto';
      probe.appendChild(first);
      probe.appendChild(second);
      (document.body || document.documentElement).appendChild(probe);
      var supported = second.getBoundingClientRect().left - first.getBoundingClientRect().left > 15;
      if (probe.parentNode) probe.parentNode.removeChild(probe);
      return supported;
    }

    var queue = [];
    var scheduled = false;

    function restore(el) {
      var state = el.__mossGapState;
      if (!state) return;
      for (var i = 0; i < state.applied.length; i++) {
        var record = state.applied[i];
        if (record.prev === '') record.node.style.removeProperty(record.prop);
        else record.node.style.setProperty(record.prop, record.prev);
      }
      state.applied = [];
      state.signature = '';
    }

    function apply(el) {
      var className = typeof el.className === 'string' ? el.className : '';
      if (className.indexOf('gap-') === -1) {
        restore(el);
        return;
      }
      var style = window.getComputedStyle(el);
      if (!style || (style.display !== 'flex' && style.display !== 'inline-flex')) {
        restore(el);
        return;
      }
      // 换行容器无法用 margin 正确模拟行间距，跳过而不是错误布局
      if (style.flexWrap && style.flexWrap !== 'nowrap') {
        restore(el);
        return;
      }
      var dir = style.flexDirection && style.flexDirection.indexOf('column') === 0 ? 'column' : 'row';
      var gap = parseFloat(dir === 'column' ? style.rowGap : style.columnGap);
      if (!gap || !isFinite(gap) || gap <= 0) {
        restore(el);
        return;
      }
      var children = [];
      for (var i = 0; i < el.children.length; i++) children.push(el.children[i]);
      var signature = dir + '|' + gap + '|' + children.length;
      var state = el.__mossGapState;
      if (state && state.signature === signature) return;
      restore(el);
      state = el.__mossGapState = { signature: signature, applied: [] };

      var prop = dir === 'column' ? 'margin-top' : 'margin-left';
      for (var j = 1; j < children.length; j++) {
        var child = children[j];
        var childStyle = window.getComputedStyle(child);
        if (!childStyle) continue;
        if (childStyle.position === 'absolute' || childStyle.position === 'fixed') continue;
        // auto margin 参与居中/贴边布局，补 margin 会破坏原语义
        if (dir === 'column' ? childStyle.marginTop === 'auto' : childStyle.marginLeft === 'auto') continue;
        var prev = child.style.getPropertyValue(prop);
        var base = prev ? parseFloat(prev) : 0;
        if (!isFinite(base)) base = 0;
        state.applied.push({ node: child, prop: prop, prev: prev });
        child.style.setProperty(prop, base + gap + 'px');
      }
    }

    function flush() {
      scheduled = false;
      var list = queue;
      queue = [];
      for (var i = 0; i < list.length; i++) {
        try {
          apply(list[i]);
        } catch (err) {
          /* 单个节点失败不影响整体布局 */
        }
      }
    }

    function schedule(el, force) {
      if (!el || el.nodeType !== 1) return;
      if (force && el.__mossGapState) el.__mossGapState.signature = '';
      if (queue.indexOf(el) === -1) queue.push(el);
      if (!scheduled) {
        scheduled = true;
        // 用 setTimeout 而非 rAF：无头/后台标签页下 rAF 可能不触发，导致补丁永不执行
        setTimeout(flush, 0);
      }
    }

    function scanAll() {
      var nodes = document.querySelectorAll('[class*="gap-"]');
      for (var i = 0; i < nodes.length; i++) schedule(nodes[i], true);
    }

    function start() {
      // 必须在 DOM 就绪后探测：head 阶段 body 尚不存在，测量结果不可靠
      if (supportsFlexGap()) return;
      scanAll();
      if (typeof MutationObserver !== 'function') return;
      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var mutation = mutations[i];
          if (mutation.type === 'childList') {
            if (mutation.target && mutation.target.nodeType === 1) schedule(mutation.target, true);
            for (var j = 0; j < mutation.addedNodes.length; j++) {
              var added = mutation.addedNodes[j];
              if (added.nodeType === 1) {
                schedule(added, true);
                if (added.parentElement) schedule(added.parentElement, true);
              }
            }
          } else if (mutation.type === 'attributes' && mutation.target.nodeType === 1) {
            schedule(mutation.target, true);
          }
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      // 样式表可能晚于 DOM 到达（dev 的按需 CSS / PWA 冷启动）：
      // 首次 apply 时 display/gap 尚未生效会直接跳过，这里在样式就绪后补扫。
      window.addEventListener('load', scanAll);
      document.addEventListener(
        'load',
        function (event) {
          var target = event.target;
          if (target && target.tagName === 'LINK') scanAll();
        },
        true,
      );
      setTimeout(scanAll, 300);
      setTimeout(scanAll, 1200);
      var resizeTimer = 0;
      window.addEventListener('resize', function () {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(scanAll, 120);
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  })();

  // ------------------------------------- color-mix 动态变量桥（Chrome < 111）
  // 构建期只能解析 CSS 里声明的主题色；--palette-* 等变量由 JS 在运行时写入。
  // 对这类变量，构建产物会生成 rgba(var(--x-rgb), a) 回退，这里负责把当前
  // 主题下的颜色写入 --x-rgb，并在主题/调色板变化后刷新。
  (function () {
    if (typeof document === 'undefined' || !window.getComputedStyle) return;
    if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('color', 'color-mix(in oklab, red, red)')) return;

    function parseRgbText(value) {
      var input = String(value || '').trim();
      if (!input) return null;
      var varMatch = /^var\(\s*(--[\w-]+)\s*\)$/.exec(input);
      if (varMatch) return null;
      var hex = /^#([0-9a-f]{3,8})$/i.exec(input);
      if (hex) {
        var body = hex[1];
        if (body.length === 3 || body.length === 4) {
          return [
            parseInt(body[0] + body[0], 16),
            parseInt(body[1] + body[1], 16),
            parseInt(body[2] + body[2], 16),
          ];
        }
        if (body.length === 6 || body.length === 8) {
          return [
            parseInt(body.slice(0, 2), 16),
            parseInt(body.slice(2, 4), 16),
            parseInt(body.slice(4, 6), 16),
          ];
        }
        return null;
      }
      var rgb = /^rgba?\(([^)]+)\)$/i.exec(input);
      if (rgb) {
        var parts = rgb[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
        if (parts.length < 3) return null;
        return [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])];
      }
      return null;
    }

    var names = [];
    var queued = false;

    function collect(rules) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule.cssRules) {
          collect(rule.cssRules);
          continue;
        }
        var text = rule.cssText;
        if (!text || text.indexOf('var(--') === -1) continue;
        var re = /var\((--[\w-]+)-rgb\)/g;
        var match;
        while ((match = re.exec(text)) !== null) {
          if (names.indexOf(match[1]) === -1) names.push(match[1]);
        }
      }
    }

    function refresh() {
      queued = false;
      names = [];
      var sheets = document.styleSheets;
      for (var i = 0; i < sheets.length; i++) {
        try {
          if (sheets[i].cssRules) collect(sheets[i].cssRules);
        } catch (err) {
          /* 跨域样式表跳过 */
        }
      }
      if (names.length === 0) return;
      var root = document.documentElement;
      var computed = window.getComputedStyle(root);
      for (var j = 0; j < names.length; j++) {
        var name = names[j];
        var rgb = parseRgbText(computed.getPropertyValue(name));
        if (!rgb) continue;
        var next = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
        if (root.style.getPropertyValue(name + '-rgb') !== next) {
          root.style.setProperty(name + '-rgb', next);
        }
      }
    }

    function schedule() {
      if (queued) return;
      queued = true;
      (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(refresh);
    }

    function start() {
      schedule();
      if (typeof MutationObserver !== 'function') return;
      if (document.head) {
        new MutationObserver(schedule).observe(document.head, { childList: true });
      }
      new MutationObserver(schedule).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
      window.addEventListener('load', schedule);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  })();

  // -------------------------------- 运行时颜色归一化（Chrome < 111）
  // Chrome 100/80 不支持 oklch()/oklab()/color-mix()，但运行时会写入这些字符串：
  // - theme-palette 写入 --palette-*（oklch）与 --palette-chart-*（color-mix）
  // - 设置页主题色块用内联 backgroundColor: oklch(...)
  // - SplashScreen 的内联 <style> 用 oklch 作为遮罩背景
  // CSSOM 会丢弃非法声明，但 style 属性原文与 <style>.textContent 仍在，
  // 因此这里直接重写原文，把它们降级为 rgb()/rgba()。
  (function () {
    if (typeof document === 'undefined') return;
    if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('color', 'oklch(0.5 0.1 200)')) return;

    function clamp255(value) {
      return Math.max(0, Math.min(255, Math.round(value)));
    }

    function encodeGamma(value) {
      var v = value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(Math.max(value, 0), 1 / 2.4) - 0.055;
      return clamp255(v * 255);
    }

    function oklabToRgb(l, a, b, alpha) {
      var l_ = l + 0.3963377774 * a + 0.2158037573 * b;
      var m_ = l - 0.1055613458 * a - 0.0638541728 * b;
      var s_ = l - 0.0894841775 * a - 1.291485548 * b;
      var l3 = l_ * l_ * l_;
      var m3 = m_ * m_ * m_;
      var s3 = s_ * s_ * s_;
      return {
        r: encodeGamma(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
        g: encodeGamma(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
        b: encodeGamma(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
        a: alpha == null ? 1 : alpha,
      };
    }

    function formatColor(color) {
      if (color.a >= 1) return 'rgb(' + color.r + ', ' + color.g + ', ' + color.b + ')';
      return 'rgba(' + color.r + ', ' + color.g + ', ' + color.b + ', ' + Math.round(color.a * 1000) / 1000 + ')';
    }

    function parseColorToken(text) {
      var value = String(text || '').trim();
      if (!value) return null;
      if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

      var hex = /^#([0-9a-f]{3,8})$/i.exec(value);
      if (hex) {
        var body = hex[1];
        if (body.length === 3 || body.length === 4) {
          return {
            r: parseInt(body[0] + body[0], 16),
            g: parseInt(body[1] + body[1], 16),
            b: parseInt(body[2] + body[2], 16),
            a: body.length === 4 ? parseInt(body[3] + body[3], 16) / 255 : 1,
          };
        }
        if (body.length === 6 || body.length === 8) {
          return {
            r: parseInt(body.slice(0, 2), 16),
            g: parseInt(body.slice(2, 4), 16),
            b: parseInt(body.slice(4, 6), 16),
            a: body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : 1,
          };
        }
        return null;
      }

      var rgb = /^rgba?\(([^)]+)\)$/i.exec(value);
      if (rgb) {
        var parts = rgb[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
        if (parts.length < 3) return null;
        return {
          r: clamp255(parseFloat(parts[0])),
          g: clamp255(parseFloat(parts[1])),
          b: clamp255(parseFloat(parts[2])),
          a: parts.length >= 4 ? (parts[3].indexOf('%') !== -1 ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1,
        };
      }

      var ok = /^(oklch|oklab)\(([^)]*)\)$/i.exec(value);
      if (ok) {
        var args = ok[2].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
        if (args.length < 3) return null;
        var l = parseFloat(args[0]);
        if (args[0].indexOf('%') !== -1 || l > 1) l = l / 100;
        var alpha = args.length >= 4 ? (args[3].indexOf('%') !== -1 ? parseFloat(args[3]) / 100 : parseFloat(args[3])) : 1;
        if (isNaN(l) || isNaN(alpha)) return null;
        if (ok[1].toLowerCase() === 'oklab') {
          return oklabToRgb(l, parseFloat(args[1]), parseFloat(args[2]), alpha);
        }
        var c = parseFloat(args[1]);
        var h = (parseFloat(args[2]) * Math.PI) / 180;
        if (isNaN(c) || isNaN(h)) return null;
        return oklabToRgb(l, c * Math.cos(h), c * Math.sin(h), alpha);
      }

      return null;
    }

    function splitArgs(text) {
      var parts = [];
      var current = '';
      var depth = 0;
      for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (depth === 0 && ch === ',') {
          parts.push(current);
          current = '';
          continue;
        }
        current += ch;
      }
      parts.push(current);
      return parts;
    }

    function parseWeighted(text) {
      var input = String(text || '').trim();
      if (!input) return null;
      var weight = null;
      var trailing = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)$/.exec(input);
      if (trailing) {
        input = trailing[1].trim();
        weight = parseFloat(trailing[2]);
      } else {
        var leading = /^(\d+(?:\.\d+)?)%\s+(.*)$/.exec(input);
        if (leading) {
          weight = parseFloat(leading[1]);
          input = leading[2].trim();
        }
      }
      var color = parseColorToken(input);
      return color ? { color: color, weight: weight } : null;
    }

    function mixColorMix(inner) {
      var parts = splitArgs(inner);
      if (parts.length < 3) return null;
      var first = parseWeighted(parts[1]);
      var second = parseWeighted(parts[2]);
      if (!first || !second) return null;
      var w1 = first.weight;
      var w2 = second.weight;
      if (w1 == null && w2 == null) {
        w1 = 50;
        w2 = 50;
      } else if (w1 == null) {
        w1 = 100 - w2;
      } else if (w2 == null) {
        w2 = 100 - w1;
      }
      var total = w1 + w2;
      if (!total) return null;
      var p1 = w1 / total;
      var p2 = w2 / total;
      var alpha = first.color.a * p1 + second.color.a * p2;
      if (alpha <= 0) return 'rgba(0, 0, 0, 0)';
      return (
        'rgba(' +
        clamp255((first.color.r * first.color.a * p1 + second.color.r * second.color.a * p2) / alpha) +
        ', ' +
        clamp255((first.color.g * first.color.a * p1 + second.color.g * second.color.a * p2) / alpha) +
        ', ' +
        clamp255((first.color.b * first.color.a * p1 + second.color.b * second.color.a * p2) / alpha) +
        ', ' +
        Math.round(alpha * 1000) / 1000 +
        ')'
      );
    }

    function matchParen(text, openIndex) {
      var depth = 0;
      var quote = '';
      for (var i = openIndex; i < text.length; i++) {
        var ch = text[i];
        if (quote) {
          if (ch === '\\') i++;
          else if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    }

    var TOKEN_RE = /oklch\(|oklab\(|color-mix\(/i;
    var TOKEN_ALL_RE = /oklch\(|oklab\(|color-mix\(/gi;

    function replaceColors(text) {
      if (!text || !TOKEN_RE.test(text)) return text;
      var out = '';
      var cursor = 0;
      while (cursor < text.length) {
        TOKEN_ALL_RE.lastIndex = cursor;
        var found = TOKEN_ALL_RE.exec(text);
        if (!found) {
          out += text.slice(cursor);
          break;
        }
        var start = found.index;
        out += text.slice(cursor, start);
        var open = start + found[0].length - 1;
        var close = matchParen(text, open);
        if (close === -1) {
          out += text.slice(start);
          break;
        }
        var kind = found[0].toLowerCase();
        var inner = text.slice(open + 1, close);
        var replacement = null;
        if (kind === 'color-mix(') {
          replacement = mixColorMix(inner);
        } else {
          var color = parseColorToken(text.slice(start, close + 1));
          replacement = color ? formatColor(color) : null;
        }
        out += replacement || text.slice(start, close + 1);
        cursor = close + 1;
      }
      return out;
    }

    function normalizeStyleAttribute(el) {
      var attr = el.getAttribute && el.getAttribute('style');
      if (!attr || !TOKEN_RE.test(attr)) return;
      var next = replaceColors(attr);
      if (next !== attr) el.setAttribute('style', next);
    }

    // React 等框架对内联样式走 CSSOM（style.setProperty / style.backgroundColor = ...），
    // 非法值会在赋值时被静默丢弃，连 style 属性都不会生成，事后无法挽救。
    // 因此在原型层拦截：先把 oklch/oklab/color-mix 降级成 rgb，再交给原生 setter。
    var COLOR_PROPERTIES = [
      'color', 'background', 'backgroundColor', 'backgroundImage',
      'border', 'borderColor', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
      'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
      'outline', 'outlineColor', 'boxShadow', 'textShadow', 'textDecorationColor',
      'caretColor', 'columnRuleColor', 'accentColor', 'scrollbarColor',
      'fill', 'stroke', 'stopColor', 'floodColor', 'lightingColor',
      'WebkitTextFillColor', 'WebkitTextStrokeColor',
    ];

    function toCssName(name) {
      return name.replace(/[A-Z]/g, function (ch) {
        return '-' + ch.toLowerCase();
      });
    }

    function installStyleBridge() {
      var proto = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype;
      if (!proto) return;

      // 先接管 setProperty（React 写自定义属性/部分样式走这里）
      var nativeSetProperty = proto.setProperty;
      if (typeof nativeSetProperty === 'function') {
        proto.setProperty = function (property, value, priority) {
          return nativeSetProperty.call(this, property, typeof value === 'string' ? replaceColors(value) : value, priority);
        };
      }

      // Chrome 100 的 camelCase 样式属性并不作为 own accessor 暴露在
      // CSSStyleDeclaration.prototype 上（getOwnPropertyDescriptor 为 undefined），
      // 因此不能“包一层已有 setter”，只能自己定义访问器，转调 setProperty。
      for (var i = 0; i < COLOR_PROPERTIES.length; i++) {
        (function (name, cssName) {
          try {
            Object.defineProperty(proto, name, {
              configurable: true,
              enumerable: true,
              get: function () {
                return this.getPropertyValue(cssName);
              },
              set: function (value) {
                this.setProperty(cssName, value);
              },
            });
          } catch (err) {
            /* 宿主对象不可改写时保持原样 */
          }
        })(COLOR_PROPERTIES[i], toCssName(COLOR_PROPERTIES[i]));
      }

      var cssTextDescriptor = Object.getOwnPropertyDescriptor(proto, 'cssText');
      if (cssTextDescriptor && typeof cssTextDescriptor.set === 'function') {
        var nativeCssText = cssTextDescriptor.set;
        Object.defineProperty(proto, 'cssText', {
          configurable: true,
          enumerable: cssTextDescriptor.enumerable,
          get: cssTextDescriptor.get,
          set: function (value) {
            nativeCssText.call(this, typeof value === 'string' ? replaceColors(value) : value);
          },
        });
      }
    }

    installStyleBridge();

    function normalizeStyleElement(el) {
      var text = el.textContent;
      if (!text || !TOKEN_RE.test(text)) return;
      var next = replaceColors(text);
      if (next !== text) el.textContent = next;
    }

    function scan(root) {
      if (!root || root.nodeType !== 1) return;
      if (root.tagName === 'STYLE') normalizeStyleElement(root);
      normalizeStyleAttribute(root);
      var styled = root.querySelectorAll('[style]');
      for (var i = 0; i < styled.length; i++) normalizeStyleAttribute(styled[i]);
      var styles = root.querySelectorAll('style');
      for (var j = 0; j < styles.length; j++) normalizeStyleElement(styles[j]);
    }

    var pending = [];
    var scheduled = false;
    function schedule(node) {
      if (!node || node.nodeType !== 1) return;
      if (pending.indexOf(node) === -1) pending.push(node);
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        var list = pending;
        pending = [];
        for (var i = 0; i < list.length; i++) {
          try {
            scan(list[i]);
          } catch (err) {
            /* 单个节点失败不影响整体 */
          }
        }
      }, 0);
    }

    function start() {
      scan(document.documentElement);
      if (typeof MutationObserver !== 'function') return;
      new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var mutation = mutations[i];
          if (mutation.type === 'attributes') {
            var attr = mutation.target.getAttribute && mutation.target.getAttribute('style');
            if (attr && TOKEN_RE.test(attr)) schedule(mutation.target);
            continue;
          }
          for (var j = 0; j < mutation.addedNodes.length; j++) {
            var node = mutation.addedNodes[j];
            if (node.nodeType === 1) schedule(node);
          }
        }
      }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style'],
        childList: true,
        subtree: true,
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  })();
})();

