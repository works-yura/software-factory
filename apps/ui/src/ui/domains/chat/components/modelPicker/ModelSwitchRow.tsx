// The model-switch divider: `ModelSwitchRow` is drawn above the user message that starts the
// switching turn, and `resolveModelSwitchChange` says what changed. The divider is a
// `TranscriptDivider`; its providers are the catalog's instances (`toProviderInstances`).
import { TranscriptDivider } from "@mastra/playground-ui/components/ai/transcript-divider";
import type { ModelSelection, ServerProviderModel } from "@factory/harness/models/contracts";
import { ModelSelection as ModelSelectionSchema } from "@factory/harness/models/contracts";
import { getModelSelectionStringOptionValue, getProviderOptionCurrentValue } from "@factory/harness/models/model";
import { isReasoningSelect } from "@factory/harness/models/modelTraits";
import { REASONING_EFFORT_OPTION_IDS } from "@factory/harness/models";
import { useTranslation } from "react-i18next";

import { useModelCatalogQuery } from "../../../../../hooks/useAvailableModels";
import { useChatModelCatalog } from "../../context/useChatModelCatalog";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { type ProviderInstanceEntry, toProviderInstances } from "./providerInstances";

/** `message.content.metadata.modelSwitch`: the selection the turn before ran and the one this turn runs. */
export interface ModelSwitch {
  readonly from: ModelSelection;
  readonly to: ModelSelection;
}

export function readModelSwitch(metadata: Record<string, unknown> | undefined): ModelSwitch | null {
  const value = metadata?.modelSwitch;
  if (typeof value !== "object" || value === null) return null;
  const from = ModelSelectionSchema.safeParse((value as { from?: unknown }).from);
  const to = ModelSelectionSchema.safeParse((value as { to?: unknown }).to);
  return from.success && to.success ? { from: from.data, to: to.data } : null;
}

export interface ModelSwitchChange {
  readonly modelChanged: boolean;
  readonly effort: { readonly from: string; readonly to: string } | null;
}

function findModel(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> | undefined,
): ServerProviderModel | undefined {
  return (
    models?.find((candidate) => candidate.slug === selection.model) ??
    models?.find((candidate) => candidate.aliases?.includes(selection.model))
  );
}

/**
 * What a recorded model switch visibly changed, or null when it changed neither the model nor the
 * effort. The composer omits an untouched effort, so an unset effort reads as the model's default.
 */
export function resolveModelSwitchChange(
  { from, to }: ModelSwitch,
  providers: ReadonlyArray<Pick<ProviderInstanceEntry, "instanceId" | "models">>,
): ModelSwitchChange | null {
  const modelsOf = (selection: ModelSelection) =>
    providers.find((provider) => provider.instanceId === selection.instanceId)?.models;
  const fromEffort = resolveEffort(from, modelsOf(from));
  const toEffort = resolveEffort(to, modelsOf(to));
  // An alias (`opus`) and its slug name the same model.
  const modelChanged =
    (findModel(from, modelsOf(from))?.slug ?? from.model) !==
    (findModel(to, modelsOf(to))?.slug ?? to.model);
  const effort =
    fromEffort && toEffort && fromEffort.value !== toEffort.value
      ? { from: fromEffort.label, to: toEffort.label }
      : null;
  return modelChanged || effort ? { modelChanged, effort } : null;
}

/** The composer's reasoning control for the model; stated values only when the catalog lacks it. */
function resolveEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> | undefined,
): { readonly value: string; readonly label: string } | undefined {
  const model = findModel(selection, models);
  if (model === undefined) {
    // Pi states its effort as `thinking`; the catalog would otherwise mark it a reasoning control.
    const value = [...REASONING_EFFORT_OPTION_IDS, "thinking"]
      .map((id) => getModelSelectionStringOptionValue(selection, id))
      .find((candidate) => candidate !== undefined);
    return value === undefined ? undefined : { value, label: value };
  }
  const descriptor = model.capabilities?.optionDescriptors?.find(isReasoningSelect);
  if (descriptor === undefined) return undefined;
  const value =
    getModelSelectionStringOptionValue(selection, descriptor.id) ??
    getProviderOptionCurrentValue(descriptor, selection);
  if (typeof value !== "string") return undefined;
  return { value, label: descriptor.options.find((option) => option.id === value)?.label ?? value };
}

/** A same-harness model or effort change. Shows only what changed. */
export function ModelSwitchRow(props: { readonly modelSwitch: ModelSwitch }) {
  const { t } = useTranslation("chat");
  const { catalogTarget } = useChatModelCatalog();
  const catalog = useModelCatalogQuery(catalogTarget);
  const providers = toProviderInstances(catalog.data);
  const change = resolveModelSwitchChange(props.modelSwitch, providers);
  if (change === null) return null;
  const describe = (selection: ModelSelection, effort: string | undefined) => {
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    const model = findModel(selection, provider?.models);
    const modelName = model ? getTriggerDisplayModelName(model, provider?.driverKind) : selection.model;
    return [change.modelChanged ? modelName : null, effort].filter(Boolean).join(" ");
  };
  const { from, to } = props.modelSwitch;
  return (
    <TranscriptDivider
      label={t("modelPicker.switchLabel", {
        from: describe(from, change.effort?.from),
        to: describe(to, change.effort?.to),
      })}
    />
  );
}
