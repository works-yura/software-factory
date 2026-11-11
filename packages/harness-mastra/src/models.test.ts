import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelSelection } from '@factory/harness/models/contracts';
import type { HarnessModelContext } from '@factory/harness/models/facet';
import { createHarnessModelRegistry } from '@factory/harness/models/registry';

import { createMastraHarnessModels, type MastraHarnessModelsDependencies } from './models.ts';

const FACTORY = '7a4b3c2d-1e0f-4a5b-8c7d-6e5f4a3b2c1d';

/** A Mastra facet outside any session: a controller with an OpenAI key, and one Factory. */
function setup(options: { defaults?: Record<string, ModelSelection>; orgId?: string; withRunning?: boolean } = {}) {
  const project = { id: FACTORY, orgId: options.orgId ?? 'org-1', harnessModelDefaults: options.defaults ?? {} };
  const controller = {
    listAvailableModels: async () => [
      { id: 'openai/gpt-5.5', provider: 'openai', modelName: 'gpt-5.5', hasApiKey: true },
      { id: 'openai/gpt-4o-mini', provider: 'openai', modelName: 'gpt-4o-mini', hasApiKey: true },
    ],
    getSession: vi.fn(async () => undefined),
  };
  const deps = {
    messaging: async () => ({ controller }),
    sessions: { getBySessionId: async () => null },
    workItems: {},
    sessionModel: { projects: { getById: async ({ id }: { id: string }) => (id === FACTORY ? project : null), get: async () => null } },
    catalogDefaultModelId: () => 'openai/gpt-5.5',
    ...(options.withRunning
      ? { runningSessions: { workItems: { listRunBindings: async () => [], get: async () => null } } }
      : {}),
  } as unknown as MastraHarnessModelsDependencies;
  return { models: createMastraHarnessModels(deps), project };
}

const ctx: HarnessModelContext = { viewer: { userId: 'u1', orgId: 'org-1' }, factoryProjectId: FACTORY };

describe('Mastra model facet: Factory defaults', () => {
  // The server key that lets the catalog reach OpenAI's models.
  beforeEach(() => vi.stubEnv('OPENAI_API_KEY', 'sk-test'));
  afterEach(() => vi.unstubAllEnvs());

  it('starts a Factory on its own Mastra default, else the catalog default', async () => {
    const pinned = { instanceId: 'mastra', model: 'openai/gpt-4o-mini', options: [{ id: 'effort', value: 'low' }] };
    const { models } = setup({ defaults: { mastra: pinned, 'claude-code': { instanceId: 'claude-code', model: 'opus' } } });
    expect(await models.factoryDefault?.(ctx)).toEqual(pinned);
    expect(await models.defaultSelection(ctx)).toEqual(pinned);
    expect(await models.catalogDefault(ctx)).toEqual({ instanceId: 'mastra', model: 'openai/gpt-5.5' });

    const { models: plain } = setup();
    expect(await plain.factoryDefault?.(ctx)).toBeNull();
    expect(await plain.defaultSelection(ctx)).toEqual({ instanceId: 'mastra', model: 'openai/gpt-5.5' });
    // Another organization's Factory reads as none.
    expect(await setup({ defaults: { mastra: pinned }, orgId: 'org-2' }).models.factoryDefault?.(ctx)).toBeNull();
  });

  it("checks a Factory default against the catalog the organization's credentials reach", async () => {
    const { models } = setup();
    expect(await models.check({ model: 'openai/gpt-5.5' }, ctx)).toEqual({
      ok: true,
      selection: { instanceId: 'mastra', model: 'openai/gpt-5.5' },
    });
    const effort = await models.check({ model: 'openai/gpt-5.5', options: [{ id: 'effort', value: 'nonsense' }] }, ctx);
    expect(effort).toMatchObject({ ok: false, error: expect.stringMatching(/thinking level/) });
    expect(await models.check({ model: 'anthropic/claude-opus-4-6' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/No credential/),
    });
    expect(await models.check({ model: 'openai/gpt-5.5' }, { viewer: ctx.viewer })).toMatchObject({ ok: false });
  });

  it('moves running sessions onto a new default only when the host gave it the run bindings', async () => {
    expect(setup().models.applyDefaultToRunningSessions).toBeUndefined();
    const { models } = setup({ withRunning: true });
    expect(
      await models.applyDefaultToRunningSessions?.({ instanceId: 'mastra', model: 'openai/gpt-5.5' }, { ...ctx, factoryProjectId: FACTORY }),
    ).toEqual({ applied: [], skipped: [] });
    expect((await createHarnessModelRegistry([models]).describe(ctx))[0]).toMatchObject({
      instanceId: 'mastra',
      appliesToRunningSessions: true,
      catalogDefaultSelection: { model: 'openai/gpt-5.5' },
    });
  });
});
