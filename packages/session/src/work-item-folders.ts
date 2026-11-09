import { workItemSource } from '@factory/core';
import { isWorkItemBranch, workItemBranch } from '@factory/pipelines';
import { workItemFolder } from '@factory/sandbox';
import type { WorkItemFolder, WorkItemFolders } from '@factory/sandbox';
import type { WorkItemsStorage } from '@factory/store';

type FolderWorkItems = Pick<WorkItemsStorage, 'listWorkItemIdsForSession' | 'get' | 'listRunBindings'>;

/**
 * Where the sessions of a card work: one folder per card, named after the
 * card's branch. A session works a card when it is on the card's branch (the
 * branch every card run, and the board's card session, is opened on) or when
 * a run bound it to the card (a role session started on its own branch).
 * Everything is derived from the session row and the card on every call,
 * never from a stored workdir, so a restarted server finds the folder again.
 *
 * A session bound to several cards is refused: it cannot work in two folders.
 */
export function createWorkItemFolders({ workItems }: { workItems?: FolderWorkItems }): WorkItemFolders {
  // A session is bound to its card once and for good, so the card it was found
  // bound to is remembered; a session found unbound is asked again next time.
  const boundCards = new Map<string, string>();

  const boundCard = async (session: {
    sessionId: string;
    orgId: string;
    factoryProjectId: string;
  }): Promise<string | undefined> => {
    const known = boundCards.get(session.sessionId);
    if (known) return known;
    if (!workItems) return undefined;
    const ids = await workItems.listWorkItemIdsForSession({
      orgId: session.orgId,
      factoryProjectId: session.factoryProjectId,
      sessionId: session.sessionId,
    });
    if (ids.length > 1) {
      throw new Error(
        `Factory session ${session.sessionId} is bound to several work items (${ids.join(', ')}), so it has no single card folder to work in.`,
      );
    }
    if (ids[0]) boundCards.set(session.sessionId, ids[0]);
    return ids[0];
  };

  return {
    async forSession(session) {
      // Sessions from before factory ownership name no factory to scope a shared folder by.
      if (!session.factoryProjectId) return undefined;
      const scoped = { sessionId: session.sessionId, orgId: session.orgId, factoryProjectId: session.factoryProjectId };
      if (isWorkItemBranch(session.branch)) {
        const workItemId = await boundCard(scoped);
        return workItemFolder({
          factoryProjectId: session.factoryProjectId,
          branch: session.branch,
          ...(workItemId ? { workItemId } : {}),
        });
      }
      const workItemId = await boundCard(scoped);
      if (!workItemId) return undefined;
      const item = await workItems!.get({ orgId: session.orgId, id: workItemId });
      // The card is gone and its folder with it: the session works no card any more.
      if (!item) return undefined;
      return workItemFolder({
        factoryProjectId: session.factoryProjectId,
        branch: workItemBranch({
          id: item.id,
          source: workItemSource(item.externalSource),
          metadata: item.workItem.metadata,
        }),
        workItemId: item.id,
      });
    },

    async boundSessionIds({ orgId, folder }) {
      if (!folder.workItemId || !workItems) return [];
      const bindings = await workItems.listRunBindings(orgId, folder.factoryProjectId, folder.workItemId);
      return [...new Set(bindings.map(binding => binding.sessionId))];
    },
  };
}

/** The card folder of a card, from the card itself: what its sessions resolve to. */
export function workItemFolderForCard(item: {
  id: string;
  factoryProjectId: string;
  externalSource: Parameters<typeof workItemSource>[0];
  workItem: { metadata: Record<string, unknown> | null };
}): WorkItemFolder {
  return workItemFolder({
    factoryProjectId: item.factoryProjectId,
    branch: workItemBranch({ id: item.id, source: workItemSource(item.externalSource), metadata: item.workItem.metadata }),
    workItemId: item.id,
  });
}

/**
 * A role cannot start on a card while another of the card's sessions is
 * running: they share one sandbox folder, and two agents working one
 * checkout at once would trample each other's commands and files.
 */
export class CardSessionRunningError extends Error {
  readonly code = 'card_session_running';
  readonly sessionId: string;
  readonly role: string;

  constructor(role: string, running: { role: string; sessionId: string }) {
    super(
      `The card's ${running.role} session ${running.sessionId} is still running, and every session of a card works in the card's one sandbox folder. ` +
        `Start ${role} once that run has ended, or stop it first.`,
    );
    this.name = 'CardSessionRunningError';
    this.sessionId = running.sessionId;
    this.role = running.role;
  }
}

/** The first of the card's sessions other than `sessionId` that is running, by role. */
export function runningCardSession(
  sessions: Readonly<Record<string, { sessionId: string }>>,
  sessionId: string | undefined,
  isRunning: (sessionId: string) => boolean,
): { role: string; sessionId: string } | undefined {
  for (const [role, ref] of Object.entries(sessions)) {
    if (ref.sessionId !== sessionId && isRunning(ref.sessionId)) return { role, sessionId: ref.sessionId };
  }
  return undefined;
}
