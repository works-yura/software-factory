// Codex's side of model selection: the instance id its selections carry, a listed model's option
// descriptors (reasoning effort, service tier) and a selection compiled into a turn's `turn/start`
// fields. Pure: the facet (`./harness-models.ts`) and the catalog both read it.
import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionChoice,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from '@factory/harness/models/contracts';
import { codexModelFamily, createModelCapabilities, formatCodexModelName, getModelSelectionBooleanOptionValue, getModelSelectionStringOptionValue } from '@factory/harness/models/model';
import { EFFORT_OPTION_ID } from '@factory/harness/models/selection';

import type { CodexListedModel } from '../protocol/schema.ts';

/** `ModelSelection.instanceId` of every Codex selection, and `harnessModelDefaults.codex`. */
export const CODEX_INSTANCE_ID = 'codex';
/** The harness id Codex sessions report (`HarnessDescriptor.id`). */
export const CODEX_HARNESS_ID = 'codex';
/** The option id of a model's service tier (Standard, Fast, Ultrafast). */
export const SERVICE_TIER_OPTION_ID = 'serviceTier';
/** The service tier that sends none: the model's standard speed. */
export const DEFAULT_SERVICE_TIER_ID = 'default';

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

const SERVICE_TIER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ultrafast: 'Even faster, more expensive',
};

export function reasoningEffortLabel(reasoningEffort: string): string {
  return REASONING_EFFORT_LABELS[reasoningEffort] ?? reasoningEffort;
}

export function codexDefaultReasoningEffortOverride(model: string): 'medium' | undefined {
  return codexModelFamily(model) === 'gpt-6-astra' ? 'medium' : undefined;
}

/** The reasoning select: `role: 'reasoning'` under the shared `effort` id, so pickers and defaults treat it as every harness's effort. */
export function codexEffortDescriptor(efforts: ReadonlyArray<string>, defaultEffort: string | undefined): ProviderOptionDescriptor | undefined {
  if (efforts.length === 0) return undefined;
  const options: ProviderOptionChoice[] = efforts.map(effort => ({
    id: effort,
    label: reasoningEffortLabel(effort),
    ...(effort === defaultEffort ? { isDefault: true } : {}),
  }));
  const current = options.find(option => option.isDefault)?.id;
  return {
    id: EFFORT_OPTION_ID,
    label: 'Reasoning',
    type: 'select',
    role: 'reasoning',
    options,
    ...(current ? { currentValue: current } : {}),
  };
}

/** The service-tier select: Standard (no tier sent) plus the model's own tiers. */
export function codexServiceTierDescriptor(
  tiers: ReadonlyArray<{ id: string; name: string; description?: string }>,
  defaultTier: string | null | undefined,
): ProviderOptionDescriptor | undefined {
  if (tiers.length === 0) return undefined;
  const current = tiers.some(tier => tier.id === defaultTier) ? defaultTier! : DEFAULT_SERVICE_TIER_ID;
  return {
    id: SERVICE_TIER_OPTION_ID,
    label: 'Service Tier',
    type: 'select',
    options: [
      { id: DEFAULT_SERVICE_TIER_ID, label: 'Standard', ...(current === DEFAULT_SERVICE_TIER_ID ? { isDefault: true } : {}) },
      ...tiers.map(tier => {
        const description = SERVICE_TIER_DESCRIPTIONS[tier.id] ?? tier.description;
        return {
          id: tier.id,
          label: tier.name,
          ...(description ? { description } : {}),
          ...(current === tier.id ? { isDefault: true } : {}),
        };
      }),
    ],
    currentValue: current,
  };
}

/** A listed model's descriptors: its reasoning efforts and, where it has any, its service tiers. */
export function mapCodexModelCapabilities(model: CodexListedModel): ModelCapabilities {
  const efforts = model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort);
  const defaultEffort = codexDefaultReasoningEffortOverride(model.model) ?? model.defaultReasoningEffort;
  const serviceTiers =
    model.serviceTiers && model.serviceTiers.length > 0
      ? model.serviceTiers
      : (model.additionalSpeedTiers ?? []).map(id => ({ id, name: id === 'fast' ? 'Fast' : id, description: '' }));
  const optionDescriptors = [
    codexEffortDescriptor(efforts, defaultEffort),
    codexServiceTierDescriptor(serviceTiers, model.defaultServiceTier),
  ].filter((descriptor): descriptor is ProviderOptionDescriptor => descriptor !== undefined);
  return createModelCapabilities({ optionDescriptors });
}

export { codexModelFamily, formatCodexModelName };

/** The service tier a selection asks for; Standard sends none. A legacy `fastMode: true` is Fast. */
export function getCodexServiceTierOptionValue(selection: ModelSelection | null | undefined): string | undefined {
  const tier =
    getModelSelectionStringOptionValue(selection, SERVICE_TIER_OPTION_ID) ??
    (getModelSelectionBooleanOptionValue(selection, 'fastMode') === true ? 'fast' : undefined);
  return tier === DEFAULT_SERVICE_TIER_ID ? undefined : tier;
}

/** What one Codex turn sends with `turn/start`. */
export interface CodexTurnSelection {
  /** The selection the turn runs, with the Factory defaults filled in: what a model-switch marker shows. */
  selection: ModelSelection | null;
  /** `model`; unset leaves Codex's own default (its config). */
  model?: string;
  /** `effort`. */
  effort?: string;
  /** `serviceTier`. */
  serviceTier?: string;
}

/**
 * A Codex turn's fields: the session's own selection when it has one, else its Factory's Codex
 * default (`harnessModelDefaults.codex`), else nothing (Codex's own model, effort and tier).
 */
export function compileCodexTurn(input: { selection?: ModelSelection | null; factoryDefault?: ModelSelection | null }): CodexTurnSelection {
  const chosen = input.selection?.model?.trim()
    ? input.selection
    : input.factoryDefault?.model?.trim()
      ? input.factoryDefault
      : null;
  if (!chosen) return { selection: null };
  const model = chosen.model.trim();
  const options: ProviderOptionSelection[] = [...(chosen.options ?? [])];
  const selection: ModelSelection = { instanceId: CODEX_INSTANCE_ID, model, ...(options.length ? { options } : {}) };
  const effort = getModelSelectionStringOptionValue(selection, EFFORT_OPTION_ID) ?? codexDefaultReasoningEffortOverride(model);
  const serviceTier = getCodexServiceTierOptionValue(selection);
  return {
    selection,
    model,
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** A Mastra thinking level as a Codex reasoning effort (the agent tool and older clients send one). */
export function codexEffortForThinkingLevel(level: string | null | undefined): string | undefined {
  if (!level) return undefined;
  if (level === 'off') return 'minimal';
  return CODEX_EFFORTS.includes(level) ? level : undefined;
}
