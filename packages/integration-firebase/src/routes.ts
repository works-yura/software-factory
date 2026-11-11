/**
 * Firebase's HTTP surface under `/web/firebase`: the org's service account (uploaded, never sent
 * back), each Factory's project and apps, and a connection check that names what is missing.
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

import { ServiceAccountKeyError, parseServiceAccountKey } from './service-account.ts';
import type { FetchLike } from './service-account.ts';
import {
  firebaseFactoryMappingSchema,
  readConnectionSummary,
  readFactoryMapping,
  readFirebaseSettings,
  readServiceAccount,
  readsCrashes,
  saveFactoryMapping,
  saveServiceAccount,
} from './settings.ts';
import type { FirebaseFactoryMapping } from './settings.ts';
import { FirebaseObservabilitySource } from './source.ts';

export interface FirebaseRoutesOptions {
  auth: RouteAuth;
  storage: Pick<IntegrationStorageHandle, 'connections' | 'settings'>;
  projects: Pick<FactoryProjectsStorage, 'get'>;
  hooks?: IntegrationHooks;
  fetch?: FetchLike;
  now?: () => Date;
}

/** One line of the connection check. */
export interface FirebaseCheck {
  check: 'logs' | 'crashes';
  /** The project (logs) or app id (crashes) checked. */
  target: string;
  ok: boolean;
  message?: string;
  missingRole?: string;
  fix?: string;
}

const connectionBodySchema = z.object({ serviceAccountJson: z.string().min(2).max(20_000) });
const checkBodySchema = z.object({ mapping: firebaseFactoryMappingSchema.optional() });
const factoryIdSchema = z.string().min(1).max(128);

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
    throw new Refusal(403, { error: 'forbidden', message: 'Only organization admins can change the Firebase connection.' });
  }
  return { orgId: tenant.orgId, userId: tenant.userId ?? null };
}

async function factoryOf(c: Context, projects: FirebaseRoutesOptions['projects'], orgId: string): Promise<string> {
  const parsed = factoryIdSchema.safeParse(c.req.param('factoryProjectId'));
  if (!parsed.success) throw new Refusal(400, { error: 'invalid_factory' });
  const project = await projects.get({ orgId, id: parsed.data });
  if (!project) throw new Refusal(404, { error: 'factory_not_found' });
  return parsed.data;
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

/** Runs the reads an agent would make, one per feature and app, and reports each. */
export async function checkFirebaseAccess(source: FirebaseObservabilitySource, mapping: FirebaseFactoryMapping, now: Date): Promise<FirebaseCheck[]> {
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
  if (mapping.logs) await run('logs', mapping.projectId, () => source.queryLogs({ from, to: now, limit: 1 }));
  for (const app of readsCrashes(mapping) ? mapping.apps : []) {
    await run('crashes', app.appId, () => source.listCrashIssues({ appId: app.appId, from, to: now, limit: 1 }));
  }
  return checks;
}

export function buildFirebaseRoutes(options: FirebaseRoutesOptions): ApiRoute[] {
  const { auth, storage, projects, hooks } = options;
  const now = options.now ?? (() => new Date());

  const audit = async (c: Context, action: 'connected' | 'disconnected' | 'mapping_updated', factoryProjectId?: string, metadata?: Record<string, unknown>) =>
    hooks?.emitAudit?.({
      context: c,
      input: {
        action: `factory.observability.${action}`,
        ...(factoryProjectId ? { factoryProjectId } : {}),
        targets: [{ type: 'integration', id: 'firebase', name: 'Firebase' }],
        ...(metadata ? { metadata } : {}),
      },
    });

  const status = async (orgId: string) => {
    const account = await readConnectionSummary(storage, orgId);
    return { connected: account !== null, ...(account ? { account } : {}) };
  };

  return [
    registerApiRoute('/web/firebase/status', {
      method: 'GET',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        return c.json(await status(orgId));
      }),
    }),
    registerApiRoute('/web/firebase/connection', {
      method: 'PUT',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId, userId } = await caller(c, auth, true);
        const body = connectionBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) throw new Refusal(400, { error: 'invalid_body', message: 'Paste the service account key JSON.' });
        let key;
        try {
          key = parseServiceAccountKey(body.data.serviceAccountJson);
        } catch (error) {
          if (error instanceof ServiceAccountKeyError) throw new Refusal(422, { error: 'invalid_key', message: error.message });
          throw error;
        }
        const account = await saveServiceAccount(storage, orgId, userId, key);
        await audit(c, 'connected', undefined, { clientEmail: account.clientEmail, projectId: account.projectId, keyId: account.keyId });
        return c.json({ connected: true, account });
      }),
    }),
    registerApiRoute('/web/firebase/connection', {
      method: 'DELETE',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, true);
        await storage.connections.delete(orgId);
        await audit(c, 'disconnected');
        return c.json({ connected: false });
      }),
    }),
    registerApiRoute('/web/firebase/factories', {
      method: 'GET',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        return c.json({ mappings: (await readFirebaseSettings(storage, orgId)).factories });
      }),
    }),
    registerApiRoute('/web/firebase/factories/:factoryProjectId', {
      method: 'GET',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, false);
        const factoryProjectId = await factoryOf(c, projects, orgId);
        return c.json({ mapping: await readFactoryMapping(storage, orgId, factoryProjectId) });
      }),
    }),
    registerApiRoute('/web/firebase/factories/:factoryProjectId', {
      method: 'PUT',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, true);
        const factoryProjectId = await factoryOf(c, projects, orgId);
        const body = firebaseFactoryMappingSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) {
          throw new Refusal(422, { error: 'invalid_mapping', message: body.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
        }
        const appIds = body.data.apps.map(app => app.appId);
        if (new Set(appIds).size !== appIds.length) throw new Refusal(422, { error: 'invalid_mapping', message: 'An app is listed twice.' });
        await saveFactoryMapping(storage, orgId, factoryProjectId, body.data);
        await audit(c, 'mapping_updated', factoryProjectId, { projectId: body.data.projectId, logs: body.data.logs, apps: appIds });
        return c.json({ mapping: body.data });
      }),
    }),
    registerApiRoute('/web/firebase/factories/:factoryProjectId', {
      method: 'DELETE',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, true);
        const factoryProjectId = await factoryOf(c, projects, orgId);
        await saveFactoryMapping(storage, orgId, factoryProjectId, null);
        await audit(c, 'mapping_updated', factoryProjectId, { removed: true });
        return c.json({ mapping: null });
      }),
    }),
    registerApiRoute('/web/firebase/factories/:factoryProjectId/check', {
      method: 'POST',
      requiresAuth: false,
      handler: handle(async c => {
        const { orgId } = await caller(c, auth, true);
        const factoryProjectId = await factoryOf(c, projects, orgId);
        const body = checkBodySchema.safeParse(await c.req.json().catch(() => ({})));
        if (!body.success) throw new Refusal(422, { error: 'invalid_mapping', message: body.error.message });
        const mapping = body.data.mapping ?? (await readFactoryMapping(storage, orgId, factoryProjectId));
        if (!mapping) throw new Refusal(409, { error: 'not_mapped', message: 'Choose the Firebase project for this Factory first.' });
        const key = await readServiceAccount(storage, orgId);
        if (!key) throw new Refusal(409, { error: 'not_connected', message: 'Upload a service account key first.' });
        const source = new FirebaseObservabilitySource({
          key,
          mapping,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          now,
        });
        const checks = await checkFirebaseAccess(source, mapping, now());
        return c.json({ ok: checks.every(check => check.ok), checks });
      }),
    }),
  ];
}
