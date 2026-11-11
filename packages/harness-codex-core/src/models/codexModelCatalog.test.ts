import { describe, expect, it } from 'vitest';

import type { ServerProviderModel } from '@factory/harness/models/contracts';
import type * as ModelCatalog from '@factory/harness/models/ModelCatalog';

import { applyCodexModelCatalog, bundledCodexModels, parseCodexModelListResponse } from './codexModelCatalog.ts';
import { FAKE_CODEX_MODELS } from '../testkit.ts';

const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: 'gpt-test',
  name: 'GPT Test',
  isCustom: false,
  capabilities: null,
  ...overrides,
});

const entry = (overrides: Partial<ModelCatalog.ProviderCatalogModel> & { readonly slug: string }): ModelCatalog.ProviderCatalogModel => ({
  name: overrides.slug,
  status: 'current',
  capabilities: null,
  adapter: undefined,
  profileAdapter: undefined,
  ...overrides,
});

const catalog: ModelCatalog.ProviderCatalog = {
  defaultChatModel: undefined,
  models: [
    entry({ slug: 'gpt-next', name: 'GPT Next', badge: 'new', adapter: { codex: { minVersion: '1.2.0' } } }),
    entry({ slug: 'gpt-unversioned' }),
    entry({ slug: 'gpt-retired', status: 'legacy', adapter: { codex: { minVersion: '1.2.0' } } }),
  ],
};

const draft = (version: string | undefined, models: ReadonlyArray<ServerProviderModel> = []) => ({
  ...(version ? { version } : {}),
  models,
});

describe('applyCodexModelCatalog', () => {
  it('names current models that need a newer Codex and are missing from discovery', () => {
    expect(applyCodexModelCatalog(draft('1.1.9'), catalog).updateRequiredModels).toEqual([
      { slug: 'gpt-next', name: 'GPT Next', badge: 'new', minVersion: '1.2.0' },
    ]);
    for (const result of [
      applyCodexModelCatalog(draft('1.2.0'), catalog),
      applyCodexModelCatalog(draft('1.1.9', [model({ slug: 'openai.gpt-next' })]), catalog),
      applyCodexModelCatalog(draft(undefined), catalog),
      applyCodexModelCatalog(draft('1.1.9', [model({ slug: 'gpt-next' })]), {
        ...catalog,
        models: [{ ...catalog.models[0]!, slug: 'openai.gpt-next' }],
      }),
    ]) {
      expect(result.updateRequiredModels).toBeUndefined();
    }
  });

  it('classifies qualified Codex families without changing their wire ids', () => {
    const classified = applyCodexModelCatalog(
      draft('1.2.0', [model({ slug: 'openai.gpt-test', isLegacy: true }), model({ slug: 'openai.gpt-retired' })]),
      catalog,
    );
    expect(classified.models.map(entry => [entry.slug, entry.isLegacy ?? false])).toEqual([
      ['openai.gpt-test', false],
      ['openai.gpt-retired', true],
    ]);
  });
});

describe('the Codex catalog', () => {
  it("reads `model/list`'s models with their names and descriptors", () => {
    const models = parseCodexModelListResponse({
      ...FAKE_CODEX_MODELS,
      data: [...FAKE_CODEX_MODELS.data, { ...FAKE_CODEX_MODELS.data[1]!, model: 'gpt-hidden', hidden: true }],
    });
    expect(models.map(entry => [entry.slug, entry.name, entry.isDefault ?? false])).toEqual([
      ['gpt-test-sol', 'GPT-Test-Sol', true],
      ['gpt-test-luna', 'GPT-Test-Luna', false],
    ]);
    expect(models[0]!.capabilities?.optionDescriptors?.map(descriptor => descriptor.id)).toEqual(['effort', 'serviceTier']);
  });

  it("falls back to the bundled manifest's codex section, current models first", () => {
    const models = bundledCodexModels();
    expect(models.length).toBeGreaterThan(0);
    const firstLegacy = models.findIndex(entry => entry.isLegacy);
    expect(models.slice(0, firstLegacy).every(entry => !entry.isLegacy)).toBe(true);
    expect(models.filter(entry => entry.isDefault)).toHaveLength(1);
    const descriptors = models[0]!.capabilities?.optionDescriptors ?? [];
    expect(descriptors.map(descriptor => descriptor.id)).toEqual(['effort', 'serviceTier']);
    expect(descriptors[0]).toMatchObject({ role: 'reasoning', currentValue: 'medium' });
  });
});
