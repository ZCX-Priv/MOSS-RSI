// 临时校验脚本：解析 webui/vite.config.ts，确认 dev server 绑定的 host（验证后删除）
import { resolveConfig } from 'vite';

const c = await resolveConfig({ configFile: 'vite.config.ts' }, 'serve');
console.log(JSON.stringify({ host: c.server.host, port: c.server.port }));