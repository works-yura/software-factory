import { describe, expect, it } from 'vitest';

import type { HarnessModelContext } from './facet.ts';
import { withConnectionAvailability } from './facet.ts';
import { createHarnessModelRegistry } from './registry.ts';
import { codexStubModels } from './registry.testFixtures.ts';

const alice: HarnessModelContext = { viewer: { userId: 'alice', orgId: 'o1' } };
const bob: HarnessModelContext = { viewer: { userId: 'bob', orgId: 'o1' } };

describe('withConnectionAvailability', () => {
  it('lists a harness without a connection of the viewer as unavailable, with why and where to connect', async () => {
    const registry = createHarnessModelRegistry();
    registry.register(
      withConnectionAvailability(codexStubModels(new Set()), {
        connector: 'robo',
        missing: async ctx => (ctx.viewer.userId === 'alice' ? undefined : 'No Robo sign-in of yours.'),
      }),
    );
    const [forAlice] = await registry.describe(alice);
    expect(forAlice).toMatchObject({ available: true, connector: 'robo' });
    expect(forAlice!.models.length).toBeGreaterThan(0);

    const [forBob] = await registry.describe(bob);
    expect(forBob).toMatchObject({ available: false, needsSetup: true, reason: 'No Robo sign-in of yours.', connector: 'robo', models: [] });
  });

  it("keeps the facet's own refusal first, and its methods as they were", async () => {
    const inner = codexStubModels(new Set(['s1']));
    const wrapped = withConnectionAvailability(
      { ...inner, availability: async (_ctx: HarnessModelContext) => ({ available: false, reason: 'CLI missing' }) },
      { connector: 'robo', missing: async () => 'never asked' },
    );
    expect(await wrapped.availability!(alice)).toEqual({ available: false, reason: 'CLI missing' });
    expect(await wrapped.owns('s1')).toBe(true);
    expect(wrapped.instanceId).toBe(inner.instanceId);
  });
});
