import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { z } from 'zod';

import type { RouteAuth } from '@factory/http';
import type { IntegrationHooks } from '@factory/integrations';

import { ClickUpApiError } from './api.ts';
import { clickUpMetadataOf, clickUpTokenOf } from './connection.ts';
import type { ClickUpClients, ClickUpConnectionStorage } from './connection.ts';
import type { ClickUpIntake } from './intake.ts';

const listIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export interface ClickUpRoutesOptions {
  auth: RouteAuth;
  clients: ClickUpClients;
  storage: () => ClickUpConnectionStorage;
  intake: Pick<ClickUpIntake, 'lists'>;
  intervalSeconds: number;
  hooks?: IntegrationHooks;
}

/** `GET /web/clickup/status`: the organization's connection, checked live. Never the token. */
export interface ClickUpStatusView {
  /** The organization stored a token. */
  configured: boolean;
  /** ClickUp accepted it just now. */
  connected: boolean;
  workspaces: string[];
  /** The ClickUp account the token belongs to. */
  account?: { username: string };
  intervalSeconds: number;
  /** The caller may connect, replace or disconnect the token (an organization admin). */
  canManage: boolean;
  /** The organization's own name for the connection; absent shows the account. */
  name?: string;
  /** When the connection was made and who made it (absent on connections from before that was kept). */
  connectedAt?: string;
  connectedBy?: string;
  error?: string;
}

async function resolveOrg(
  c: Context,
  auth: RouteAuth,
): Promise<{ orgId: string; userId: string | null; canManage: boolean } | { response: Response }> {
  await auth.ensureUser(c);
  const tenant = auth.tenant(c);
  if (!tenant) return { response: c.json({ error: 'unauthorized' }, 401) };
  if (!tenant.orgId) {
    return { response: c.json({ error: 'organization_required', message: 'ClickUp intake requires an organization.' }, 403) };
  }
  const canManage = !auth.enabled() || (await auth.isOrganizationAdmin(c, tenant.orgId));
  return { orgId: tenant.orgId, userId: tenant.userId ?? null, canManage };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildClickUpRoutes(options: ClickUpRoutesOptions): ApiRoute[] {
  const { auth, clients, storage, intake, intervalSeconds } = options;

  const status = async (orgId: string, canManage: boolean): Promise<ClickUpStatusView> => {
    const connection = await storage().connections.get(orgId);
    const token = clickUpTokenOf(connection?.data);
    if (!connection || !token) return { configured: false, connected: false, workspaces: [], intervalSeconds, canManage };
    const stored = clickUpMetadataOf(connection.metadata);
    const meta = connection.metadata;
    const account = {
      ...(stored?.username ? { account: { username: stored.username } } : {}),
      ...(typeof meta.name === 'string' ? { name: meta.name } : {}),
      connectedAt: connection.createdAt.toISOString(),
      ...(typeof meta.connectedBy === 'string' ? { connectedBy: meta.connectedBy } : {}),
    };
    // The token is checked live, so the page can say "rejected" instead of showing an empty list.
    try {
      const workspaces = await clients.forToken(token).listWorkspaces();
      return { configured: true, connected: true, workspaces: workspaces.map(w => w.name), ...account, intervalSeconds, canManage };
    } catch (error) {
      return { configured: true, connected: false, error: errorMessage(error), workspaces: [], ...account, intervalSeconds, canManage };
    }
  };

  return [
    registerApiRoute('/web/clickup/status', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrg(c as unknown as Context, auth);
        if ('response' in resolved) return resolved.response;
        return c.json(await status(resolved.orgId, resolved.canManage));
      },
    }),
    registerApiRoute('/web/clickup/lists', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrg(c as unknown as Context, auth);
        if ('response' in resolved) return resolved.response;
        if (!(await storage().connections.get(resolved.orgId))) {
          return c.json({ error: 'clickup_not_connected', message: 'Connect ClickUp for this organization first.' }, 409);
        }
        try {
          return c.json({ lists: await intake.lists(resolved.orgId) });
        } catch (error) {
          const rejected = error instanceof ClickUpApiError && (error.status === 401 || error.status === 403);
          return c.json(
            { error: rejected ? 'clickup_auth_failed' : 'clickup_fetch_failed', message: errorMessage(error) },
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
        const client = await clients.forOrg(resolved.orgId);
        if (!client) return c.json({ error: 'clickup_not_connected', message: 'Connect ClickUp for this organization first.' }, 409);
        try {
          const list = await client.getList(listId.data);
          return c.json({ statuses: list.statuses });
        } catch (error) {
          return c.json({ error: 'clickup_fetch_failed', message: errorMessage(error) }, 502);
        }
      },
    }),
  ];
}
