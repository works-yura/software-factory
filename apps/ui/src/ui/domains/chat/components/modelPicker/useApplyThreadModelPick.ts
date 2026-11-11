// Sends a model pick to the session its harness runs: Mastra through its model and thinking-level
// routes (the chat's models and thinking contexts, which also hold a draft's pick), any other
// harness through `POST …/sessions/:id/model` with the selection's options. A failed pick is
// released, so the picker shows what the session runs again.
import { isThinkingLevelSetting } from "@mastra/code-sdk/thinking";
import { toast } from "@mastra/playground-ui/components/Toaster";
import type { ModelSelection } from "@factory/harness/models/contracts";
import { getModelSelectionStringOptionValue } from "@factory/harness/models/model";
import { EFFORT_OPTION_ID } from "@factory/harness/models/selection";
import { MASTRA_INSTANCE_ID } from "@factory/credentials/mastra-models";

import { useSetSessionModelSelectionMutation } from "../../../../../hooks/useAgentControllerStateMutations";
import { translator } from "../../../../i18n/t";
import { useChatModels } from "../../context/useChatModels";
import { useChatSessionContext } from "../../context/useChatSessionContext";
import { useOptionalChatThinking } from "../../context/useChatThinking";
import { AGENT_CONTROLLER_ID } from "../../services/constants";
import { type ComposerThreadTarget, useComposerDraftStore, composerDraftActions } from "./composerDraftStore";

const tk = translator("chat");

/** The thread's pick still waiting to reach its session, if any. */
export function pendingThreadModelPick(target: ComposerThreadTarget): ModelSelection | null {
  const draft = useComposerDraftStore.getState().draftsByThreadKey[target];
  if (!draft?.modelSelectionExplicit || !draft.activeProvider) return null;
  return draft.modelSelectionByProvider[draft.activeProvider] ?? null;
}

/** Sets an existing thread's composer pick on the thread, so any next turn runs on it. */
export function useApplyThreadModelPick() {
  const { sessionId, baseUrl, sessionEnabled, draftSessionId } = useChatSessionContext();
  const models = useChatModels();
  const thinking = useOptionalChatThinking();
  const { mutateAsync: setModelSelection } = useSetSessionModelSelectionMutation({
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId,
    baseUrl,
    enabled: sessionEnabled,
  });

  const send = async (pick: ModelSelection) => {
    if (pick.instanceId !== MASTRA_INSTANCE_ID) {
      await setModelSelection({ modelId: pick.model, options: pick.options ?? [], instanceId: pick.instanceId });
      return;
    }
    const effort = getModelSelectionStringOptionValue(pick, EFFORT_OPTION_ID);
    const level = isThinkingLevelSetting(effort) ? effort : undefined;
    if (pick.model !== models.activeModelId) {
      // A draft's models and thinking are separate local states; a session switches both at once.
      await models.setModel(pick.model, draftSessionId ? undefined : level);
      if (draftSessionId && level) await thinking.setLevel(level);
      return;
    }
    if (level && level !== thinking.level?.level) await thinking.setLevel(level);
  };

  return async (target: ComposerThreadTarget) => {
    const pick = pendingThreadModelPick(target);
    if (!pick) return;
    // A draft of a harness without local model state keeps its pick until its session exists
    // (`useHandoffPrompt` sends it before the first prompt).
    if (draftSessionId && pick.instanceId !== MASTRA_INSTANCE_ID) return;
    try {
      await send(pick);
    } catch (error) {
      toast.error(tk("modelPicker.applyFailedTitle"), {
        description: tk("modelPicker.applyFailedDescription", {
          message: error instanceof Error ? error.message : tk("modelPicker.tryAgain"),
        }),
      });
    }
    composerDraftActions.releaseModelSelection(target, pick);
  };
}
