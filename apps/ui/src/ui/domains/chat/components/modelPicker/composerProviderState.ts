// The composer's per-provider option state. There are no increase/decrease-effort shortcuts, and
// a model outside the catalog gets no saved-options fallback here.
import type {
  ModelCapabilities,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@factory/harness/models/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@factory/harness/models/model";

import type { ComposerThreadTarget } from "./composerDraftStore";
import {
  getProviderModelCapabilities,
  type PromptUltrathink,
  type TraitsSelectionInput,
} from "./TraitsPicker";

type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  promptInjectionState?: ComposerPromptInjectionState;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
};

type ComposerPromptInjectionState = "none" | "ultrathink";

type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type ComposerTraitsTarget = {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  threadKey?: ComposerThreadTarget | undefined;
  onDraftModelOptionsChange?: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  promptUltrathink: PromptUltrathink;
  onPromptEdit: (edit: (prompt: string) => string) => void;
};

export function getComposerPromptInjectionState(prompt: string): ComposerPromptInjectionState {
  return isClaudeUltrathinkPrompt(prompt) ? "ultrathink" : "none";
}

/** Cursor ACP can default Fast to true; Factory requires a user selection. */
export function withImplicitFastModeDefault(
  caps: ModelCapabilities,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const hasExplicitFastMode = modelOptions?.some((selection) => selection.id === "fastMode");
  if (hasExplicitFastMode) {
    return modelOptions ?? undefined;
  }
  const hasFastModeDescriptor = caps.optionDescriptors?.some(
    (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
  );
  if (!hasFastModeDescriptor) {
    return modelOptions ?? undefined;
  }
  return [...(modelOptions ?? []), { id: "fastMode", value: false }];
}

function resolveComposerOptionSelections(
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): {
  caps: ModelCapabilities;
  selections: ReadonlyArray<ProviderOptionSelection> | undefined;
} {
  const caps = getProviderModelCapabilities(models, model);
  return { caps, selections: withImplicitFastModeDefault(caps, modelOptions) };
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const { provider, model, models, modelOptions, promptInjectionState = "none" } = input;
  const { caps, selections } = resolveComposerOptionSelections(models, model, modelOptions);
  const descriptors = getProviderOptionDescriptors({ caps, selections });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptInjectionState === "ultrathink";

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildExplicitProviderOptionSelectionsFromDescriptors(
      descriptors,
      selections,
    ),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

/**
 * The composer's traits input with the model's implicit defaults applied, so a pick writes what
 * the composer would send.
 */
export function resolveComposerTraitsInput(input: ComposerTraitsTarget): TraitsSelectionInput {
  const { threadKey, ...rest } = input;
  const { selections } = resolveComposerOptionSelections(
    input.models,
    input.model,
    input.modelOptions,
  );
  return { ...rest, ...(threadKey ? { threadKey } : {}), modelOptions: selections };
}
