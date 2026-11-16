/**
 * `/web/assistant/sources/*` (ADR-0051 phase 2; the tag per the amendment of 2026-11-16): the
 * person's own ClickUp connection in their current organization — connect with a personal API
 * token, their tag (pattern, who may tag, context size), sync now, disconnect. There is no
 * per-channel setting: every chat is looked at for the tag only. The owner is always the caller;
 * the token never leaves the server.
 */
import { AssistantError, assistantHandler, jsonBody } from '@factory/assistant-core';
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
    // The caller's own last ClickUp read, redacted to its shape (status, counts, keys, enum values):
    // for checking live data without names, message text or the token. Only ever the caller's own.
    registerApiRoute(`${p}/clickup/diagnostics`, {
      method: 'GET',
      handler: handle(async (c, owner) => c.json({ diagnostics: await source.diagnostics(owner) })),
    }),
    registerApiRoute(`${p}/clickup`, {
      method: 'POST',
      handler: handle(async (c, owner) => {
        const body = await jsonBody(c);
        if (typeof body.token !== 'string') throw new AssistantError('invalid_body', 'Send the token as text.', 400);
        return c.json({ clickup: await source.connect(owner, body.token) });
      }),
    }),
    registerApiRoute(`${p}/clickup/org`, {
      method: 'POST',
      // Only the person whose own ClickUp account the organization's token is; anyone else gets 403.
      handler: handle(async (c, owner) => c.json({ clickup: await source.connectOrg(owner) })),
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
    // The person's tag: `{ pattern?: string | null (null: the default), who?: 'me' | 'anyone', contextMessages?: number }`.
    registerApiRoute(`${p}/clickup/tag`, {
      method: 'PUT',
      handler: handle(async (c, owner) => {
        const body = await jsonBody(c);
        if (body.pattern === undefined && body.who === undefined && body.contextMessages === undefined) {
          throw new AssistantError('invalid_body', 'Send pattern, who and/or contextMessages.', 400);
        }
        if (body.pattern !== undefined && body.pattern !== null && typeof body.pattern !== 'string') {
          throw new AssistantError('invalid_body', 'pattern is text, or null for the default.', 400);
        }
        const clickup = await source.setTag(owner, {
          ...(body.pattern !== undefined ? { pattern: body.pattern as string | null } : {}),
          ...(body.who !== undefined ? { who: body.who as 'me' | 'anyone' } : {}),
          ...(body.contextMessages !== undefined ? { contextMessages: body.contextMessages as number } : {}),
        });
        return c.json({ clickup });
      }),
    }),
  ];
  return declareAccess(routes, CLICKUP_SOURCE_ROUTE_ACCESS);
}

/** Every write is the person's own (ADR-0045 `self.write`). */
export const CLICKUP_SOURCE_ROUTE_ACCESS: Readonly<Record<string, RouteAccess>> = {
  'POST /web/assistant/sources/clickup': 'self.write',
  'POST /web/assistant/sources/clickup/org': 'self.write',
  'DELETE /web/assistant/sources/clickup': 'self.write',
  'POST /web/assistant/sources/clickup/sync': 'self.write',
  'PUT /web/assistant/sources/clickup/tag': 'self.write',
};
