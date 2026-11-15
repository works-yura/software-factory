import { InvitationEmails, notifierFromEnv, type Notifier } from '@factory/notifications';

/**
 * The server's notifier (ADR-0047), built once from the environment. Without a mail provider it
 * has no channels: invitations are then shared by their link alone, as before.
 */
export function createNotifier(env: NodeJS.ProcessEnv = process.env): Notifier {
  return notifierFromEnv(env);
}

/** Emails every invitation to the invited address; the link points at MASTRACODE_PUBLIC_URL. */
export function createInvitationEmails(notifier: Notifier, publicUrl: string): InvitationEmails | undefined {
  return notifier.channels.length > 0 ? new InvitationEmails(notifier, publicUrl) : undefined;
}
