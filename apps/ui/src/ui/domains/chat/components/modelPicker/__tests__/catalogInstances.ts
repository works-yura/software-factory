// `/web/config/models` `instances` for tests, as the server's harness model facets describe them.
import type { ModelCatalogEntry } from '@factory/api/config';
import { mastraModelCapabilities, mastraModelInstance, mastraModelSelection } from '@factory/credentials/mastra-models';
import type { ModelSelection } from '@factory/harness/models/contracts';
import { claudeCodeModels } from '@factory/harness-claude-code/models/claude-code';
import type { HarnessModelInstanceInfo } from '@factory/harness/models/facet';
import { getAvailableThinkingLevelsForModel } from '@mastra/code-sdk/thinking';

/**
 * Mastra's instance from its catalog entries, descriptors from each model's thinking levels.
 * `defaultModelId` is the Factory's default and, unless `catalogDefaultModelId` says otherwise, the catalog's.
 */
export function mastraTestInstance(
  models: ModelCatalogEntry[],
  defaultModelId: string | null = null,
  options: { catalogDefaultModelId?: string | null; factoryDefault?: ModelSelection | null; appliesToRunningSessions?: boolean } = {},
): HarnessModelInstanceInfo {
  return mastraModelInstance(
    models.map(entry => ({
      ...entry,
      capabilities: entry.capabilities ?? mastraModelCapabilities(getAvailableThinkingLevelsForModel(entry.id, entry.reasoningOptions)),
    })),
    {
      factoryDefault: options.factoryDefault !== undefined ? options.factoryDefault : defaultModelId ? mastraModelSelection(defaultModelId) : null,
      catalogDefaultModelId: options.catalogDefaultModelId !== undefined ? options.catalogDefaultModelId : defaultModelId,
      ...(options.appliesToRunningSessions !== undefined ? { appliesToRunningSessions: options.appliesToRunningSessions } : {}),
    },
  );
}

/** Claude Code's instance: the bundled catalog, with the Factory's Claude Code default when it set one. */
export function claudeCodeTestInstance(factoryDefault: ModelSelection | null = null): HarnessModelInstanceInfo {
  const catalogDefault = { instanceId: 'claude-code', model: 'claude-opus-5-5' };
  return {
    instanceId: 'claude-code',
    harnessId: 'claude-code',
    displayName: 'Claude Code',
    available: true,
    needsSetup: false,
    defaultModel: (factoryDefault ?? catalogDefault).model,
    defaultSelection: factoryDefault ?? catalogDefault,
    factoryDefaultSelection: factoryDefault,
    catalogDefaultSelection: catalogDefault,
    appliesToRunningSessions: false,
    models: claudeCodeModels(),
  };
}
