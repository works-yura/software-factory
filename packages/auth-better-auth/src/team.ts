/**
 * Factory's roles on better-auth (ADR-0045): the `viewer` role in better-auth's access control, and
 * the organization events (role changes, removals, invitations, edits) the server audits. Who may do
 * what in Factory is `can()` of `@factory/access`; better-auth only stores memberships and checks its
 * own organization endpoints.
 */
import type { Session, User } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { defaultAc, defaultRoles } from 'better-auth/plugins/organization/access';

/** The organization plugin's creator role: one per organization, never given. */
export const OWNER_ROLE = 'owner';

/**
 * Access control for the organization plugin: better-auth's own roles plus
 * `viewer`, which holds no organization permission (like `member`); what keeps a
 * viewer read-only in Factory is the server's gate, not better-auth.
 */
export const organizationAccessControl = {
  ac: defaultAc,
  roles: {
    ...defaultRoles,
    viewer: defaultAc.newRole({ organization: [], member: [], invitation: [], team: [], ac: ['read'] }),
  },
};

// ============================================
// Events
// ============================================

/** Something that happened to an organization, for the server's audit log. */
export interface OrganizationEvent {
  action:
    | 'factory.organization.updated'
    | 'factory.organization.member_role_changed'
    | 'factory.organization.member_removed'
    | 'factory.organization.member_left'
    | 'factory.organization.invitation_created'
    | 'factory.organization.invitation_canceled'
    | 'factory.organization.invitation_accepted';
  organizationId: string;
  actor: { userId: string; name?: string; email?: string; avatarUrl?: string };
  targets: Array<{ type: string; id: string; name?: string }>;
  metadata?: Record<string, unknown>;
}

export type OrganizationEventHandler = (event: OrganizationEvent) => Promise<void>;

/**
 * Carries organization events from better-auth to whoever records them (the
 * Factory server's audit log), and membership changes to the provider's role
 * cache. The handler is set after construction because the audit log exists
 * only once the server has booted.
 */
export class OrganizationEventRelay {
  #handler: OrganizationEventHandler | undefined;
  #membershipListeners = new Set<(organizationId: string, userId: string) => void>();

  setHandler(handler: OrganizationEventHandler | undefined): void {
    this.#handler = handler;
  }

  onMembershipChanged(listener: (organizationId: string, userId: string) => void): void {
    this.#membershipListeners.add(listener);
  }

  membershipChanged(organizationId: string, userId: string): void {
    for (const listener of this.#membershipListeners) listener(organizationId, userId);
  }

  #removalListeners = new Set<(organizationId: string, userId: string) => Promise<void>>();
  #deletionListeners = new Set<(userId: string) => Promise<void>>();

  /**
   * A person left an organization or was removed from it: what they kept there that is theirs
   * alone (their assistant, ADR-0051) is erased by the listener.
   */
  onMemberRemoved(listener: (organizationId: string, userId: string) => Promise<void>): void {
    this.#removalListeners.add(listener);
  }

  /** A person's account was deleted (better-auth's `user.delete` hook): the listener erases what was theirs. */
  onUserDeleted(listener: (userId: string) => Promise<void>): void {
    this.#deletionListeners.add(listener);
  }

  /**
   * Runs every removal listener. The removal already happened, so a listener that fails is logged
   * loudly (naming the person and organization) and does not undo it; the next listener still runs.
   */
  async memberRemoved(organizationId: string, userId: string): Promise<void> {
    for (const listener of this.#removalListeners) {
      try {
        await listener(organizationId, userId);
      } catch (error) {
        console.error(`[BetterAuth] Cleaning up after removing ${userId} from ${organizationId} failed; it must be retried by hand.`, error);
      }
    }
  }

  async userDeleted(userId: string): Promise<void> {
    for (const listener of this.#deletionListeners) {
      try {
        await listener(userId);
      } catch (error) {
        console.error(`[BetterAuth] Cleaning up after deleting the account ${userId} failed; it must be retried by hand.`, error);
      }
    }
  }

  /**
   * Records the event. The change it describes already happened, so a missing
   * handler or a failed write is logged loudly but does not undo or fail it.
   */
  async emit(event: OrganizationEvent): Promise<void> {
    const handler = this.#handler;
    if (!handler) {
      console.error(
        `[BetterAuth] Organization event ${event.action} in ${event.organizationId} was not audited: no audit handler is set.`,
      );
      return;
    }
    try {
      await handler(event);
    } catch (error) {
      console.error(`[BetterAuth] Could not audit organization event ${event.action} in ${event.organizationId}.`, error);
    }
  }
}

function actorOf(user: User): OrganizationEvent['actor'] {
  return {
    userId: user.id,
    ...(user.name ? { name: user.name } : {}),
    ...(user.email ? { email: user.email } : {}),
    ...(user.image ? { avatarUrl: user.image } : {}),
  };
}

interface MemberLike {
  id?: string;
  userId?: string;
  organizationId?: string;
  role?: string;
}

interface InvitationLike {
  id?: string;
  email?: string;
  role?: string;
  organizationId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * better-auth's `after` hook for the organization endpoints Factory audits. It
 * reads what the endpoint returned (a failed endpoint returns an `APIError`,
 * which is skipped) and the session of whoever called it.
 */
export function organizationEventsHook(relay: OrganizationEventRelay) {
  return createAuthMiddleware(async ctx => {
    const path = ctx.path;
    if (!path.startsWith('/organization/')) return;
    const returned = ctx.context.returned;
    if (!returned || returned instanceof APIError || returned instanceof Response) return;
    const result = record(returned);
    if (!result) return;
    const session = (ctx.context.session ?? (await getSessionFromCtx(ctx))) as { user: User; session: Session } | null;
    if (!session) return;
    const actor = actorOf(session.user);
    const body = record(ctx.body) ?? {};

    switch (path) {
      case '/organization/update-member-role': {
        const member = result as MemberLike;
        if (!member.organizationId || !member.userId) return;
        relay.membershipChanged(member.organizationId, member.userId);
        await relay.emit({
          action: 'factory.organization.member_role_changed',
          organizationId: member.organizationId,
          actor,
          targets: [{ type: 'member', id: member.userId }],
          metadata: { role: member.role },
        });
        return;
      }
      case '/organization/remove-member': {
        const member = record(result.member) as MemberLike | undefined;
        if (!member?.organizationId || !member.userId) return;
        relay.membershipChanged(member.organizationId, member.userId);
        await relay.memberRemoved(member.organizationId, member.userId);
        await relay.emit({
          action: 'factory.organization.member_removed',
          organizationId: member.organizationId,
          actor,
          targets: [{ type: 'member', id: member.userId }],
          metadata: { role: member.role },
        });
        return;
      }
      case '/organization/leave': {
        const member = result as MemberLike;
        if (!member.organizationId || !member.userId) return;
        relay.membershipChanged(member.organizationId, member.userId);
        await relay.memberRemoved(member.organizationId, member.userId);
        await relay.emit({
          action: 'factory.organization.member_left',
          organizationId: member.organizationId,
          actor,
          targets: [{ type: 'member', id: member.userId }],
        });
        return;
      }
      case '/organization/invite-member': {
        const invitation = result as InvitationLike;
        if (!invitation.organizationId || !invitation.id) return;
        await relay.emit({
          action: 'factory.organization.invitation_created',
          organizationId: invitation.organizationId,
          actor,
          targets: [{ type: 'invitation', id: invitation.id, ...(invitation.email ? { name: invitation.email } : {}) }],
          metadata: { role: invitation.role },
        });
        return;
      }
      case '/organization/cancel-invitation': {
        const invitation = result as InvitationLike;
        if (!invitation.organizationId || !invitation.id) return;
        await relay.emit({
          action: 'factory.organization.invitation_canceled',
          organizationId: invitation.organizationId,
          actor,
          targets: [{ type: 'invitation', id: invitation.id, ...(invitation.email ? { name: invitation.email } : {}) }],
        });
        return;
      }
      case '/organization/accept-invitation': {
        const invitation = record(result.invitation) as InvitationLike | undefined;
        const member = record(result.member) as MemberLike | undefined;
        if (!invitation?.organizationId || !invitation.id) return;
        if (member?.userId) relay.membershipChanged(invitation.organizationId, member.userId);
        await relay.emit({
          action: 'factory.organization.invitation_accepted',
          organizationId: invitation.organizationId,
          actor,
          targets: [{ type: 'invitation', id: invitation.id }],
          metadata: { role: invitation.role },
        });
        return;
      }
      case '/organization/update': {
        const organization = result as { id?: string; name?: string };
        if (!organization.id) return;
        const data = record(body.data) ?? {};
        await relay.emit({
          action: 'factory.organization.updated',
          organizationId: organization.id,
          actor,
          targets: [{ type: 'organization', id: organization.id, ...(organization.name ? { name: organization.name } : {}) }],
          metadata: { fields: Object.keys(data).sort() },
        });
        return;
      }
      default:
        return;
    }
  });
}
