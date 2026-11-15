/**
 * What Factory needs from wherever memberships, invitations, join links and avatars live. The auth
 * provider (better-auth) implements the first two as an adapter; `@factory/store` the last two.
 */
import type { AssignableRole, Role } from './permissions.ts';

export interface Member {
  /** The membership's id (what a role change or removal names). */
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
  name: string;
  email: string;
  image?: string | null;
}

export interface Person {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

/** An organization's members. Every method throws when the store cannot answer; none guesses. */
export interface MembershipDirectory {
  /** The person's role in the organization, or `null` when they are not a member. */
  role(organizationId: string, userId: string): Promise<Role | null>;
  listMembers(organizationId: string): Promise<Member[]>;
  /** Adds a member (a join link's use). Already a member: their membership, unchanged. */
  addMember(organizationId: string, userId: string, role: AssignableRole): Promise<Member>;
  /** Changes a role among viewer, member and admin; the owner's never changes. */
  changeRole(organizationId: string, memberId: string, role: AssignableRole): Promise<Member>;
  /** Removes a member; never the owner. */
  remove(organizationId: string, memberId: string): Promise<void>;
  /** The person leaves; the owner cannot. */
  leave(organizationId: string, userId: string): Promise<void>;
  person(userId: string): Promise<Person | null>;
  /** The organization's name and avatar, or `null` when it does not exist. */
  organization(organizationId: string): Promise<{ id: string; name: string; logo: string | null } | null>;
}

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: AssignableRole;
  status: string;
  expiresAt: string;
}

/**
 * Invitations by email: a link the inviter can copy, and an email with the same link when the
 * server has a mail channel (`InvitationNotifier`).
 */
export interface InvitationService {
  invite(organizationId: string, email: string, role: AssignableRole, inviterUserId: string): Promise<Invitation>;
  cancel(organizationId: string, invitationId: string): Promise<void>;
  list(organizationId: string): Promise<Invitation[]>;
}

/** An invitation was created or sent again. */
export interface InvitationCreated {
  invitationId: string;
  email: string;
  role: string;
  organization: { id: string; name: string };
  inviter: { userId: string; name?: string; email?: string };
  expiresAt: Date;
}

/**
 * Tells the invited person (`@factory/notifications` sends an email). Never throws: the
 * invitation exists either way, and its link stays in the team settings to copy.
 */
export interface InvitationNotifier {
  invitationCreated(event: InvitationCreated): Promise<void>;
}

export type JoinLinkStatus = 'active' | 'expired' | 'revoked' | 'used_up';

export interface JoinLink {
  id: string;
  organizationId: string;
  token: string;
  name: string;
  role: AssignableRole;
  /** Lowercase email domains; empty lets any verified email in. */
  allowedDomains: string[];
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
  createdBy: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface NewJoinLink {
  organizationId: string;
  name: string;
  role: AssignableRole;
  allowedDomains: string[];
  expiresAt: Date | null;
  maxUses: number | null;
  createdBy: string;
}

export interface JoinLinkStore {
  create(link: NewJoinLink): Promise<JoinLink>;
  list(organizationId: string): Promise<JoinLink[]>;
  get(organizationId: string, id: string): Promise<JoinLink | null>;
  findByToken(token: string): Promise<JoinLink | null>;
  revoke(organizationId: string, id: string, at: Date): Promise<JoinLink | null>;
  /**
   * Counts one use if the link is still active at `now`, atomically: concurrent calls never go past
   * the limit. Answers the link after the use, or why it cannot be used.
   */
  takeUse(id: string, now: Date): Promise<{ link: JoinLink } | { refusal: Exclude<JoinLinkStatus, 'active'> | 'not_found' }>;
}

export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];
/** Largest avatar, in bytes (the browser scales to 256 px first). */
export const AVATAR_MAX_BYTES = 256 * 1024;

export interface AvatarStore {
  put(ownerUserId: string, type: AvatarType, bytes: Uint8Array): Promise<{ id: string }>;
  get(id: string): Promise<{ type: AvatarType; bytes: Uint8Array } | null>;
}
