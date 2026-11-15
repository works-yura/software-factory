import { RequestContext } from '@mastra/core/request-context';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { OBSERVABILITY_CONTRACT_NOW, observabilityContractSeed } from '@factory/capabilities/observability-contract';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import type { TestAuthUser } from '@factory/http/testing';

import { FirebaseIntegration } from './integration.ts';
import { buildFirebaseRoutes } from './routes.ts';
import { buildConnectionRoutes } from '@factory/integrations';
import { describeConnectorContract } from '@factory/integrations/testing';
import { GoogleCloudConnections } from './connections.ts';
import { newBindingId, saveBinding } from './settings.ts';
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
  const auth = fakeRouteAuth({ isAdmin: async () => options.isAdmin ?? true });
  const projects = { get: async ({ orgId, id }: { orgId: string; id: string }) => (orgId === 'org-1' && FACTORIES.has(id) ? ({ id, name: id } as never) : null) };
  const hooks = {
    emitAudit: async ({ input }: { input: { action: string; metadata?: Record<string, unknown> } }) =>
      void audits.push({ action: input.action, ...(input.metadata ? { metadata: input.metadata } : {}) }),
    onManagedMcpServersChanged: async (orgId: string) => void managedSyncs.push(orgId),
  };
  mountApiRoutes(app, buildFirebaseRoutes({ auth, storage, projects, hooks: hooks as never, fetch: google.fetch, now: () => OBSERVABILITY_CONTRACT_NOW }));
  const facet = new GoogleCloudConnections({ storage, projects, hooks: hooks as never, fetch: google.fetch, now: () => OBSERVABILITY_CONTRACT_NOW });
  mountApiRoutes(app, buildConnectionRoutes({ auth, connectors: [{ id: 'google-cloud', connections: facet }], emitAudit: hooks.emitAudit as never }));
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  const json = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => (await call(method, path, body)).json() as Promise<T>;
  const addAccount = async (key = syncta(), name?: string) =>
    (await json<{ account: { id: string } }>('POST', '/web/firebase/accounts', { serviceAccountJson: JSON.stringify(key), ...(name ? { name } : {}) })).account.id;
  /** Connects through the facet for `factory`: a new key, or an account the organization has. */
  const connect = (input: Record<string, string>, method = 'key', factory = 'factory-1') =>
    call('POST', `/web/connections?factoryProjectId=${factory}`, { connector: 'google-cloud', method, input });
  const connected = async (input: Record<string, string>, method = 'key', factory = 'factory-1') =>
    ((await (await connect(input, method, factory)).json()) as any).connection.id.slice('google-cloud:'.length) as string;
  const path = (id: string, suffix = '', factory = 'factory-1') => `/web/connections/${encodeURIComponent(`google-cloud:${id}`)}${suffix}${suffix.includes('?') ? '&' : '?'}factoryProjectId=${factory}`;
  /** Writes a binding straight into storage, for tests about what bindings do rather than how they are made. */
  const bind = (accountId: string, overrides: Record<string, unknown> = {}) =>
    saveBinding(storage, 'org-1', { id: newBindingId(), ...binding(accountId), ...overrides } as never);
  return { storage, google, audits, call, json, addAccount, managedSyncs, connect, connected, path, bind };
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

  it('replaces an account\'s key and renames another without touching the rest', async () => {
    const { call, json, storage, connected, path } = setup();
    const first = await connected({ serviceAccountJson: JSON.stringify(syncta()) });
    const second = await connected({ serviceAccountJson: JSON.stringify(bookfate()), projectId: 'bookfate-prod' });
    const replaced = await call('POST', path(first, '/reconnect'), { input: { serviceAccountJson: JSON.stringify(fakeServiceAccountKey({ private_key_id: 'key-2' })) } });
    expect(replaced.status).toBe(200);
    expect((await call('PATCH', path(second, '/settings'), { section: 'account', values: { name: 'BookFate' } })).status).toBe(200);
    const state = await json<FirebaseStateView>('GET', '/web/firebase/status');
    expect(state.accounts.map(account => [account.name, account.keyId])).toEqual([
      ['syncta-prod', 'key-2'],
      ['BookFate', 'key-bf'],
    ]);
    const secondAccount = state.bindings.find(binding => binding.id === second)!.accountId;
    expect((storage.rows.connections.get('org-1')!.data as any).accounts[secondAccount].serviceAccount.client_email).toBe(
      'factory@bookfate-prod.iam.gserviceaccount.com',
    );
  });

  it('refuses a file that is not a service account key without repeating it, and a foreign token_uri', async () => {
    const { call, connect } = setup();
    const response = await call('POST', '/web/firebase/accounts', { serviceAccountJson: '{"type":"authorized_user","secret":"s3cr3t"}' });
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).toMatch(/not a service account key/);
    expect(text).not.toContain('s3cr3t');
    const evil = JSON.stringify(fakeServiceAccountKey({ token_uri: 'https://evil.example.com/token' }));
    expect((await call('POST', '/web/firebase/accounts', { serviceAccountJson: evil })).status).toBe(422);
    const refused = await connect({ serviceAccountJson: '{"type":"authorized_user","secret":"s3cr3t"}' });
    expect(refused.status).toBe(422);
    const body = await refused.text();
    expect(body).toMatch(/serviceAccountJson/);
    expect(body).not.toContain('s3cr3t');
  });

  it('deletes an account only after naming every binding that goes with it', async () => {
    const { call, json, connected, path, audits } = setup();
    const kept = await connected({ serviceAccountJson: JSON.stringify(bookfate()), projectId: 'bookfate-prod' }, 'key', 'factory-2');
    const first = await connected({ serviceAccountJson: JSON.stringify(syncta()) });
    const impact = await json('GET', path(first, '/impact'));
    expect(impact).toMatchObject({ items: [{ label: 'syncta-prod — Factory «factory-1»', outcome: 'deleted' }], requiresConfirm: true });
    const refused = await call('DELETE', path(first));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'account_in_use', impact: { items: [expect.objectContaining({ outcome: 'deleted' })] } });
    expect((await call('DELETE', path(first, '?confirm=1'))).status).toBe(200);
    const state = await json<FirebaseStateView>('GET', '/web/firebase/status');
    expect(state.bindings.map(binding => binding.id)).toEqual([kept]);
    expect(audits.at(-1)).toMatchObject({ action: 'factory.observability.disconnected' });
  });

  it('lets only an organization admin change accounts or bindings', async () => {
    const { call, connect } = setup({ isAdmin: false });
    expect((await call('POST', '/web/firebase/accounts', { serviceAccountJson: JSON.stringify(syncta()) })).status).toBe(403);
    expect((await connect({ serviceAccountJson: JSON.stringify(syncta()) })).status).toBe(403);
    expect((await call('GET', '/web/firebase/status')).status).toBe(200);
    expect((await call('GET', '/web/connections?factoryProjectId=factory-1')).status).toBe(200);
  });
});

describe('Google Cloud connections (ADR-0035)', () => {
  it('binds one Factory to several Google Cloud projects: a new key, then an account the organization has', async () => {
    const { json, connect, addAccount } = setup();
    const created = await connect({ name: 'Syncta', serviceAccountJson: JSON.stringify(syncta()) });
    expect(await created.json()).toMatchObject({
      type: 'connected',
      connection: { label: 'syncta-prod', scope: 'factory', accountLabel: 'Syncta', provides: [{ key: 'logs' }], state: { tone: 'ok' } },
      title: 'This Factory reads syncta-prod',
    });
    const bookfateAccount = await addAccount(bookfate());
    const methods = (await json('GET', '/web/connections/methods?factoryProjectId=factory-1')).connectors[0].methods;
    expect(methods[1]).toMatchObject({ id: 'account', available: true, fields: [expect.objectContaining({ type: 'select', options: expect.arrayContaining([expect.objectContaining({ value: bookfateAccount })]) }), expect.anything()] });
    expect((await connect({ accountId: bookfateAccount, projectId: 'bookfate-prod' }, 'account')).status).toBe(200);
    const listed = (await json('GET', '/web/connections?factoryProjectId=factory-1')).connections;
    expect(listed.map((row: any) => [row.label, row.accountLabel])).toEqual([
      ['syncta-prod', 'Syncta'],
      ['bookfate-prod', 'bookfate-prod'],
    ]);
    expect((await json('GET', '/web/connections?factoryProjectId=factory-2')).connections).toEqual([]);
  });

  it('refuses another org\'s Factory, an unknown account, a bad app id and a duplicate app', async () => {
    const { call, connect, connected, path } = setup();
    expect((await connect({ serviceAccountJson: JSON.stringify(syncta()) }, 'key', 'factory-x')).status).toBe(400);
    expect((await connect({ accountId: 'acc-missing' }, 'account')).status).toBe(422);
    const id = await connected({ serviceAccountJson: JSON.stringify(syncta()) });
    const bad = await call('PATCH', path(id, '/settings'), { section: 'binding', values: { apps: 'com.syncta' } });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ fields: { apps: expect.stringContaining('com.syncta') } });
    const app = '1:1234567890:android:abc123';
    expect((await call('PATCH', path(id, '/settings'), { section: 'binding', values: { apps: `${app}\n${app}` } })).status).toBe(422);
  });

  it('saves what a binding reads, unlinks it, and keeps when and by whom it was made through a rename', async () => {
    const { call, json, connected, path, audits, managedSyncs } = setup();
    const id = await connected({ serviceAccountJson: JSON.stringify(syncta()) });
    const saved = await call('PATCH', path(id, '/settings'), {
      section: 'binding',
      values: { logs: false, crashes: true, apps: '1:1234567890:android:abc123 Syncta Android' },
    });
    expect(await saved.json()).toEqual({ message: 'Saved' });
    let state = await json<FirebaseStateView>('GET', '/web/firebase/status');
    expect(state.bindings).toEqual([
      expect.objectContaining({ id, logs: false, crashes: true, apps: [{ appId: '1:1234567890:android:abc123', platform: 'android', label: 'Syncta Android' }], createdAt: expect.any(String), createdBy: 'u1' }),
    ]);
    const createdAt = state.bindings[0]!.createdAt;
    expect(await json('PATCH', path(id), { name: 'Syncta prod' })).toEqual({ name: 'Syncta prod' });
    state = await json<FirebaseStateView>('GET', '/web/firebase/status');
    expect(state.bindings[0]).toMatchObject({ name: 'Syncta prod', createdAt });
    expect((await call('POST', path(id, '/unlink'))).status).toBe(200);
    state = await json<FirebaseStateView>('GET', '/web/firebase/status');
    expect(state.bindings).toEqual([]);
    expect(state.accounts).toHaveLength(1);
    expect(audits.filter(audit => audit.action === 'factory.observability.mapping_updated')).toHaveLength(3);
    expect(managedSyncs).toHaveLength(3);
  });

  it('checks a binding read by read on its page, with its own account, and names the missing role', async () => {
    const { call, connected, path } = setup({
      google: { fail: { crashlytics: { status: 403, body: { error: { code: 403, message: 'The caller does not have permission' } } } } },
    });
    const id = await connected({ serviceAccountJson: JSON.stringify(syncta()) });
    await call('PATCH', path(id, '/settings'), { section: 'binding', values: { crashes: true, apps: '1:1234567890:android:abc123' } });
    const { sections } = (await (await call('GET', path(id, '/detail'))).json()) as any;
    expect(sections.filter((section: any) => section.type === 'notice')).toEqual([
      expect.objectContaining({ tone: 'error', title: 'Crashes · 1:1234567890:android:abc123', message: expect.stringContaining('roles/firebasecrashlytics.viewer') }),
    ]);
    expect(sections.find((section: any) => section.id === 'binding').fields.map((field: any) => field.name)).toEqual(['projectId', 'logs', 'crashes', 'apps', 'database', 'databaseId']);
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
    expect((await call('POST', '/web/connections?factoryProjectId=factory-1', { connector: 'google-cloud', method: 'account', input: { accountId: state.accounts[0]!.id } })).status).toBe(200);
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
    const { storage, bind, addAccount, google } = setup();
    const integration = new FirebaseIntegration({ fetch: google.fetch });
    integration.initialize({ storage: storage as never });

    expect(await integration.agentTools({ requestContext: sessionContext('factory-1') })).toEqual({});
    const synctaAccount = await addAccount(syncta());
    expect(await integration.agentTools({ requestContext: sessionContext('factory-1') })).toEqual({});

    await bind(synctaAccount);
    const tools = await integration.agentTools({ requestContext: sessionContext('factory-1') });
    expect(Object.keys(tools).sort()).toEqual([
      'observability_crash_issue',
      'observability_crash_issues',
      'observability_log_groups',
      'observability_query_logs',
    ]);
    expect(await integration.agentTools({ requestContext: sessionContext('factory-2') })).toEqual({});

    const result = await (tools.observability_query_logs as Runnable).execute({ limit: 3 }, {});
    expect(result.project).toBe('syncta-prod');
    const text = JSON.stringify(result);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('ya29.');
    expect(text).not.toContain('anna.koval@example.com');
  });

  it('asks which project when a Factory reads two, and reads each with its own account', async () => {
    const { storage, bind, addAccount, google } = setup();
    const integration = new FirebaseIntegration({ fetch: google.fetch });
    integration.initialize({ storage: storage as never });
    await bind(await addAccount(syncta()), { crashes: false, apps: [] });
    await bind(await addAccount(bookfate()), { projectId: 'bookfate-prod', crashes: false, apps: [] });

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
    const { call, connected, path, managedSyncs, storage, json } = setup();
    const id = await connected({ serviceAccountJson: JSON.stringify(syncta()) });
    await call('PATCH', path(id, '/settings'), { section: 'binding', values: { database: true, databaseId: 'analytics' } });
    await connected({ serviceAccountJson: JSON.stringify(bookfate()), projectId: 'other-prod' }, 'key', 'factory-2');
    expect(managedSyncs).toEqual(['org-1', 'org-1', 'org-1']);
    const accountId = (await json<FirebaseStateView>('GET', '/web/firebase/status')).bindings.find(binding => binding.id === id)!.accountId;

    const integration = new FirebaseIntegration();
    integration.initialize({ storage: storage as never });
    expect(await integration.managedMcpServers('org-1')).toEqual([
      {
        key: id,
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
    // Its page carries the database's own editor: the one custom section, keyed by the managed server.
    const { sections } = (await (await call('GET', path(id, '/detail'))).json()) as any;
    expect(sections.find((section: any) => section.type === 'custom')).toEqual(
      expect.objectContaining({ component: 'mcp-server', params: { owner: 'firebase', key: id } }),
    );

    await call('POST', path(id, '/unlink'));
    expect(managedSyncs).toHaveLength(4);
    expect(await integration.managedMcpServers('org-1')).toEqual([]);
  });

  it('checks «База» by listing the database\'s collections and names Cloud Datastore Viewer when refused', async () => {
    const run = async (setupOptions: Parameters<typeof setup>[0]) => {
      const t = setup(setupOptions);
      const id = await t.connected({ serviceAccountJson: JSON.stringify(syncta()) });
      await t.call('PATCH', t.path(id, '/settings'), { section: 'binding', values: { logs: false, database: true } });
      return ((await (await t.call('GET', t.path(id, '/detail'))).json()) as any).sections.filter((section: any) => section.type === 'notice');
    };
    expect(await run({})).toEqual([{ type: 'notice', tone: 'info', title: 'Access checked: everything turned on can be read.' }]);
    const refused = await run({ google: { fail: { firestore: { status: 403, body: { error: { code: 403, message: 'Missing or insufficient permissions.', status: 'PERMISSION_DENIED' } } } } } });
    expect(refused).toEqual([expect.objectContaining({ tone: 'error', title: 'Database · syncta-prod/(default)', message: expect.stringContaining('roles/datastore.viewer') })]);
  });
});

// The connector conformance kit (`@factory/integrations/testing`): a Factory's binding of a service account.
describeConnectorContract('Google Cloud', async () => {
  const storage = memoryIntegrationStorage();
  const google = fakeGoogle(observabilityContractSeed(), {});
  const projects = { get: async ({ orgId, id }: { orgId: string; id: string }) => (orgId === 'org-1' && FACTORIES.has(id) ? ({ id, name: id } as never) : null) };
  const hooks = { emitAudit: async () => {}, onManagedMcpServersChanged: async () => {} };
  const key = syncta();
  return {
    registration: { id: 'google-cloud', connections: new GoogleCloudConnections({ storage, projects, hooks: hooks as never, fetch: google.fetch, now: () => OBSERVABILITY_CONTRACT_NOW }) },
    orgId: 'org-1',
    admin: 'admin',
    member: 'member',
    factoryProjectId: 'factory-1',
    // The private key in any form must never come back.
    secrets: [key.private_key, 'PRIVATE KEY'],
    expectsConnections: true,
    seed: async ({ send }) => {
      const connected = await send('admin', 'POST', '/web/connections?factoryProjectId=factory-1', {
        connector: 'google-cloud',
        method: 'key',
        input: { serviceAccountJson: JSON.stringify(key) },
      });
      if (connected.status !== 200) throw new Error(`seed failed: ${JSON.stringify(connected.body)}`);
    },
    remove: true,
  };
});
