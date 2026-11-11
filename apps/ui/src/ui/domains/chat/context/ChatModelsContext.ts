import type { ThinkingLevelSetting } from '@mastra/code-sdk/thinking';
import { createContext } from 'react';

export interface ChatModelsApi {
  activeModelId: string | undefined;
  defaultModelId: string | undefined;
  /** The model a switch in flight is moving to. */
  pendingModelId: string | undefined;
  isLoading: boolean;
  error: Error | undefined;
  /** Switches the model; a `thinkingLevel` switches the level with it (a sticky pick for that model). */
  setModel: (modelId: string, thinkingLevel?: ThinkingLevelSetting) => Promise<void>;
}

export const ChatModelsContext = createContext<ChatModelsApi | null>(null);
