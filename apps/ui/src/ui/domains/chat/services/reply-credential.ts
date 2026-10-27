import { translator } from '../../../i18n/t';

const tk = translator('chat');

/** The user whose personal credentials a thread runs on. */
export interface ThreadOwner {
  id: string;
  name?: string;
  avatarUrl?: string;
}

/**
 * Names the credential the server stamped on a reply when it answered:
 * `credentialLabel` ("Claude Pro/Max") and, for a personal credential,
 * `credentialOwnerId`. A reply stamped without an owner ran on the
 * organization's credential; an unstamped reply gets no label.
 */
export function replyCredentialLabel(
  metadata: Record<string, unknown>,
  threadOwner: ThreadOwner | undefined,
  viewerId: string | undefined,
): string | undefined {
  const { credentialLabel, credentialOwnerId } = metadata;
  if (typeof credentialLabel !== 'string') return undefined;
  const label = credentialLabel;
  if (typeof credentialOwnerId !== 'string') return tk('credential.replyOrganization', { label });
  if (credentialOwnerId === viewerId) return tk('credential.replyYours', { label });
  if (credentialOwnerId === threadOwner?.id && threadOwner.name) {
    return tk('credential.replyOwner', { name: threadOwner.name, label });
  }
  return tk('credential.replyPersonal', { label });
}
