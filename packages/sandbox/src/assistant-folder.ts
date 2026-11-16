/**
 * The sandbox folder of a person's «Помічник» (ADR-0051) in one organization: a persistent
 * workspace with no repository, under the sandbox root like session and card folders, so the agent
 * user (ADR-0041) reaches it through the same ACLs and the Seatbelt profile (ADR-0050) allows it
 * without another root. One folder per owner `(orgId, userId)`:
 *
 *   <root>/assistant/<orgId>/<userId>/workspace   ← where the agent works
 *
 * The key is derived from the owner on every use, never read back from storage or a request.
 */

/** The directory under the sandbox root that holds every assistant's folder. */
export const ASSISTANT_FOLDERS_DIR = 'assistant';

/** The working directory inside an assistant's folder (room beside it for the server's own bookkeeping). */
export const ASSISTANT_WORKSPACE_DIR = 'workspace';

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;

/**
 * `assistant/<orgId>/<userId>`. Ids are taken as they are, never sanitized: two owners must never
 * map to one folder, so an id that is not a plain path segment is refused instead.
 */
export function assistantFolderKey(orgId: string, userId: string): string {
  for (const segment of [orgId, userId]) {
    if (typeof segment !== 'string' || !SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new Error('An assistant owner id is not a plain path segment; refusing a sandbox folder for it.');
    }
  }
  return `${ASSISTANT_FOLDERS_DIR}/${orgId}/${userId}`;
}

/** Whether a folder key names an assistant's folder (`assistant/<org>/<user>`). */
export function isAssistantFolderKey(key: string | undefined): boolean {
  const segments = key?.split('/') ?? [];
  return segments.length === 3 && segments[0] === ASSISTANT_FOLDERS_DIR && segments.slice(1).every(segment => SEGMENT.test(segment));
}
