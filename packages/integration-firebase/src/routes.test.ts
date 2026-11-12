import { RequestContext } from '@mastra/core/request-context';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { OBSERVABILITY_CONTRACT_NOW, observabilityContractSeed } from '@factory/capabilities/observability-contract';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import type { TestAuthUser } from '@factory/http/testing';

import { FirebaseIntegration } from './integration.ts';
import { buildFirebaseRoutes } from './routes.ts';
import type { FirebaseStateView } from './routes.ts';
import { fakeGoogle, fakeServiceAccountKey, memoryIntegrationStorage } from './testing.ts';

const admin: TestAuthUser = { id: 'u1', organizationId: 'org-1' };
const FACTORIES = new Set(['factory-1', 'factory-2']);

const syncta = () => fakeServiceAccountKey();
const bookfate = () =>
  fakeServiceAccountKey({
    project_id: 'bookfate-prod',
    private_key_id: 'key-bf',
    client_email: 'factory@bookfate-prod.iam.gserviceaccount.com',
  });

function setup(options: { user?: TestAuthUser | null; isAdmin?: boolean; google?: Parameters<typeof fakeGoogle>[1] } = {}) {
  const storage = memoryIntegrationStorage();
  const managedSyncs: string[] = [];
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
      projects: { get: async ({ orgId, id }) => (orgId === 'org-1' && FACTORIES.has(id) ? ({ id } as never) : null) },
      hooks: {
        emitAudit: async ({ input }) => void audits.push({ action: input.action, ...(input.metadata ? { metadata: input.metadata } : {}) }),
        onManagedMcpServersChanged: async orgId => void managedSyncs.push(orgId),
      },
      fetch: google.fetch,
      now: () => OBSERVABILITY_CONTRACT_NOW,
    }),
  );
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  const json = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => (await call(method, path, body)).json() as Promise<T>;
  const addAccount = async (key = syncta(), name?: string) =>
    (await json<{ account: { id: string } }>('POST', '/web/firebase/accounts', { serviceAccountJson: JSON.stringify(key), ...(name ? { name } : {}) })).account.id;
  return { storage, google, audits, call, json, addAccount, managedSyncs };
}

const binding = (accountId: string, overrides: Record<string, unknown> = {}) => ({
  factoryProjectId: 'factory-1',
  accountId,
  projectId: 'syncta-prod',
  projectNumber: '1234567890',
  logs: true,
  crashes: true,
  apps: [{ appId: '1:1234567890:android:abc123', platform: 'android' as const, label: 'Syncta Android' }],
  ...overrides,
});

describe('Firebase accounts', () => {
  it('adds several accounts, answers with their summaries only, and keeps every key encrypted in one row', async () => {
    const { call, json, storage, audits, addAccount } = setup();
    const first = await addAccount(syncta(), 'Syncta');
    const second = await addAccount(bookfate());
    expect(first).not.toBe(second);
    const response = await call('GET', '/web/firebase/status');
    const text = await response.text();
    expect(text).not.toContain('PRIVATE KEY');
    const state = JSON.parse(text) as FirebaseStateView;
    expect(state.accounts).toEqual([
      { id: first, name: 'Syncta', clientEmail: 'factory-reader@syncta-prod.iam.gserviceaccount.com', projectId: 'syncta-prod', keyId: 'key-1', bindingIds: [] },
      // No name given: the key's own project.
      { id: second, name: 'bookfate-prod', clientEmail: 'factory@bookfate-prod.iam.gserviceaccount.com', projectId: 'bookfate-prod', keyId: 'key-bf', bindingIds: [] },
    ]);
    const row = storage.rows.connections.get('org-1')!;
    expect(Object.keys((row.data as any).accounts)).toEqual([first, second]);
    expect((row.data as any).accounts[first].serviceAccount.private_key).toContain('PRIVATE KEY');
    expect(JSON.stringify(row.metadata)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(audits)).not.toContain('PRIVATE KEY');
    expect(audits.map(audit => audit.action)).toEqual(['factory.observability.connected', 'factory.observability.connected']);
    expect(await json('GET', '/web/firebase/status')).toEqual(state);
  });

  it('replaces one account\'s key and renames another without touching the rest', async () => {
    const { json, storage, addAccount } = setup();
    const first = await addAccount(syncta());
    const second = await addAccount(bookfate());
    await json('PUT', `/web/firebase/accounts/${first}`, { serviceAccountJson: JSON.stringify(fakeServiceAccountKey({ private_key_id: 'key-2' })) });
    const renamed = await json<FirebaseStateView>('PUT', `/web/firebase/accounts/${second}`, { name: 'BookFate' });
    expect(renamed.accounts.map(account => [account.name, account.keyId])).toEqual([
      ['syncta-prod', 'key-2'],
      ['BookFate', 'key-bf'],
    ]);
    expect((storage.rows.connections.get('org-1')!.data as any).accounts[second].serviceAccount.client_email).toBe(
      'factory@bookfate-prod.iam.gserviceaccount.com',
    );
  });

  it('refuses a file that is not a service account key without repeating it, and a foreign token_uri', async () => {
    const { call } = setup();
    const response = await call('POST', '/web/firebase/accounts', { serviceAccountJson: '{"type":"authorized_user","secret":"s3cr3t"}' });
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).toMatch(/not a service account key/);
    expect(text).not.toContain('s3cr3t');
    const evil = JSON.stringify(fakeServiceAccountKey({ token_uri: 'https://evil.example.com/token' }));
    expect((await call('POST', '/web/firebase/accounts', { serviceAccountJson: evil })).status).toBe(422);
  });

  it('will not remove an account its bindings read through unless asked to remove them too', async () => {
    const { call, json, addAccount, audits } = setup();
    const accountId = await addAccount();
    const other = await addAccount(bookfate());
    const { binding: kept } = await json('POST', '/web/firebase/bindings', binding(other, { projectId: 'bookfate-prod', factoryProjectId: 'factory-2' }));
    await json('POST', '/web/firebase/bindings', binding(accountId));

    const refused = await call('DELETE', `/web/firebase/accounts/${accountId}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'account_in_use', bindings: [{ factoryProjectId: 'factory-1', projectId: 'syncta-prod' }] });

    const state = await json<FirebaseStateView>('DELETE', `/web/firebase/accounts/${accountId}?withBindings=true`);
    expect(state.accounts.map(account => account.id)).toEqual([other]);
    expect(state.bindings.map(binding => binding.id)).toEqual([kept.id]);
    expect(audits.at(-1)).toMatchObject({ action: 'factory.observability.disconnected' });
  });

  it('lets only an organization admin change accounts or bindings', async () => {
    const { call } = setup({ isAdmin: false });
    expect((await call('POST', '/web/firebase/accounts', { serviceAccountJson: JSON.stringify(syncta()) })).status).toBe(403);
    expect((await call('POST', '/web/firebase/bindings', binding('acc-x'))).status).toBe(403);
    expect((await call('GET', '/web/firebase/status')).status).toBe(200);
  });
});

describe('Firebase bindings', () => {
  it('binds one Factory to several Google Cloud projects through different accounts', async () => {
    const { json, addAccount } = setup();
    const synctaAccount = await addAccount(syncta());
    const bookfateAccount = await addAccount(bookfate());
    await json('POST', '/web/firebase/bindings', binding(synctaAccount, { crashes: false, apps: [] }));
    const state = await json<FirebaseStateView>(
      'POST',
      '/web/firebase/bindings',
      binding(bookfateAccount, { projectId: 'bookfate-prod', projectNumber: '900351719125', logs: false }),
    );
    expect(state.bindings.map(saved => [saved.factoryProjectId, saved.accountId, saved.projectId])).toEqual([
      ['factory-1', synctaAccount, 'syncta-prod'],
      ['factory-1', bookfateAccount, 'bookfate-prod'],
    ]);
    expect(state.accounts.map(account => account.bindingIds.length)).toEqual([1, 1]);
  });

  it('refuses another org\'s Factory, an unknown account, a bad app id and a duplicate app', async () => {
    const { call, addAccount } = setup();
    const accountId = await addAccount();
    expect((await call('POST', '/web/firebase/bindings', binding(accountId, { factoryProjectId: 'factory-x' }))).status).toBe(404);
    expect((await call('POST', '/web/firebase/bindings', binding('acc-missing'))).status).toBe(422);
    const bad = await call('POST', '/web/firebase/bindings', binding(accountId, { apps: [{ appId: 'com.syncta', platform: 'android' }] }));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { message: string }).message).toMatch(/apps\.0\.appId/);
    const app = binding(accountId).apps[0]!;
    expect((await call('POST', '/web/firebase/bindings', binding(accountId, { apps: [app, app] }))).status).toBe(422);
  });

  it('updates and removes a binding by id', async () => {
    const { call, json, addAccount, audits } = setup();
    const accountId = await addAccount();
    const { binding: saved } = await json('POST', '/web/firebase/bindings', binding(accountId));
    const updated = await json<FirebaseStateView>('PUT', `/web/firebase/bindings/${saved.id}`, binding(accountId, { logs: false }));
    expect(updated.bindings).toEqual([expect.objectContaining({ id: saved.id, logs: false })]);
    expect((await call('PUT', '/web/firebase/bindings/bnd-missing', binding(accountId))).status).toBe(404);
    expect((await json<FirebaseStateView>('DELETE', `/web/firebase/bindings/${saved.id}`)).bindings).toEqual([]);
    expect((await call('DELETE', `/web/firebase/bindings/${saved.id}`)).status).toBe(404);
    expect(audits.filter(audit => audit.action === 'factory.observability.mapping_updated')).toHaveLength(3);
  });

  it('records when and by whom a binding was made, keeps it through a rename', async () => {
    const { json, addAccount } = setup();
    const accountId = await addAccount();
    const { binding: saved } = await json('POST', '/web/firebase/bindings', binding(accountId));
    expect(saved).toMatchObject({ createdAt: expect.any(String), createdBy: expect.any(String) });
    const renamed = await json<FirebaseStateView>('PUT', `/web/firebase/bindings/${saved.id}`, binding(accountId, { name: 'Syncta prod' }));
    expect(renamed.bindings).toEqual([expect.objectContaining({ name: 'Syncta prod', createdAt: saved.createdAt, createdBy: saved.createdBy })]);
  });

  it('checks a binding read by read, with its own account, and names the missing role', async () => {
    const { call, json, addAccount } = setup({
      google: { fail: { crashlytics: { status: 403, body: { error: { code: 403, message: 'The caller does not have permission' } } } } },
    });
    const accountId = await addAccount();
    const draft = binding(accountId);
    const response = await call('POST', '/web/firebase/bindings/check', { binding: draft });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      checks: [
        { check: 'logs', target: 'syncta-prod', ok: true },
        expect.objectContaining({ check: 'crashes', target: draft.apps[0]!.appId, ok: false, missingRole: 'roles/firebasecrashlytics.viewer' }),
      ],
    });
    expect(await json('POST', '/web/firebase/bindings/check', { binding: { ...draft, crashes: false } })).toEqual({
      ok: true,
      checks: [{ check: 'logs', target: 'syncta-prod', ok: true }],
    });
    expect((await call('POST', '/web/firebase/bindings/check', { binding: binding('acc-missing') })).status).toBe(422);
  });
});

describe('Firebase upgrade from one key per organization', () => {
  it('turns the first version\'s key into the first account and each Factory mapping into a binding, once', async () => {
    const { json, storage } = setup();
    const key = syncta();
    await storage.connections.upsert('org-1', {
      data: { serviceAccount: key },
      metadata: { clientEmail: key.client_email, projectId: key.project_id, keyId: key.private_key_id },
    });
    await storage.settings.save('org-1', '__org__', {
      factories: {
        'factory-1': { projectId: 'syncta-prod', projectNumber: '1234567890', logs: true, apps: [] },
        'factory-2': { projectId: 'bookfate-prod', logs: false, crashes: false, apps: [] },
      },
    });

    const first = await json<FirebaseStateView>('GET', '/web/firebase/status');
    expect(first.accounts).toEqual([
      expect.objectContaining({ name: 'syncta-prod', clientEmail: key.client_email, keyId: 'key-1', bindingIds: ['bnd-factory-1', 'bnd-factory-2'] }),
    ]);
    const accountId = first.accounts[0]!.id;
    expect(first.bindings).toEqual([
      { id: 'bnd-factory-1', factoryProjectId: 'factory-1', accountId, projectId: 'syncta-prod', projectNumber: '1234567890', logs: true, crashes: true, apps: [] },
      { id: 'bnd-factory-2', factoryProjectId: 'factory-2', accountId, projectId: 'bookfate-prod', logs: false, crashes: false, apps: [] },
    ]);
    // The key itself moved, no re-upload.
    expect((storage.rows.connections.get('org-1')!.data as any).accounts[accountId].serviceAccount.private_key).toBe(key.private_key);

    expect(await json('GET', '/web/firebase/status')).toEqual(first);
  });

  it('upgrades a key with no mappings (connected, nothing bound yet)', async () => {
    const { json, storage, call } = setup();
    const key = syncta();
    await storage.connections.upsert('org-1', { data: { serviceAccount: key }, metadata: {} });
    const state = await json<FirebaseStateView>('GET', '/web/firebase/status');
    expect(state.accounts).toHaveLength(1);
    expect(state.bindings).toEqual([]);
    // The upgraded account is usable straight away.
    expect((await call('POST', '/web/firebase/bindings', binding(state.accounts[0]!.id))).status).toBe(200);
  });
});

describe('FirebaseIntegration agent tools', () => {
  function sessionContext(factoryProjectId: string) {
    const requestContext = new RequestContext();
    requestContext.set('user', { id: 'u1', organizationId: 'org-1' });
    requestContext.set('controller', { sessionId: 's', resourceId: 's', threadId: 't', getState: () => ({ factoryProjectId }) });
    return requestContext;
  }

  type Runnable = { execute: (input: unknown, ctx: unknown) => Promise<any> };

  it('offers the tools only to a bound Factory, one per binding, and the output carries no key or token', async () => {
    const { storage, json, addAccount, google } = setup();
    const integration = new FirebaseIntegration({ fetch: google.fetch });
    integration.initialize({ storage: storage as never });

    expect(await integration.agentTools({ requestContext: sessionContext('factory-1') })).toEqual({});
    const synctaAccount = await addAccount(syncta());
    expect(await integration.agentTools({ requestContext: sessionContext('factory-1') })).toEqual({});

    await json('POST', '/web/firebase/bindings', binding(synctaAccount));
    const tools = await integration.agentTools({ requestContext: sessionContext('factory-1') });
    expect(Object.keys(tools).sort()).toEqual(['observability_crash_issue', 'observability_crash_issues', 'observability_query_logs']);
    expect(await integration.agentTools({ requestContext: sessionContext('factory-2') })).toEqual({});

    const result = await (tools.observability_query_logs as Runnable).execute({ limit: 3 }, {});
    expect(result.project).toBe('syncta-prod');
    const text = JSON.stringify(result);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('ya29.');
    expect(text).not.toContain('anna.koval@example.com');
  });

  it('asks which project when a Factory reads two, and reads each with its own account', async () => {
    const { storage, json, addAccount, google } = setup();
    const integration = new FirebaseIntegration({ fetch: google.fetch });
    integration.initialize({ storage: storage as never });
    await json('POST', '/web/firebase/bindings', binding(await addAccount(syncta()), { crashes: false, apps: [] }));
    await json('POST', '/web/firebase/bindings', binding(await addAccount(bookfate()), { projectId: 'bookfate-prod', crashes: false, apps: [] }));

    const tools = await integration.agentTools({ requestContext: sessionContext('factory-1') });
    const logs = tools.observability_query_logs as Runnable;
    const window = { limit: 1 };
    expect((await logs.execute(window, {})).error).toMatch(/several projects/);
    expect((await logs.execute({ ...window, project: 'bookfate-prod' }, {})).project).toBe('bookfate-prod');
    const read = google.calls.filter(call => call.url.includes('entries:list')).at(-1);
    expect(read?.body).toMatchObject({ resourceNames: ['projects/bookfate-prod'] });
  });
});

describe('Google Cloud «База»', () => {
  it('asks for the managed MCP servers to be synced after each binding or account change, and serves one Toolbox server per «База» binding', async () => {
    const { json, call, addAccount, managedSyncs, storage } = setup();
    const accountId = await addAccount();
    const created = await json<{ binding: { id: string } }>(
      'POST',
      '/web/firebase/bindings',
      binding(accountId, { database: { enabled: true, databaseId: 'analytics' } }),
    );
    await json('POST', '/web/firebase/bindings', binding(accountId, { factoryProjectId: 'factory-2', projectId: 'other-prod' }));
    expect(managedSyncs).toEqual(['org-1', 'org-1']);

    const integration = new FirebaseIntegration();
    integration.initialize({ storage: storage as never });
    expect(await integration.managedMcpServers('org-1')).toEqual([
      {
        key: created.binding.id,
        name: 'db-syncta-prod',
        label: 'Firestore syncta-prod · analytics',
        launch: {
          transport: 'catalog',
          entry: 'mcp-toolbox',
          variant: 'firestore',
          inputs: { FIRESTORE_PROJECT: 'syncta-prod', FIRESTORE_DATABASE: 'analytics' },
          credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: accountId } },
        },
        assignments: [{ factoryProjectId: 'factory-1' }],
      },
    ]);

    await call('DELETE', `/web/firebase/bindings/${created.binding.id}`);
    expect(managedSyncs).toHaveLength(3);
    expect(await integration.managedMcpServers('org-1')).toEqual([]);
  });

  it('checks «База» by listing the database\'s collections and names Cloud Datastore Viewer when refused', async () => {
    const ok = setup();
    const okAccount = await ok.addAccount();
    const passed = await ok.json<{ ok: boolean; checks: Array<{ check: string; ok: boolean; target: string }> }>('POST', '/web/firebase/bindings/check', {
      binding: binding(okAccount, { logs: false, crashes: false, database: { enabled: true } }),
    });
    expect(passed).toEqual({ ok: true, checks: [{ check: 'database', target: 'syncta-prod/(default)', ok: true }] });

    const refused = setup({ google: { fail: { firestore: { status: 403, body: { error: { code: 403, message: 'Missing or insufficient permissions.', status: 'PERMISSION_DENIED' } } } } } });
    const refusedAccount = await refused.addAccount();
    const failed = await refused.json<{ ok: boolean; checks: Array<{ check: string; ok: boolean; missingRole?: string }> }>('POST', '/web/firebase/bindings/check', {
      binding: binding(refusedAccount, { logs: false, crashes: false, database: { enabled: true } }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.checks[0]).toMatchObject({ check: 'database', ok: false, missingRole: 'roles/datastore.viewer' });
  });
});
