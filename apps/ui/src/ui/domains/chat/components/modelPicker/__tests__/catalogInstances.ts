// `/web/config/models` `instances` for tests, as the server's harness model facets describe them.
import type { ModelCatalogEntry } from '@factory/api/config';
import { mastraModelCapabilities, mastraModelInstance } from '@factory/credentials/mastra-models';
import { claudeCodeModels } from '@factory/harness-claude-code/models/claude-code';
import type { HarnessModelInstanceInfo } from '@factory/harness/models/facet';
import { getAvailableThinkingLevelsForModel } from '@mastra/code-sdk/thinking';

/** Mastra's instance from its catalog entries, descriptors from each model's thinking levels. */
export function mastraTestInstance(models: ModelCatalogEntry[], defaultModelId: string | null = null): HarnessModelInstanceInfo {
  return mastraModelInstance(
    models.map(entry => ({
      ...entry,
      capabilities: entry.capabilities ?? mastraModelCapabilities(getAvailableThinkingLevelsForModel(entry.id, entry.reasoningOptions)),
    })),
    defaultModelId,
  );
}

/** Claude Code's instance: the bundled catalog. */
export function claudeCodeTestInstance(): HarnessModelInstanceInfo {
  return {
    instanceId: 'claude-code',
    harnessId: 'claude-code',
    displayName: 'Claude Code',
    available: true,
    needsSetup: false,
    defaultModel: 'claude-opus-5-5',
    defaultSelection: { instanceId: 'claude-code', model: 'claude-opus-5-5' },
    models: claudeCodeModels(),
  };
}
