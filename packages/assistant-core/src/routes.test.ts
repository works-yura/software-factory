import { can } from '@factory/access';
import { enforceRouteAccess, routeAccess, undeclaredWrites } from '@factory/http';
import type { RouteAuth } from '@factory/http';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { FactoryAccess } from './factory-access.ts';
import { ASSISTANT_ROUTE_ACCESS, buildAssistantRoutes } from './routes.ts';
import { AssistantService } from './service.ts';
import { AssistantStorage } from './storage.ts';
import { FakeBrain, FakeFactory, FakeMemory, fakeModels, MemoryBlobStore, testCipher } from './testing.ts';

/**
 * The routes on a Hono app behind the real access gate, with a test auth that reads the caller from
 * headers (`x-user`, `x-org`, `x-role`).
 */
const auth: RouteAuth = {
  enabled: () => true,
  ensureUser: async () => undefined,
  tenant: (c: Context) => {
    const userId = c.req.header('x-user');
    return userId ? { userId, orgId: c.req.header('x-org') ?? 'org-a', role: c.req.header('x-role') ?? 'member' } : undefined;
  },
  can: async (c: Context, permission) => can(c.req.header('x-role') ?? 'member', permission),
};

let app: Hono;
let pending: Array<Promise<void>>;
let factory: FakeFactory;

const as = (userId: string, orgId = 'org-a', role = 'member') => ({ 'x-user': userId, 'x-org': orgId, 'x-role': role });

function call(path: string, init: RequestInit & { who?: Record<string, string> } = {}) {
  const { who, ...rest } = init;
  return app.request(`http://localhost${path}`, { ...rest, headers: { ...(who ?? {}), ...((rest.headers as Record<string, string>) ?? {}) } });
}

function json(path: string, method: string, body: unknown, who: Record<string, string>) {
  return call(path, { method, who, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function settle() {
  while (pending.length) await pending.shift();
}

beforeEach(async () => {
  const backend = new LibSQLFactoryStorage({ id: 'assistant-routes', url: ':memory:' });
  const storage = backend.registerDomain(new AssistantStorage());
  await backend.init();
  pending = [];
  factory = new FakeFactory();
  const service = new AssistantService({
    storage,
    blobs: new MemoryBlobStore(),
    brain: new FakeBrain(),
    memory: new FakeMemory(),
    models: fakeModels,
    factory,
    grant: factory,
    audit: async () => undefined,
    blobReferencedElsewhere: async () => false,
    schedule: task => {
      pending.push(task());
    },
  });
  const access = new FactoryAccess({
    storage,
    cipher: testCipher,
    publicOrigin: 'http://localhost',
    authServer: async () => new Response(JSON.stringify({ client_id: 'client-1' }), { status: 201 }),
  });
  app = new Hono();
  for (const route of enforceRouteAccess(buildAssistantRoutes({ auth, service, access, models: fakeModels }), auth)) {
    app.on([route.method], route.path, c => (route as unknown as { handler: (c: Context) => Promise<Response> }).handler(c));
  }
});

describe('/web/assistant routes', () => {
  it('declare self.write on every write', () => {
    const routes = buildAssistantRoutes({ auth, service: {} as never, access: {} as never, models: fakeModels });
    expect(undeclaredWrites(routes)).toEqual([]);
    for (const route of routes) {
      const declared = routeAccess(route);
      if (declared !== undefined) expect(declared).toBe('self.write');
    }
    expect(Object.values(ASSISTANT_ROUTE_ACCESS).every(access => access === 'self.write')).toBe(true);
  });

  it('serve the caller’s own requests; another person’s are 404', async () => {
    const form = new FormData();
    form.set('text', 'Checkout fails');
    form.set('fromName', 'Olena');
    form.append('files', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], 'shot.png', { type: 'image/png' }));
    const created = await call('/web/assistant/requests', { method: 'POST', who: as('ada'), body: form });
    expect(created.status).toBe(201);
    const { request } = (await created.json()) as { request: { id: string; status: string } };
    expect(request.status).toBe('new');
    await settle();

    const opened = await call(`/web/assistant/requests/${request.id}`, { who: as('ada') });
    const view = (await opened.json()) as { request: { status: string }; messages: unknown[]; files: Array<{ contentUrl: string }> };
    expect(view.request.status).toBe('waiting_me');
    expect(view.messages).toHaveLength(2);
    const content = await call(view.files[0]!.contentUrl, { who: as('ada') });
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');

    for (const stranger of [as('bob'), as('ada', 'org-b')]) {
      expect((await call(`/web/assistant/requests/${request.id}`, { who: stranger })).status).toBe(404);
      expect((await call(view.files[0]!.contentUrl, { who: stranger })).status).toBe(404);
      expect((await json(`/web/assistant/requests/${request.id}/close`, 'POST', {}, stranger)).status).toBe(404);
      expect((await json(`/web/assistant/requests/${request.id}/messages`, 'POST', { text: 'x' }, stranger)).status).toBe(404);
      const list = (await (await call('/web/assistant/requests', { who: stranger })).json()) as { requests: unknown[] };
      expect(list.requests).toEqual([]);
    }
  });

  it('let a viewer use their own assistant (self.write), and refuse a caller without it', async () => {
    expect((await json('/web/assistant/requests', 'POST', { text: 'hi' }, as('vera', 'org-a', 'viewer'))).status).toBe(201);
    expect((await json('/web/assistant/requests', 'POST', { text: 'hi' }, as('x', 'org-a', 'stranger'))).status).toBe(403);
    expect((await json('/web/assistant/requests', 'POST', { text: 'hi' }, {})).status).toBe(401);
  });

  it('keep notes and settings per person', async () => {
    const note = await json('/web/assistant/notes', 'POST', { text: 'call Olena' }, as('ada'));
    const { note: created } = (await note.json()) as { note: { id: string } };
    expect((await json(`/web/assistant/notes/${created.id}`, 'PATCH', { text: 'x' }, as('bob'))).status).toBe(404);
    expect((await call(`/web/assistant/notes/${created.id}`, { method: 'DELETE', who: as('bob') })).status).toBe(404);

    expect((await json('/web/assistant/settings', 'PUT', { retentionDays: 7 }, as('ada'))).status).toBe(200);
    const bob = (await (await call('/web/assistant/settings', { who: as('bob') })).json()) as { settings: { retentionDays: number } };
    expect(bob.settings.retentionDays).toBe(30);
    expect((await json('/web/assistant/settings', 'PUT', { retentionDays: 9999 }, as('ada'))).status).toBe(400);
  });

  it('erase only the caller’s assistant', async () => {
    await json('/web/assistant/requests', 'POST', { text: 'a' }, as('ada'));
    await json('/web/assistant/requests', 'POST', { text: 'b' }, as('bob'));
    await settle();
    const cleared = await json('/web/assistant/clear', 'POST', {}, as('ada'));
    expect(await cleared.json()).toEqual({ cleared: { requests: 1, files: 0 } });
    const bobs = (await (await call('/web/assistant/requests', { who: as('bob') })).json()) as { requests: unknown[] };
    expect(bobs.requests).toHaveLength(1);
    expect(factory.revoked).toEqual(['org-a:ada']);
  });

  it('start the Factory consent with a same-origin return path only', async () => {
    const started = await json('/web/assistant/factory-access/start', 'POST', { returnTo: '/factories/f/settings/account' }, as('ada'));
    const { url } = (await started.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.pathname).toBe('/auth/api/oauth2/authorize');
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://localhost/web/assistant/factory-access/callback');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toContain('offline_access');

    const callback = await call(`/web/assistant/factory-access/callback?code=c&state=wrong`, { who: as('ada') });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/?assistantAccess=failed');
  });
});
