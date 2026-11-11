import type { AgentControllerThinkingLevel } from '@mastra/client-js';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { ModelSelection, ProviderOptionSelection } from '@factory/harness/models/contracts';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { translator } from '../ui/i18n/t';
import type { AgentControllerMutationArgs } from './agentControllerMutationArgs';
import {
  createAgentControllerClient,
  requireAgentControllerSession,
} from '../ui/domains/chat/services/agentControllerClient';

const tk = translator('chat');

export function useSetAgentControllerStateMutation({
  agentControllerId,
  sessionId,
  baseUrl = '',
  enabled = true,
}: AgentControllerMutationArgs) {
  const queryClient = useQueryClient();
  const { session } = createAgentControllerClient({ agentControllerId, sessionId, baseUrl, enabled });

  return useMutation({
    mutationFn: (updates: Record<string, unknown>) => requireAgentControllerSession(session).setState(updates),
    onSuccess: async (_data, updates) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentControllerConnectionState(agentControllerId, sessionId),
        }),
        'settings' in updates
          ? queryClient.invalidateQueries({
              queryKey: queryKeys.agentControllerSettings(agentControllerId, sessionId),
              exact: true,
            })
          : Promise.resolve(),
      ]);
    },
  });
}

interface ModelSwitch {
  modelId: string;
  thinkingLevel?: AgentControllerThinkingLevel;
}

export function useSwitchAgentControllerModelMutation(args: AgentControllerMutationArgs) {
  const queryClient = useQueryClient();
  const { session } = createAgentControllerClient(args);

  return useMutation({
    mutationFn: ({ modelId, thinkingLevel }: ModelSwitch) =>
      requireAgentControllerSession(session).switchModel(modelId, { thinkingLevel }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentControllerConnectionState(args.agentControllerId, args.sessionId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentControllerSettings(args.agentControllerId, args.sessionId),
          exact: true,
        }),
      ]),
  });
}

interface SessionModelSelectionUpdate {
  /** A catalog slug or alias; null clears the session's own pick back to its Factory's. */
  modelId: string | null;
  options?: ReadonlyArray<ProviderOptionSelection>;
  /**
   * The instance the pick came from. One of another harness moves the session there with a context
   * handoff where the server accepts it (`acceptsHandoff`); elsewhere the server refuses it.
   */
  instanceId?: string;
}

/** A session's move to another harness, as the model route reports it. */
export interface SessionHarnessHandoff {
  id: string;
  fromInstanceId: string;
  toInstanceId: string;
  harnessId: string;
}

export interface SessionModelSelectionResult {
  ok: true;
  modelSelection: ModelSelection | null;
  appliesFrom?: 'now' | 'next-turn';
  /** Set when the pick moved the session to another harness. */
  handoff?: SessionHarnessHandoff;
}

/**
 * Sets a session's model selection with its options (`POST …/sessions/:id/model`), the route the
 * session's harness answers through its model facet (Claude Code: effort, fast mode, context window,
 * Ultracode). Mastra's client only sends `{ modelId, thinkingLevel }`, so this posts directly. A
 * pick that moved the session to another harness also refreshes the session (its harness) and its
 * model catalog, so the composer follows the harness it runs on now.
 */
export function useSetSessionModelSelectionMutation(args: AgentControllerMutationArgs) {
  const queryClient = useQueryClient();
  const { client } = useApiConfig();

  return useMutation({
    mutationFn: ({ modelId, options, instanceId }: SessionModelSelectionUpdate) => {
      if (args.enabled === false) throw new Error(tk('errors.sessionUnavailable'));
      return client.post<SessionModelSelectionResult>(
        `/api/agent-controller/${encodeURIComponent(args.agentControllerId)}/sessions/${encodeURIComponent(args.sessionId)}/model`,
        { modelId, ...(options ? { options } : {}), ...(instanceId ? { instanceId } : {}) },
      );
    },
    onSuccess: async result => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentControllerConnectionState(args.agentControllerId, args.sessionId),
        }),
        ...(result?.handoff
          ? [
              queryClient.invalidateQueries({ queryKey: queryKeys.userSession(args.sessionId) }),
              queryClient.invalidateQueries({ queryKey: queryKeys.availableModels() }),
              queryClient.invalidateQueries({ queryKey: queryKeys.agentControllerSettings(args.agentControllerId, args.sessionId) }),
            ]
          : []),
      ]);
    },
  });
}
