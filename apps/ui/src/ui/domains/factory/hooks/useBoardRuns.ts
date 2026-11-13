import { toast } from '@mastra/playground-ui/components/Toaster';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { translator } from '../../../i18n/t';

import { useApiConfig } from '../../../../api/config';
import { useStartFactoryRun } from '../../../../hooks/useStartFactoryRun';
import { itemSessionSpec, itemThreadSession } from '../boardItems';
import { sessionRepositoryFor } from '../boardRepository';
import { listWorkItems } from '../services/workItems';
import type { WorkItem, WorkItemSessionRef } from '../services/workItems';

const tk = translator('board');

const preparingSessionLabel = () => tk('runs.preparingSession');

/** Opening the chat session a card carries, and minting one when it has none yet. */
export function useBoardRuns({ factoryProjectId }: { factoryProjectId: string }) {
  const { baseUrl } = useApiConfig();
  const { start, startingItemIds, enabled, repositories } = useStartFactoryRun();
  const navigate = useNavigate();

  // A card click refetches items before it can decide whether to open an
  // existing thread or mint a new session. That wait is a round trip long and
  // the mutation isn't pending yet, so without this the card sits completely
  // silent after the click.
  const [preparingItems, setPreparingItems] = useState<Record<string, string>>({});
  // Guarded by a ref, not by preparingItems: two clicks landing in the same
  // render both read the pre-click state, so the state value can't reject the
  // second one.
  const preparingRef = useRef<Set<string>>(new Set());
  const beginPreparingItem = (itemId: string, label: string) => {
    if (preparingRef.current.has(itemId)) return false;
    preparingRef.current.add(itemId);
    setPreparingItems(current => ({ ...current, [itemId]: label }));
    return true;
  };
  const clearPreparingItem = (itemId: string) => {
    preparingRef.current.delete(itemId);
    setPreparingItems(current => {
      if (!(itemId in current)) return current;
      const { [itemId]: _cleared, ...rest } = current;
      return rest;
    });
  };

  const openThread = async (session: WorkItemSessionRef) => {
    navigate(`/factories/${factoryProjectId}/workspaces/${session.sessionId}/threads/${session.threadId}`);
  };

  // The clicked card alone, read fresh: it may have gained a session since it was listed, or been
  // deleted. A failed read used to be silent: an expired auth cookie made every board click a
  // no-op with no feedback. Toast so the click never dies quietly.
  const refreshItem = async (itemId: string) => {
    let cards: WorkItem[];
    try {
      cards = (await listWorkItems(baseUrl, factoryProjectId, undefined, { workItemId: [itemId] })).workItems;
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : tk('runs.refreshFailed'));
      return;
    }
    const item = cards.find(candidate => candidate.id === itemId);
    if (!item) {
      toast.error(tk('runs.cardGone'));
      return;
    }
    return item;
  };

  const openOrCreateSession = async (item: WorkItem) => {
    if (!beginPreparingItem(item.id, preparingSessionLabel())) return;
    try {
      const refreshed = await refreshItem(item.id);
      if (!refreshed) return;
      const existingSession = itemThreadSession(refreshed.sessions);
      if (existingSession) {
        await openThread(existingSession);
        return;
      }
      const spec = itemSessionSpec(refreshed);
      // The session spans the Factory's environment; nobody picks a
      // repository unless the card itself names one.
      const target = sessionRepositoryFor(repositories, refreshed);
      if ('error' in target) {
        toast.error(
          target.error === 'unlinked'
            ? tk('runs.repositoryNotLinked', { repository: target.slug })
            : target.error === 'environment'
              ? tk('runs.noEnvironmentRepository')
              : tk('runs.noMatchingRepository'),
        );
        return;
      }
      await start.mutateAsync({
        branch: spec.branch,
        threadTitle: spec.threadTitle,
        workItem: {
          id: refreshed.id,
          role: 'chat',
          source: refreshed.source,
          sourceKey: refreshed.sourceKey,
          title: refreshed.title,
          metadata: refreshed.metadata,
          workItem: refreshed.workItem,
        },
      });
    } finally {
      clearPreparingItem(item.id);
    }
  };

  return {
    enabled,
    error: start.error,
    preparingFor: (itemId: string): string | undefined =>
      preparingItems[itemId] ?? (startingItemIds.includes(itemId) ? preparingSessionLabel() : undefined),
    openThread,
    refreshItem,
    openOrCreateSession,
  };
}
