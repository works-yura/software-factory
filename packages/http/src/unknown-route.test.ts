import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute } from '@mastra/core/server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';

import { buildUnknownServerRoutes } from './unknown-route.ts';

/** The app the Mastra deployer builds: custom routes in their order, then its HTML catch-all for every GET. */
function deployerApp(routes: ApiRoute[]): Hono {
  const app = new Hono();
  for (const route of routes) {
    if (!('handler' in route) || !route.handler) continue;
    // @mastra/core types the handler with its bundled hono's Context; the runtime one is this app's.
    const handler = route.handler as unknown as (c: Context) => Response | Promise<Response>;
    if (route.method === 'ALL') app.all(route.path, handler);
    else app.on([route.method], [route.path], handler);
  }
  app.get('*', c => c.newResponse('<!doctype html><title>Mastra Server</title>', 200, { 'Content-Type': 'text/html' }));
  return app;
}

const realRoutes = [
  registerApiRoute('/web/connections', { method: 'GET', handler: c => c.json({ connections: [] }) }),
  registerApiRoute('/web/connections/:id', { method: 'DELETE', handler: c => c.json({ removed: c.req.param('id') }) }),
  registerApiRoute('/auth/me', { method: 'GET', requiresAuth: false, handler: c => c.json({ authenticated: false }) }),
];

describe('buildUnknownServerRoutes', () => {
  const app = deployerApp([...realRoutes, ...buildUnknownServerRoutes()]);

  it('answers a removed /web route with a JSON 404, not the HTML welcome page', async () => {
    // A page from before a deploy asking for accounts at their old path.
    const res = await app.request('/web/config/providers/claude-code/accounts', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ error: 'not_found', message: expect.stringContaining('/web/config/providers/claude-code/accounts') });
  });

  it('answers every method and the /auth prefix the same way', async () => {
    for (const [method, path] of [
      ['POST', '/web/config/providers/claude-code/accounts/sign-in'],
      ['PATCH', '/web/connections'],
      ['GET', '/auth/nothing-here'],
    ] as const) {
      const res = await app.request(path, { method });
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(await res.json()).toMatchObject({ error: 'not_found' });
    }
  });

  it('leaves every real route answering first, parameters included', async () => {
    expect(await (await app.request('/web/connections')).json()).toEqual({ connections: [] });
    expect(await (await app.request('/web/connections/abc', { method: 'DELETE' })).json()).toEqual({ removed: 'abc' });
    expect(await (await app.request('/auth/me')).json()).toEqual({ authenticated: false });
  });

  it('leaves paths outside the server prefixes to the deployer (the UI and its own pages)', async () => {
    const res = await app.request('/settings/integrations');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
