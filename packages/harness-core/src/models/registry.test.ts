import { describe, expect, it } from 'vitest';

import type { ServerProviderModel } from './contracts.ts';
import type { HarnessModelContext, HarnessModels } from './facet.ts';
import { createHarnessModelRegistry } from './registry.ts';
import { codexStubModels } from './registry.testFixtures.ts';
import { checkModelSelection, EFFORT_OPTION_ID } from './selection.ts';

const ctx: HarnessModelContext = { viewer: { userId: 'u1', orgId: 'o1' } };

function fallbackModels(): HarnessModels {
  const models: ServerProviderModel[] = [
    { slug: 'anthropic/claude-opus-4-6', name: 'Opus', isCustom: false, capabilities: null },
  ];
  return {
    instanceId: 'default',
    harnessId: 'default',
    displayName: 'Default',
    owns: async () => true,
    list: async () => models,
    defaultSelection: async () => null,
    check: async request => checkModelSelection('default', models, request),
    getSelection: async () => null,
    setSelection: async (_sessionId, selection) => ({ ok: true, modelSelection: selection, appliesFrom: 'now' }),
  };
}

describe('HarnessModelRegistry', () => {
  it('lists a registered harness beside the default one, which goes last', async () => {
    const registry = createHarnessModelRegistry();
    registry.register(fallbackModels(), { fallback: true });
    registry.register(codexStubModels(new Set(['s-codex'])));
    const instances = await registry.describe(ctx);
    expect(instances.map(instance => instance.instanceId)).toEqual(['default', 'codex-stub']);
    expect(instances[1]).toMatchObject({
      harnessId: 'codex',
      displayName: 'Codex',
      available: true,
      defaultModel: 'gpt-5.3-codex',
      models: [{ slug: 'gpt-5.3-codex' }, { slug: 'gpt-5-mini' }],
    });
    expect((await registry.forSession('s-codex'))?.instanceId).toBe('codex-stub');
    expect((await registry.forSession('anything-else'))?.instanceId).toBe('default');
  });

  it('checks and sets a pick on the harness that runs the session', async () => {
    const codex = codexStubModels(new Set(['s-codex']));
    const registry = createHarnessModelRegistry([codex]);
    registry.register(fallbackModels(), { fallback: true });
    const switched = await registry.switchSessionModel(
      's-codex',
      { model: 'gpt-5.3-codex', options: [{ id: 'reasoningEffort', value: 'high' }, { id: 'fastMode', value: true }] },
      ctx,
    );
    const selection = {
      instanceId: 'codex-stub',
      model: 'gpt-5.3-codex',
      options: [
        { id: 'reasoningEffort', value: 'high' },
        { id: 'fastMode', value: true },
      ],
    };
    expect(switched).toEqual({ ok: true, modelSelection: selection, appliesFrom: 'next-turn' });
    expect(await codex.getSelection('s-codex', ctx)).toEqual(selection);

    expect(
      await registry.switchSessionModel('s-codex', { model: 'gpt-5-mini', options: [{ id: EFFORT_OPTION_ID, value: 'high' }] }, ctx),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/gpt-5-mini has no option effort/) });
    expect(await registry.switchSessionModel('s-codex', { model: 'o3' }, ctx)).toMatchObject({ ok: false, status: 400 });
    expect(await registry.switchSessionModel('s-codex', { model: null }, ctx)).toMatchObject({ ok: true, modelSelection: null });
  });

  it('refuses a pick from another harness instance: that is a handoff', async () => {
    const registry = createHarnessModelRegistry([codexStubModels(new Set(['s-codex']))]);
    registry.register(fallbackModels(), { fallback: true });
    expect(
      await registry.switchSessionModel('s-codex', { model: 'anthropic/claude-opus-4-6', instanceId: 'default' }, ctx),
    ).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/handoff/) });
  });

  it('lists an instance whose catalog fails as unavailable, and refuses duplicate instances', async () => {
    const registry = createHarnessModelRegistry([
      { ...codexStubModels(new Set()), list: async () => Promise.reject(new Error('codex is not installed')) },
    ]);
    expect(await registry.describe(ctx)).toMatchObject([{ instanceId: 'codex-stub', available: false, reason: 'codex is not installed' }]);
    expect(() => registry.register(codexStubModels(new Set()))).toThrow(/already registered/);
    expect(await registry.switchSessionModel('nobody', { model: 'x' }, ctx)).toMatchObject({ ok: false, status: 404 });
  });
});
