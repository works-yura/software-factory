// Mastra's side of model selection: the instance id its selections carry, its thinking levels as
// option descriptors, and its catalog entries as `ServerProviderModel`s. Pure (browser-safe): the server's
// Mastra model facet (`@factory/harness-mastra`), the catalog and the UI all read it from here.
import type { ModelCapabilities, ModelSelection, ServerProviderModel } from '@factory/harness/models/contracts';
import type { HarnessModelInstanceInfo } from '@factory/harness/models/facet';
import { EFFORT_OPTION_ID } from '@factory/harness/models/selection';

import type { ModelCatalogEntry } from './model-catalog.ts';
import { providerDisplayName } from './provider-display-name.ts';

/** `ModelSelection.instanceId` of a Mastra session: its model is a Mastra model router id. */
export const MASTRA_INSTANCE_ID = 'mastra';
/** The harness that runs it (`MASTRA_HARNESS.id` in `@factory/contracts`). */
export const MASTRA_HARNESS_ID = 'mastra';
export const MASTRA_DISPLAY_NAME = 'Mastra';

const THINKING_LEVEL_LABELS: Readonly<Record<string, string>> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

/**
 * A Mastra model's reasoning control, from the thinking levels it runs at
 * (`getAvailableThinkingLevelsForModel` in `@mastra/code-sdk/thinking`). A model with one level or
 * none has no control. Its value goes to the session as `thinkingLevel`.
 */
export function mastraModelCapabilities(levels: ReadonlyArray<string>): ModelCapabilities {
  if (levels.length < 2) return { optionDescriptors: [] };
  return {
    optionDescriptors: [
      {
        id: EFFORT_OPTION_ID,
        label: 'Reasoning',
        type: 'select',
        role: 'reasoning',
        options: levels.map(id => ({ id, label: THINKING_LEVEL_LABELS[id] ?? id })),
      },
    ],
  };
}

/** The selection a Mastra session runs: its model and, when known, its thinking level. */
export function mastraModelSelection(modelId: string, thinkingLevel?: string | null): ModelSelection {
  return {
    instanceId: MASTRA_INSTANCE_ID,
    model: modelId,
    ...(thinkingLevel ? { options: [{ id: EFFORT_OPTION_ID, value: thinkingLevel }] } : {}),
  };
}

/** A Mastra catalog entry as a `ServerProviderModel`: its router id is the slug, its provider the sub-provider. */
export function mastraServerModel(
  entry: Pick<ModelCatalogEntry, 'id' | 'modelName' | 'provider' | 'capabilities'>,
  defaultModelId?: string | null,
): ServerProviderModel {
  return {
    slug: entry.id,
    name: entry.modelName,
    subProvider: providerDisplayName(entry.provider),
    isCustom: false,
    ...(entry.id === defaultModelId ? { isDefault: true } : {}),
    capabilities: entry.capabilities ?? null,
  };
}

/** Mastra's instance in `/web/config/models`, from a catalog the route already resolved. */
export function mastraModelInstance(
  models: ReadonlyArray<Pick<ModelCatalogEntry, 'id' | 'modelName' | 'provider' | 'capabilities'>>,
  defaultModelId: string | null,
): HarnessModelInstanceInfo {
  return {
    instanceId: MASTRA_INSTANCE_ID,
    harnessId: MASTRA_HARNESS_ID,
    displayName: MASTRA_DISPLAY_NAME,
    available: models.length > 0,
    // No credential reaches any model yet: the picker offers the provider setup.
    needsSetup: models.length === 0,
    defaultModel: defaultModelId,
    defaultSelection: defaultModelId ? mastraModelSelection(defaultModelId) : null,
    models: models.map(entry => mastraServerModel(entry, defaultModelId)),
  };
}
