/**
 * The organization's ClickUp connection (Settings › Підключення › ClickUp, `clickup:org`) used as a
 * person's own source (ADR-0051): only when its token provably belongs to that person, never on
 * anyone's word.
 *
 * Proof, in order:
 * 1. A ClickUp↔Factory identity link (ADR-0018 `connect FCT-…`) for the token's ClickUp user in
 *    this organization. When links exist they decide: the person must be the only Factory user
 *    linked to that ClickUp account.
 * 2. Without a link: the person is the Factory user who saved the current token (the connection
 *    row's `userId`, rewritten whenever the token is replaced).
 *
 * Anyone else in the organization is not offered it and needs their own personal token. The proof
 * is checked again on every read, so a removed or replaced connection stops the source at once.
 */
import type { AssistantOwner } from '@factory/assistant-core';

/** The organization's ClickUp connection as the source sees it. The token never leaves the server. */
export interface OrgClickUpConnection {
  token: string;
  /** The Factory user who saved the current token (`integration_connections.user_id`). */
  savedBy: string | null;
  /** The ClickUp account the token belongs to, as checked when it was saved. */
  account: { id: string; name: string; workspaces: string[] };
}

/** What the server reads for the proof: the connection row and the identity links. */
export interface OrgClickUpReader {
  connection(orgId: string): Promise<OrgClickUpConnection | null>;
  /** Factory users linked to this ClickUp user in this organization (ADR-0018 links, platform `clickup`). */
  linkedUsers(orgId: string, clickUpUserId: string): Promise<string[]>;
}

export type OrgOwnership = 'identity_link' | 'saved_by';

/** The organization's connection when its token is this person's own ClickUp account, with how that is known. */
export async function orgConnectionFor(
  reader: OrgClickUpReader,
  owner: AssistantOwner,
): Promise<{ connection: OrgClickUpConnection; proof: OrgOwnership } | null> {
  const connection = await reader.connection(owner.orgId);
  if (!connection || !connection.account.id) return null;
  const linked = [...new Set(await reader.linkedUsers(owner.orgId, connection.account.id))];
  if (linked.length > 0) {
    return linked.length === 1 && linked[0] === owner.userId ? { connection, proof: 'identity_link' } : null;
  }
  return connection.savedBy !== null && connection.savedBy === owner.userId ? { connection, proof: 'saved_by' } : null;
}
