import type { MastraDBMessage } from '@mastra/core/agent-controller';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';

import { INITIAL_THREAD_MESSAGE_LIMIT, queryKeys } from '../../../../api/keys';
import { addCachedSession } from '../../../../hooks/useWorkspaces';
import { createUserSession } from '../../workspaces/services/user-sessions';
import { useChatModels } from '../context/useChatModels';
import { useChatSessionContext } from '../context/useChatSessionContext';
import { useChatThinking } from '../context/useChatThinking';
import type { PendingImage } from '../context/ComposerImagesContext';
import { AGENT_CONTROLLER_ID } from '../services/constants';
import { stashHandoffFiles } from '../services/handoffFiles';
import { promptHandoffState } from './useHandoffPrompt';
import { translator } from '../../../i18n/t';

const tk = translator('chat');

export function useCreateUserSessionFromDraft() {
  const { baseUrl, factorySessionState, claudeCode } = useChatSessionContext();
  const { activeModelId, defaultModelId } = useChatModels();
  const { override: thinkingLevelOverride } = useChatThinking();
  const { factoryId, draftSessionId } = useParams<{ factoryId: string; draftSessionId: string }>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: async ({ prompt, files }: { prompt: string; files: PendingImage[] }) => {
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

      try {
        const session = await createUserSession(baseUrl, projectRepositoryId, {
          sessionId: draftSessionId,
          title: prompt,
          // A session someone opens for themselves stays theirs until they share it.
          visibility: 'private',
        });
        return { session, prompt, files, factoryId, handoffModelId, thinkingLevelOverride: handoffThinkingLevel };
      } catch (error) {
        const message = error instanceof Error ? error.message : tk('draftSession.creationFailed');
        throw new Error(tk('draftSession.createFailed', { message }), { cause: error });
      }
    },
    onSuccess: ({ session, prompt, files, factoryId, handoffModelId, thinkingLevelOverride }) => {
      queryClient.setQueryData(queryKeys.userSession(session.sessionId), session);
      addCachedSession(queryClient, factoryId, session);
      queryClient.setQueryData<MastraDBMessage[]>(
        queryKeys.agentControllerThreadMessages(
          AGENT_CONTROLLER_ID,
          session.sessionId,
          session.sessionId,
          INITIAL_THREAD_MESSAGE_LIMIT,
        ),
        [],
      );
      stashHandoffFiles(session.sessionId, files);
      void navigate(`/factories/${factoryId}/user/threads/${session.sessionId}`, {
        replace: true,
        state: promptHandoffState(prompt, {
          modelId: handoffModelId,
          thinkingLevel: thinkingLevelOverride,
        }),
      });
    },
  });
}
