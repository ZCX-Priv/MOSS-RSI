// src/modules/im/adapters/onebot/index.ts
// QQ 用户模式（OneBot 11）渠道描述符与适配器工厂。

import type { ImAdapterContext, ImChannelAdapter, ImChannelDescriptor } from '../../types';
import { OneBotGateway, verifyOneBotConfig } from './gateway';

export const descriptor: ImChannelDescriptor = {
  id: 'qq-onebot',
  label: 'QQ 用户模式（OneBot 11）',
  guide:
    'MOSS 自带完整 OneBot 11 服务端，支持三种连接方式：\n'
    + '① 反向 WS：协议端（NapCat / SnowLuma / Lagrange）连接到本机 ws://127.0.0.1:<端口>/onebot/v11/ws；\n'
    + '② 正向 WS：填写协议端 WS 地址，由 MOSS 主动连接；\n'
    + '③ HTTP：填写协议端 HTTP 地址，MOSS 调用其 API，协议端把事件推送到本机 /onebot/v11/event。\n'
    + 'Token 与协议端配置保持一致（可留空）。',
  fields: [
    {
      key: 'mode',
      label: '连接方式',
      type: 'select',
      required: false,
      defaultValue: 'reverse-ws',
      options: [
        { value: 'reverse-ws', label: '反向 WS（协议端连入）' },
        { value: 'forward-ws', label: '正向 WS（MOSS 连出）' },
        { value: 'http', label: 'HTTP（MOSS 调 API）' },
      ],
    },
    {
      key: 'listenPort',
      label: '本机监听端口',
      type: 'number',
      required: false,
      defaultValue: '6199',
      placeholder: '6199',
    },
    {
      key: 'backendUrl',
      label: '协议端地址',
      type: 'text',
      required: false,
      placeholder: 'ws://127.0.0.1:3001 或 http://127.0.0.1:3000',
    },
    { key: 'accessToken', label: 'AccessToken（可选）', type: 'password', required: false },
  ],
  capabilities: { markdown: false, group: true, qrLogin: false },
  async verify(credentials) {
    return verifyOneBotConfig(credentials);
  },
};

export function createAdapter(ctx: ImAdapterContext): ImChannelAdapter {
  return new OneBotGateway(ctx);
}
