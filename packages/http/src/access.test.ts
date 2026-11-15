import { registerApiRoute } from '@mastra/core/server';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { declareAccess, enforceRouteAccess, route, routeAccess, undeclaredWrites, withAccess } from './access.ts';
import { fakeRouteAuth, mountApiRoutes } from './testing.ts';

const ok = async (c: { json: (body: unknown) => Response }) => c.json({ ok: true });

function app(role: 'viewer' | 'member' | 'admin', options: { enabled?: boolean } = {}) {
  const routes = enforceRouteAccess(
    [
      route('/web/cards', { method: 'POST', access: 'card.write', handler: ok as never }),
      route('/web/org', { method: 'PATCH', access: 'org.manage', handler: ok as never }),
      route('/web/hook', { method: 'POST', access: 'public', requiresAuth: false, handler: ok as never }),
      registerApiRoute('/web/cards', { method: 'GET', handler: ok as never }),
      registerApiRoute('/web/forgotten', { method: 'DELETE', handler: ok as never }),
    ],
    fakeRouteAuth({ enabled: options.enabled ?? true, role: async () => role }),
  );
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, { id: 'u1', organizationId: 'org1' } as never);
    await next();
  });
  mountApiRoutes(hono, routes);
  return hono;
}

describe('route access', () => {
  it('lets a role through to what it may do, and answers 403 forbidden naming the permission otherwise', async () => {
    expect((await app('member').request('/web/cards', { method: 'POST' })).status).toBe(200);
    const refused = await app('viewer').request('/web/cards', { method: 'POST' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'forbidden', permission: 'card.write' });
    expect((await app('member').request('/web/org', { method: 'PATCH' })).status).toBe(403);
    expect((await app('admin').request('/web/org', { method: 'PATCH' })).status).toBe(200);
  });

  it('passes reads and public routes without a role check', async () => {
    expect((await app('viewer').request('/web/cards')).status).toBe(200);
    expect((await app('viewer').request('/web/hook', { method: 'POST' })).status).toBe(200);
  });

  it('refuses a write that declares nothing, for everyone, and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app('admin').request('/web/forgotten', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'permission_undeclared' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('DELETE /web/forgotten declares no permission'));
    error.mockRestore();
  });

  it('checks no role with sign-in off: one local operator', async () => {
    expect((await app('viewer', { enabled: false }).request('/web/org', { method: 'PATCH' })).status).toBe(200);
  });

  it('lists the writes that declare nothing', () => {
    const routes = [
      withAccess('card.write', registerApiRoute('/a', { method: 'POST', handler: ok as never })),
      registerApiRoute('/b', { method: 'PUT', handler: ok as never }),
      registerApiRoute('/c', { method: 'GET', handler: ok as never }),
    ];
    expect(undeclaredWrites(routes)).toEqual(['PUT /b']);
  });

  it('stamps routes from a module table and refuses an unknown permission', () => {
    const [declared] = declareAccess([registerApiRoute('/x', { method: 'POST', handler: ok as never })], { 'POST /x': 'run.start' });
    expect(routeAccess(declared!)).toBe('run.start');
    expect(() => withAccess('do.anything' as never, registerApiRoute('/y', { method: 'POST', handler: ok as never }))).toThrow(/Unknown permission/);
  });
});
