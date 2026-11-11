// What a model's traits show and how a pick writes them. There is no standalone traits menu: the
// status line docks the effort column inside the model picker (`ComposerModelEffort.tsx`).
import {
  getDescriptorStringValue,
  getTraitSelectChange,
  isReasoningSelect,
  replaceDescriptorCurrentValue,
  selectableProviderOptionChoices,
} from "@factory/harness/models/modelTraits";
import type {
  ModelCapabilities,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@factory/harness/models/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@factory/harness/models/model";

import { translator } from "../../../../i18n/t";
import { composerDraftActions, type ComposerThreadTarget } from "./composerDraftStore";

const tk = translator("chat");

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

/**
 * All the picker reads from the prompt while rendering. Passing this instead of
 * the prompt keeps the picker from re-rendering on every keystroke.
 */
export type PromptUltrathink = "none" | "prefix" | "body";

export function readPromptUltrathink(prompt: string): PromptUltrathink {
  if (!isClaudeUltrathinkPrompt(prompt)) return "none";
  return isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, "")) ? "body" : "prefix";
}

const SAVED_OPTION_LABELS: Readonly<Record<string, string>> = {
  agent: "Agent",
  effort: "Effort",
  reasoningEffort: "Reasoning effort",
  variant: "Reasoning",
};

function savedOptionLabel(id: string): string {
  return (
    SAVED_OPTION_LABELS[id] ??
    id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase())
  );
}

function buildUnavailableModelOptionDescriptors(
  selections: ProviderOptions | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return (selections ?? []).map((selection) =>
    typeof selection.value === "boolean"
      ? {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "boolean" as const,
          currentValue: selection.value,
        }
      : {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "select" as const,
          options: [{ id: selection.value, label: selection.value }],
          currentValue: selection.value,
        },
  );
}

/** The catalog model by slug or alias. */
export function findProviderModel(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
): ServerProviderModel | undefined {
  if (!model) return undefined;
  return (
    models.find((candidate) => candidate.slug === model) ??
    models.find((candidate) => candidate.aliases?.includes(model))
  );
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
): ModelCapabilities {
  return findProviderModel(models, model)?.capabilities ?? { optionDescriptors: [] };
}

type TraitsPersistence =
  | {
      threadKey?: ComposerThreadTarget;
      /** Runs after a change is written to the draft. */
      onDraftModelOptionsChange?: (nextOptions: ProviderOptions | undefined) => void;
      onModelOptionsChange?: never;
    }
  | {
      threadKey?: undefined;
      onDraftModelOptionsChange?: never;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

function getSelectedTraits(
  _provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  promptUltrathink: PromptUltrathink,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
) {
  const caps = getProviderModelCapabilities(models, model);
  // A model that left the catalog still shows its saved options, for any harness, as a session can run on a model its viewer's catalog no longer lists.
  const modelIsUnavailable = Boolean(model) && findProviderModel(models, model) === undefined;
  const descriptors = modelIsUnavailable
    ? buildUnavailableModelOptionDescriptors(modelOptions)
    : getProviderOptionDescriptors({
        caps,
        selections: modelOptions,
      });
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptUltrathink !== "none";
  const ultrathinkInBodyText = ultrathinkPromptControlled && promptUltrathink === "body";
  const effort =
    (ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(primarySelectDescriptor)) ?? null;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    contextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    selectedAgent,
    selectedAgentLabel,
    modelIsUnavailable,
  };
}

export function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.promptUltrathink ?? "none",
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow = selected.contextWindowDescriptor !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls:
      showEffort ||
      showThinking ||
      showFastMode ||
      showContextWindow ||
      showAgent ||
      (selected.modelIsUnavailable && selected.descriptors.length > 0),
  };
}

/**
 * `modelOptions` must already carry the composer's implicit defaults (see
 * `withImplicitFastModeDefault`) so the persisted selection matches what the
 * picker would write.
 */
export function getReasoningTraitStep(input: {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderOptions | undefined;
  reportedModelSelection: ModelSelection | null | undefined;
  prompt: string;
  direction: 1 | -1;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    readPromptUltrathink(input.prompt),
    input.modelOptions,
    true,
  );
  if (selected.modelIsUnavailable || selected.ultrathinkInBodyText) return null;
  const descriptor = selected.selectDescriptors.find(isReasoningSelect);
  const choices = descriptor ? selectableProviderOptionChoices(descriptor) : [];
  if (!descriptor || choices.length < 2) return null;
  const isPrimary = descriptor.id === selected.primarySelectDescriptor?.id;
  const current =
    isPrimary && selected.ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(
          descriptor,
          { instanceId: input.instanceId, model: input.model, options: input.modelOptions ?? [] },
          input.reportedModelSelection,
        );
  // Walk the full catalog order so a typed Ultrathink keeps its place, then land on a pickable level.
  const ordered = input.direction > 0 ? descriptor.options : [...descriptor.options].reverse();
  const position =
    [current, getDescriptorStringValue(descriptor)]
      .map((value) => ordered.findIndex((option) => option.id === value))
      .find((index) => index >= 0) ?? -1;
  const next = [...ordered.slice(position + 1), ...ordered.slice(0, Math.max(position, 0))].find(
    (option) => choices.includes(option),
  );
  const change = next && getTraitSelectChange(selected, descriptor, input.prompt, next.id);
  return change?.modelOptions ? { prompt: change.prompt, modelOptions: change.modelOptions } : null;
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  /** Receives an edit of the live prompt; the picker never holds the prompt text itself. */
  onPromptEdit?: (edit: (prompt: string) => string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  allowPromptInjectedEffort?: boolean;
  triggerClassName?: string;
}

export type TraitsSelectionInput = TraitsMenuContentProps & TraitsPersistence;

/** The model's traits with their shown values, and writers that persist a change. */
export function useTraitsSelection({
  provider,
  instanceId,
  models,
  model,
  promptUltrathink,
  onPromptEdit,
  modelOptions,
  reportedModelSelection,
  allowPromptInjectedEffort = true,
  triggerClassName: _triggerClassName,
  ...persistence
}: TraitsSelectionInput) {
  const modelSelection =
    instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null;
  const updateModelOptions = (nextOptions: ProviderOptions | undefined) => {
    if ("onModelOptionsChange" in persistence && persistence.onModelOptionsChange) {
      persistence.onModelOptionsChange(nextOptions);
      return;
    }
    const threadTarget = persistence.threadKey;
    if (!threadTarget || !instanceId || !model) {
      return;
    }
    composerDraftActions.setProviderModelOptions(threadTarget, instanceId, nextOptions, {
      model,
      persistSticky: true,
    });
    persistence.onDraftModelOptionsChange?.(nextOptions);
  };
  const selected = getTraitsSectionVisibility({
    provider,
    models,
    model,
    promptUltrathink,
    modelOptions,
    allowPromptInjectedEffort,
  });
  return {
    ...selected,
    /** The option a select shows, where an Ultrathink prompt owns the primary select. */
    selectValue: (descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>) =>
      selected.ultrathinkPromptControlled && descriptor.id === selected.primarySelectDescriptor?.id
        ? "ultrathink"
        : (getDescriptorStringValue(descriptor, modelSelection, reportedModelSelection) ?? ""),
    currentLabel: (descriptor: ProviderOptionDescriptor) =>
      getProviderOptionCurrentLabel(descriptor, modelSelection, reportedModelSelection),
    changeSelect: (
      descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
      value: string,
    ) => {
      // Whether a pick applies, and the options it writes, do not depend on the prompt text.
      const change = getTraitSelectChange(selected, descriptor, "", value);
      if (!change) return;
      onPromptEdit?.(
        (prompt) => getTraitSelectChange(selected, descriptor, prompt, value)?.prompt ?? prompt,
      );
      updateModelOptions(change.modelOptions);
    },
    changeBoolean: (descriptorId: string, value: boolean) => {
      updateModelOptions(
        buildProviderOptionSelectionsFromDescriptors(
          replaceDescriptorCurrentValue(selected.descriptors, descriptorId, value),
        ),
      );
    },
  };
}

export function ultrathinkInBodyNote(): string {
  return tk("modelPicker.ultrathinkInBody");
}
