import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

// https://vite.dev/config/
// 构建产物输出到项目根目录 dist/webui/，与 src/modules/server/static-assets.ts 对齐
// 后端端口默认 7766，可通过 MOSS_BACKEND_PORT 环境变量覆盖（与 config/config.json 的 server.port 对齐）
const backendPort = process.env.MOSS_BACKEND_PORT ?? '7766';
const backendHttp = `http://127.0.0.1:${backendPort}`;
const backendWs = `ws://127.0.0.1:${backendPort}`;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
      manifest: {
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
      },
      workbox: {
        // 含 html：保证 index.html 进入 precache。
        // 这是此前「硬刷新/更新拿不到新版本」的致命根因修复——旧配置漏了 html，
        // 导致 index.html 不在 precache，而 vite-plugin-pwa 仍注入
        // NavigationRoute(createHandlerBoundToURL('index.html'))，SW 启动求值时同步抛
        // non-precached-url → 新 SW 安装/更新必然失败 → 旧 SW 永久接管返回旧 shell。
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
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
      // dev 模式启用 SW：用于调试 PWA 安装/离线行为（生产同款 SW 逻辑）
      devOptions: { enabled: true },
    }),
  ],
  // dev 预构建全部「懒加载重依赖」：避免运行中首次访问某依赖时触发重新预构建，
  // 使此前引用的 ?v=<hash> 模块 URL 失效 → 懒加载渲染器报
  // “Failed to fetch dynamically imported module”（需重启 dev 生效）。
  optimizeDeps: {
    include: [
      'sql.js', 'xlsx', 'epubjs', 'mermaid', 'shiki', 'pdfjs-dist', 'three',
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
    target: 'es2022',
  },
})
