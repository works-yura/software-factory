/**
 * Firebase's HTTP surface under `/web/firebase`:
 * - accounts — the org's Google Cloud service accounts (a key uploaded once, never sent back);
 * - bindings — which Factory reads which Google Cloud project through which account;
 * - a check per binding that names the missing role or API.
 * Writes are an organization admin's call once auth is on.
 */

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { z } from 'zod';

import { ObservabilityProviderError, ObservabilityQueryError } from '@factory/capabilities';
import type { RouteAuth } from '@factory/http';
import type { IntegrationHooks } from '@factory/integrations';
import type { FactoryProjectsStorage, IntegrationStorageHandle } from '@factory/store';

import { listFirestoreDatabases, listGoogleCloudProjects } from './discovery.ts';
import { FIRESTORE_API, GoogleApiClient } from './google-api.ts';
import { ServiceAccountKeyError, ServiceAccountTokens, parseServiceAccountKey } from './service-account.ts';
import type { FetchLike, ServiceAccountKey } from './service-account.ts';
import {
  deleteAccount,
  deleteBinding,
  firebaseBindingInputSchema,
  newBindingId,
  readAccountKey,
  readFirebaseState,
  readsCrashes,
  readsDatabase,
  renameAccount,
  saveAccount,
  saveBinding,
} from './settings.ts';
import type { FirebaseAccount, FirebaseBinding, FirebaseBindingInput, FirebaseState } from './settings.ts';
import { FirebaseObservabilitySource } from './source.ts';

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
const updateAccountSchema = z
  .object({ name: accountNameSchema.optional(), serviceAccountJson: z.string().min(2).max(20_000).optional() })
  .refine(body => body.name !== undefined || body.serviceAccountJson !== undefined, 'Send a new name or a new key.');
const checkBodySchema = z.object({ binding: firebaseBindingInputSchema });
const idSchema = z.string().min(1).max(64);

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
  if (write && auth.enabled() && !(await auth.isOrganizationAdmin(c, tenant.orgId))) {
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

function param(c: Context, name: string): string {
  const parsed = idSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new Refusal(400, { error: `invalid_${name}` });
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

export function buildFirebaseRoutes(options: FirebaseRoutesOptions): ApiRoute[] {
  const { auth, storage, projects, hooks } = options;
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
  /** «База» bindings are MCP servers the factory manages: bring them in line after any change. */
  const syncManaged = async (orgId: string) => {
    await hooks?.onManagedMcpServersChanged?.(orgId);
  };

  /** A binding the org may save: its Factory is the org's, its account exists, its apps are unique. */
  const validBinding = async (orgId: string, input: FirebaseBindingInput) => {
    if (!(await projects.get({ orgId, id: input.factoryProjectId }))) throw new Refusal(404, { error: 'factory_not_found' });
    const state = await readFirebaseState(storage, orgId);
    if (!state.accounts.some(account => account.id === input.accountId)) {
      throw new Refusal(422, { error: 'account_not_found', message: 'Choose one of the Google Cloud accounts.' });
    }
    const appIds = input.apps.map(app => app.appId);
    if (new Set(appIds).size !== appIds.length) throw new Refusal(422, { error: 'invalid_binding', message: 'An app is listed twice.' });
    return state;
  };

  const bindingAudit = (binding: FirebaseBinding) => ({
    bindingId: binding.id,
    accountId: binding.accountId,
    projectId: binding.projectId,
    logs: binding.logs,
    crashes: binding.crashes,
    apps: binding.apps.map(app => app.appId),
    database: readsDatabase(binding),
  });

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
    // What the account can see, for the binding form's project and database choices. Read-only;
    // a refusal comes back as `denied` with what is still known (the key's project, `(default)`).
    registerApiRoute('/web/firebase/accounts/:accountId/projects', {
      method: 'GET',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        const key = await readAccountKey(storage, orgId, param(c, 'accountId'));
        if (!key) throw new Refusal(404, { error: 'account_not_found' });
        return c.json(await listGoogleCloudProjects(key, options.fetch ? { fetch: options.fetch } : {}));
      }),
    }),
    registerApiRoute('/web/firebase/accounts/:accountId/databases', {
      method: 'GET',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        const key = await readAccountKey(storage, orgId, param(c, 'accountId'));
        if (!key) throw new Refusal(404, { error: 'account_not_found' });
        const project = c.req.query('project')?.trim() || key.project_id;
        if (project.length > 128) throw new Refusal(400, { error: 'invalid_project' });
        return c.json(await listFirestoreDatabases(key, project, options.fetch ? { fetch: options.fetch } : {}));
      }),
    }),
    registerApiRoute('/web/firebase/accounts/:accountId', {
      method: 'PUT',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId, userId } = await caller(c, auth, true);
        const accountId = param(c, 'accountId');
        const body = await readBody(c, updateAccountSchema, 'invalid_body');
        const current = (await readFirebaseState(storage, orgId)).accounts.find(account => account.id === accountId);
        if (!current) throw new Refusal(404, { error: 'account_not_found' });
        const name = body.name ?? current.name;
        const account = body.serviceAccountJson
          ? await saveAccount(storage, orgId, userId, { accountId, name, key: parseKey(body.serviceAccountJson) })
          : await renameAccount(storage, orgId, accountId, name);
        if (!account) throw new Refusal(404, { error: 'account_not_found' });
        await audit(c, 'connected', {
          accountId,
          name,
          clientEmail: account.clientEmail,
          projectId: account.projectId,
          keyId: account.keyId,
          replacedKey: body.serviceAccountJson !== undefined,
        });
        return c.json({ account, ...(await view(orgId)) });
      }),
    }),
    registerApiRoute('/web/firebase/accounts/:accountId', {
      method: 'DELETE',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, true);
        const accountId = param(c, 'accountId');
        const state = await readFirebaseState(storage, orgId);
        const used = state.bindings.filter(binding => binding.accountId === accountId);
        // Bindings stop reading when their account goes: the person confirms that, it never happens by surprise.
        if (used.length > 0 && c.req.query('withBindings') !== 'true') {
          throw new Refusal(409, {
            error: 'account_in_use',
            message: 'Bindings read through this account; confirm to remove them with it.',
            bindings: used.map(binding => ({ id: binding.id, factoryProjectId: binding.factoryProjectId, projectId: binding.projectId })),
          });
        }
        const removed = await deleteAccount(storage, orgId, accountId);
        if (!removed) throw new Refusal(404, { error: 'account_not_found' });
        await audit(c, 'disconnected', { accountId, removedBindings: removed.removedBindings });
        await syncManaged(orgId);
        return c.json(await view(orgId));
      }),
    }),
    registerApiRoute('/web/firebase/bindings', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId, userId } = await caller(c, auth, true);
        const input = await readBody(c, firebaseBindingInputSchema, 'invalid_binding');
        await validBinding(orgId, input);
        const binding = await saveBinding(storage, orgId, {
          id: newBindingId(),
          ...input,
          createdAt: new Date().toISOString(),
          ...(userId ? { createdBy: userId } : {}),
        });
        await audit(c, 'mapping_updated', bindingAudit(binding), binding.factoryProjectId);
        await syncManaged(orgId);
        return c.json({ binding, ...(await view(orgId)) });
      }),
    }),
    registerApiRoute('/web/firebase/bindings/:bindingId', {
      method: 'PUT',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, true);
        const bindingId = param(c, 'bindingId');
        const input = await readBody(c, firebaseBindingInputSchema, 'invalid_binding');
        const state = await validBinding(orgId, input);
        const existing = state.bindings.find(binding => binding.id === bindingId);
        if (!existing) throw new Refusal(404, { error: 'binding_not_found' });
        // A change keeps when and by whom the binding was made.
        const binding = await saveBinding(storage, orgId, {
          id: bindingId,
          ...input,
          ...(existing.createdAt ? { createdAt: existing.createdAt } : {}),
          ...(existing.createdBy ? { createdBy: existing.createdBy } : {}),
        });
        await audit(c, 'mapping_updated', bindingAudit(binding), binding.factoryProjectId);
        await syncManaged(orgId);
        return c.json({ binding, ...(await view(orgId)) });
      }),
    }),
    registerApiRoute('/web/firebase/bindings/:bindingId', {
      method: 'DELETE',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, true);
        const bindingId = param(c, 'bindingId');
        const existing = (await readFirebaseState(storage, orgId)).bindings.find(binding => binding.id === bindingId);
        if (!existing || !(await deleteBinding(storage, orgId, bindingId))) throw new Refusal(404, { error: 'binding_not_found' });
        await audit(c, 'mapping_updated', { bindingId, removed: true, projectId: existing.projectId }, existing.factoryProjectId);
        await syncManaged(orgId);
        return c.json(await view(orgId));
      }),
    }),
    registerApiRoute('/web/firebase/bindings/check', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, true);
        const { binding } = await readBody(c, checkBodySchema, 'invalid_binding');
        await validBinding(orgId, binding);
        const key = await readAccountKey(storage, orgId, binding.accountId);
        if (!key) throw new Refusal(422, { error: 'account_not_found', message: 'Choose one of the Google Cloud accounts.' });
        const source = new FirebaseObservabilitySource({ key, binding, ...(options.fetch ? { fetch: options.fetch } : {}), now });
        const checks = await checkFirebaseAccess(source, binding, now(), firestoreReader(key, options.fetch));
        return c.json({ ok: checks.length > 0 && checks.every(check => check.ok), checks });
      }),
    }),
  ];
}
