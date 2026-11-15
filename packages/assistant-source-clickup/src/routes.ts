/**
 * `/web/assistant/sources/*` (ADR-0051 phase 2): the person's own ClickUp connection in their
 * current organization — connect with a personal API token, a mode per channel, sync now,
 * disconnect. The owner is always the caller; the token never leaves the server.
 */
import { AssistantError, assistantHandler, isChannelMode, jsonBody } from '@factory/assistant-core';
import type { RouteAccess, RouteAuth } from '@factory/http';
import { declareAccess } from '@factory/http';
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';

import type { ClickUpChatSource } from './source.ts';

export const SOURCES_ROUTE_PREFIX = '/web/assistant/sources';

export function buildClickUpSourceRoutes(deps: { auth: RouteAuth; source: ClickUpChatSource }): ApiRoute[] {
  const { source } = deps;
  const handle = (handler: Parameters<typeof assistantHandler>[1]) => assistantHandler(deps.auth, handler);
  const p = SOURCES_ROUTE_PREFIX;
  const routes = [
    registerApiRoute(p, {
      method: 'GET',
      handler: handle(async (c, owner) => c.json({ clickup: await source.view(owner) })),
    }),
    registerApiRoute(`${p}/clickup`, {
      method: 'POST',
      handler: handle(async (c, owner) => {
        const body = await jsonBody(c);
        if (typeof body.token !== 'string') throw new AssistantError('invalid_body', 'Send the token as text.', 400);
        return c.json({ clickup: await source.connect(owner, body.token) });
      }),
    }),
    registerApiRoute(`${p}/clickup`, {
      method: 'DELETE',
      handler: handle(async (c, owner) => {
        await source.disconnect(owner);
        return c.json({ clickup: await source.view(owner) });
      }),
    }),
    registerApiRoute(`${p}/clickup/sync`, {
      method: 'POST',
      handler: handle(async (c, owner) => {
        const result = await source.syncNow(owner);
        return c.json({ result: { ingested: result.ingested, channels: result.channels, error: result.error ?? null }, clickup: await source.view(owner) });
      }),
    }),
    registerApiRoute(`${p}/clickup/channels/:workspaceId/:channelId`, {
      method: 'PUT',
      handler: handle(async (c, owner) => {
        const body = await jsonBody(c);
        if (!isChannelMode(body.mode)) throw new AssistantError('invalid_mode', 'mode is ignore, addressed or watch.', 400);
        await source.setMode(owner, {
          workspaceId: c.req.param('workspaceId') ?? '',
          channelId: c.req.param('channelId') ?? '',
          mode: body.mode,
        });
        return c.json({ clickup: await source.view(owner) });
      }),
    }),
  ];
  return declareAccess(routes, CLICKUP_SOURCE_ROUTE_ACCESS);
}

/** Every write is the person's own (ADR-0045 `self.write`). */
export const CLICKUP_SOURCE_ROUTE_ACCESS: Readonly<Record<string, RouteAccess>> = {
  'POST /web/assistant/sources/clickup': 'self.write',
  'DELETE /web/assistant/sources/clickup': 'self.write',
  'POST /web/assistant/sources/clickup/sync': 'self.write',
  'PUT /web/assistant/sources/clickup/channels/:workspaceId/:channelId': 'self.write',
};
