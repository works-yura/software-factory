import { translator } from '../../../i18n/t';

const tk = translator('auth');

/**
 * Organizations, members and invitation links through better-auth's own organization endpoints
 * (`/auth/api/organization/*`, served by the Google sign-in provider). better-auth checks every
 * call itself: only an owner or admin can invite, cancel and remove, and an invitation opens only
 * for the email it was made for.
 */

export type OrganizationRole = 'owner' | 'admin' | 'member';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
}

export interface OrganizationMember {
  id: string;
  userId: string;
  role: OrganizationRole;
  user: { id: string; name: string; email: string; image?: string | null };
}

export interface OrganizationInvitation {
  id: string;
  email: string;
  role: OrganizationRole;
  status: string;
  expiresAt: string;
  organizationId: string;
}

export interface FullOrganization extends OrganizationSummary {
  members: OrganizationMember[];
  invitations: OrganizationInvitation[];
}

/** What the invited person sees before accepting. */
export interface InvitationDetails extends OrganizationInvitation {
  organizationName: string;
  inviterEmail: string;
}

/** A failed organization call, with better-auth's machine-readable code when it sent one. */
export class OrganizationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OrganizationRequestError';
  }
}

async function organizationRequest<T>(baseUrl: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}/auth/api/organization/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    credentials: 'include',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // better-auth answers JSON; anything else (a proxy's HTML page, an empty body) is a failure,
    // also on a 2xx, so nothing reads it as an empty result.
    throw new OrganizationRequestError(tk('organization.requestFailed', { status: res.status }), res.status);
  }
  if (!res.ok) {
    const error = (data ?? {}) as { message?: string; code?: string };
    throw new OrganizationRequestError(
      error.message || tk('organization.requestFailed', { status: res.status }),
      res.status,
      error.code,
    );
  }
  return data as T;
}

export function listOrganizations(baseUrl: string): Promise<OrganizationSummary[]> {
  return organizationRequest(baseUrl, 'list');
}

export function getOrganization(baseUrl: string, organizationId: string): Promise<FullOrganization> {
  return organizationRequest(baseUrl, `get-full-organization?organizationId=${encodeURIComponent(organizationId)}`);
}

export function setActiveOrganization(baseUrl: string, organizationId: string): Promise<OrganizationSummary> {
  return organizationRequest(baseUrl, 'set-active', { organizationId });
}

/** Invitations are always for the `member` role; fine-grained roles come later. */
export function inviteMember(baseUrl: string, organizationId: string, email: string): Promise<OrganizationInvitation> {
  return organizationRequest(baseUrl, 'invite-member', { email, role: 'member', organizationId });
}

export function cancelInvitation(baseUrl: string, invitationId: string): Promise<unknown> {
  return organizationRequest(baseUrl, 'cancel-invitation', { invitationId });
}

export function removeMember(baseUrl: string, organizationId: string, memberId: string): Promise<unknown> {
  return organizationRequest(baseUrl, 'remove-member', { memberIdOrEmail: memberId, organizationId });
}

export function getInvitation(baseUrl: string, invitationId: string): Promise<InvitationDetails> {
  return organizationRequest(baseUrl, `get-invitation?id=${encodeURIComponent(invitationId)}`);
}

export function acceptInvitation(baseUrl: string, invitationId: string): Promise<{ invitation: OrganizationInvitation }> {
  return organizationRequest(baseUrl, 'accept-invitation', { invitationId });
}

export function rejectInvitation(baseUrl: string, invitationId: string): Promise<unknown> {
  return organizationRequest(baseUrl, 'reject-invitation', { invitationId });
}

/** The link the inviter sends by hand: the SPA's own origin, so it opens wherever they use Factory. */
export function invitationLink(invitationId: string): string {
  return `${window.location.origin}/invite/${encodeURIComponent(invitationId)}`;
}

/** Pending and not yet expired: the invitations worth showing and copying. */
export function isOpenInvitation(invitation: OrganizationInvitation, now = Date.now()): boolean {
  return invitation.status === 'pending' && new Date(invitation.expiresAt).getTime() > now;
}

export function canManageMembers(role: OrganizationRole | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Opens the app afresh in the newly active organization (after switching or accepting an
 * invitation): factories, boards and settings all belong to it, so nothing cached from the previous
 * one may stay on screen. Not for a plain "go home", which is a router navigation. Service-level so
 * tests can replace it (jsdom's `window.location.assign` cannot be spied on).
 */
export function reloadIntoOrganization(): void {
  window.location.assign('/');
}
