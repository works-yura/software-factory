import { describe, expect, it } from 'vitest';

import { createHarnessModelRegistry } from '@factory/harness/models/registry';

import { CODEX_NEEDS_LOGIN_REASON, CODEX_NOT_INSTALLED_REASON, createCodexCatalogSource, createCodexHarnessModels } from './harness-models.ts';
import { probeCodex } from './probe.ts';
import { parseCodexModelListResponse } from './codexModelCatalog.ts';
import { FAKE_CODEX_MODELS, fakeCodexSpawn } from '../testkit.ts';

class FakeSession {
  readonly settings = new Map<string, unknown>();
  readonly thread = {
    getSetting: async ({ key }: { key: string }) => this.settings.get(key),
    setSetting: async ({ key, value }: { key: string; value: unknown }) => {
      this.settings.set(key, value);
    },
  };
}

const listed = parseCodexModelListResponse(FAKE_CODEX_MODELS);
const viewer = { viewer: { userId: 'u', orgId: 'o' } };

function facet(options: { factoryDefault?: { instanceId: string; model: string } | null; catalog?: Parameters<typeof createCodexHarnessModels>[0]['catalog'] } = {}) {
  const sessions = new Map([['s1', new FakeSession()]]);
  const models = createCodexHarnessModels<FakeSession>({
    owns: async id => sessions.has(id),
    getSession: async id => sessions.get(id),
    defaults: async () => options.factoryDefault ?? null,
    factoryDefaults: async () => options.factoryDefault ?? null,
    settingKeys: { selection: 'codexModelSelection', lastSelection: 'codexLastSelection' },
    catalog: options.catalog ?? (async () => ({ available: true, models: listed })),
  });
  return { models, session: sessions.get('s1')! };
}

describe('createCodexHarnessModels', () => {
  it('lists the catalog and names its default', async () => {
    const { models } = facet();
    expect(models.instanceId).toBe('codex');
    expect(models.harnessId).toBe('codex');
    expect((await models.list(viewer)).map(model => model.slug)).toEqual(['gpt-test-sol', 'gpt-test-luna']);
    expect(await models.catalogDefault(viewer)).toEqual({ instanceId: 'codex', model: 'gpt-test-sol' });
    expect(await models.defaultSelection(viewer)).toEqual({ instanceId: 'codex', model: 'gpt-test-sol' });
  });

  it("checks a pick against the model's effort and service tier", async () => {
    const { models } = facet();
    expect(await models.check({ model: 'gpt-test-sol', options: [{ id: 'serviceTier', value: 'ultrafast' }], thinkingLevel: 'high' }, viewer)).toEqual({
      ok: true,
      selection: {
        instanceId: 'codex',
        model: 'gpt-test-sol',
        options: [
          { id: 'serviceTier', value: 'ultrafast' },
          { id: 'effort', value: 'high' },
        ],
      },
    });
    const refused = await models.check({ model: 'gpt-test-luna', options: [{ id: 'serviceTier', value: 'priority' }] }, viewer);
    expect(refused).toMatchObject({ ok: false });
    expect(await models.check({ model: 'gpt-unknown' }, viewer)).toMatchObject({ ok: false, error: expect.stringContaining('Unknown model') });
  });

  it('applies a pick from the next turn and marks the turn that switches', async () => {
    const { models, session } = facet({ factoryDefault: { instanceId: 'codex', model: 'gpt-test-luna' } });
    expect(await models.turnSelection(session)).toEqual({ model: 'gpt-test-luna' });
    const pick = { instanceId: 'codex', model: 'gpt-test-sol', options: [{ id: 'effort', value: 'high' }] };
    expect(await models.setSelection('s1', pick, viewer)).toEqual({ ok: true, modelSelection: pick, appliesFrom: 'next-turn' });
    expect(await models.turnSelection(session)).toEqual({
      model: 'gpt-test-sol',
      effort: 'high',
      modelSwitch: { from: { instanceId: 'codex', model: 'gpt-test-luna' }, to: pick },
    });
    expect(await models.turnSelection(session)).toEqual({ model: 'gpt-test-sol', effort: 'high' });
    expect(await models.setSelection('missing', null, viewer)).toMatchObject({ ok: false, status: 404 });
  });

  it('switches through the registry and refuses another harness instance', async () => {
    const { models } = facet();
    const registry = createHarnessModelRegistry([models]);
    expect(await registry.switchSessionModel('s1', { model: 'gpt-test-luna' }, viewer)).toMatchObject({ ok: true, appliesFrom: 'next-turn' });
    expect(await registry.switchSessionModel('s1', { model: 'claude-opus-5-5', instanceId: 'claude-code' }, viewer)).toMatchObject({ ok: false, status: 409 });
    const [info] = await registry.describe(viewer);
    expect(info).toMatchObject({ instanceId: 'codex', harnessId: 'codex', displayName: 'Codex', available: true, defaultModel: 'gpt-test-sol' });
  });

  it('reports a missing or signed-out CLI as needing setup', async () => {
    const missing = createCodexCatalogSource({ installed: () => false, probeInput: () => ({ cwd: '/', env: {} }) });
    const signedOut = createCodexCatalogSource({
      installed: () => true,
      probe: async () => ({ version: '0.166.0', account: null, needsLogin: true, models: [] }),
      probeInput: () => ({ cwd: '/', env: {} }),
    });
    const registry = createHarnessModelRegistry([facet({ catalog: missing }).models]);
    expect((await registry.describe(viewer))[0]).toMatchObject({ available: false, needsSetup: true, reason: CODEX_NOT_INSTALLED_REASON, models: [] });
    expect(await signedOut()).toMatchObject({ available: false, needsSetup: true, reason: CODEX_NEEDS_LOGIN_REASON });
    // A Factory default can still be checked against the bundled catalog.
    const bundledCheck = await facet({ catalog: missing }).models.check({ model: 'gpt-6.1-sol' }, viewer);
    expect(bundledCheck).toMatchObject({ ok: true });
  });

  it('probes the CLI once per TTL and falls back to the bundled list when listing fails', async () => {
    let probes = 0;
    let now = 0;
    const source = createCodexCatalogSource({
      installed: () => true,
      probe: async () => {
        probes += 1;
        if (probes === 1) throw new Error('timeout');
        return { version: '0.166.0', account: { type: 'apiKey' }, needsLogin: false, models: listed };
      },
      probeInput: () => ({ cwd: '/', env: {} }),
      now: () => now,
    });
    const first = await source();
    expect(first.available).toBe(true);
    expect(first.reason).toContain('bundled');
    expect(first.models.length).toBeGreaterThan(0);
    now += 60_000;
    const second = await source();
    expect(second.models.map(model => model.slug)).toEqual(['gpt-test-sol', 'gpt-test-luna']);
    await source();
    expect(probes).toBe(2);
  });
});

describe('probeCodex', () => {
  it('reads the version, the account and every page of models', async () => {
    const spawn = fakeCodexSpawn(server =>
      server.handle('model/list', params =>
        params.cursor ? { data: [FAKE_CODEX_MODELS.data[1]], nextCursor: null } : { data: [FAKE_CODEX_MODELS.data[0]], nextCursor: 'page-2' },
      ),
    );
    const result = await probeCodex({ cwd: '/', env: {}, spawn });
    expect(result).toMatchObject({ version: '0.166.0', needsLogin: false, account: { type: 'chatgpt', planType: 'plus' } });
    expect(result.models.map(model => model.slug)).toEqual(['gpt-test-sol', 'gpt-test-luna']);
    expect(spawn.servers[0]!.closed).toBe(true);
  });

  it('stops at the account when the CLI is not signed in', async () => {
    const spawn = fakeCodexSpawn(server => server.handle('account/read', () => ({ account: null, requiresOpenaiAuth: true })));
    expect(await probeCodex({ cwd: '/', env: {}, spawn })).toEqual({ version: '0.166.0', account: null, needsLogin: true, models: [] });
    expect(spawn.servers[0]!.requests('model/list')).toEqual([]);
  });
});
