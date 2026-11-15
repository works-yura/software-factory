/**
 * Who may do what in an organization (ADR-0045). Every check in Factory is `can(role, permission)`;
 * nothing compares role names.
 */

/**
 * Everything a route or a handler can require. Reads need nothing beyond membership (`board.read`
 * is every role's); each write names one of these.
 */
export const PERMISSIONS = [
  /** See boards, cards, chats, activity and settings. */
  'board.read',
  /** The person's own state: attention marks, their profile, leaving, accepting a join link. */
  'self.write',
  /** Create, edit, move, delete cards and their attachments; fire intake. */
  'card.write',
  /** Write comments on cards. */
  'comment.write',
  /** Start runs, approve or retry decisions, chat with agents, start automations. */
  'run.start',
  /** Work in sessions: create, recreate and close them, edit their files, git. */
  'session.write',
  /** The Factory's member-level settings: environment builds, sandboxes asleep, model defaults, knowledge. */
  'factory.configure',
  /** The Factory's admin-level settings: boards, intake routes, skills, sandbox env, project admin fields. */
  'factory.manage',
  /** Integrations, connections, MCP servers, GitHub tokens. */
  'connections.manage',
  /** The organization itself: its model keys and sign-ins, name and avatar. */
  'org.manage',
  /** Members and their roles, invitations. */
  'members.manage',
  /** Join links. */
  'join-links.manage',
  /** Other people's comments and shared sessions. */
  'content.moderate',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/** Every role a membership can hold. `owner` is the organization's creator: one, never given. */
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Roles a person can be given by an invitation, a join link or a role change. */
export const ASSIGNABLE_ROLES = ['viewer', 'member', 'admin'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === 'string' && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

const VIEWER: readonly Permission[] = ['board.read', 'self.write'];
const MEMBER: readonly Permission[] = [
  ...VIEWER,
  'card.write',
  'comment.write',
  'run.start',
  'session.write',
  'factory.configure',
];
const ADMIN: readonly Permission[] = [
  ...MEMBER,
  'factory.manage',
  'connections.manage',
  'org.manage',
  'members.manage',
  'join-links.manage',
  'content.moderate',
];

/** The matrix: what each role may do. The owner has an admin's permissions. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  viewer: new Set(VIEWER),
  member: new Set(MEMBER),
  admin: new Set(ADMIN),
  owner: new Set(ADMIN),
};

/** The only check: whether a role holds a permission. An unknown role holds nothing. */
export function can(role: Role | string | null | undefined, permission: Permission): boolean {
  return isRole(role) && ROLE_PERMISSIONS[role].has(permission);
}

/** A role's permissions in catalog order (what `/auth/me` reports). */
export function permissionsFor(role: Role | string | null | undefined): Permission[] {
  return isRole(role) ? PERMISSIONS.filter(permission => ROLE_PERMISSIONS[role].has(permission)) : [];
}
