import { useContext } from 'react';

import { ChatThinkingContext } from './ChatThinkingContext';
import type { ChatThinkingApi } from './ChatThinkingContext';

export function useChatThinking(): ChatThinkingApi {
  const ctx = useContext(ChatThinkingContext);
  if (!ctx) throw new Error('useChatThinking must be used within a ChatSessionProvider');
  return ctx;
}

const NO_THINKING: ChatThinkingApi = {
  level: undefined,
  loadError: undefined,
  override: undefined,
  setLevel: () => Promise.reject(new Error('No thinking level in this chat')),
  resetLevel: () => Promise.reject(new Error('No thinking level in this chat')),
};

/** The chat's thinking level, or none where a surface is drawn without the thinking context. */
export function useOptionalChatThinking(): ChatThinkingApi {
  return useContext(ChatThinkingContext) ?? NO_THINKING;
}
