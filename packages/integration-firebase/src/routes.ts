/**
 * Firebase's HTTP surface under `/web/firebase`: the organization's Google Cloud accounts as read
 * (`status`) and added from an MCP server's form (a key uploaded once, never sent back). Bindings —
 * connecting, settings, the access check, unlinking and removal — are the connections facet
 * (`connections.ts`, ADR-0035). Writes are an organization admin's call once auth is on.
 */

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { z } from 'zod';

import { ObservabilityProviderError, ObservabilityQueryError } from '@factory/capabilities';
import type { RouteAuth } from '@factory/http';
import type { IntegrationHooks } from '@factory/integrations';
import type { FactoryProjectsStorage, IntegrationStorageHandle } from '@factory/store';

import { FIRESTORE_API, GoogleApiClient } from './google-api.ts';
import { ServiceAccountKeyError, ServiceAccountTokens, parseServiceAccountKey } from './service-account.ts';
import type { FetchLike, ServiceAccountKey } from './service-account.ts';
import { readFirebaseState, readsCrashes, readsDatabase, saveAccount } from './settings.ts';
import type { FirebaseAccount, FirebaseBinding, FirebaseState } from './settings.ts';
import { FirebaseObservabilitySource } from './source.ts';
import { declareAccess } from '@factory/http';
import type { RouteAccess } from '@factory/http';

export interface FirebaseRoutesOptions {
  auth: RouteAuth;
  storage: Pick<IntegrationStorageHandle, 'connections' | 'settings'>;
  projects: Pick<FactoryProjectsStorage, 'get'>;
  hooks?: IntegrationHooks;
  fetch?: FetchLike;
  now?: () => Date;
}

/** One line of the access check. */
export interface FirebaseCheck {
  check: 'logs' | 'crashes' | 'database';
  /** The Google Cloud project (logs), app id (crashes) or Firestore database (database) checked. */
  target: string;
  ok: boolean;
  message?: string;
  missingRole?: string;
  fix?: string;
}

/** An account as the settings page lists it: never the key, with the bindings that use it. */
export interface FirebaseAccountView extends FirebaseAccount {
  bindingIds: string[];
}

export interface FirebaseStateView {
  accounts: FirebaseAccountView[];
  bindings: FirebaseBinding[];
}

const accountNameSchema = z.string().trim().min(1).max(80);
const addAccountSchema = z.object({ name: accountNameSchema.optional(), serviceAccountJson: z.string().min(2).max(20_000) });

class Refusal extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422;
  readonly body: Record<string, unknown>;

  constructor(status: 400 | 401 | 403 | 404 | 409 | 422, body: Record<string, unknown>) {
    super(String(body.error));
    this.status = status;
    this.body = body;
  }
}

async function caller(c: Context, auth: RouteAuth, write: boolean): Promise<{ orgId: string; userId: string | null }> {
  await auth.ensureUser(c);
  const tenant = auth.tenant(c);
  if (!tenant) throw new Refusal(401, { error: 'unauthorized' });
  if (!tenant.orgId) throw new Refusal(403, { error: 'organization_required', message: 'Firebase needs an organization.' });
  if (write && auth.enabled() && !(await auth.can(c, 'connections.manage', tenant.orgId))) {
    throw new Refusal(403, { error: 'forbidden', message: 'Only organization admins can change Firebase accounts and bindings.' });
  }
  return { orgId: tenant.orgId, userId: tenant.userId ?? null };
}

function handle(run: (c: Context) => Promise<Response>) {
  return async (raw: unknown) => {
    const c = raw as Context;
    try {
      return await run(c);
    } catch (error) {
      if (error instanceof Refusal) return c.json(error.body, error.status);
      throw error;
    }
  };
}

function parseKey(json: string): ServiceAccountKey {
  try {
    return parseServiceAccountKey(json);
  } catch (error) {
    if (error instanceof ServiceAccountKeyError) throw new Refusal(422, { error: 'invalid_key', message: error.message });
    throw error;
  }
}

async function readBody<S extends z.ZodType>(c: Context, schema: S, error: string): Promise<z.output<S>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) {
    throw new Refusal(422, {
      error,
      message: parsed.error.issues.map(issue => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; '),
    });
  }
  return parsed.data;
}


export function stateView(state: FirebaseState): FirebaseStateView {
  return {
    accounts: state.accounts.map(account => ({
      ...account,
      bindingIds: state.bindings.filter(binding => binding.accountId === account.id).map(binding => binding.id),
    })),
    bindings: state.bindings,
  };
}

/** Runs the reads an agent would make, one per feature and app, and reports each. */
export async function checkFirebaseAccess(
  source: FirebaseObservabilitySource,
  binding: Pick<FirebaseBinding, 'projectId' | 'logs' | 'crashes' | 'apps' | 'database'>,
  now: Date,
  database?: { listCollections(projectId: string, databaseId: string): Promise<unknown> },
): Promise<FirebaseCheck[]> {
  const checks: FirebaseCheck[] = [];
  const run = async (check: FirebaseCheck['check'], target: string, read: () => Promise<unknown>) => {
    try {
      await read();
      checks.push({ check, target, ok: true });
    } catch (error) {
      if (error instanceof ObservabilityProviderError) {
        checks.push({
          check,
          target,
          ok: false,
          message: error.message,
          ...(error.missingRole ? { missingRole: error.missingRole } : {}),
          ...(error.fix ? { fix: error.fix } : {}),
        });
      } else if (error instanceof ObservabilityQueryError) {
        checks.push({ check, target, ok: false, message: error.message });
      } else {
        throw error;
      }
    }
  };
  const from = new Date(now.getTime() - 86_400_000);
  if (binding.logs) await run('logs', binding.projectId, () => source.queryLogs({ from, to: now, limit: 1 }));
  for (const app of readsCrashes(binding) ? binding.apps : []) {
    await run('crashes', app.appId, () => source.listCrashIssues({ appId: app.appId, from, to: now, limit: 1 }));
  }
  if (readsDatabase(binding) && database) {
    const id = binding.database?.databaseId || '(default)';
    await run('database', `${binding.projectId}/${id}`, () => database.listCollections(binding.projectId, id));
  }
  return checks;
}

/** The read MCP Toolbox's Firestore tools start with: list a database's top-level collections. */
export function firestoreReader(key: ServiceAccountKey, fetch?: FetchLike): { listCollections(projectId: string, databaseId: string): Promise<unknown> } {
  const tokens = new ServiceAccountTokens(key, fetch ? { fetch } : {});
  return {
    listCollections: (projectId, databaseId) =>
      new GoogleApiClient({ tokens, projectId, ...(fetch ? { fetch } : {}) }).request(
        FIRESTORE_API,
        `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:listCollectionIds`,
        { method: 'POST', body: { pageSize: 1 } },
      ),
  };
}

export function buildFirebaseRoutes(...args: Parameters<typeof buildFirebaseRoutesUndeclared>): ApiRoute[] {
  return declareAccess(buildFirebaseRoutesUndeclared(...args), ROUTE_ACCESS);
}

function buildFirebaseRoutesUndeclared(options: FirebaseRoutesOptions): ApiRoute[] {
  const { auth, storage, hooks } = options;
  const now = options.now ?? (() => new Date());

  const audit = async (
    c: Context,
    action: 'connected' | 'disconnected' | 'mapping_updated',
    metadata: Record<string, unknown>,
    factoryProjectId?: string,
  ) =>
    hooks?.emitAudit?.({
      context: c,
      input: {
        action: `factory.observability.${action}`,
        ...(factoryProjectId ? { factoryProjectId } : {}),
        targets: [{ type: 'integration', id: 'firebase', name: 'Firebase' }],
        metadata,
      },
    });

  const view = async (orgId: string) => stateView(await readFirebaseState(storage, orgId));
  return [
    registerApiRoute('/web/firebase/status', {
      method: 'GET',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        return c.json(await view(orgId));
      }),
    }),
    registerApiRoute('/web/firebase/accounts', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId, userId } = await caller(c, auth, true);
        const body = await readBody(c, addAccountSchema, 'invalid_body');
        const key = parseKey(body.serviceAccountJson);
        const account = await saveAccount(storage, orgId, userId, { name: body.name ?? key.project_id, key });
        await audit(c, 'connected', { accountId: account.id, name: account.name, clientEmail: account.clientEmail, projectId: account.projectId, keyId: account.keyId });
        return c.json({ account, ...(await view(orgId)) });
      }),
    }),
  ];
}

/** What each route that changes something needs (ADR-0045, `@factory/access`). */
const ROUTE_ACCESS: Readonly<Record<string, RouteAccess>> = {
  'POST /web/firebase/accounts': 'connections.manage',
};
