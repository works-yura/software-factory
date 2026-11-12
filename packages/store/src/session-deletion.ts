// The one way a source-control session's record is deleted. Every path that deletes a session (the
// Factory and GitHub session routes, session retirement) goes through here, so the invariant holds
// everywhere: an active run binding always points at an existing session.
import type { SourceControlSession, SourceControlStorageHandle } from './source-control/base.ts';
import type { WorkItemsStorage } from './work-items/base.ts';

export interface SessionRecordStores {
  readonly sourceControl: Pick<SourceControlStorageHandle, 'sessions'>;
  /** Absent when the Factory's work items are not set up: there is nothing that could point at the session. */
  readonly workItems?: Pick<WorkItemsStorage, 'clearSessionReferences'> | undefined;
}

/**
 * Deletes a session's record. The cards' refs to it are stripped and its active run bindings
 * revoked first, in one work-items transaction; then the session row and its repository rows go.
 * The two live in different storage domains, so the order is what keeps the invariant: a failure
 * in between leaves a session nothing points at (deleting it again finishes the job), never a
 * binding on a deleted session. The dispatcher's stale-binding sweep and its self-healing at
 * dispatch cover rows deleted by any older path. Tearing down the session's sandbox, harness
 * state and folders is the caller's business.
 */
export async function deleteSessionRecord(
  stores: SessionRecordStores,
  session: Pick<SourceControlSession, 'id' | 'orgId' | 'sessionId'>,
): Promise<void> {
  await stores.workItems?.clearSessionReferences({ orgId: session.orgId, sessionId: session.sessionId });
  await stores.sourceControl.sessions.delete(session.id);
}
