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

import { z } from 'zod';

import { MCP_SUGGESTION_SOURCES, mcpCatalogVariant, mcpCredentialRefSchema, mcpServerInputSchema } from '@factory/core';
import type { McpServerInput, McpServerView } from '@factory/core';
import type { RouteAuth } from '@factory/http';
import { McpServerNameTakenError, mergeMcpSecrets } from '@factory/store';
import type { McpServersStorage } from '@factory/store';

import { McpToolNotTryableError } from './hub.ts';
import type { McpServerHub } from './hub.ts';
import { MCP_CATALOG, mcpCatalogEntryById } from './catalog.ts';
import type { McpCredentials } from './credentials.ts';
import type { ManagedMcpServers } from './managed.ts';

export interface McpServerRoutesOptions {
  auth: RouteAuth;
  servers: Pick<McpServersStorage, 'list' | 'get' | 'getRecord' | 'create' | 'update' | 'delete'>;
  hub: Pick<McpServerHub, 'status' | 'check' | 'reconnect' | 'tryTool'>;
  credentials: Pick<McpCredentials, 'options' | 'suggestions' | 'discover'>;
  /** Syncs the servers integrations manage before the organization's list is read. */
  managed?: Pick<ManagedMcpServers, 'ensure'>;
  audit?: {
    record(input: {
      orgId: string;
      actorId: string;
      action:
        | 'factory.mcp_server.created'
        | 'factory.mcp_server.updated'
        | 'factory.mcp_server.deleted'
        | 'factory.mcp_server.reconnected';
      targets: Array<{ type: string; id: string; name?: string }>;
      metadata?: Record<string, unknown>;
    }): Promise<unknown>;
  };
  /** The audit trail, read for a server's recent calls. */
  auditLog?: {
    list(input: { orgId: string; factoryProjectId?: string; actions?: string[]; limit?: number; before?: string }): Promise<{
      events: Array<{
        actorId: string;
        actorType: string;
        action: string;
        targets: Array<{ type: string; id: string }>;
        metadata: Record<string, unknown>;
        factoryProjectId: string | null;
        occurredAt: Date;
      }>;
      nextCursor?: string;
    }>;
  };
  /** The clock activity windows are measured from (tests pin it). */
  now?: () => Date;
}

/** One call to a server's tool, as the page lists it. */
export interface McpServerCall {
  at: string;
  tool: string;
  outcome: 'ok' | 'error';
  durationMs?: number;
  /** The agent session that called it; absent for a person's «Спробувати». */
  sessionId?: string;
  factoryProjectId?: string;
  tried: boolean;
}

const RECENT_CALLS = 20;

/** One call in a Factory's activity: the call, and which server it went to. */
export interface McpActivityCall extends McpServerCall {
  serverId: string;
  serverLabel: string;
}

/** What «Активність» on Підключення shows: the window's counts and its newest calls. */
export interface McpActivity {
  since: string;
  total: number;
  errors: number;
  calls: McpActivityCall[];
  /** The trail held more than was read: counts are a lower bound. */
  truncated: boolean;
}

const CALL_ACTIONS = ['factory.mcp_server.tool_called', 'factory.mcp_server.tool_tried'];
const ACTIVITY_CALLS = 50;
const ACTIVITY_PAGE = 200;
const ACTIVITY_PAGES = 5;

type AuditEvent = Awaited<ReturnType<NonNullable<McpServerRoutesOptions['auditLog']>['list']>>['events'][number];

/** An audit event of a tool call as the page lists it: no payloads, a person's try marked as such. */
function callOf(event: AuditEvent): McpServerCall {
  const tried = event.action === 'factory.mcp_server.tool_tried';
  const sessionId = typeof event.metadata.sessionId === 'string' ? event.metadata.sessionId : undefined;
  return {
    at: new Date(event.occurredAt).toISOString(),
    tool: String(event.metadata.tool ?? ''),
    outcome: event.metadata.outcome === 'error' ? 'error' : 'ok',
    ...(typeof event.metadata.durationMs === 'number' ? { durationMs: event.metadata.durationMs } : {}),
    ...(sessionId && !tried ? { sessionId } : {}),
    ...(event.factoryProjectId ? { factoryProjectId: event.factoryProjectId } : {}),
    tried,
  };
}

/**
 * A Factory's agent calls through every MCP server since `since`, newest first: counts over the window
 * (a lower bound when the trail held more than was read: `truncated`) and the newest `limit` calls with
 * the server named. No payloads. What the MCP connector serves as «Активність» (`McpConnections.activity`).
 */
export async function readMcpActivity({
  auditLog,
  servers,
  orgId,
  factoryProjectId,
  since,
  limit = ACTIVITY_CALLS,
}: {
  auditLog: NonNullable<McpServerRoutesOptions['auditLog']>;
  servers: Pick<McpServersStorage, 'list'>;
  orgId: string;
  factoryProjectId: string;
  since: Date;
  limit?: number;
}): Promise<Omit<McpActivity, 'since'>> {
  const activity: Omit<McpActivity, 'since'> = { total: 0, errors: 0, calls: [], truncated: false };
  const labels = new Map((await servers.list(orgId)).map(server => [server.id, server.label]));
  let before: string | undefined;
  for (let page = 0; page < ACTIVITY_PAGES; page += 1) {
    const result = await auditLog.list({ orgId, factoryProjectId, actions: CALL_ACTIONS, limit: ACTIVITY_PAGE, ...(before ? { before } : {}) });
    let reachedStart = false;
    for (const event of result.events) {
      if (new Date(event.occurredAt) < since) {
        reachedStart = true;
        break;
      }
      const target = event.targets.find(candidate => candidate.type === 'mcp_server');
      if (!target) continue;
      const call = callOf(event);
      activity.total += 1;
      if (call.outcome === 'error') activity.errors += 1;
      if (activity.calls.length < limit) {
        activity.calls.push({ ...call, serverId: target.id, serverLabel: labels.get(target.id) ?? (typeof event.metadata.server === 'string' ? event.metadata.server : target.id) });
      }
    }
    if (reachedStart || !result.nextCursor) break;
    before = result.nextCursor;
    if (page === ACTIVITY_PAGES - 1) activity.truncated = true;
  }
  return activity;
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

const discoverBodySchema = z.object({
  credential: mcpCredentialRefSchema,
  from: z.enum(MCP_SUGGESTION_SOURCES),
  /** The other inputs the lookup depends on, by role (`project` for a project's databases). */
  context: z.record(z.string().max(64), z.string().max(256)).default({}),
});

const tryBodySchema = z.object({
  tool: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const checkBodySchema = z.object({
  /** The stored server being edited: its saved secrets fill whatever the form did not retype. */
  id: z.string().min(1).max(64).optional(),
  server: z.unknown(),
});

async function readInput(c: Context) {
  return parseInput(await c.req.json().catch(() => undefined));
}

function parseInput(body: unknown) {
  const parsed = mcpServerInputSchema.safeParse(body);
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
  const { auth, servers, hub, audit, credentials, managed, auditLog } = options;
  const now = options.now ?? (() => new Date());
  return [
    registerApiRoute('/web/mcp-servers', {
      method: 'GET',
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        await managed?.ensure(orgId);
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
    // Choices for an input from the account another input picked (projects, databases). Read-only;
    // a refusal comes back as `denied` with what is still known, never as an error.
    registerApiRoute('/web/mcp-servers/discover', {
      method: 'POST',
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        const parsed = discoverBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) throw new Refusal(422, { error: 'invalid_discovery', message: parsed.error.issues[0]?.message ?? 'Invalid request.' });
        const { credential, from, context } = parsed.data;
        return c.json(await credentials.discover(orgId, credential, from, context));
      }),
    }),
    // «Перевірити» before saving: starts the config as entered, lists its tools, stores nothing.
    registerApiRoute('/web/mcp-servers/check', {
      method: 'POST',
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, true);
        const body = checkBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) throw new Refusal(422, { error: 'invalid_server', message: 'Send the server to check.' });
        const input = parseInput(body.data.server);
        const stored = body.data.id ? await servers.getRecord(orgId, body.data.id) : null;
        if (body.data.id && !stored) throw new Refusal(404, { error: 'not_found' });
        const secrets = mergeMcpSecrets(stored?.secrets ?? { env: {}, headers: {}, files: {} }, input.secrets);
        const status = await hub.check(orgId, { name: input.name, launch: input.launch, secrets, toolPolicies: input.toolPolicies });
        return c.json({ status });
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
        const serverId = id(c);
        const input = await readInput(c);
        const existing = await servers.get(orgId, serverId);
        if (!existing) throw new Refusal(404, { error: 'not_found' });
        // An integration's server keeps the config and access its settings give it: only what each
        // tool may do and the masking are a person's to change here.
        const write: McpServerInput = existing.owner
          ? {
              name: existing.name,
              label: existing.label,
              launch: existing.launch,
              assignments: existing.assignments,
              toolPolicies: input.toolPolicies,
              maskPersonalData: input.maskPersonalData,
              enabled: existing.enabled,
            }
          : input;
        const updated = await servers.update(orgId, serverId, write, userId);
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
        if (!existing) throw new Refusal(404, { error: 'not_found' });
        if (existing.owner) {
          throw new Refusal(409, {
            error: 'managed_by_integration',
            integration: existing.owner.integration,
            message: 'An integration manages this server; switch it off in Settings › Integrations.',
          });
        }
        if (!(await servers.delete(orgId, existing.id))) throw new Refusal(404, { error: 'not_found' });
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
    // «Перепідключити»: stops every running instance (sessions restart it on their next call) and re-checks.
    registerApiRoute('/web/mcp-servers/:id/reconnect', {
      method: 'POST',
      handler: handle(async c => {
        const { orgId, userId } = await caller(c, auth, true);
        const serverId = id(c);
        const status = await hub.reconnect(orgId, serverId);
        if (!status) throw new Refusal(404, { error: 'not_found' });
        await audit?.record({
          orgId,
          actorId: userId,
          action: 'factory.mcp_server.reconnected',
          targets: [{ type: 'mcp_server', id: serverId }],
          metadata: { connected: status.connected },
        });
        return c.json({ status });
      }),
    }),
    // «Спробувати»: runs one read-only tool by itself. An admin's call, since it starts the server.
    registerApiRoute('/web/mcp-servers/:id/try', {
      method: 'POST',
      handler: handle(async c => {
        const { orgId, userId } = await caller(c, auth, true);
        const body = tryBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) throw new Refusal(422, { error: 'invalid_trial', message: 'Name the tool to try.' });
        try {
          const trial = await hub.tryTool(orgId, id(c), body.data.tool, body.data.arguments, userId);
          if (!trial) throw new Refusal(404, { error: 'not_found' });
          return c.json({ trial });
        } catch (error) {
          if (error instanceof McpToolNotTryableError) {
            throw new Refusal(422, { error: error.reason, message: error.message });
          }
          throw error;
        }
      }),
    }),
    // The server's last calls from the audit trail: who (session), which tool, outcome, how long. No payloads.
    registerApiRoute('/web/mcp-servers/:id/calls', {
      method: 'GET',
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        const serverId = id(c);
        if (!(await servers.get(orgId, serverId))) throw new Refusal(404, { error: 'not_found' });
        if (!auditLog) return c.json({ calls: [] });
        const page = await auditLog.list({
          orgId,
          actions: CALL_ACTIONS,
          limit: 200,
        });
        const calls: McpServerCall[] = page.events
          .filter(event => event.targets.some(target => target.type === 'mcp_server' && target.id === serverId))
          .slice(0, RECENT_CALLS)
          .map(callOf);
        return c.json({ calls });
      }),
    }),
  ];
}
