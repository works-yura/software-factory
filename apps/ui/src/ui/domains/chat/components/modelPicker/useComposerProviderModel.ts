// The provider instances the composer offers, which one is selected, and the model and options the
// thread resolves to on it: read from the catalog response (`toProviderInstances`), the session's
// own selection (`threadModelSelection`) and the person's pick still on its way to the session
// (the draft store), which wins while it is pending.
import type { ModelSelection, ServerProviderModel } from "@factory/harness/models/contracts";
import { ModelSelection as ModelSelectionSchema } from "@factory/harness/models/contracts";
import { MASTRA_HARNESS } from "@factory/contracts/harnesses";
import { claudeEffortForThinkingLevel } from "@factory/harness-claude-code/models/claude-code";
import { EFFORT_OPTION_ID } from "@factory/harness/models/selection";
import { MASTRA_INSTANCE_ID, mastraModelSelection } from "@factory/credentials/mastra-models";

import { useModelCatalogQuery } from "../../../../../hooks/useAvailableModels";
import { useOptionalChatCommands } from "../../context/ChatCommandsProvider";
import { useChatConnection } from "../../context/useChatConnection";
import { useChatModelCatalog } from "../../context/useChatModelCatalog";
import { useChatModels } from "../../context/useChatModels";
import { useChatSessionContext } from "../../context/useChatSessionContext";
import { useOptionalChatThinking } from "../../context/useChatThinking";
import { useComposerDraftModelState } from "./composerDraftStore";
import { getComposerPromptInjectionState, getComposerProviderState } from "./composerProviderState";
import {
  instanceForHarness,
  type ProviderInstanceEntry,
  toProviderInstances,
} from "./providerInstances";

const NO_PROVIDER_MODELS: ReadonlyArray<ServerProviderModel> = [];

/** The Factory's own pick for a harness whose sessions follow it until they pick their own. */
export interface FactoryModelDefault {
  model: string | null;
  options: ModelSelection["options"];
}

function readModelSelection(value: unknown): ModelSelection | null {
  const parsed = ModelSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function useComposerProviderModel() {
  const chatSession = useChatSessionContext();
  const { harness, claudeCode, draftSessionId, sessionId } = chatSession;
  const { catalogTarget, projectQuery } = useChatModelCatalog();
  const catalogQuery = useModelCatalogQuery(catalogTarget);
  const models = useChatModels();
  const thinking = useOptionalChatThinking();
  const { state } = useChatConnection();
  const composerDraft = useOptionalChatCommands()?.composerDraft ?? "";
  const threadKey = draftSessionId ?? sessionId;
  const draftModelState = useComposerDraftModelState(threadKey);

  const providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry> = toProviderInstances(
    catalogQuery.data,
  );
  const lockedEntry = instanceForHarness(providerInstanceEntries, harness?.id);
  const selectedProvider = lockedEntry?.driverKind ?? harness?.id ?? MASTRA_HARNESS.id;

  // The Factory's model and thinking level, which a Claude Code session follows until it picks.
  const factoryEffort = claudeEffortForThinkingLevel(projectQuery.data?.defaultThinkingLevel);
  const factoryDefault: FactoryModelDefault = {
    model: claudeCode?.model ?? lockedEntry?.defaultModel ?? null,
    options: factoryEffort ? [{ id: EFFORT_OPTION_ID, value: factoryEffort }] : [],
  };

  const threadModelSelection: ModelSelection | null = (() => {
    if (!lockedEntry) return null;
    if (lockedEntry.driverKind === MASTRA_HARNESS.id) {
      const modelId = models.pendingModelId ?? models.activeModelId;
      return modelId ? mastraModelSelection(modelId, thinking.level?.level) : null;
    }
    const reported = readModelSelection((state as { modelSelection?: unknown } | undefined)?.modelSelection);
    if (reported) return reported;
    return factoryDefault.model
      ? {
          instanceId: lockedEntry.instanceId,
          model: factoryDefault.model,
          ...(factoryDefault.options?.length ? { options: factoryDefault.options } : {}),
        }
      : null;
  })();

  const pendingPick =
    draftModelState?.modelSelectionExplicit && draftModelState.activeProvider
      ? (draftModelState.modelSelectionByProvider[draftModelState.activeProvider] ?? null)
      : null;
  const selection = pendingPick ?? threadModelSelection;
  const selectedInstanceId = selection?.instanceId ?? lockedEntry?.instanceId ?? MASTRA_INSTANCE_ID;
  const selectedProviderModels =
    providerInstanceEntries.find((entry) => entry.instanceId === selectedInstanceId)?.models ??
    NO_PROVIDER_MODELS;
  const selectedModel = selection?.model ?? "";
  const composerProviderState = getComposerProviderState({
    provider: selectedProvider,
    model: selectedModel,
    models: selectedProviderModels,
    promptInjectionState: getComposerPromptInjectionState(composerDraft),
    modelOptions: selection?.options,
  });

  return {
    catalogQuery,
    threadKey,
    providerInstanceEntries,
    lockedEntry,
    selectedInstanceId,
    selectedProvider,
    selectedProviderModels,
    selectedModel,
    composerModelOptions: selection?.options,
    threadModelSelection,
    pendingPick,
    factoryDefault,
    composerProviderState,
  };
}
