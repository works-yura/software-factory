import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { z } from 'zod';

import type { RouteAuth } from '@factory/http';
import type { IntegrationStorageHandle } from '@factory/store';

import { ClickUpApiError } from './api.ts';
import type { ClickUpClient } from './api.ts';
import type { ClickUpIntake } from './intake.ts';
import { readClickUpSettings, saveClickUpSettings } from './settings.ts';

const settingsBodySchema = z.object({ autoStart: z.boolean() });

export interface ClickUpRoutesOptions {
  auth: RouteAuth;
  client: ClickUpClient;
  intake: Pick<ClickUpIntake, 'lists'>;
  storage: Pick<IntegrationStorageHandle, 'settings'>;
  intervalSeconds: number;
}

async function resolveOrg(
  c: Context,
  auth: RouteAuth,
): Promise<{ orgId: string } | { response: Response }> {
  await auth.ensureUser(c);
  const tenant = auth.tenant(c);
  if (!tenant) return { response: c.json({ error: 'unauthorized' }, 401) };
  if (!tenant.orgId) {
    return { response: c.json({ error: 'organization_required', message: 'ClickUp intake requires an organization.' }, 403) };
  }
  return { orgId: tenant.orgId };
}

export function buildClickUpRoutes(options: ClickUpRoutesOptions): ApiRoute[] {
  const { auth, client, intake, storage, intervalSeconds } = options;
  return [
    registerApiRoute('/web/clickup/status', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrg(c as unknown as Context, auth);
        if ('response' in resolved) return resolved.response;
        const settings = await readClickUpSettings(storage, resolved.orgId);
        // The token is checked live, so the page can say "rejected" instead of showing an empty list.
        try {
          const workspaces = await client.listWorkspaces();
          return c.json({ configured: true, connected: true, workspaces: workspaces.map(w => w.name), intervalSeconds, ...settings });
        } catch (error) {
          return c.json({
            configured: true,
            connected: false,
            error: error instanceof Error ? error.message : String(error),
            workspaces: [],
            intervalSeconds,
            ...settings,
          });
        }
      },
    }),
    registerApiRoute('/web/clickup/lists', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrg(c as unknown as Context, auth);
        if ('response' in resolved) return resolved.response;
        try {
          return c.json({ lists: await intake.lists() });
        } catch (error) {
          const rejected = error instanceof ClickUpApiError && (error.status === 401 || error.status === 403);
          return c.json(
            {
              error: rejected ? 'clickup_auth_failed' : 'clickup_fetch_failed',
              message: error instanceof Error ? error.message : String(error),
            },
            rejected ? 409 : 502,
          );
        }
      },
    }),
    registerApiRoute('/web/clickup/settings', {
      method: 'PUT',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrg(c as unknown as Context, auth);
        if ('response' in resolved) return resolved.response;
        const body = await c.req.json().catch(() => undefined);
        const parsed = settingsBodySchema.safeParse(body);
        if (!parsed.success) return c.json({ error: 'invalid_settings' }, 400);
        await saveClickUpSettings(storage, resolved.orgId, parsed.data);
        return c.json(parsed.data);
      },
    }),
  ];
}
