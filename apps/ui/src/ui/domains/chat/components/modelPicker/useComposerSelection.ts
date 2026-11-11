// The composer's model selection, with `getStartedThreadModelChangeBlockReason`. A pick on the
// thread's own harness instance is written to the draft store, remembered as sticky and sent to
// the session at once (`useApplyThreadModelPick`); a pick on another harness gets a "Start a new
// chat to switch providers" toast, since a chat cannot be handed over to another harness. Runtime
// mode, worktree and branch choices stay in their own controls.
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@factory/harness/models/contracts";
import { MASTRA_HARNESS } from "@factory/contracts/harnesses";
import {
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  modelSelectionsEqual,
} from "@factory/harness/models/model";
import { toast } from "@mastra/playground-ui/components/Toaster";
import { formatModelName } from "@mastra/playground-ui/utils/model";
import { useNavigate, useParams } from "react-router";

import { settingsSectionPath } from "../../../settings/settingsSections";
import { translator } from "../../../../i18n/t";
import { useOptionalChatCommands } from "../../context/ChatCommandsProvider";
import { useChatSessionContext } from "../../context/useChatSessionContext";
import { useChatModels } from "../../context/useChatModels";
import { useOptionalChatThinking } from "../../context/useChatThinking";
import { factoryThinkingSourceLabel } from "../../services/thinkingLevels";
import type { SelectionOrigin } from "./ComposerModelEffort";
import { composerDraftActions, useComposerDraftStore } from "./composerDraftStore";
import { resolveComposerTraitsInput } from "./composerProviderState";
import type { ModelEsque } from "./providerIconUtils";
import { findInstanceModel } from "./providerInstances";
import { readPromptUltrathink } from "./TraitsPicker";
import { useApplyThreadModelPick } from "./useApplyThreadModelPick";
import { useComposerProviderModel } from "./useComposerProviderModel";
import { useSetSessionModelSelectionMutation } from "../../../../../hooks/useAgentControllerStateMutations";
import { AGENT_CONTROLLER_ID } from "../../services/constants";

const tk = translator("chat");

export function getStartedThreadModelChangeBlockReason(input: {
  hasStartedSession: boolean;
  supportsProviderSwitchingViaHandoff?: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }
  const currentModelSelection = {
    ...input.currentModelSelection,
    instanceId: input.currentProviderInstanceId ?? input.currentModelSelection.instanceId,
  };
  if (
    currentModelSelection.instanceId === input.nextModelSelection.instanceId ||
    input.supportsProviderSwitchingViaHandoff === true
  ) {
    return null;
  }
  return {
    title: tk("modelPicker.switchBlockedTitle"),
    description: tk("modelPicker.switchBlockedDescription"),
  };
}

/** The composer's model choice for the next turn: the picker's state and what its picks do. */
export function useComposerSelection() {
  const navigate = useNavigate();
  const { factoryId } = useParams<{ factoryId: string }>();
  const { sessionId, baseUrl, sessionEnabled, draftSessionId } = useChatSessionContext();
  const setComposerDraft = useOptionalChatCommands()?.setComposerDraft;
  const thinking = useOptionalChatThinking();
  const models = useChatModels();
  const providerModel = useComposerProviderModel();
  const {
    threadKey,
    providerInstanceEntries,
    lockedEntry,
    selectedInstanceId,
    selectedProvider,
    selectedProviderModels,
    selectedModel,
    composerModelOptions,
    threadModelSelection,
    pendingPick,
    factoryDefault,
  } = providerModel;
  const applyThreadModelPick = useApplyThreadModelPick();
  const { mutateAsync: setSessionModelSelection } = useSetSessionModelSelectionMutation({
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId,
    baseUrl,
    enabled: sessionEnabled,
  });
  const composerDraft = useOptionalChatCommands()?.composerDraft ?? "";

  const openProviderSetup = (_instanceId: ProviderInstanceId) => {
    if (factoryId) void navigate(settingsSectionPath(factoryId, "models"));
  };

  const onProviderModelSelect = (instanceId: ProviderInstanceId, model: string) => {
    const resolvedModel = findInstanceModel(providerInstanceEntries, { instanceId, model })?.slug;
    if (!resolvedModel) return;
    const rememberedOptions =
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[instanceId]?.[resolvedModel];
    const nextModelSelection: ModelSelection =
      rememberedOptions !== undefined && rememberedOptions.length > 0
        ? { instanceId, model: resolvedModel, options: [...rememberedOptions] }
        : { instanceId, model: resolvedModel };
    // A chat runs on one harness from its first message (a draft on its Factory's).
    const currentModelSelection = threadModelSelection ?? {
      instanceId: lockedEntry?.instanceId ?? instanceId,
      model: selectedModel,
    };
    const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
      hasStartedSession: true,
      supportsProviderSwitchingViaHandoff: false,
      currentModelSelection,
      currentProviderInstanceId: lockedEntry?.instanceId ?? null,
      nextModelSelection,
    });
    if (modelChangeBlockReason) {
      toast.warning(modelChangeBlockReason.title, {
        description: modelChangeBlockReason.description,
      });
      return;
    }
    if (pendingPick === null && threadModelSelection && modelSelectionsEqual(threadModelSelection, nextModelSelection)) {
      return;
    }
    composerDraftActions.setModelSelection(threadKey, nextModelSelection, {
      explicit: true,
      replaceOptions: true,
    });
    composerDraftActions.setStickyModelSelection(nextModelSelection);
    void applyThreadModelPick(threadKey);
  };

  // v4's thinking control said why a Mastra session's level is not shown yet; the column does now.
  const effortUnavailableReason = ((): string | undefined => {
    if (selectedProvider !== MASTRA_HARNESS.id) return undefined;
    if (providerModel.catalogQuery.isPending) return tk("thinking.catalogLoading");
    if (thinking.loadError) return tk("thinking.loadFailed");
    if (!thinking.level) return tk("thinking.notLoaded");
    if (models.pendingModelId) return tk("thinking.switchingModel");
    return undefined;
  })();

  const traits = selectedModel && !effortUnavailableReason
    ? resolveComposerTraitsInput({
        provider: selectedProvider,
        instanceId: selectedInstanceId,
        threadKey,
        // The options were written to the draft store: send them on.
        onDraftModelOptionsChange: () => void applyThreadModelPick(threadKey),
        model: selectedModel,
        models: selectedProviderModels,
        modelOptions: composerModelOptions,
        reportedModelSelection: threadModelSelection,
        promptUltrathink: readPromptUltrathink(composerDraft),
        onPromptEdit: (edit) => setComposerDraft?.(edit(composerDraft)),
      })
    : null;

  // Where the selection comes from, against the one default every harness reports (its Factory's,
  // else its catalog's): the footer's "Follows the Factory default" / "Set for this session".
  const origin = ((): SelectionOrigin | null => {
    const source = factoryThinkingSourceLabel();
    const current = pendingPick ?? threadModelSelection;
    if (!current) return null;
    const resolve = (model: string) =>
      findInstanceModel(providerInstanceEntries, { instanceId: current.instanceId, model })?.slug ?? model;
    const factoryModel = factoryDefault.model ? resolve(factoryDefault.model) : null;
    const modelDiffers = resolve(current.model) !== factoryModel;
    if (lockedEntry?.driverKind === MASTRA_HARNESS.id) {
      // A Mastra session keeps its thinking level on its live state, which says whether it is its own.
      if (!thinking.level) return null;
      const thinkingOwn = thinking.level.origin === "session";
      return {
        source,
        setForSession: modelDiffers || thinkingOwn,
        onUseDefault: () => {
          const resets: Array<Promise<unknown>> = [];
          if (pendingPick) composerDraftActions.releaseModelSelection(threadKey, pendingPick);
          else if (modelDiffers && factoryModel && !draftSessionId) {
            resets.push(setSessionModelSelection({ modelId: factoryModel }));
          }
          if (thinkingOwn) resets.push(thinking.resetLevel());
          void Promise.all(resets).catch((cause: unknown) =>
            toast.error(cause instanceof Error ? cause.message : tk("thinking.resetFailed")),
          );
        },
      };
    }
    const setForSession =
      modelDiffers ||
      !optionsEqual(current.options, factoryDefault.options, findInstanceModel(providerInstanceEntries, current));
    return {
      source,
      setForSession,
      onUseDefault: draftSessionId
        ? () => {
            if (pendingPick) composerDraftActions.releaseModelSelection(threadKey, pendingPick);
          }
        : () => {
            void setSessionModelSelection({ modelId: null }).catch((cause: unknown) =>
              toast.error(cause instanceof Error ? cause.message : tk("modelPicker.switchFailed")),
            );
          },
    };
  })();

  // The thread's model stays listed, marked unavailable, when the catalog no longer has it.
  const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>(
    providerInstanceEntries.map((entry) => [entry.instanceId, entry.models]),
  );
  if (selectedModel && !findInstanceModel(providerInstanceEntries, { instanceId: selectedInstanceId, model: selectedModel })) {
    modelOptionsByInstance.set(selectedInstanceId, [
      ...(modelOptionsByInstance.get(selectedInstanceId) ?? []),
      { slug: selectedModel, name: formatModelName(selectedModel), isUnavailable: true },
    ]);
  }

  return {
    ...providerModel,
    modelOptionsByInstance,
    traits,
    effortUnavailableReason,
    origin,
    onProviderModelSelect,
    openProviderSetup,
  };
}

/**
 * Whether two option lists pick the same thing on `model`: an option left out reads as the
 * model's own default, so `[]` and an explicit default level are the same pick.
 */
function optionsEqual(
  left: ReadonlyArray<ProviderOptionSelection> | undefined,
  right: ReadonlyArray<ProviderOptionSelection> | undefined,
  model: ServerProviderModel | undefined,
): boolean {
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  const resolved = (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
    const values = new Map<string, unknown>();
    for (const descriptor of getProviderOptionDescriptors({ caps: model?.capabilities ?? {}, selections: options ?? [] })) {
      const value = getProviderOptionCurrentValue(descriptor);
      values.set(descriptor.id, descriptor.type === "boolean" ? value === true : value);
    }
    // Options the model does not describe count as they are.
    for (const option of options ?? []) {
      if (!descriptors.some((descriptor) => descriptor.id === option.id)) values.set(option.id, option.value);
    }
    return values;
  };
  const a = resolved(left);
  const b = resolved(right);
  return a.size === b.size && [...a].every(([id, value]) => b.get(id) === value);
}
