import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA, type ManifestOptions } from 'vite-plugin-pwa'
import path from 'node:path'
import { mossCompat } from './compat/vite-plugin-compat.ts'

// https://vite.dev/config/
// 构建产物输出到项目根目录 dist/webui/，与 src/modules/server/static-assets.ts 对齐
// 后端端口默认 7766，可通过 MOSS_BACKEND_PORT 环境变量覆盖（与 config/config.json 的 server.port 对齐）
const backendPort = process.env.MOSS_BACKEND_PORT ?? '7766';
const backendHttp = `http://127.0.0.1:${backendPort}`;
const backendWs = `ws://127.0.0.1:${backendPort}`;

/** PWA manifest（生产由 vite-plugin-pwa 生成文件；dev 由下面的中间件直接返回） */
const pwaManifest: Partial<ManifestOptions> = {
  name: 'MOSS',
  short_name: 'MOSS',
  description: 'MOSS - AI 工作台',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#09090b',
  theme_color: '#18181b',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

/**
 * dev 兜底：站点若曾被旧 dev Service Worker 接管，页面仍可能带着
 * /manifest.webmanifest 的 link 请求。Vite SPA fallback 会返回 index.html
 * （HTML 不是合法 JSON → Chrome 报 Manifest Syntax error）。
 * 这里在 dev server 直接返回合法 manifest，保证控制台干净。
 */
function mossDevManifest(): Plugin {
  return {
    name: 'moss-dev-manifest',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/manifest.webmanifest') {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        res.end(JSON.stringify(pwaManifest));
      });
    },
  };
}

export default defineConfig({
  plugins: [
    // 浏览器兼容层：index.html 头部内联 polyfills + CSS 降级（dev/build 共用）。
    // 放在最前，保证 polyfill 脚本先于 PWA 的 registerSW 与业务 module 脚本执行。
    ...mossCompat({
      polyfillsFile: path.resolve(import.meta.dirname, 'compat/polyfills.js'),
    }),
    react(),
    tailwindcss(),
    mossDevManifest(),
    // PWA：manifest + service worker（autoUpdate 静默更新）。
    // 预缓存全部静态资源（hashed 文件名长缓存）；/api 与 /ws 永不缓存；
    // dev 模式（devOptions.enabled）提供 manifest + 空壳 SW，支持安装调试。
    // 图标：Chrome/Chromium 安装硬性要求 192x192 与 512x512 PNG（由 MOSS.png 真实缩放生成）
    VitePWA({
      registerType: 'autoUpdate',
      // 显式 script 注入：默认 auto/null + autoUpdate 时 vite-plugin-pwa 会无条件
      // 强制 workbox.skipWaiting/clientsClaim = true（覆盖下方 false），闪屏修复失效；
      // 显式声明后跳过强制覆盖，注入形态与之前完全一致（index.html 引 registerSW.js）
      injectRegister: 'script',
      includeAssets: ['MOSS.png', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png'],
      manifest: pwaManifest,
      workbox: {
        // SW 运行时内联为单文件：跳过 workbox-build 的 Rollup + OMT + AMD + manualChunks
        // 分包路径（该路径会额外加载原生 rollup/Babel/Terser，是构建收尾卡顿的主要来源）。
        inlineWorkboxRuntime: true,
        // 含 html：保证 index.html 进入 precache。
        // 这是此前「硬刷新/更新拿不到新版本」的致命根因修复——旧配置漏了 html，
        // 导致 index.html 不在 precache，而 vite-plugin-pwa 仍注入
        // NavigationRoute(createHandlerBoundToURL('index.html'))，SW 启动求值时同步抛
        // non-precached-url → 新 SW 安装/更新必然失败 → 旧 SW 永久接管返回旧应用外壳。
        //
        // 预缓存只覆盖「应用外壳」：入口 JS/CSS + 少数核心 vendor chunk。
        // 不再把 552 个懒加载 chunk（28.5MB）全部预缓存 —— 首次安装 SW 时下载/哈希
        // 数十 MB 会与首屏争抢 CPU/IO，这是冷启动慢的重要来源。
        globPatterns: [
          '**/*.{html,ico,woff2}',
          'assets/index-*.{js,css}',
          'assets/vendor-react-*.js',
          'assets/vendor-icons-*.js',
          'assets/vendor-ui-*.js',
          'assets/vendor-markdown-*.js',
        ],
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/],
        // 主 chunk 含 @lobehub/icons 品牌图标（约 +0.8MB raw）+ react-material-icon-theme
        // 文件类型图标数据（约 +1.1MB minified，见 components/shared/FileTypeIcon），放宽预缓存上限
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // 消除更新闪屏：默认 skipWaiting+clientsClaim 会让新 SW 在旧页面仍运行时
        // 立即激活并 cleanupOutdatedCaches 清掉旧 precache——旧页面的懒加载 chunk
        // 随之 404，表现为「先显示旧版完整界面 → 闪一下 → 重回 loading」（PWA 尤甚）。
        // 改为 waiting 策略：新 SW 安装后等待，旧标签全部关闭后才激活接管，
        // 下次冷启动自然用新版，全程无闪屏。
        skipWaiting: false,
        clientsClaim: false,
      },
      // dev 模式不再启用 SW：dev SW 会接管模块请求，更新/重载时造成「闪一下」与旧缓存假象。
      // 生产构建仍生成完整 SW（PWA 安装/离线能力不变）。
      devOptions: { enabled: false },
    }),
  ],
  // dev 转换也按 Chrome 80 降级语法（build.target 只作用于打包）。
  // 否则源码里的 ??= / ||= / &&= 会在 dev(:3000) 原样下发，Chrome 80 直接 SyntaxError。
  oxc: {
    target: 'chrome80',
  },
  // dev 预构建全部「懒加载重依赖」：避免运行中首次访问某依赖时触发重新预构建，
  // 使此前引用的 ?v=<hash> 模块 URL 失效 → 懒加载渲染器报
  // “Failed to fetch dynamically imported module”（需重启 dev 生效）。
  optimizeDeps: {
    // 依赖预构建同样降到 Chrome 80（esbuildOptions 已弃用，使用 rolldown transform）
    rolldownOptions: {
      transform: { target: 'chrome80' },
    },
    include: [
      'sql.js', '@e965/xlsx', 'epubjs', 'mermaid', 'shiki', 'pdfjs-dist', 'three',
      'docx-preview', 'libarchive.js', '@aiden0z/pptx-renderer', 'jszip',
      'fontkit', 'flv.js', 'video.js', 'wavesurfer.js', 'utif', 'heic2any',
      '@cornerstonejs/codec-openjpeg', 'smiles-drawer', 'dxf-render',
      'mathjax/es5/tex-mml-chtml.js',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 3000,
    // dev 首访预热：进入页面即开始转换这两个入口链，避免「先等 Vite 编译 → 再请求」的串行等待
    warmup: {
      // 首屏核心入口链：预热 App / TaskPage 及其首屏立即挂载的重组件，
      // 减少 dev 首访时「先等 Vite 编译 → 再请求」的串行等待。
      clientFiles: [
        './src/App.tsx',
        './src/components/pages/TaskPage.tsx',
        './src/components/shared/TaskInput.tsx',
        './src/components/layout/Sidebar.tsx',
        './src/render/markdown/MarkdownRenderer.tsx',
      ],
    },
    // 仅绑定回环（IPv4 127.0.0.1）：开发服务器只对本机开放，局域网不可达。
    // 显式写 127.0.0.1（而非 Vite 默认的 'localhost'）：Windows 上 localhost 可能
    // 只解析到 IPv6 ::1，写死 IPv4 后 http://127.0.0.1:3000 与 http://localhost:3000
    // 均可访问（浏览器对 localhost 有 ::1 → 127.0.0.1 回退）。
    // 不再使用 host:true —— 那会绑定 0.0.0.0 把 dev 暴露到局域网，
    // 且经 Vite 代理后请求源地址变为回环，会绕过后端远程门卫。
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: backendHttp,
        changeOrigin: true,
      },
      '/ws': {
        target: backendWs,
        ws: true,
        // 后端重启（--watch）/ 连接被重置时的善后：http-proxy 默认只报错不作为，
        // 浏览器侧 socket 挂死 → 前端要等 30s 心跳超时才发现死链。
        // 主动 end() 客户端侧 → 前端立即 onclose → ~1s 后自动重连
        configure(proxy) {
          const closeClientSide = (resOrSocket: unknown) => {
            const maybe = resOrSocket as { end?: unknown } | null;
            if (maybe && typeof maybe.end === 'function') {
              (maybe.end as () => void)();
            }
          };
          // http-proxy 专用事件：ECONNRESET（后端重启/连接重置）
          proxy.on('econnreset', (_err, _req, resOrSocket) => closeClientSide(resOrSocket));
          // 兜底：其它代理错误（如后端未启动 ECONNREFUSED）同样关闭客户端侧；
          // ECONNRESET 已由上方专用事件处理，跳过避免重复
          proxy.on('error', (err, _req, resOrSocket) => {
            if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
            closeClientSide(resOrSocket);
          });
        },
      },
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, '../dist/webui'),
    emptyOutDir: true,
    sourcemap: false,
    // 语法下限 Chrome 80：统一降级 ??= / ||= / &&= / class static block 等语法。
    // 运行时缺失的 API 由 compat/polyfills.js 补齐（Chrome 80/100 均可解析执行）。
    target: ['chrome80'],
    // 552 个 chunk 逐个计算 gzip 体积纯属构建开销，产物与功能不受影响
    reportCompressedSize: false,
    // 主 chunk 体积告警阈值：应用外壳（React + 品牌图标 + 文件类型图标数据）约 5MB，
    // 重依赖（pdfjs/three/mermaid/shiki…）已全部走动态 import 拆分到独立 chunk。
    // 该阈值仅避免对「已知且有意为之」的入口体积重复告警，不改变产物结构。
    chunkSizeWarningLimit: 6000,
    rolldownOptions: {
      output: {
        // 显式分组：把「入口静态依赖」收成少量稳定大 chunk。
        // 默认按模块拆分会让每个 lucide 图标/小组件各自成 chunk，入口挂 47 条 modulepreload，
        // 冷启动要发几十个并行请求；分组后 preload 数量与主包解析成本显著下降。
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|zustand|sonner|i18next|react-i18next)[\\/]/,
            },
            {
              name: 'vendor-icons',
              test: /node_modules[\\/](lucide-react|@lobehub|@icons-pack)[\\/]/,
            },
            {
              name: 'vendor-ui',
              test: /node_modules[\\/](radix-ui|@radix-ui|@dnd-kit|cmdk)[\\/]/,
            },
            {
              name: 'vendor-markdown',
              test: /node_modules[\\/](markdown-it|katex)[\\/]/,
            },
          ],
        },
      },
      onwarn(warning, warn) {
        // @cornerstonejs/codec-openjpeg 为兼容 Node 静态 import 了 fs/path，
        // 浏览器分支不会执行这两条路径；仅屏蔽该模块的 externalize 提示，其它告警照常输出。
        const msg = String(warning?.message ?? '');
        if (
          msg.includes('has been externalized for browser compatibility') &&
          msg.includes('@cornerstonejs/codec-openjpeg')
        ) {
          return;
        }
        warn(warning);
      },
    },
  },
})
