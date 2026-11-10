import { RequestContext } from '@mastra/core/request-context';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { OBSERVABILITY_CONTRACT_NOW, observabilityContractSeed } from '@factory/capabilities/observability-contract';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import type { TestAuthUser } from '@factory/http/testing';

import { FirebaseIntegration } from './integration.ts';
import { buildFirebaseRoutes } from './routes.ts';
import { fakeGoogle, fakeServiceAccountKey, memoryIntegrationStorage } from './testing.ts';

const admin: TestAuthUser = { id: 'u1', organizationId: 'org-1' };
const mapping = {
  projectId: 'syncta-prod',
  projectNumber: '1234567890',
  logs: true,
  apps: [{ appId: '1:1234567890:android:abc123', platform: 'android' as const, label: 'Syncta Android' }],
};

function setup(options: { user?: TestAuthUser | null; isAdmin?: boolean; google?: Parameters<typeof fakeGoogle>[1] } = {}) {
  const storage = memoryIntegrationStorage();
  const google = fakeGoogle(observabilityContractSeed(), options.google ?? {});
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    const user = options.user === undefined ? admin : options.user;
    if (user) c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  mountApiRoutes(
    app,
    buildFirebaseRoutes({
      auth: fakeRouteAuth({ isOrganizationAdmin: async () => options.isAdmin ?? true }),
      storage,
      projects: { get: async ({ orgId, id }) => (orgId === 'org-1' && id === 'factory-1' ? ({ id } as never) : null) },
      hooks: { emitAudit: async ({ input }) => void audits.push({ action: input.action, ...(input.metadata ? { metadata: input.metadata } : {}) }) },
      fetch: google.fetch,
      now: () => OBSERVABILITY_CONTRACT_NOW,
    }),
  );
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return { storage, google, audits, call };
}

const keyJson = () => JSON.stringify(fakeServiceAccountKey());

describe('Firebase routes', () => {
  it('stores the uploaded key and answers with its summary only, never the key', async () => {
    const { call, storage, audits } = setup();
    const saved = await call('PUT', '/web/firebase/connection', { serviceAccountJson: keyJson() });
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain('PRIVATE KEY');
    expect(JSON.parse(text)).toEqual({
      connected: true,
      account: { clientEmail: 'factory-reader@syncta-prod.iam.gserviceaccount.com', projectId: 'syncta-prod', keyId: 'key-1' },
    });
    expect((storage.rows.connections.get('org-1')?.data as any).serviceAccount.private_key).toContain('PRIVATE KEY');
    expect(JSON.stringify(storage.rows.connections.get('org-1')?.metadata)).not.toContain('PRIVATE KEY');
    const status = await (await call('GET', '/web/firebase/status')).text();
    expect(status).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(audits)).not.toContain('PRIVATE KEY');
    expect(audits[0]?.action).toBe('factory.observability.connected');
  });

  it('refuses a file that is not a service account key without repeating it', async () => {
    const { call } = setup();
    const response = await call('PUT', '/web/firebase/connection', { serviceAccountJson: '{"type":"authorized_user","secret":"s3cr3t"}' });
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).toMatch(/not a service account key/);
    expect(text).not.toContain('s3cr3t');
  });

  it('refuses a key whose token_uri is not Google\'s', async () => {
    const { call } = setup();
    const evil = JSON.stringify(fakeServiceAccountKey({ token_uri: 'https://evil.example.com/token' }));
    const response = await call('PUT', '/web/firebase/connection', { serviceAccountJson: evil });
    expect(response.status).toBe(422);
  });

  it('lets only an organization admin change the connection or a mapping', async () => {
    const { call } = setup({ isAdmin: false });
    expect((await call('PUT', '/web/firebase/connection', { serviceAccountJson: keyJson() })).status).toBe(403);
    expect((await call('PUT', '/web/firebase/factories/factory-1', mapping)).status).toBe(403);
    expect((await call('GET', '/web/firebase/status')).status).toBe(200);
  });

  it('saves a Factory mapping, refuses another org\'s Factory and a bad app id', async () => {
    const { call } = setup();
    expect((await call('PUT', '/web/firebase/factories/factory-1', mapping)).status).toBe(200);
    expect(await (await call('GET', '/web/firebase/factories/factory-1')).json()).toEqual({ mapping });
    expect((await call('PUT', '/web/firebase/factories/factory-2', mapping)).status).toBe(404);
    const bad = await call('PUT', '/web/firebase/factories/factory-1', { ...mapping, apps: [{ appId: 'com.syncta', platform: 'android' }] });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { message: string }).message).toMatch(/apps\.0\.appId/);
  });

  it('checks the connection, read by read, and names the missing role', async () => {
    const { call } = setup({
      google: { fail: { crashlytics: { status: 403, body: { error: { code: 403, message: 'The caller does not have permission' } } } } },
    });
    expect((await call('POST', '/web/firebase/factories/factory-1/check', { mapping })).status).toBe(409);
    await call('PUT', '/web/firebase/connection', { serviceAccountJson: keyJson() });
    const response = await call('POST', '/web/firebase/factories/factory-1/check', { mapping });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      checks: [
        { check: 'logs', target: 'syncta-prod', ok: true },
        expect.objectContaining({ check: 'crashes', target: mapping.apps[0]!.appId, ok: false, missingRole: 'roles/firebasecrashlytics.viewer' }),
      ],
    });
  });
});

describe('FirebaseIntegration agent tools', () => {
  function sessionContext(factoryProjectId: string) {
    const requestContext = new RequestContext();
    requestContext.set('user', { id: 'u1', organizationId: 'org-1' });
    requestContext.set('controller', { sessionId: 's', resourceId: 's', threadId: 't', getState: () => ({ factoryProjectId }) });
    return requestContext;
  }

  it('offers the tools only to a mapped Factory of a connected org, and the output carries no key or token', async () => {
    const storage = memoryIntegrationStorage();
    const google = fakeGoogle(observabilityContractSeed());
    const integration = new FirebaseIntegration({ fetch: google.fetch });
    integration.initialize({ storage: storage as never });

    expect(await integration.agentTools({ requestContext: sessionContext('factory-1') })).toEqual({});
    await storage.settings.save('org-1', '__org__', { factories: { 'factory-1': mapping } });
    expect(await integration.agentTools({ requestContext: sessionContext('factory-1') })).toEqual({});

    await storage.connections.upsert('org-1', { data: { serviceAccount: fakeServiceAccountKey() }, metadata: {} });
    const tools = await integration.agentTools({ requestContext: sessionContext('factory-1') });
    expect(Object.keys(tools).sort()).toEqual(['observability_crash_issue', 'observability_crash_issues', 'observability_query_logs']);
    expect(await integration.agentTools({ requestContext: sessionContext('factory-other') })).toEqual({});

    const result = await (tools.observability_query_logs as { execute: (input: unknown, ctx: unknown) => Promise<unknown> }).execute(
      { from: '2026-11-11T00:00:00Z', to: '2026-11-11T11:00:00Z', limit: 3 },
      {},
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('ya29.');
    expect(text).not.toContain('anna.koval@example.com');
  });
});
