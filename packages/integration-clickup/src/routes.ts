import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { z } from 'zod';

import type { RouteAuth } from '@factory/http';
import type { IntegrationHooks } from '@factory/integrations';

import { ClickUpApiError } from './api.ts';
import { clickUpMetadataOf, clickUpTokenOf, saveClickUpConnection } from './connection.ts';
import type { ClickUpClients, ClickUpConnectionMetadata, ClickUpConnectionStorage } from './connection.ts';
import type { ClickUpIntake } from './intake.ts';

const listIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const tokenBodySchema = z.object({ token: z.string().trim().min(1).max(500) });

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

/** What ClickUp says about a token: its account and Workspaces, or why it refused. */
async function checkToken(
  clients: ClickUpClients,
  token: string,
): Promise<{ account: ClickUpConnectionMetadata } | { status: 422 | 502; body: Record<string, unknown> }> {
  const client = clients.forToken(token);
  try {
    const user = await client.authorizedUser();
    const workspaces = await client.listWorkspaces();
    return { account: { username: user.username, userId: user.id, workspaces: workspaces.map(w => w.name) } };
  } catch (error) {
    clients.forget(token);
    if (error instanceof ClickUpApiError && (error.status === 401 || error.status === 403)) {
      return {
        status: 422,
        body: {
          error: 'invalid_token',
          message: `ClickUp rejected this token (${error.status}). Paste a personal API token (pk_…) from ClickUp › Settings › Apps; a regenerated token replaces the old one.`,
        },
      };
    }
    return {
      status: 502,
      body: { error: 'clickup_unreachable', message: `ClickUp could not check the token: ${errorMessage(error)}` },
    };
  }
}

export function buildClickUpRoutes(options: ClickUpRoutesOptions): ApiRoute[] {
  const { auth, clients, storage, intake, intervalSeconds, hooks } = options;

  const status = async (orgId: string, canManage: boolean): Promise<ClickUpStatusView> => {
    const connection = await storage().connections.get(orgId);
    const token = clickUpTokenOf(connection?.data);
    if (!connection || !token) return { configured: false, connected: false, workspaces: [], intervalSeconds, canManage };
    const stored = clickUpMetadataOf(connection.metadata);
    const account = stored?.username ? { account: { username: stored.username } } : {};
    // The token is checked live, so the page can say "rejected" instead of showing an empty list.
    try {
      const workspaces = await clients.forToken(token).listWorkspaces();
      return { configured: true, connected: true, workspaces: workspaces.map(w => w.name), ...account, intervalSeconds, canManage };
    } catch (error) {
      return { configured: true, connected: false, error: errorMessage(error), workspaces: [], ...account, intervalSeconds, canManage };
    }
  };

  const audit = (c: Context, action: 'token_connected' | 'token_removed', metadata: Record<string, unknown>) =>
    hooks?.emitAudit?.({
      context: c,
      input: {
        action: `factory.integration.${action}` as const,
        targets: [{ type: 'integration', id: 'clickup', name: 'ClickUp' }],
        metadata,
      },
    });

  const forbidden = (c: Context) =>
    c.json({ error: 'forbidden', message: 'Only organization admins can connect or disconnect ClickUp.' }, 403);

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
    // Connect or replace the organization's token: checked against ClickUp first, stored encrypted.
    registerApiRoute('/web/clickup/connection', {
      method: 'PUT',
      requiresAuth: false,
      handler: async c => {
        const context = c as unknown as Context;
        const resolved = await resolveOrg(context, auth);
        if ('response' in resolved) return resolved.response;
        if (!resolved.canManage) return forbidden(context);
        const body = tokenBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) return c.json({ error: 'invalid_body', message: 'Send the ClickUp API token as { "token": "pk_…" }.' }, 422);
        const checked = await checkToken(clients, body.data.token);
        if ('status' in checked) return c.json(checked.body, checked.status);
        const previous = await storage().connections.get(resolved.orgId);
        await saveClickUpConnection(storage(), resolved.orgId, {
          token: body.data.token,
          userId: resolved.userId,
          account: checked.account,
        });
        const before = clickUpTokenOf(previous?.data);
        if (before && before !== body.data.token) clients.forget(before);
        audit(context, 'token_connected', { replaced: previous !== null, account: checked.account.username });
        return c.json(await status(resolved.orgId, resolved.canManage));
      },
    }),
    registerApiRoute('/web/clickup/connection', {
      method: 'DELETE',
      requiresAuth: false,
      handler: async c => {
        const context = c as unknown as Context;
        const resolved = await resolveOrg(context, auth);
        if ('response' in resolved) return resolved.response;
        if (!resolved.canManage) return forbidden(context);
        const previous = await storage().connections.get(resolved.orgId);
        const removed = await storage().connections.delete(resolved.orgId);
        const before = clickUpTokenOf(previous?.data);
        if (before) clients.forget(before);
        if (removed) audit(context, 'token_removed', {});
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
