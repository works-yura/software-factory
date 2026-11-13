import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { SandboxView, SleepOutcome } from '@factory/sandbox';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import { SandboxRoutes } from './sandboxes.ts';

const PROJECT = '11111111-2222-4333-8444-555555555555';
const user = { id: 'u1', organizationId: 'org1' };

function app(options: { admin?: boolean; views?: SandboxView[]; outcome?: SleepOutcome } = {}) {
  const sleep = vi.fn(async (): Promise<SleepOutcome> => options.outcome ?? { outcome: 'slept' });
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  mountApiRoutes(
    hono as never,
    new SandboxRoutes({
      auth: fakeRouteAuth({ isOrganizationAdmin: async () => options.admin ?? true }),
      projects: { get: async ({ id }: { id: string }) => (id === PROJECT ? ({ id } as never) : null) },
      sleeper: { list: async () => options.views ?? [], sleep },
    }).routes(),
  );
  return { hono, sleep };
}

const idle: SandboxView = {
  key: 'work-items/f/card-1',
  kind: 'card',
  orgId: 'org1',
  factoryProjectId: PROJECT,
  sessionIds: ['s-1'],
  repos: ['api'],
  sizeBytes: 1024,
  lastActivityAt: '2030-01-01T00:00:00.000Z',
  state: 'idle',
  problems: [],
};

describe('sandbox routes', () => {
  it('lists the Factory’s sandboxes for an admin, without owner ids', async () => {
    const { hono } = app({ views: [idle] });
    const response = await hono.request(`/web/factory/projects/${PROJECT}/sandboxes`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { sandboxes: Array<Record<string, unknown>>; canManage: boolean };
    expect(body.canManage).toBe(true);
    expect(body.sandboxes).toEqual([{ ...idle, orgId: undefined, factoryProjectId: undefined }].map(({ orgId: _o, factoryProjectId: _f, ...view }) => view));
  });

  it('is for organization admins only', async () => {
    const { hono, sleep } = app({ admin: false, views: [idle] });
    expect((await hono.request(`/web/factory/projects/${PROJECT}/sandboxes`)).status).toBe(403);
    const post = await hono.request(`/web/factory/projects/${PROJECT}/sandboxes/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: idle.key }),
    });
    expect(post.status).toBe(403);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('puts an idle sandbox of this Factory to sleep, refuses an active one, and knows no other', async () => {
    const post = (hono: Hono, key: string) =>
      hono.request(`/web/factory/projects/${PROJECT}/sandboxes/sleep`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
    const ok = app({ views: [idle] });
    expect(await (await post(ok.hono, idle.key)).json()).toEqual({ outcome: 'slept' });
    expect(ok.sleep).toHaveBeenCalledWith(idle.key, 'manual');
    expect((await post(ok.hono, 'work-items/other/card')).status).toBe(404);
    expect((await post(app({ views: [idle], outcome: { outcome: 'active' } }).hono, idle.key)).status).toBe(409);
    const failed = await post(app({ views: [idle], outcome: { outcome: 'failed', message: 'no credentials' } }).hono, idle.key);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: 'save_failed', message: 'no credentials' });
    expect((await post(app({ views: [{ ...idle, state: 'asleep' }] }).hono, idle.key)).status).toBe(404);
  });
});
