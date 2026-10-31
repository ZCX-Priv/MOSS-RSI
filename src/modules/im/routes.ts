// src/modules/im/routes.ts
// /api/im/* 路由：渠道描述符、状态快照、机器人 CRUD、测试、配对码/绑定、统一扫码接入。
// 所有路由 auth:true（与 config/remote 一致）；凭据只进 bots.json，不出现在响应里。

import type { HttpRequest, HttpResponse, Route } from '../server/types';
import { asRecord, str } from './adapters/util';
import type { ImController } from './controller';
import type { ImProvisioningManager } from './provisioning';
import type { ImBotOptions } from './types';

function ok(body: unknown): HttpResponse {
  return { status: 200, body };
}

function fail(error: unknown, status = 400): HttpResponse {
  return { status, body: { error: error instanceof Error ? error.message : String(error) } };
}

function bodyOf(req: HttpRequest): Record<string, unknown> {
  return asRecord(req.body) ?? {};
}

export function createImRoutes(
  controller: ImController,
  provisioning: ImProvisioningManager,
): Route[] {
  const botIdOf = (params?: Record<string, string>): string => str(params?.botId);

  return [
    {
      method: 'GET',
      pattern: '/api/im/channels',
      auth: true,
      handler: async (): Promise<HttpResponse> => ok({ channels: controller.descriptors() }),
    },
    {
      method: 'GET',
      pattern: '/api/im/status',
      auth: true,
      handler: async (): Promise<HttpResponse> => ok(controller.status()),
    },
    {
      method: 'POST',
      pattern: '/api/im/bots',
      auth: true,
      handler: async (req: HttpRequest): Promise<HttpResponse> => {
        const body = bodyOf(req);
        const credentials: Record<string, string> = {};
        const rawCredentials = asRecord(body.credentials);
        if (rawCredentials) {
          for (const [key, value] of Object.entries(rawCredentials)) {
            if (typeof value === 'string') credentials[key] = value;
          }
        }
        try {
          const snapshot = await controller.saveBot({
            botId: str(body.botId) || undefined,
            channel: str(body.channel),
            name: str(body.name) || undefined,
            credentials,
            options: (asRecord(body.options) ?? {}) as unknown as Partial<ImBotOptions>,
            enabled: body.enabled === undefined ? undefined : body.enabled === true,
          });
          return ok(snapshot);
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/im/bots/:botId',
      auth: true,
      handler: async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
        try {
          await controller.removeBot(botIdOf(params));
          return ok({ removed: true });
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/im/bots/:botId/enable',
      auth: true,
      handler: async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
        try {
          return ok(await controller.setEnabled(botIdOf(params), true));
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/im/bots/:botId/disable',
      auth: true,
      handler: async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
        try {
          return ok(await controller.setEnabled(botIdOf(params), false));
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/im/bots/:botId/reconnect',
      auth: true,
      handler: async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
        try {
          return ok(await controller.reconnect(botIdOf(params)));
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/im/bots/:botId/test',
      auth: true,
      handler: async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
        try {
          await controller.test(botIdOf(params));
          return ok({ sent: true });
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/im/bots/:botId/pairing',
      auth: true,
      handler: async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
        try {
          return ok(await controller.rotatePairing(botIdOf(params)));
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/im/bots/:botId/unbind',
      auth: true,
      handler: async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
        try {
          const userId = str(bodyOf(req).userId);
          if (!userId) throw new Error('缺少 userId');
          return ok(await controller.unbind(botIdOf(params), userId));
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/im/provisioning/:channel/start',
      auth: true,
      handler: async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
        try {
          return ok(await provisioning.start(str(params?.channel)));
        } catch (error) {
          return fail(error, 502);
        }
      },
    },
    {
      method: 'GET',
      pattern: '/api/im/provisioning/:loginId',
      auth: true,
      handler: async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
        try {
          const loginId = str(params?.loginId);
          const snapshot = provisioning.get(loginId);
          if (!snapshot) throw new Error('登录会话不存在或已过期');
          return ok(snapshot);
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/im/provisioning/:loginId/verify',
      auth: true,
      handler: async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
        try {
          return ok(await provisioning.verify(str(params?.loginId), str(bodyOf(req).code)));
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/im/provisioning/:loginId/cancel',
      auth: true,
      handler: async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
        try {
          return ok(await provisioning.cancel(str(params?.loginId)));
        } catch (error) {
          return fail(error);
        }
      },
    },
  ];
}
