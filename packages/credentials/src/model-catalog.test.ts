import { describe, expect, it } from 'vitest';

import { buildModelCatalog, isDeprecatedModel } from './model-catalog.ts';

describe('buildModelCatalog', () => {
  it('leaves out models their provider has retired', async () => {
    const controller = {
      listAvailableModels: async () => [
        { id: 'opencode/deepseek-v4-flash-vision-exp', provider: 'opencode', modelName: 'deepseek-v4-flash-vision-exp', hasApiKey: true },
        { id: 'opencode/deepseek-v4.1-flash', provider: 'opencode', modelName: 'deepseek-v4.1-flash', hasApiKey: true },
      ],
    };

    const catalog = await buildModelCatalog({ controller });

    expect(isDeprecatedModel('opencode', 'deepseek-v4-flash-vision-exp')).toBe(true);
    expect(catalog.map(model => model.id)).toEqual(['opencode/deepseek-v4.1-flash']);
  });

  it('keeps a model of a provider the registry does not know', () => {
    expect(isDeprecatedModel('acme-custom', 'model-1')).toBe(false);
  });
});
