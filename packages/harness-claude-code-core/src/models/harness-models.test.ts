import { describe, expect, it } from 'vitest';

import { createHarnessModelRegistry } from '@factory/harness/models/registry';

import { CLAUDE_CODE_INSTANCE_ID } from './claude-code.ts';
import { createClaudeCodeHarnessModels } from './harness-models.ts';

function fakeSession() {
  const settings = new Map<string, unknown>();
  return {
    settings,
    thread: {
      getSetting: async ({ key }: { key: string }) => settings.get(key),
      setSetting: async ({ key, value }: { key: string; value: unknown }) => {
        settings.set(key, value);
      },
    },
  };
}

const ctx = { viewer: { userId: 'u', orgId: 'o' } };

describe('createClaudeCodeHarnessModels', () => {
  it('checks, sets and compiles a session pick through the registry', async () => {
    const session = fakeSession();
    const models = createClaudeCodeHarnessModels({
      owns: async id => id === 's1',
      getSession: async id => (id === 's1' ? session : undefined),
      defaults: async () => ({ instanceId: CLAUDE_CODE_INSTANCE_ID, model: 'sonnet', options: [{ id: 'effort', value: 'low' }] }),
      settingKeys: { selection: 'sel', lastSelection: 'last' },
    });
    const registry = createHarnessModelRegistry([models]);

    // Nothing picked: the Factory's Claude Code default.
    expect(await models.getSelection('s1', ctx)).toEqual({
      instanceId: CLAUDE_CODE_INSTANCE_ID,
      model: 'sonnet',
      options: [{ id: 'effort', value: 'low' }],
    });
    expect(await models.turnSelection(session)).toMatchObject({ model: 'sonnet', effort: 'low' });

    const switched = await registry.switchSessionModel('s1', { model: 'opus', thinkingLevel: 'high' }, ctx);
    expect(switched).toEqual({
      ok: true,
      appliesFrom: 'next-turn',
      modelSelection: { instanceId: CLAUDE_CODE_INSTANCE_ID, model: 'opus', options: [{ id: 'effort', value: 'high' }] },
    });
    const turn = await models.turnSelection(session);
    expect(turn).toMatchObject({ model: 'opus', effort: 'high', modelSwitch: { from: { model: 'sonnet' }, to: { model: 'opus' } } });
    // The next turn on the same pick marks no switch.
    expect((await models.turnSelection(session)).modelSwitch).toBeUndefined();

    expect(await registry.switchSessionModel('s1', { model: 'opus', thinkingLevel: 'bogus' }, ctx)).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringMatching(/Unknown thinking level/),
    });
    expect(await registry.switchSessionModel('s1', { model: 'gpt-5' }, ctx)).toMatchObject({ ok: false, status: 400 });
    expect(await registry.switchSessionModel('s1', { model: null }, ctx)).toMatchObject({ ok: true, modelSelection: { model: 'sonnet' } });
  });

  it('defaults a new chat to its Factory default, else the catalog default', async () => {
    const base = {
      owns: async () => false,
      getSession: async () => undefined,
      defaults: async () => null,
      settingKeys: { selection: 'sel', lastSelection: 'last' },
    };
    const catalogDefault = { instanceId: CLAUDE_CODE_INSTANCE_ID, model: 'claude-opus-5-5' };
    const plain = createClaudeCodeHarnessModels(base);
    expect(await plain.defaultSelection(ctx)).toEqual(catalogDefault);
    expect(await plain.catalogDefault(ctx)).toEqual(catalogDefault);
    expect(await plain.factoryDefault?.(ctx)).toBeNull();

    const haiku = { instanceId: CLAUDE_CODE_INSTANCE_ID, model: 'haiku' };
    const pinned = createClaudeCodeHarnessModels({ ...base, factoryDefaults: async () => haiku });
    expect(await pinned.defaultSelection(ctx)).toEqual(haiku);
    expect(await pinned.factoryDefault?.(ctx)).toEqual(haiku);
    // The registry lists both, so Settings shows the pick and what a reset goes back to.
    expect((await createHarnessModelRegistry([pinned]).describe(ctx))[0]).toMatchObject({
      defaultModel: 'haiku',
      factoryDefaultSelection: haiku,
      catalogDefaultSelection: catalogDefault,
    });
  });

  it('a session follows its Factory default until it picks its own', async () => {
    const session = fakeSession();
    let factory: { instanceId: string; model: string } | null = { instanceId: CLAUDE_CODE_INSTANCE_ID, model: 'sonnet' };
    const models = createClaudeCodeHarnessModels({
      owns: async () => true,
      getSession: async () => session,
      defaults: async () => factory,
      settingKeys: { selection: 'sel', lastSelection: 'last' },
    });
    const sessionCtx = { ...ctx, sessionId: 's1' };
    expect(await models.defaultSelection(sessionCtx)).toEqual(factory);
    expect(await models.factoryDefault?.(sessionCtx)).toEqual(factory);
    factory = null;
    // No Factory default: the CLI's own model, shown as the catalog default.
    expect(await models.turnSelection(session)).toEqual({});
    expect(await models.defaultSelection(sessionCtx)).toEqual({ instanceId: CLAUDE_CODE_INSTANCE_ID, model: 'claude-opus-5-5' });
  });
});
