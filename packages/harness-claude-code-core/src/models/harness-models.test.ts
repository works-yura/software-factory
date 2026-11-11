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
      defaults: async () => ({ model: 'sonnet', thinkingLevel: 'off' }),
      settingKeys: { selection: 'sel', lastSelection: 'last' },
    });
    const registry = createHarnessModelRegistry([models]);

    // Nothing picked: the Factory's model at its thinking level (off reads as low).
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

  it('defaults a new chat to its Factory model, else the catalog default', async () => {
    const base = {
      owns: async () => false,
      getSession: async () => undefined,
      defaults: async () => null,
      settingKeys: { selection: 'sel', lastSelection: 'last' },
    };
    expect(await createClaudeCodeHarnessModels(base).defaultSelection(ctx)).toEqual({
      instanceId: CLAUDE_CODE_INSTANCE_ID,
      model: 'claude-opus-5-5',
    });
    expect(
      await createClaudeCodeHarnessModels({ ...base, factoryDefaults: async () => ({ model: 'haiku' }) }).defaultSelection(ctx),
    ).toMatchObject({ model: 'haiku' });
  });
});
