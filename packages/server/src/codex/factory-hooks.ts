// What a Factory gives its Codex sessions beyond the shared turn-harness wiring: live web reads on
// a Product card (as Claude Code's `WebFetch`/`WebSearch` run unasked there), and the images Codex
// generates kept as attachments, where the chat and the card show files.
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';

import type { AttachmentService, WorkItemsStorage } from '@factory/store';

type Coordinates = { orgId: string; factoryProjectId: string; sessionId: string; threadId: string; resourceId: string };

/** Whether the session works a Product card: its Brief reads providers' pricing pages, live. */
export function codexLiveWebForProductCards(
  workItems: Pick<WorkItemsStorage, 'findActiveRunBindingByThread' | 'get'>,
): (session: Coordinates) => Promise<boolean> {
  return async ({ orgId, threadId, resourceId, sessionId }) => {
    const binding = await workItems.findActiveRunBindingByThread({ orgId, threadId, resourceId, sessionId });
    if (!binding) return false;
    const item = await workItems.get({ orgId: binding.orgId, id: binding.workItemId });
    return item?.board === 'product';
  };
}

/** Opens a file a harness CLI named. */
export type AgentFileOpener = (path: string) => Readable;

/**
 * Keeps an image Codex generated as an attachment: the card's when the session works one, the
 * session's otherwise, added by the session's owner.
 *
 * The path comes from the CLI, which runs as the agent (ADR-0041) and may name any file: with an
 * agent user, `open` reads it with the agent's rights (`cat` as the agent), never the server's, so a
 * path into the server user's home yields nothing.
 */
export function codexGeneratedImageKeeper(deps: {
  attachments: Pick<AttachmentService, 'ingest'>;
  workItems?: Pick<WorkItemsStorage, 'findActiveRunBindingForSession'>;
  open?: AgentFileOpener;
}): (session: Coordinates & { userId: string }, image: { path: string; prompt?: string }) => Promise<void> {
  return async (session, image) => {
    const binding = await deps.workItems?.findActiveRunBindingForSession({
      orgId: session.orgId,
      factoryProjectId: session.factoryProjectId,
      sessionId: session.sessionId,
    });
    await deps.attachments.ingest({
      orgId: session.orgId,
      owner: binding
        ? { workItemId: binding.workItemId, factoryProjectId: session.factoryProjectId }
        : { sessionId: session.sessionId, factoryProjectId: session.factoryProjectId },
      name: basename(image.path),
      body: (deps.open ?? (path => createReadStream(path)))(image.path),
      source: 'chat',
      addedBy: session.userId,
    });
  };
}
