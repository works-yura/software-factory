import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { z } from 'zod';

import type { RouteAuth } from '@factory/http';

import { ClickUpApiError } from './api.ts';
import type { ClickUpClient } from './api.ts';
import type { ClickUpIntake } from './intake.ts';

const listIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export interface ClickUpRoutesOptions {
  auth: RouteAuth;
  client: ClickUpClient;
  intake: Pick<ClickUpIntake, 'lists'>;
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
  const { auth, client, intake, intervalSeconds } = options;
  return [
    registerApiRoute('/web/clickup/status', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrg(c as unknown as Context, auth);
        if ('response' in resolved) return resolved.response;
        // The token is checked live, so the page can say "rejected" instead of showing an empty list.
        try {
          const workspaces = await client.listWorkspaces();
          return c.json({ configured: true, connected: true, workspaces: workspaces.map(w => w.name), intervalSeconds });
        } catch (error) {
          return c.json({
            configured: true,
            connected: false,
            error: error instanceof Error ? error.message : String(error),
            workspaces: [],
            intervalSeconds,
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
    registerApiRoute('/web/clickup/lists/:listId/statuses', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrg(c as unknown as Context, auth);
        if ('response' in resolved) return resolved.response;
        const listId = listIdSchema.safeParse(c.req.param('listId'));
        if (!listId.success) return c.json({ error: 'invalid_list' }, 400);
        try {
          const list = await client.getList(listId.data);
          return c.json({ statuses: list.statuses });
        } catch (error) {
          return c.json({ error: 'clickup_fetch_failed', message: error instanceof Error ? error.message : String(error) }, 502);
        }
      },
    }),
  ];
}
