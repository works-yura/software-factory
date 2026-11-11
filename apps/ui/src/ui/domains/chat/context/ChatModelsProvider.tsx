import type { ReactNode } from 'react';
import { useState } from 'react';

import { useChatModelCatalog } from './useChatModelCatalog';
import { useFallbackModelQuery } from '../../../../hooks/useAvailableModels';
import { useSwitchAgentControllerModelMutation } from '../../../../hooks/useAgentControllerStateMutations';
import { AGENT_CONTROLLER_ID } from '../services/constants';
import { ChatModelsContext } from './ChatModelsContext';
import type { ChatModelsApi } from './ChatModelsContext';
import { useChatConnection } from './useChatConnection';
import { useChatSessionContext } from './useChatSessionContext';

interface ChatModelsProviderProps {
  children: ReactNode;
}

export function ChatModelsProvider({
  children,
  initialDraftModelId,
}: ChatModelsProviderProps & { initialDraftModelId?: string }) {
  const { draftSessionId } = useChatSessionContext();
  return draftSessionId ? (
    <DraftChatModelsProvider initialModelId={initialDraftModelId}>{children}</DraftChatModelsProvider>
  ) : (
    <LiveChatModelsProvider>{children}</LiveChatModelsProvider>
  );
}

function DraftChatModelsProvider({ children, initialModelId }: ChatModelsProviderProps & { initialModelId?: string }) {
  const { projectQuery: factoryProjectQuery, catalogTarget } = useChatModelCatalog();
  const [draftModelId, setDraftModelId] = useState(initialModelId);
  const defaultModelId = factoryProjectQuery.data?.defaultModelId ?? undefined;
  // No Factory default: the draft starts on the server's built-in pick, as the session will.
  const usesFallback = factoryProjectQuery.isSuccess && !defaultModelId;
  const fallbackModelQuery = useFallbackModelQuery({ ...catalogTarget, enabled: usesFallback });
  const value: ChatModelsApi = {
    activeModelId: draftModelId ?? defaultModelId ?? fallbackModelQuery.data,
    defaultModelId,
    pendingModelId: undefined,
    isLoading: factoryProjectQuery.isPending || (usesFallback && fallbackModelQuery.isPending),
    error: factoryProjectQuery.error ?? (usesFallback ? fallbackModelQuery.error : null) ?? undefined,
    setModel: modelId => {
      setDraftModelId(modelId);
      return Promise.resolve();
    },
  };

  return <ChatModelsContext.Provider value={value}>{children}</ChatModelsContext.Provider>;
}

function LiveChatModelsProvider({ children }: ChatModelsProviderProps) {
  const { sessionId, baseUrl, sessionEnabled } = useChatSessionContext();
  const { state } = useChatConnection();
  const { projectQuery, sessionModelsQuery } = useChatModelCatalog();
  const localDefaultModelId = projectQuery.data?.defaultModelId;
  const defaultModelId = sessionModelsQuery.isSuccess
    ? (('defaultModelId' in sessionModelsQuery.data ? sessionModelsQuery.data.defaultModelId : localDefaultModelId) ??
      undefined)
    : undefined;
  const {
    mutateAsync: switchModel,
    isPending: switching,
    variables: switchingTo,
  } = useSwitchAgentControllerModelMutation({
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId,
    baseUrl,
    enabled: sessionEnabled,
  });
  const value: ChatModelsApi = {
    activeModelId: state?.modelId,
    defaultModelId,
    pendingModelId: switching ? switchingTo?.modelId : undefined,
    isLoading: sessionModelsQuery.isPending,
    error: sessionModelsQuery.error ?? undefined,
    setModel: (modelId, thinkingLevel) => switchModel({ modelId, ...(thinkingLevel ? { thinkingLevel } : {}) }),
  };

  return <ChatModelsContext.Provider value={value}>{children}</ChatModelsContext.Provider>;
}
