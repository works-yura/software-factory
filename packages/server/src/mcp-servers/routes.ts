/**
 * Settings › MCP-сервери under `/web/mcp-servers` (upstream Mastra's stored MCP client CRUD,
 * `/stored/mcp-clients`, for the Factory): the organization's servers, the catalog (MCP Registry
 * `server.json` entries), the accounts a catalog input can be filled from,
 * and a check that starts a server and lists its tools. Secret values go in and never come out.
 * Writes are an organization admin's call once auth is on.
 */

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import { mcpCatalogVariant, mcpServerInputSchema } from '@factory/core';
import type { McpServerInput, McpServerView } from '@factory/core';
import type { RouteAuth } from '@factory/http';
import { McpServerNameTakenError } from '@factory/store';
import type { McpServersStorage } from '@factory/store';

import type { McpServerHub } from './hub.ts';
import { MCP_CATALOG, mcpCatalogEntryById } from './catalog.ts';
import type { McpCredentials } from './credentials.ts';

export interface McpServerRoutesOptions {
  auth: RouteAuth;
  servers: Pick<McpServersStorage, 'list' | 'get' | 'create' | 'update' | 'delete'>;
  hub: Pick<McpServerHub, 'status'>;
  credentials: Pick<McpCredentials, 'options' | 'suggestions'>;
  audit?: {
    record(input: {
      orgId: string;
      actorId: string;
      action: 'factory.mcp_server.created' | 'factory.mcp_server.updated' | 'factory.mcp_server.deleted';
      targets: Array<{ type: string; id: string; name?: string }>;
      metadata?: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

class Refusal extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422;
  readonly body: Record<string, unknown>;

  constructor(status: 400 | 401 | 403 | 404 | 409 | 422, body: Record<string, unknown>) {
    super(String(body.error));
    this.status = status;
    this.body = body;
  }
}

async function caller(c: Context, auth: RouteAuth, write: boolean): Promise<{ orgId: string; userId: string }> {
  await auth.ensureUser(c);
  const tenant = auth.tenant(c);
  if (!tenant) throw new Refusal(401, { error: 'unauthorized' });
  if (!tenant.orgId) throw new Refusal(403, { error: 'organization_required', message: 'MCP servers need an organization.' });
  if (write && auth.enabled() && !(await auth.isOrganizationAdmin(c, tenant.orgId))) {
    throw new Refusal(403, { error: 'forbidden', message: 'Only organization admins can change MCP servers.' });
  }
  return { orgId: tenant.orgId, userId: tenant.userId ?? 'local' };
}

function handle(run: (c: Context) => Promise<Response>) {
  return async (raw: unknown) => {
    const c = raw as Context;
    c.header('Cache-Control', 'no-store');
    try {
      return await run(c);
    } catch (error) {
      if (error instanceof Refusal) return c.json(error.body, error.status);
      if (error instanceof McpServerNameTakenError) return c.json({ error: 'name_taken', message: error.message }, 409);
      throw error;
    }
  };
}

async function readInput(c: Context) {
  const parsed = mcpServerInputSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) {
    throw new Refusal(422, {
      error: 'invalid_server',
      message: parsed.error.issues.map(issue => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; '),
    });
  }
  checkCatalogLaunch(parsed.data);
  return parsed.data;
}

/** A catalog launch names a known entry, one of its ways to run, and only inputs that way has. */
function checkCatalogLaunch(input: McpServerInput): void {
  const { launch } = input;
  if (launch.transport !== 'catalog') return;
  const entry = mcpCatalogEntryById(launch.entry);
  if (!entry) throw new Refusal(422, { error: 'invalid_server', message: `The catalog has no server "${launch.entry}".` });
  const variant = mcpCatalogVariant(entry, launch.variant);
  if (!variant) throw new Refusal(422, { error: 'invalid_server', message: `Choose how to run ${entry.label.en}.` });
  const known = new Map(variant.fields.map(field => [field.key, field]));
  const secretKeys = [...Object.keys(input.secrets?.env ?? {}), ...Object.keys(input.secrets?.files ?? {})];
  for (const key of [...Object.keys(launch.inputs), ...Object.keys(launch.credentials), ...secretKeys]) {
    if (!known.has(key)) throw new Refusal(422, { error: 'invalid_server', message: `${entry.label.en} has no input ${key}.` });
  }
  for (const [key, ref] of Object.entries(launch.credentials)) {
    if (known.get(key)?.credential !== ref.kind) throw new Refusal(422, { error: 'invalid_server', message: `${key} is not filled from ${ref.kind}.` });
  }
}

function id(c: Context): string {
  const value = c.req.param('id');
  if (!value || value.length > 64) throw new Refusal(400, { error: 'invalid_id' });
  return value;
}

function target(server: McpServerView) {
  return [{ type: 'mcp_server', id: server.id, name: server.label }];
}

export function buildMcpServerRoutes(options: McpServerRoutesOptions): ApiRoute[] {
  const { auth, servers, hub, audit, credentials } = options;
  return [
    registerApiRoute('/web/mcp-servers', {
      method: 'GET',
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        const canEdit = !auth.enabled() || (await auth.isOrganizationAdmin(c, orgId));
        return c.json({ servers: await servers.list(orgId), catalog: MCP_CATALOG, credentials: await credentials.options(orgId), canEdit });
      }),
    }),
    registerApiRoute('/web/mcp-servers/suggestions', {
      method: 'GET',
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        const factoryProjectId = c.req.query('factoryProjectId');
        if (!factoryProjectId || factoryProjectId.length > 128) throw new Refusal(400, { error: 'factory_required' });
        return c.json({ suggestions: await credentials.suggestions(orgId, factoryProjectId) });
      }),
    }),
    registerApiRoute('/web/mcp-servers', {
      method: 'POST',
      handler: handle(async c => {
        const { orgId, userId } = await caller(c, auth, true);
        const created = await servers.create(orgId, await readInput(c), userId);
        await audit?.record({ orgId, actorId: userId, action: 'factory.mcp_server.created', targets: target(created) });
        return c.json({ server: created }, 201);
      }),
    }),
    registerApiRoute('/web/mcp-servers/:id', {
      method: 'PUT',
      handler: handle(async c => {
        const { orgId, userId } = await caller(c, auth, true);
        const updated = await servers.update(orgId, id(c), await readInput(c), userId);
        if (!updated) throw new Refusal(404, { error: 'not_found' });
        await audit?.record({ orgId, actorId: userId, action: 'factory.mcp_server.updated', targets: target(updated) });
        return c.json({ server: updated });
      }),
    }),
    registerApiRoute('/web/mcp-servers/:id', {
      method: 'DELETE',
      handler: handle(async c => {
        const { orgId, userId } = await caller(c, auth, true);
        const existing = await servers.get(orgId, id(c));
        if (!existing || !(await servers.delete(orgId, existing.id))) throw new Refusal(404, { error: 'not_found' });
        await audit?.record({ orgId, actorId: userId, action: 'factory.mcp_server.deleted', targets: target(existing) });
        return c.json({ deleted: true });
      }),
    }),
    registerApiRoute('/web/mcp-servers/:id/status', {
      method: 'POST',
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        const status = await hub.status(orgId, id(c));
        if (!status) throw new Refusal(404, { error: 'not_found' });
        return c.json({ status });
      }),
    }),
  ];
}
