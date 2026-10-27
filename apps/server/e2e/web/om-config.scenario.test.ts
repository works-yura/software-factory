import { LibSQLFactoryStorage } from '@mastra/libsql';
import { MemorySettingsStorage } from '@factory/store/memory-settings/base';
import { ConfigRoutes } from '@factory/api/config';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RouteAuth } from '@factory/http/route';

/**
 * The web settings panel owns observational memory through the real
 * `/web/config/om` routes, which persist to the app database rather than to
 * mutable session state. These tests mount the real route module on a Hono app
 * backed by a real libsql `memory_settings` table and drive it over HTTP, so the
 * web surface's contract — persisted intent (`model: 'auto'` or a concrete id),
 * the effective concrete model it resolves to, and provider status — is
 * asserted end to end.
 */

/** Auth-disabled host: a Factory's memory settings live under the `local` sentinel org. */
const localAuth: RouteAuth = {
  enabled: () => false,
  ensureUser: async () => undefined,
  tenant: () => undefined,
  isOrganizationAdmin: async () => true,
};

/** A catalog whose only mode carries a provider that has a built-in low-cost OM pack. */
const FACTORY_ID = 'factory-1';
const FACTORY_ROW = { orgId: 'local', userId: `factory-project:${FACTORY_ID}` };

const controller = {
  listAvailableModels: async () => [{ provider: 'anthropic', hasApiKey: true }],
  listModes: () => [{ id: 'build', defaultModelId: 'anthropic/claude-opus-5' }],
};

describe('web OM config routes', () => {
  let storage: LibSQLFactoryStorage;
  let memorySettings: MemorySettingsStorage;
  let app: Hono;

  beforeEach(async () => {
    storage = new LibSQLFactoryStorage({ id: 'web-om-test', url: ':memory:' });
    memorySettings = storage.registerDomain(new MemorySettingsStorage());
    await storage.init();

    app = new Hono();
    for (const route of new ConfigRoutes({ auth: localAuth, controller, memorySettings }).routes()) {
      if ('handler' in route && route.handler) app.on(route.method, route.path, route.handler as never);
    }
  });

  afterEach(async () => {
    await storage.close();
  });

  // Memory settings belong to a Factory, so every request names one.
  const put = (path: string, body: Record<string, unknown>) =>
    app.request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, factoryId: FACTORY_ID }),
    });
  const read = () => app.request(`/web/config/om?factoryId=${FACTORY_ID}`);

  it('reports an empty row as auto intent with a resolved effective model', async () => {
    // There are no personal memory settings: a request that names no Factory is refused.
    expect((await app.request('/web/config/om')).status).toBe(400);
    const res = await read();
    expect(res.status).toBe(200);
    const { config } = await res.json();

    // Intent stays `auto`; the effective model follows the factory default's
    // provider through the shared low-cost OM pack.
    expect(config.observer).toMatchObject({ model: 'auto', effectiveModelId: 'anthropic/claude-haiku-4-5' });
    expect(config.reflector).toMatchObject({ model: 'auto', effectiveModelId: 'anthropic/claude-haiku-4-5' });
    // Deprecated flat aliases mirror the effective model, never the intent.
    expect(config.observerModelId).toBe('anthropic/claude-haiku-4-5');
    expect(config.observationThreshold).toBe(30_000);
    expect(config.observeAttachments).toBe('auto');
  });

  it('persists a concrete model to one role without touching the other', async () => {
    const putRes = await put('/web/config/om/observer/model', { modelId: 'anthropic/claude-fable-5' });
    expect(putRes.status).toBe(200);
    const { config } = await putRes.json();
    expect(config.observer).toMatchObject({
      model: 'anthropic/claude-fable-5',
      effectiveModelId: 'anthropic/claude-fable-5',
    });

    const stored = await memorySettings.get(FACTORY_ROW);
    expect(stored).toMatchObject({ observerModelId: 'anthropic/claude-fable-5', reflectorModelId: null });

    const reread = await (await read()).json();
    expect(reread.config.reflector).toMatchObject({ model: 'auto' });
  });

  it('round-trips a role back to auto as a null column', async () => {
    await put('/web/config/om/observer/model', { modelId: 'anthropic/claude-fable-5' });
    const autoRes = await put('/web/config/om/observer/model', { modelId: 'auto' });
    expect(autoRes.status).toBe(200);
    expect((await autoRes.json()).config.observer).toMatchObject({ model: 'auto' });

    const stored = await memorySettings.get(FACTORY_ROW);
    expect(stored?.observerModelId).toBeNull();
  });
});
