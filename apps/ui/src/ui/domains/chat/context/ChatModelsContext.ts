import { createContext } from 'react';

export interface ChatModelsApi {
  activeModelId: string | undefined;
  defaultModelId: string | undefined;
  /** The model a switch in flight is moving to. */
  pendingModelId: string | undefined;
  isLoading: boolean;
  error: Error | undefined;
  setModel: (modelId: string) => Promise<void>;
}

export const ChatModelsContext = createContext<ChatModelsApi | null>(null);
