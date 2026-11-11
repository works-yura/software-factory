import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { isRecord } from '../lib/isRecord';
import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { AGENT_CONTROLLER_ID } from '../ui/domains/chat/services/constants';
import { createUserSession } from '../ui/domains/workspaces/services/user-sessions';
import { useFactoryQuery } from './useFactories';
import { sessionRepositoryFor } from '../ui/domains/factory/boardRepository';
import { startFactoryRun, updateWorkItem } from '../ui/domains/factory/services/workItems';
import type { WorkItem, WorkItemSource } from '../ui/domains/factory/services/workItems';
import { translator } from '../ui/i18n/t';

const tk = translator('app');

export interface StartFactoryRunWorkItem {
  id: string;
  role: string;
  source: WorkItemSource;
  sourceKey: string | null;
  parentWorkItemId?: string;
  title: string;
  url?: string | null;
  metadata?: Record<string, unknown>;
  workItem?: WorkItem['workItem'];
}

export interface StartFactoryRunInput {
  branch: string;
  threadTitle: string;
  workItem: StartFactoryRunWorkItem;
}

/**
 * Open the card's own session: create the durable Factory session, then hand
 * session/thread creation, binding and board persistence to the server
 * coordinator. The card does not move — a lane transition is what starts a run.
 */
export function useStartFactoryRun() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const factoryQuery = useFactoryQuery(factoryId);
  const repositories = factoryQuery.data?.repositories ?? [];
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();

  const startMutationKey = ['factory', 'start-run', factoryId] as const;
  const mutation = useMutation({
    mutationKey: startMutationKey,
    mutationFn: async ({ branch, threadTitle, workItem }: StartFactoryRunInput) => {
      if (!factoryId) throw new Error('A Factory session needs a factory in the route');
      // A card that names no repository runs across the environment: the
      // session row is filed under its first repository and the card stays
      // unbound, so every environment repository is equally its own.
      const target = sessionRepositoryFor(repositories, workItem);
      if ('error' in target) throw new Error(tk('errors.noEnvironmentRepository'));
      const { repository, namedByCard } = target;
      // A normalized card patches only the repository: its provider facts are the work item's, not the board's.
      const metadata = namedByCard
        ? workItem.workItem
          ? { repository: repository.slug }
          : { ...workItem.metadata, repository: repository.slug }
        : { ...workItem.metadata };
      if (namedByCard && workItem.metadata?.repository !== repository.slug) {
        await updateWorkItem(baseUrl, workItem.id, { metadata });
      }
      const userSession = await createUserSession(baseUrl, repository.projectRepositoryId, { branch });
      const sessionId = userSession.sessionId;

      const prepared = await startFactoryRun(baseUrl, factoryId, {
        sessionId,
        threadTitle,
        kickoffKey: crypto.randomUUID(),
        workItem: {
          id: workItem.id,
          role: workItem.role,
          input: {
            source: workItem.source,
            sourceKey: workItem.sourceKey,
            parentWorkItemId: workItem.parentWorkItemId,
            title: workItem.title,
            url: workItem.url ?? null,
            metadata,
          },
        },
      });

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentControllerThreads(AGENT_CONTROLLER_ID, sessionId),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workItems(factoryId) }),
        // The session was just minted. Without this the sidebar keeps serving
        // its cached list and it only appears once some later navigation
        // happens to refetch it.
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions(factoryId) }),
      ]);
      return { factoryId, sessionId, threadId: prepared.threadId, threadTitle };
    },
  });

  const startingItemIds = useMutationState({
    filters: { mutationKey: startMutationKey, status: 'pending' },
    select: pending => startingWorkItemId(pending.state.variables),
  }).filter(itemId => itemId !== undefined);

  return {
    start: mutation,
    startingItemIds,
    enabled: Boolean(factoryId && repositories.length > 0),
    repositories,
  };
}

function startingWorkItemId(variables: unknown): string | undefined {
  if (!isRecord(variables) || !isRecord(variables.workItem)) return undefined;
  return typeof variables.workItem.id === 'string' ? variables.workItem.id : undefined;
}
