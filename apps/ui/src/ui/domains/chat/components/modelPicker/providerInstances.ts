// The provider instances the model picker offers. An instance is one harness a chat can run on
// (Mastra, Claude Code, …) with its models; the picker and the draft state only see this shape.
// `toProviderInstances` is the one place that reads the server's catalog response
// (`/web/config/models` `instances`, one per harness model facet).
import type { ModelCatalogEntry } from "@factory/api/config";
import type { ModelCatalogResponse } from "../../../../../hooks/useAvailableModels";
import { HARNESSES, MASTRA_HARNESS } from "@factory/contracts/harnesses";
import type { HarnessModelInstanceInfo } from "@factory/harness/models/facet";
import type {
  ModelCapabilities,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderModel,
} from "@factory/harness/models/contracts";
import { EFFORT_OPTION_ID } from "@factory/harness/models/selection";
import { mastraModelCapabilities, mastraModelInstance, mastraModelSelection } from "@factory/credentials/mastra-models";
import { getAvailableThinkingLevelsForModel } from "@mastra/code-sdk/thinking";
import type { ThinkingLevelSetting } from "@mastra/code-sdk/thinking";

import { translator } from "../../../../i18n/t";
import { THINKING_LEVEL_LABELS } from "../../services/thinkingLevels";

const tk = translator("chat");


export type ServerProviderState = "ready" | "warning" | "error" | "disabled";

export interface ProviderInstanceEntry {
  readonly instanceId: ProviderInstanceId;
  /** The harness that runs it (`HarnessDescriptor.id`): a pick on another harness needs a new chat. */
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly status: ServerProviderState;
  readonly isAvailable: boolean;
  /** No credential reaches any model yet: the picker offers the provider setup (Settings → Models). */
  readonly needsSetup: boolean;
  readonly defaultModel: string | null;
  /** The Factory's own default for this instance; null when it follows `catalogDefault`. */
  readonly factoryDefault: ModelSelection | null;
  /** The harness's own default, what "Use catalog default" goes back to. */
  readonly catalogDefault: ModelSelection | null;
  /** Its facet can move running sessions onto a new Factory default. */
  readonly appliesToRunningSessions: boolean;
  /** Why it is unavailable, as its facet says. */
  readonly reason?: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

/** What a session of this instance follows until it picks its own: the Factory's default, else the catalog's. */
export function instanceDefaultSelection(entry: Pick<ProviderInstanceEntry, "factoryDefault" | "catalogDefault">): ModelSelection | null {
  return entry.factoryDefault ?? entry.catalogDefault;
}

/** Disabled instances may retain ready status until reconciliation. */
export function isProviderInstancePickerReady(entry: ProviderInstanceEntry): boolean {
  return entry.enabled && entry.isAvailable && entry.status === "ready";
}

export function isProviderInstancePickerVisible(entry: ProviderInstanceEntry): boolean {
  return entry.enabled;
}

/** Marks an instance apart from another of the same harness (two accounts of one provider). */
export function shouldShowInstanceBadge(
  entry: Pick<ProviderInstanceEntry, "driverKind" | "accentColor" | "enabled">,
  entries: Iterable<Pick<ProviderInstanceEntry, "driverKind" | "enabled">>,
): boolean {
  if (entry.accentColor) return true;
  let sharedProviderCount = 0;
  for (const candidate of entries) {
    if (candidate.driverKind !== entry.driverKind) continue;
    // Historical threads still need to distinguish accounts that are all disabled.
    if (entry.enabled && !candidate.enabled) continue;
    if (++sharedProviderCount > 1) return true;
  }
  return false;
}

/**
 * Mastra's thinking levels in the UI's language, as v4's thinking control (the chat's `/think`,
 * Settings) names them, so the picker and that control agree. Presentation only: other harnesses'
 * descriptors keep the labels their catalog gives.
 */
function translatedThinkingLevels(capabilities: ModelCapabilities | null | undefined): ModelCapabilities | null {
  if (!capabilities) return null;
  return {
    ...capabilities,
    optionDescriptors: capabilities.optionDescriptors?.map((descriptor) =>
      descriptor.type === "select" && descriptor.id === EFFORT_OPTION_ID
        ? {
            ...descriptor,
            label: tk("thinking.label"),
            options: descriptor.options.map((option) => ({
              ...option,
              label: THINKING_LEVEL_LABELS[option.id as ThinkingLevelSetting] ?? option.label,
            })),
          }
        : descriptor,
    ),
  };
}

/** A model name without the family word its instance already names ("Claude Opus 5.5" under Claude Code: "Opus 5.5"). */
function withShortName(model: ServerProviderModel, displayName: string): ServerProviderModel {
  if (model.shortName) return model;
  const family = displayName.split(/\s+/u)[0];
  if (!family || !model.name.startsWith(`${family} `)) return model;
  return { ...model, shortName: model.name.slice(family.length + 1) };
}

/** The catalog's models with `isDefault` on `selection`'s model (by slug or alias) alone. */
export function withDefaultMarked(
  models: ReadonlyArray<ServerProviderModel>,
  selection: Pick<ModelSelection, "model"> | null,
): ServerProviderModel[] {
  const marked = selection
    ? (models.find((model) => model.slug === selection.model) ??
      models.find((model) => model.aliases?.includes(selection.model)))
    : undefined;
  if (!marked) return [...models];
  return models.map((model) => {
    const { isDefault: _isDefault, ...rest } = model;
    return model === marked ? { ...rest, isDefault: true } : rest;
  });
}

function toEntry(instance: HarnessModelInstanceInfo): ProviderInstanceEntry {
  const displayName = HARNESSES.find((harness) => harness.id === instance.harnessId)?.label ?? instance.displayName;
  // A server that predates the per-harness defaults reports only the effective default.
  const factoryDefault = instance.factoryDefaultSelection ?? null;
  const catalogDefault =
    instance.catalogDefaultSelection !== undefined ? instance.catalogDefaultSelection : (instance.defaultSelection ?? null);
  const models = instance.models.map((model) => {
    const named = withShortName(model, instance.displayName);
    return instance.harnessId === MASTRA_HARNESS.id
      ? { ...named, capabilities: translatedThinkingLevels(model.capabilities) }
      : named;
  });
  return {
    instanceId: instance.instanceId,
    driverKind: instance.harnessId,
    displayName,
    enabled: true,
    status: instance.available ? "ready" : "error",
    isAvailable: instance.available,
    needsSetup: instance.needsSetup,
    defaultModel: instance.defaultModel,
    factoryDefault,
    catalogDefault,
    appliesToRunningSessions: instance.appliesToRunningSessions ?? false,
    ...(instance.reason ? { reason: instance.reason } : {}),
    // "Default" in the picker is what a session follows: the Factory's default, else the catalog's.
    models: withDefaultMarked(models, factoryDefault ?? catalogDefault),
  };
}

/**
 * A server that predates `instances` lists Mastra's catalog alone: its entries as harness models,
 * with the descriptors derived from each model's thinking levels as the server does.
 */
function legacyMastraInstance(response: ModelCatalogResponse): HarnessModelInstanceInfo {
  const models = response.models.map((entry: ModelCatalogEntry) => ({
    ...entry,
    capabilities:
      entry.capabilities ??
      mastraModelCapabilities(getAvailableThinkingLevelsForModel(entry.id, entry.reasoningOptions)),
  }));
  return mastraModelInstance(models, {
    factoryDefault: response.defaultModelId ? mastraModelSelection(response.defaultModelId) : null,
    catalogDefaultModelId: response.fallbackModelId ?? null,
  });
}

/**
 * The adapter from the catalog response to provider instances: one per harness the server runs
 * (`instances`, from each harness's model facet), with nothing harness-specific here.
 */
export function toProviderInstances(
  response: ModelCatalogResponse | undefined,
): ProviderInstanceEntry[] {
  if (!response) return [];
  return (response.instances ?? [legacyMastraInstance(response)]).map(toEntry);
}

/** The instance a harness runs its sessions on. */
export function instanceForHarness(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  harnessId: string | undefined,
): ProviderInstanceEntry | undefined {
  return entries.find((entry) => entry.driverKind === (harnessId ?? MASTRA_HARNESS.id));
}

/** The catalog model a selection names, by slug or alias (`opus`). */
export function findInstanceModel(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): ServerProviderModel | undefined {
  const models = entries.find((entry) => entry.instanceId === selection.instanceId)?.models ?? [];
  return (
    models.find((model) => model.slug === selection.model) ??
    models.find((model) => model.aliases?.includes(selection.model))
  );
}
