import type { MastraDBMessage } from '@mastra/core/agent-controller';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';

import { INITIAL_THREAD_MESSAGE_LIMIT, queryKeys } from '../../../../api/keys';
import { addCachedSession } from '../../../../hooks/useWorkspaces';
import { createUserSession, DraftSessionCreateError } from '../../workspaces/services/user-sessions';
import type { FactoryUserSession } from '../../workspaces/services/user-sessions';
import { useChatModels } from '../context/useChatModels';
import { useChatSessionContext } from '../context/useChatSessionContext';
import { useChatThinking } from '../context/useChatThinking';
import type { PendingImage } from '../context/ComposerImagesContext';
import { AGENT_CONTROLLER_ID } from '../services/constants';
import { stashHandoffFiles } from '../services/handoffFiles';
import { startPromptHandoff } from './useHandoffPrompt';
import { translator } from '../../../i18n/t';

const tk = translator('chat');

/**
 * Starts the draft's session and opens its thread without waiting for the
 * server: the create runs under the session's query key, which the thread
 * route reads, so the thread waits on this create instead of reading a session
 * that does not exist yet. The server takes the draft's id, so a repeated
 * create returns the same session.
 */
export function useCreateUserSessionFromDraft() {
  const { baseUrl, factorySessionState, claudeCode } = useChatSessionContext();
  const { activeModelId, defaultModelId } = useChatModels();
  const { override: thinkingLevelOverride } = useChatThinking();
  const { factoryId, draftSessionId } = useParams<{ factoryId: string; draftSessionId: string }>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return ({ prompt, files }: { prompt: string; files: PendingImage[] }) => {
    const projectRepositoryId = factorySessionState?.projectRepositoryId;
    if (!draftSessionId || !factoryId || !projectRepositoryId) {
      throw new Error(tk('draftSession.reload'));
    }
    // A Claude Code session runs on its Factory's Claude model: no Mastra model or thinking level to hand off.
    if (!claudeCode && !activeModelId) {
      throw new Error(tk('draftSession.configNotReady'));
    }

    const draftKeepsServerDefaults = claudeCode || (activeModelId === defaultModelId && !thinkingLevelOverride);
    const handoffModelId = draftKeepsServerDefaults ? undefined : activeModelId;
    const handoffThinkingLevel = claudeCode ? undefined : thinkingLevelOverride;
    const draftPath = `/factories/${factoryId}/user/new/${draftSessionId}`;
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.userSession(draftSessionId),
        queryFn: async (): Promise<FactoryUserSession> => {
          let session: FactoryUserSession;
          try {
            session = await createUserSession(baseUrl, projectRepositoryId, {
              sessionId: draftSessionId,
              title: prompt,
              // A session someone opens for themselves stays theirs until they share it.
              visibility: 'private',
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : tk('draftSession.creationFailed');
            throw new DraftSessionCreateError(
              tk('draftSession.createFailed', { message }),
              { prompt, modelId: handoffModelId, thinkingLevel: handoffThinkingLevel },
              draftPath,
              { cause: error },
            );
          }
          addCachedSession(queryClient, factoryId, session);
          return session;
        },
      })
      .catch(() => undefined);
    // A new session has no history, so the thread opens on an empty transcript
    // instead of waiting on a history read the session cannot answer yet.
    queryClient.setQueryData<MastraDBMessage[]>(
      queryKeys.agentControllerThreadMessages(
        AGENT_CONTROLLER_ID,
        draftSessionId,
        draftSessionId,
        INITIAL_THREAD_MESSAGE_LIMIT,
      ),
      [],
    );
    stashHandoffFiles(draftSessionId, files);
    void navigate(`/factories/${factoryId}/user/threads/${draftSessionId}`, {
      replace: true,
      state: startPromptHandoff(draftSessionId, prompt, {
        modelId: handoffModelId,
        thinkingLevel: handoffThinkingLevel,
      }),
    });
  };
}
