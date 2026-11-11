// The composer's model selection, with `getStartedThreadModelChangeBlockReason`. A pick on the
// thread's own harness instance is written to the draft store, remembered as sticky and sent to
// the session at once (`useApplyThreadModelPick`); a pick on another harness gets a "Start a new
// chat to switch providers" toast, since a chat cannot be handed over to another harness. Runtime
// mode, worktree and branch choices stay in their own controls.
import type { ModelSelection, ProviderInstanceId, ProviderOptionSelection } from "@factory/harness/models/contracts";
import { MASTRA_HARNESS } from "@factory/contracts/harnesses";
import { modelSelectionsEqual } from "@factory/harness/models/model";
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

  const origin = ((): SelectionOrigin | null => {
    const source = factoryThinkingSourceLabel();
    if (lockedEntry?.driverKind === MASTRA_HARNESS.id) {
      if (!thinking.level) return null;
      const setForSession = thinking.level.origin === "session";
      return {
        source,
        setForSession,
        onUseDefault: () => {
          void thinking.resetLevel().catch((cause: unknown) =>
            toast.error(cause instanceof Error ? cause.message : tk("thinking.resetFailed")),
          );
        },
      };
    }
    const current = pendingPick ?? threadModelSelection;
    if (!current) return null;
    // The session follows its Factory until its selection differs from the Factory's.
    const factoryModel = factoryDefault.model
      ? findInstanceModel(providerInstanceEntries, {
          instanceId: current.instanceId,
          model: factoryDefault.model,
        })?.slug ?? factoryDefault.model
      : null;
    const sessionModel = findInstanceModel(providerInstanceEntries, current)?.slug ?? current.model;
    const setForSession =
      sessionModel !== factoryModel || !optionsEqual(current.options, factoryDefault.options);
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

function optionsEqual(
  left: ReadonlyArray<ProviderOptionSelection> | undefined,
  right: ReadonlyArray<ProviderOptionSelection> | undefined,
): boolean {
  const key = (options: ReadonlyArray<ProviderOptionSelection> | undefined) =>
    JSON.stringify([...(options ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
  return key(left) === key(right);
}
