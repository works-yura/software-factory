import type { ReactNode } from 'react';
import { useState } from 'react';

import { useChatModelCatalog } from './useChatModelCatalog';
import { useSwitchAgentControllerModelMutation } from '../../../../hooks/useAgentControllerStateMutations';
import { AGENT_CONTROLLER_ID } from '../services/constants';
import { ChatModelsContext } from './ChatModelsContext';
import type { ChatModelsApi } from './ChatModelsContext';
import { useChatConnection } from './useChatConnection';
import { useChatSessionContext } from './useChatSessionContext';

interface ChatModelsProviderProps {
  children: ReactNode;
}

export function ChatModelsProvider({ children }: ChatModelsProviderProps) {
  const { draftSessionId } = useChatSessionContext();
  return draftSessionId ? (
    <DraftChatModelsProvider>{children}</DraftChatModelsProvider>
  ) : (
    <LiveChatModelsProvider>{children}</LiveChatModelsProvider>
  );
}

function DraftChatModelsProvider({ children }: ChatModelsProviderProps) {
  const { projectQuery: factoryProjectQuery } = useChatModelCatalog();
  const [draftModelId, setDraftModelId] = useState<string>();
  const defaultModelId = factoryProjectQuery.data?.defaultModelId ?? undefined;
  const value: ChatModelsApi = {
    activeModelId: draftModelId ?? defaultModelId,
    defaultModelId,
    isLoading: factoryProjectQuery.isPending,
    error: factoryProjectQuery.error ?? undefined,
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
  const { mutateAsync: switchModel } = useSwitchAgentControllerModelMutation({
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId,
    baseUrl,
    enabled: sessionEnabled,
  });
  const value: ChatModelsApi = {
    activeModelId: state?.modelId,
    defaultModelId,
    isLoading: sessionModelsQuery.isPending,
    error: sessionModelsQuery.error ?? undefined,
    setModel: modelId => switchModel({ modelId }),
  };

  return <ChatModelsContext.Provider value={value}>{children}</ChatModelsContext.Provider>;
}
