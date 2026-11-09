import { sanitizeSegment } from './workdir.ts';

/** The directory under the sandbox root that holds every card's folder. */
export const WORK_ITEM_FOLDERS_DIR = 'work-items';

/**
 * The sandbox folder a card's sessions share. A work item gets one folder for
 * its whole chain (triage, planning, building, review, rework): its first
 * session clones the environment and runs the setup commands there, and every
 * later session of the card starts in the same checkout instead of cloning
 * and setting up again. Sessions and threads stay separate per role; only the
 * disk is shared.
 *
 * The folder is named after the card's branch (`workItemBranch`), which every
 * path that opens a card session already derives from the card, under the
 * session's factory so no other factory or organization can reach it. It is
 * derived from the session and its card on every resolve, never read back
 * from storage.
 */
export interface WorkItemFolder {
  /** Path of the folder relative to the sandbox root: `work-items/<factory>/<card branch>`. */
  key: string;
  factoryProjectId: string;
  /** The card's branch, the folder's name. */
  branch: string;
  /** The card, when the session is bound to one. */
  workItemId?: string;
}

/** The folder key of a card: `work-items/<factory>/<card branch>`, each a single safe path segment. */
export function workItemFolderKey(factoryProjectId: string, cardBranch: string): string {
  if (!factoryProjectId || !cardBranch) throw new Error('A card folder needs a factory and the card branch.');
  return `${WORK_ITEM_FOLDERS_DIR}/${sanitizeSegment(factoryProjectId)}/${sanitizeSegment(cardBranch.replace(/\//g, '-'))}`;
}

/** Build a card's folder, deriving its key. */
export function workItemFolder(input: Omit<WorkItemFolder, 'key'>): WorkItemFolder {
  return { ...input, key: workItemFolderKey(input.factoryProjectId, input.branch) };
}

/**
 * Where the sessions of a card work. The host wires the one implementation
 * every consumer uses, so the workspace, retirement and the Claude Code
 * checkout always agree on where a session's files are.
 */
export interface WorkItemFolders {
  /**
   * The card folder a session works in, or `undefined` for a session that
   * works no card (it keeps a folder of its own). Throws when the session's
   * card cannot be told apart (bound to several cards).
   */
  forSession(session: {
    sessionId: string;
    orgId: string;
    factoryProjectId?: string | null;
    branch: string;
  }): Promise<WorkItemFolder | undefined>;
  /**
   * Sessions bound to the folder's card by a run (active or revoked), which
   * work in the folder whatever their branch. Empty when the folder names no
   * card; sessions on the card branch are found by their branch.
   */
  boundSessionIds(args: { orgId: string; folder: WorkItemFolder }): Promise<string[]>;
}
