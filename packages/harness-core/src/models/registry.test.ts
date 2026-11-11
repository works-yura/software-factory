import { describe, expect, it } from 'vitest';

import type { ModelSelection, ServerProviderModel } from './contracts.ts';
import { parseHarnessModelDefaults, resolveModelDefault, withHarnessModelDefault } from './defaults.ts';
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
    catalogDefault: async () => null,
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

  it('hands a pick from another harness instance to the harness switch where one accepts it', async () => {
    const owned = new Set(['s-codex']);
    const registry = createHarnessModelRegistry([codexStubModels(owned)]);
    registry.register(fallbackModels(), { fallback: true });
    const calls: Array<{ sessionId: string; from: string; to: string; model: string | null }> = [];
    registry.setHarnessSwitch({
      accepts: to => to === 'default',
      async switchHarness({ sessionId, from, to, request }) {
        calls.push({ sessionId, from: from.instanceId, to: to.instanceId, model: request.model });
        owned.delete(sessionId);
        return {
          ok: true,
          modelSelection: { instanceId: to.instanceId, model: request.model ?? 'x' },
          appliesFrom: 'next-turn',
          handoff: { id: 'h1', fromInstanceId: from.instanceId, toInstanceId: to.instanceId, harnessId: to.harnessId },
        };
      },
    });
    expect(
      await registry.switchSessionModel('s-codex', { model: 'anthropic/claude-opus-4-6', instanceId: 'default' }, ctx),
    ).toMatchObject({ ok: true, handoff: { fromInstanceId: 'codex-stub', toInstanceId: 'default' } });
    expect(calls).toEqual([{ sessionId: 's-codex', from: 'codex-stub', to: 'default', model: 'anthropic/claude-opus-4-6' }]);
    expect((await registry.forSession('s-codex'))?.instanceId).toBe('default');
    // An instance the switch does not accept still needs a new chat.
    expect(
      await registry.switchSessionModel('elsewhere', { model: 'gpt-5-mini', instanceId: 'codex-stub' }, ctx),
    ).toMatchObject({ ok: false, status: 409 });
    expect((await registry.describe(ctx)).map(info => [info.instanceId, info.acceptsHandoff])).toEqual([
      ['default', true],
      ['codex-stub', false],
    ]);
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

describe('Factory model defaults', () => {
  it('a facet falls back from the session pick to the Factory default to the catalog default', async () => {
    const factoryDefaults = { current: {} as Record<string, ModelSelection> };
    const codex = codexStubModels(new Set(['s-codex']), factoryDefaults);
    const registry = createHarnessModelRegistry([codex]);
    const factoryCtx = { ...ctx, factoryProjectId: 'f1' };

    expect(await registry.describe(factoryCtx)).toMatchObject([
      {
        instanceId: 'codex-stub',
        defaultSelection: { model: 'gpt-5.3-codex' },
        factoryDefaultSelection: null,
        catalogDefaultSelection: { model: 'gpt-5.3-codex' },
        appliesToRunningSessions: false,
      },
    ]);

    const pinned = { instanceId: 'codex-stub', model: 'gpt-5-mini' };
    factoryDefaults.current = withHarnessModelDefault(factoryDefaults.current, 'codex-stub', pinned);
    expect(await codex.defaultSelection(factoryCtx)).toEqual(pinned);
    expect((await registry.describe(factoryCtx))[0]).toMatchObject({ defaultModel: 'gpt-5-mini', factoryDefaultSelection: pinned });

    await registry.switchSessionModel('s-codex', { model: 'gpt-5.3-codex', options: [{ id: 'fastMode', value: true }] }, ctx);
    expect(await codex.defaultSelection({ ...ctx, sessionId: 's-codex' })).toMatchObject({ model: 'gpt-5.3-codex' });

    factoryDefaults.current = withHarnessModelDefault(factoryDefaults.current, 'codex-stub', null);
    expect(await codex.defaultSelection(factoryCtx)).toEqual({ instanceId: 'codex-stub', model: 'gpt-5.3-codex' });
  });

  it('reads stored defaults leniently: bad entries and mismatched instances are dropped', () => {
    expect(
      parseHarnessModelDefaults({
        mastra: { instanceId: 'mastra', model: 'openai/gpt-5.5', options: { effort: 'high' } },
        'claude-code': { provider: 'claude-code', model: 'opus' },
        codex: { instanceId: 'other', model: 'x' },
        broken: { instanceId: 'broken' },
      }),
    ).toEqual({
      mastra: { instanceId: 'mastra', model: 'openai/gpt-5.5', options: [{ id: 'effort', value: 'high' }] },
      'claude-code': { instanceId: 'claude-code', model: 'opus' },
    });
    expect(parseHarnessModelDefaults(null)).toEqual({});
    expect(parseHarnessModelDefaults(['x'])).toEqual({});
    expect(resolveModelDefault({ catalog: null })).toBeNull();
  });
});
