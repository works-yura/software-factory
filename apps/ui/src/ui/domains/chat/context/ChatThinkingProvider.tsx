import type { ThinkingLevelSetting } from '@mastra/code-sdk/thinking';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useChatModelCatalog } from './useChatModelCatalog';

import { useAgentControllerSettings } from '../../../../hooks/useAgentControllerSettings';
import { useUpdateAgentControllerSettingsMutation } from '../../../../hooks/useUpdateAgentControllerSettingsMutation';
import { useEffectiveThinkingLevel } from '../hooks/useEffectiveThinkingLevel';
import { AGENT_CONTROLLER_ID } from '../services/constants';
import { ChatThinkingContext } from './ChatThinkingContext';
import type { ChatThinkingApi } from './ChatThinkingContext';
import { useChatModels } from './useChatModels';
import { useChatSessionContext } from './useChatSessionContext';

interface ChatThinkingProviderProps {
  children: ReactNode;
}

export function ChatThinkingProvider({
  children,
  initialDraftThinkingLevel,
}: ChatThinkingProviderProps & { initialDraftThinkingLevel?: ThinkingLevelSetting }) {
  const { draftSessionId } = useChatSessionContext();
  return draftSessionId ? (
    <DraftChatThinkingProvider initialOverride={initialDraftThinkingLevel}>{children}</DraftChatThinkingProvider>
  ) : (
    <LiveChatThinkingProvider>{children}</LiveChatThinkingProvider>
  );
}

function DraftChatThinkingProvider({
  children,
  initialOverride,
}: ChatThinkingProviderProps & { initialOverride?: ThinkingLevelSetting }) {
  const { catalogTarget } = useChatModelCatalog();
  const { activeModelId } = useChatModels();
  const [override, setOverride] = useState(initialOverride);
  const { level, loadError } = useEffectiveThinkingLevel(activeModelId, override, catalogTarget);
  const value: ChatThinkingApi = {
    level,
    loadError,
    override,
    setLevel: async next => {
      setOverride(next);
    },
    resetLevel: async () => {
      setOverride(undefined);
    },
  };

  return <ChatThinkingContext.Provider value={value}>{children}</ChatThinkingContext.Provider>;
}

function LiveChatThinkingProvider({ children }: ChatThinkingProviderProps) {
  const { sessionId, baseUrl, sessionEnabled } = useChatSessionContext();
  const { catalogTarget } = useChatModelCatalog();
  const { activeModelId } = useChatModels();
  const sessionArgs = {
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId,
    baseUrl,
    enabled: sessionEnabled,
  };
  const settingsQuery = useAgentControllerSettings(sessionArgs);
  const { mutateAsync: updateSettings } = useUpdateAgentControllerSettingsMutation(sessionArgs);
  const override = settingsQuery.data?.thinkingLevel;
  const effective = useEffectiveThinkingLevel(activeModelId, override, catalogTarget);
  const settingsLoaded = settingsQuery.data !== undefined;
  const settingsLoadError = settingsQuery.error ?? undefined;
  const value: ChatThinkingApi = {
    level: settingsLoaded ? effective.level : undefined,
    loadError: settingsLoaded ? effective.loadError : settingsLoadError,
    override,
    setLevel: async next => {
      await updateSettings({ thinkingLevel: next });
    },
    resetLevel: async () => {
      await updateSettings({ thinkingLevel: null });
    },
  };

  return <ChatThinkingContext.Provider value={value}>{children}</ChatThinkingContext.Provider>;
}
