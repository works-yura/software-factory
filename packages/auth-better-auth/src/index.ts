/*
 * Derived from @mastra/auth-better-auth 1.1.8 (auth/better-auth/src/index.ts),
 * Copyright (c) Mastra AI, Inc., licensed under the Apache License 2.0.
 * Changed for Factory v4: Google is the only way in (no email/password, no
 * ICredentialsProvider), organizations come without email sending, users
 * cannot create or delete them through the API, nobody is made `owner` through
 * an invitation or a role change, invitations last 7 days, Google sign-in links
 * to an existing user row with the same email, a session's active organization
 * is honored only while the user is still a member of it, and a membership
 * lookup that fails refuses the request instead of acting in another
 * organization; Factory adds a `viewer` role, role changes among
 * viewer/member/admin, join links, avatars and audited organization events
 * (`team.ts`, ADR-0045). See THIRD_PARTY_NOTICES.md and MIGRATION.md.
 */
import type {
  AuthInitContext,
  IAuthHttpHandler,
  IAuthInit,
  IOrganizationsProvider,
  IUserProvider,
  MastraAuthProviderOptions,
  MastraAuthRequest,
} from '@mastra/core/server';
import { getRequestHeader, MastraAuthProvider } from '@mastra/core/server';
import { LibsqlDialect } from '@libsql/kysely-libsql';

import { betterAuth } from 'better-auth';
import type { Auth, BetterAuthOptions, Session, User } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { makeSignature } from 'better-auth/crypto';
import { getMigrations } from 'better-auth/db/migration';
import { jwt, organization } from 'better-auth/plugins';
import { verifyJwsAccessToken } from 'better-auth/oauth2';
import { oauthProvider } from '@better-auth/oauth-provider';

import { isAssignableRole, isRole } from '@factory/access';
import type {
  AssignableRole,
  Invitation,
  InvitationNotifier,
  InvitationService,
  Member,
  MembershipDirectory,
  Person,
  Role,
} from '@factory/access';

import { OrganizationEventRelay, organizationAccessControl, organizationEventsHook, OWNER_ROLE } from './team.ts';
import type { OrganizationEventHandler } from './team.ts';

export * from './team.ts';

type BetterAuthContext = Awaited<Auth['$context']>;
type OrganizationPluginOptions = NonNullable<Parameters<typeof organization>[0]>;

function tryDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * User type returned by Better Auth session verification.
 * Used internally for authentication token verification.
 */
export interface BetterAuthUser {
  /**
   * The better-auth session. `activeOrganizationId` comes from the
   * organization plugin (registered unconditionally by this provider); when
   * the stored session never had one set, or names an organization the user
   * no longer belongs to, `authenticateToken` resolves a default from the
   * user's existing memberships.
   */
  session: Session & { activeOrganizationId?: string | null };
  user: User;
  /**
   * Every organization the user belongs to, for requests that bring a token
   * (an MCP client's access token): the host honors an
   * `X-Mastra-Organization-Id` header only for one of these.
   */
  organizationMembershipIds?: string[];
}

type JwksFetch = Parameters<typeof verifyJwsAccessToken>[1]['jwksFetch'];

/** An OAuth access token (a JWS: three dot-separated parts); session tokens have at most two. */
function isOAuthAccessToken(token: string): boolean {
  return token.split('.').length === 3;
}

/** A token that is simply not valid (bad signature, expired, wrong audience) — not a server failure. */
function isRejectedToken(error: unknown): boolean {
  if (error instanceof APIError) return error.statusCode < 500;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('ERR_J');
}

/**
 * The user shape this provider reports to `IUserProvider` consumers (upstream
 * reports `EEUser` from `@internal/auth/ee`, which v4 does not export).
 */
export interface BetterAuthProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  metadata: { emailVerified: boolean; createdAt: Date; updatedAt: Date };
}

/**
 * Maps Better Auth User to the profile format.
 */
function mapBetterAuthUser(user: User): BetterAuthProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.image ?? undefined,
    metadata: {
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  };
}

/** Google OAuth client (Google Cloud console › APIs & Services › Credentials). */
export interface GoogleClientOptions {
  clientId: string;
  clientSecret: string;
}

/**
 * The protected resource every Factory's MCP endpoint belongs to
 * (`<publicUrl>/web/factory/projects/<id>/mcp` sits under it): the audience of
 * the OAuth access tokens MCP clients get. One resource for all Factories, so a
 * client signs in once per server, not per Factory; which Factory and
 * organization a call reaches is decided per request, like the web UI.
 */
export function factoryMcpResource(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/web/factory`;
}

/** The OAuth authorization server's issuer: better-auth under `/auth/api`. */
export function factoryAuthorizationServer(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/auth/api`;
}

/** Where the OAuth provider sends a person to sign in, and to allow an MCP client. */
export const OAUTH_LOGIN_PAGE = '/signin';
export const OAUTH_CONSENT_PAGE = '/oauth/consent';

/** How long an MCP client's access token lasts; it renews with its refresh token. */
export const OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 60 * 60;

/** How long an invitation link stays valid. */
export const INVITATION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

/** How long a person's role in an organization stays cached (the viewer gate reads it per request). */
const ROLE_CACHE_TTL_MS = 10_000;

export interface MastraAuthBetterAuthOptions extends MastraAuthProviderOptions<BetterAuthUser> {
  /**
   * The Better Auth instance to use for authentication.
   * This should be the result of calling `betterAuth({ ... })`.
   *
   * Optional when `secret` and `google` are provided: the provider then builds
   * its own `betterAuth()` instance in `init()` on the host's auth database
   * (deferred instance mode) and owns its schema migrations.
   */
  auth?: Auth;

  /**
   * Secret used for session signing by the provider-built `betterAuth()`
   * instance (deferred instance mode). Ignored when `auth` is provided.
   */
  secret?: string;

  /** Google sign-in, the only way in for the provider-built instance. Ignored when `auth` is provided. */
  google?: GoogleClientOptions;

  /**
   * Organization events (role changes, join links…) and membership changes.
   * Pass the same relay to `factoryBetterAuthOptions` when bringing your own
   * `auth`; the provider-built instance gets the provider's own.
   */
  events?: OrganizationEventRelay;

  /**
   * Tells invited people (an email with the invitation link). Without one, the inviter copies
   * the link from the team settings. Pass it to `factoryBetterAuthOptions` when bringing your own
   * `auth`.
   */
  invitations?: InvitationNotifier;
}

/** Host context the provider-built better-auth instance needs. */
export interface FactoryBetterAuthConfig {
  database: BetterAuthOptions['database'];
  secret: string;
  google: GoogleClientOptions;
  publicUrl?: string;
  allowedOrigins?: string[];
  /** Where organization events go (the provider's relay). Without one, events are logged as not audited. */
  events?: OrganizationEventRelay;
  /** Tells invited people; without one, nobody is told and the inviter shares the link. */
  invitations?: InvitationNotifier;
}

/**
 * The better-auth options Factory runs on: Google only, organizations whose
 * invitations go out through the host's `InvitationNotifier`, account linking for rows that already carry the person's
 * email (users moved over from the previous sign-in).
 *
 * Returned widened to `BetterAuthOptions`: `betterAuth()`'s return type is
 * generic over the exact options object, which would make the instance
 * incompatible with the plain `Auth` alias we store.
 */
type SendInvitationEmail = NonNullable<OrganizationPluginOptions['sendInvitationEmail']>;

/**
 * better-auth's `sendInvitationEmail`, handed to the host's notifier. A notifier that throws
 * anyway is caught here: better-auth would turn it into a failed invite after the row exists.
 */
export function invitationSender(notifier: InvitationNotifier): SendInvitationEmail {
  return async ({ id, email, role, organization, inviter, invitation }) => {
    try {
      await notifier.invitationCreated({
        invitationId: id,
        email,
        role,
        organization: { id: organization.id, name: organization.name },
        inviter: {
          userId: inviter.user.id,
          ...(inviter.user.name ? { name: inviter.user.name } : {}),
          ...(inviter.user.email ? { email: inviter.user.email } : {}),
        },
        expiresAt: new Date(invitation.expiresAt),
      });
    } catch (error) {
      console.error('[BetterAuth] The invitation notifier threw; the invitation stays, its link can be copied.', error);
    }
  };
}

export function factoryBetterAuthOptions(config: FactoryBetterAuthConfig): BetterAuthOptions {
  const allowedOrigins = config.allowedOrigins ?? [];
  const crossSite = allowedOrigins.length > 0;
  const events = config.events ?? new OrganizationEventRelay();
  return {
    database: config.database,
    secret: config.secret,
    // All provider endpoints (sign-in, callback, sign-out, session, organization)
    // live under /auth/api/*, where hosts mount handleAuthRequest.
    basePath: '/auth/api',
    ...(config.publicUrl ? { baseURL: config.publicUrl } : {}),
    // Cross-origin SPA deploys: SameSite=None only lets the browser SEND the
    // cookie — better-auth still rejects requests from origins outside its
    // own allow-list, so the SPA origins must be trusted too.
    ...(crossSite ? { trustedOrigins: allowedOrigins } : {}),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        prompt: 'select_account',
      },
    },
    account: {
      // A Google sign-in whose email matches an existing user row signs in as
      // that row, so people moved over from the previous sign-in keep their id.
      // The row must have a verified email (better-auth's
      // `requireLocalEmailVerified` default). The profile (name, picture) is
      // copied from Google only at that first link; later sign-ins leave a
      // name or picture the person chose alone (Google's
      // `overrideUserInfoOnSignIn` stays off).
      accountLinking: { enabled: true, trustedProviders: ['google'], updateUserInfoOnLink: true },
    },
    hooks: {
      ...(config.publicUrl ? { before: loopbackClientsAreNative } : {}),
      // Role changes, removals, invitations and organization edits go to the audit log.
      after: organizationEventsHook(events),
    },
    plugins: [
      ...(config.publicUrl ? mcpAuthorizationServerPlugins(config.publicUrl) : []),
      organization({
        // Owner, admin, member and viewer (ADR-0045). better-auth's own `defaultAc`
        // does not satisfy its option type's generic parameters, hence the casts.
        ac: organizationAccessControl.ac as unknown as OrganizationPluginOptions['ac'],
        roles: organizationAccessControl.roles as unknown as OrganizationPluginOptions['roles'],
        // Personal organizations are created by this provider (ensureOrganization);
        // nobody creates further ones through the API.
        allowUserToCreateOrganization: false,
        // Every factory, project and connection belongs to an organization;
        // deleting one would orphan them.
        disableOrganizationDeletion: true,
        invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
        // The invitation id travels in a link (emailed, or sent by hand), so a
        // verified email (Google's) is what proves the recipient.
        requireEmailVerificationOnInvitation: true,
        // better-auth awaits this before answering the invite (and again on a
        // resend). The notifier never throws: a mail outage leaves the
        // invitation in place with its link to copy.
        ...(config.invitations ? { sendInvitationEmail: invitationSender(config.invitations) } : {}),
        organizationHooks: {
          // better-auth lets an owner invite another owner; Factory keeps one
          // owner per organization (the one who cannot leave it).
          // Invitations carry one of the three roles a person can be given.
          beforeCreateInvitation: async ({ invitation }) => {
            const roles = invitation.role.split(',').map(role => role.trim());
            if (roles.length !== 1 || !roles.every(isAssignableRole)) {
              throw APIError.from('FORBIDDEN', {
                code: 'YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE',
                message: 'You are not allowed to invite a user with this role',
              });
            }
          },
          // A role change gives one of the three roles, and never touches the owner
          // (better-auth would let the owner hand `owner` on, or demote themself
          // while another owner exists).
          beforeUpdateMemberRole: async ({ member, newRole }) => {
            const roles = newRole.split(',').map(role => role.trim());
            if (member.role.split(',').includes(OWNER_ROLE) || roles.length !== 1 || !roles.every(isAssignableRole)) {
              throw APIError.from('FORBIDDEN', {
                code: 'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER',
                message: 'The owner keeps their role, and a member can only be made viewer, member or admin.',
              });
            }
          },
        },
      }),
    ],
    // Cross-origin SPA deploys need SameSite=None; Secure for the browser to
    // send the session cookie.
    ...(crossSite ? { advanced: { defaultCookieAttributes: { sameSite: 'none', secure: true } } } : {}),
  };
}

/**
 * Factory as the OAuth 2.1 authorization server for MCP clients (Claude Code,
 * Cursor): authorization code + PKCE, dynamic client registration (RFC 7591)
 * without a prior account, RFC 8414 metadata, refresh tokens and revocation.
 * Signing in is the Google sign-in (`/signin`), and the person allows the
 * client on the consent page. Access tokens are JWTs for the
 * {@link factoryMcpResource} audience; `authenticateToken` verifies them.
 */
function mcpAuthorizationServerPlugins(publicUrl: string): NonNullable<BetterAuthOptions['plugins']> {
  const resource = factoryMcpResource(publicUrl);
  return [
    jwt({ jwt: { issuer: factoryAuthorizationServer(publicUrl) } }),
    oauthProvider({
      loginPage: OAUTH_LOGIN_PAGE,
      consentPage: OAUTH_CONSENT_PAGE,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationRequirePKCE: true,
      resources: [{ identifier: resource, name: 'Factory MCP' }],
      clientRegistrationDefaultResources: [resource],
      clientRegistrationAllowedResources: [resource],
      accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    }),
  ];
}

function isHttpLoopbackUri(uri: unknown): boolean {
  if (typeof uri !== 'string') return false;
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * MCP clients on the person's machine (Claude Code, Cursor) register with an
 * `http://localhost:<port>/callback` redirect and no `application_type`, which
 * RFC 7591 defaults to `web` — and a web client may not redirect to loopback.
 * They are native apps (RFC 8252 §7.3), so a registration whose redirects are
 * all HTTP loopback and that names no type is registered as `native`.
 */
const loopbackClientsAreNative = createAuthMiddleware(async ctx => {
  if (ctx.path !== '/oauth2/register') return;
  const body = ctx.body as { application_type?: unknown; redirect_uris?: unknown } | undefined;
  if (!body || body.application_type !== undefined || !Array.isArray(body.redirect_uris)) return;
  if (body.redirect_uris.length === 0 || !body.redirect_uris.every(isHttpLoopbackUri)) return;
  return { context: { body: { ...body, application_type: 'native' } } };
});

/**
 * How long a resolved `userId → orgId` mapping (and a confirmed membership)
 * stays cached. Bounded so an administrator revoking a membership takes effect
 * within a minute, rather than persisting until process restart.
 */
const ORG_CACHE_TTL_MS = 60_000;

/** Loose row shapes read back from better-auth's internal DB adapter. */
interface MemberRow {
  organizationId?: string;
  role?: string;
  userId?: string;
}
interface OrganizationRow {
  id: string;
}

/**
 * Tagged auth-database handle shape hosts may pass as `AuthInitContext.database`
 * (e.g. the Mastra Code web factory's storage backends).
 */
interface TaggedAuthDatabase {
  dialect?: string;
  pool?: unknown;
  client?: unknown;
  database?: unknown;
}

/**
 * Upstream's `#cachedOrgId`/`#storeOrgId` as a small class, because Factory
 * keeps two caches with the same TTL (resolved default org, confirmed
 * memberships).
 */
class ExpiringMap<V> {
  #entries = new Map<string, { value: V; expiresAt: number }>();
  readonly #ttlMs: number;

  constructor(ttlMs: number = ORG_CACHE_TTL_MS) {
    this.#ttlMs = ttlMs;
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * The map is kept in expiry order: writes delete-then-set so refreshed
   * entries move to the back, and since every entry uses the same TTL,
   * iteration order is ascending `expiresAt`. The sweep therefore stops at the
   * first live entry, making each write amortized O(1) instead of a full scan.
   */
  set(key: string, value: V): void {
    const now = Date.now();
    for (const [existing, entry] of this.#entries) {
      if (now < entry.expiresAt) break;
      this.#entries.delete(existing);
    }
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: now + this.#ttlMs });
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/**
 * Factory authentication provider on Better Auth: Google sign-in, a personal
 * organization for every new user, organizations and invitation links.
 *
 * @see https://better-auth.com for Better Auth documentation
 */
export class MastraAuthBetterAuth
  extends MastraAuthProvider<BetterAuthUser>
  implements
    IUserProvider<BetterAuthProfile>,
    IOrganizationsProvider,
    IAuthInit,
    IAuthHttpHandler,
    MembershipDirectory,
    InvitationService
{
  #auth: Auth | undefined;
  /** What `init()` builds the instance from; set exactly when no `auth` was passed. */
  #deferred: { secret: string; google: GoogleClientOptions; invitations?: InvitationNotifier } | undefined;
  /** True when `init()` built the instance — then we also own its migrations. */
  #ownsInstance = false;
  /** Once-per-process migration latch; reset on failure so a later call retries. */
  #migrated: Promise<void> | undefined;
  /**
   * In-process `userId → orgId` cache, shared by `ensureOrganization` and the
   * `authenticateToken` default-org resolution. Only successes are cached, so
   * membership-less users re-run the lookup per request. Entries expire after
   * `ORG_CACHE_TTL_MS` so a membership revoked by an administrator stops being
   * injected into new sessions within the TTL window instead of persisting for
   * the process lifetime.
   */
  #orgCache = new ExpiringMap<string>();
  /** `userId|orgId` pairs confirmed as memberships (positive results only), same TTL. */
  #membershipCache = new ExpiringMap<true>();
  /** `userId → every orgId`, for token requests that name an organization; same TTL. */
  #membershipsCache = new ExpiringMap<string[]>();
  /** `userId|orgId → role` (`null` = not a member), for the viewer gate; short TTL, cleared on a change here. */
  #roleCache = new ExpiringMap<string | null>(ROLE_CACHE_TTL_MS);
  /** Organization events and membership changes from better-auth (see `OrganizationEventRelay`). */
  readonly #events: OrganizationEventRelay;
  /** Where the access-token signing keys are cached between verifications. */
  readonly #jwksCacheKey = {};

  /** @internal Test hook: current org-cache cardinality. */
  get orgCacheSize(): number {
    return this.#orgCache.size;
  }
  /** Set from `init()`: cross-origin SPA deploys need SameSite=None; Secure cookies. */
  #crossSite = false;

  constructor(options: MastraAuthBetterAuthOptions) {
    super({ name: options?.name ?? 'better-auth' });

    if (!options.auth) {
      if (!options.secret) {
        throw new Error(
          'Better Auth instance is required. Please provide the auth option with your Better Auth instance created via betterAuth({ ... }), ' +
            'or provide `secret` and `google` so the provider can build its own instance in init() on the host database.',
        );
      }
      if (!options.google) {
        throw new Error('Better Auth needs the Google client (`google: { clientId, clientSecret }`): Google is the only sign-in.');
      }
      this.#deferred = {
        secret: options.secret,
        google: options.google,
        ...(options.invitations ? { invitations: options.invitations } : {}),
      };
    }

    this.#auth = options.auth;
    this.#events = options.events ?? new OrganizationEventRelay();
    this.#events.onMembershipChanged((organizationId, userId) => {
      this.#roleCache.delete(`${userId}|${organizationId}`);
      this.#membershipCache.delete(`${userId}|${organizationId}`);
      this.#membershipsCache.delete(userId);
      this.#orgCache.delete(userId);
    });

    this.registerOptions(options);
  }

  /**
   * Where organization events (role changes, removals, invitations, join links,
   * organization edits) are recorded; the Factory server sets its audit log.
   */
  setOrganizationEventHandler(handler: OrganizationEventHandler | undefined): void {
    this.#events.setHandler(handler);
  }

  /**
   * The active Better Auth instance. Throws before `init()` in deferred
   * instance mode (constructed with `secret` instead of `auth`).
   */
  protected get auth(): Auth {
    if (!this.#auth) {
      throw new Error(
        'MastraAuthBetterAuth is not initialized — init() must run first (or pass a configured `auth` instance).',
      );
    }
    return this.#auth;
  }

  /**
   * Session cookie name, honoring Better Auth's `cookiePrefix`, a caller
   * override via `advanced.cookies.session_token.name`, and the `__Secure-`
   * prefix Better Auth applies when secure cookies are active.
   */
  get sessionCookieName(): string {
    const options = (this.#auth as { options?: { baseURL?: string; advanced?: Record<string, unknown> } } | undefined)
      ?.options;
    const advanced = options?.advanced as
      | {
          cookiePrefix?: string;
          useSecureCookies?: boolean;
          cookies?: { session_token?: { name?: string } };
        }
      | undefined;
    const prefix = advanced?.cookiePrefix ?? 'better-auth';
    const secure = advanced?.useSecureCookies ?? options?.baseURL?.startsWith('https://') ?? false;
    const baseName = advanced?.cookies?.session_token?.name ?? `${prefix}.session_token`;
    return `${secure ? '__Secure-' : ''}${baseName}`;
  }

  // ============================================
  // IAuthInit implementation
  // ============================================

  /**
   * One-time host initialization. In deferred instance mode (no `auth` in the
   * options) this builds the provider-owned `betterAuth()` instance on the
   * host's auth database; schema migrations then run lazily behind a
   * once-per-process latch on first use.
   *
   * Bring-your-own `auth` instances skip construction entirely — the caller
   * owns their database and migrations.
   */
  async init(ctx: AuthInitContext): Promise<void> {
    this.#crossSite = (ctx.allowedOrigins?.length ?? 0) > 0;
    const deferred = this.#deferred;
    if (this.#auth || !deferred) return; // bring-your-own instance (or already built): nothing to build

    const authDb = ctx.database as TaggedAuthDatabase | undefined;
    if (!authDb) {
      throw new Error(
        'MastraAuthBetterAuth needs a database to build its own better-auth instance, but the host passed none. ' +
          'Use a storage backend that exposes an auth database, or pass your own configured `auth` instance.',
      );
    }
    // Map the host's tagged auth-database handle onto better-auth's `database`
    // option: pg pool directly, libsql via its kysely dialect, anything else
    // passed through as-is (the host owns its compatibility).
    const database: BetterAuthOptions['database'] =
      authDb.dialect === 'postgres'
        ? (authDb.pool as Extract<BetterAuthOptions['database'], { query: unknown }>)
        : authDb.dialect === 'libsql'
          ? {
              dialect: new LibsqlDialect({ client: authDb.client } as ConstructorParameters<typeof LibsqlDialect>[0]),
              type: 'sqlite' as const,
            }
          : (authDb.database as BetterAuthOptions['database']);
    this.#auth = betterAuth(
      factoryBetterAuthOptions({
        database,
        secret: deferred.secret,
        google: deferred.google,
        publicUrl: ctx.publicUrl,
        allowedOrigins: ctx.allowedOrigins,
        events: this.#events,
        ...(deferred.invitations ? { invitations: deferred.invitations } : {}),
      }),
    );
    this.#ownsInstance = true;
  }

  /**
   * Ensure better-auth's tables exist in the host database. Only for instances
   * this provider built — bring-your-own instances manage their own migrations.
   */
  async #ensureDbReady(): Promise<void> {
    if (!this.#ownsInstance) return;
    this.#migrated ??= (async () => {
      const { runMigrations } = await getMigrations(this.auth.options as BetterAuthOptions);
      await runMigrations();
    })();
    try {
      await this.#migrated;
    } catch (error) {
      this.#migrated = undefined; // allow a later call to retry
      console.warn('[BetterAuth] Failed to run auth schema migrations; auth stays unavailable until this succeeds.');
      throw error;
    }
  }

  // ============================================
  // IAuthHttpHandler implementation
  // ============================================

  /**
   * Proxy a raw HTTP request to Better Auth's own API surface (Google sign-in
   * and callback, sign-out, session, organizations and invitations). Hosts
   * mount this under `/auth/api/*`.
   */
  async handleAuthRequest(request: Request): Promise<Response> {
    try {
      await this.#ensureDbReady();
    } catch {
      return new Response(JSON.stringify({ error: 'auth_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return this.auth.handler(request);
  }

  // ============================================
  // IOrganizationsProvider implementation
  // ============================================

  /** The better-auth context for organization lookups; throws when there is none. */
  async #requireAuthContext(): Promise<BetterAuthContext> {
    const ctx = await this.getAuthContext();
    if (!ctx) throw new Error('[BetterAuth] The better-auth context is unavailable; organizations cannot be read.');
    return ctx;
  }

  /** The user's membership row in the organization, or null when they are not a member. */
  #findMember(ctx: BetterAuthContext, organizationId: string, userId: string): Promise<MemberRow | null> {
    return ctx.adapter.findOne<MemberRow>({
      model: 'member',
      where: [
        { field: 'organizationId', value: organizationId },
        { field: 'userId', value: userId },
      ],
    });
  }

  /**
   * Read-only half of org resolution: the user's oldest existing membership,
   * cached in `#orgCache`. Never creates anything. Ordered by `createdAt` so
   * the resolved default is stable across processes for multi-org users.
   */
  async #findMembershipOrgId(ctx: BetterAuthContext, userId: string): Promise<string | undefined> {
    const memberships = await ctx.adapter.findMany<MemberRow>({
      model: 'member',
      where: [{ field: 'userId', value: userId }],
      sortBy: { field: 'createdAt', direction: 'asc' },
    });
    const orgId = memberships.find(m => m.organizationId)?.organizationId;
    if (orgId) this.#orgCache.set(userId, orgId);
    return orgId;
  }

  /**
   * Resolve the organization a session should act under when better-auth's
   * `activeOrganizationId` is not set (or was dropped by `#isMember`): an
   * existing membership or nothing. Read-only.
   *
   * Callers must run `#ensureDbReady` first (authenticateToken does). A failed
   * lookup throws: `authenticateToken` then refuses the request rather than
   * letting it run without (or in another) organization.
   */
  async #resolveActiveOrganizationId(userId: string): Promise<string | undefined> {
    const cached = this.#orgCache.get(userId);
    if (cached) return cached;
    const ctx = await this.getAuthContext();
    if (!ctx) return undefined; // e.g. a partial mock without `$context`: no organizations to resolve
    return await this.#findMembershipOrgId(ctx, userId);
  }

  /**
   * Whether the user still belongs to the organization a session names as
   * active. A member removed by an owner keeps that id on their session row;
   * honoring it would keep them inside the organization until the session
   * expires. A failed lookup throws (see `authenticateToken`).
   */
  async #isMember(userId: string, organizationId: string): Promise<boolean> {
    const key = `${userId}|${organizationId}`;
    if (this.#membershipCache.get(key)) return true;
    const ctx = await this.#requireAuthContext();
    if (!(await this.#findMember(ctx, organizationId, userId))) return false;
    this.#membershipCache.set(key, true);
    return true;
  }

  /**
   * Ensure the user belongs to an organization, mirroring the WorkOS
   * personal-org bootstrap on better-auth's organization tables:
   * ≥1 membership → oldest org id; 0 → create a personal org with an
   * idempotent slug derived from the user id.
   *
   * Concurrent/retried first logins recover via the unique slug instead of
   * creating duplicates. Slug alone is NOT proof of ownership though: in
   * upstream the organization API is reachable by any authenticated user, so
   * an attacker could squat `personal-<victimId>` (Factory turns organization
   * creation off, and keeps the check as the second line). The slug-matched
   * org is only adopted when nobody else is a member; otherwise a fresh org
   * with an unguessable slug is created instead.
   *
   * Failures are logged and thrown (upstream swallowed them and left the user
   * without an organization, which made the request run in a personal scope).
   */
  async ensureOrganization(userId: string): Promise<string | undefined> {
    const cached = this.#orgCache.get(userId);
    if (cached) return cached;

    try {
      await this.#ensureDbReady();
      const ctx = await this.#requireAuthContext();

      const firstExisting = await this.#findMembershipOrgId(ctx, userId);
      if (firstExisting) return firstExisting;

      // Build a predictable personal-org name from the user's profile.
      const userRecord = await ctx.internalAdapter.findUserById(userId);
      const label = userRecord?.email ?? userRecord?.name ?? userId;
      const orgName = `${label}'s org`;
      const orgData = () => ({
        name: orgName,
        createdAt: new Date(),
        metadata: JSON.stringify({ mastraPersonalOrg: 'true' }),
      });

      // Create the personal org. The slug is derived from the user id, so a
      // concurrent/prior bootstrap that already created it makes the insert
      // reject on the unique slug — recover by looking the org up instead.
      const slug = `personal-${userId}`;
      let organizationId: string;
      try {
        const created = await ctx.adapter.create<Record<string, unknown>, OrganizationRow>({
          model: 'organization',
          data: { ...orgData(), slug },
        });
        organizationId = created.id;
      } catch (error) {
        const existing = await ctx.adapter.findOne<OrganizationRow>({
          model: 'organization',
          where: [{ field: 'slug', value: slug }],
        });
        if (!existing) throw error;
        // Only adopt the slug-matched org when nobody else is a member (zero
        // members = a concurrent bootstrap of this same user that hasn't
        // attached yet). Otherwise fall back to an unguessable slug.
        const existingMembers = await ctx.adapter.findMany<MemberRow>({
          model: 'member',
          where: [{ field: 'organizationId', value: existing.id }],
        });
        const foreignMember = existingMembers.some(m => m.userId !== userId);
        if (foreignMember) {
          const fallback = await ctx.adapter.create<Record<string, unknown>, OrganizationRow>({
            model: 'organization',
            data: { ...orgData(), slug: `personal-${userId}-${crypto.randomUUID()}` },
          });
          organizationId = fallback.id;
        } else {
          organizationId = existing.id;
        }
      }

      // Idempotently attach the user: tolerate a membership a concurrent
      // bootstrap already created.
      try {
        await ctx.adapter.create({
          model: 'member',
          data: { organizationId, userId, role: OWNER_ROLE, createdAt: new Date() },
        });
      } catch (error) {
        if (!(await this.#findMember(ctx, organizationId, userId))) throw error;
      }

      this.#orgCache.set(userId, organizationId);
      return organizationId;
    } catch (error) {
      console.error(
        `[BetterAuth] Failed to bootstrap the personal organization for user ${userId}; ` +
          'their requests are refused until this succeeds.',
        error,
      );
      throw error;
    }
  }

  /**
   * Whether the user holds an admin-equivalent role (`owner` or `admin`) in
   * the organization. A failed lookup throws; the host's gate denies and logs it.
   */
  async isOrganizationAdmin(organizationId: string, userId: string): Promise<boolean> {
    await this.#ensureDbReady();
    const ctx = await this.#requireAuthContext();
    const membership = await this.#findMember(ctx, organizationId, userId);
    return membership?.role === OWNER_ROLE || membership?.role === 'admin';
  }

  // ============================================
  // MembershipDirectory and InvitationService (@factory/access, ADR-0045)
  // ============================================

  /**
   * The person's role in the organization, or `null` when they are not a member. Cached for
   * {@link ROLE_CACHE_TTL_MS}; a role change, removal or join in this process clears the entry at
   * once. A failed lookup throws; the host answers 503.
   */
  async role(organizationId: string, userId: string): Promise<Role | null> {
    const key = `${userId}|${organizationId}`;
    const cached = this.#roleCache.get(key);
    if (cached !== undefined) return cached as Role | null;
    const ctx = await this.#directoryContext();
    const membership = await this.#findMember(ctx, organizationId, userId);
    const role = membership?.role === undefined ? null : this.#readRole(membership.role, organizationId, userId);
    this.#roleCache.set(key, role);
    return role;
  }

  /** A stored role Factory does not know is a broken row, not a guess at "member". */
  #readRole(stored: string, organizationId: string, userId: string): Role {
    if (!isRole(stored)) {
      throw new Error(`[BetterAuth] User ${userId} has the unknown role "${stored}" in organization ${organizationId}.`);
    }
    return stored;
  }

  async #directoryContext(): Promise<BetterAuthContext> {
    await this.#ensureDbReady();
    return this.#requireAuthContext();
  }

  async #memberView(ctx: BetterAuthContext, row: Required<MemberRow> & { id: string }): Promise<Member> {
    const user = await ctx.internalAdapter.findUserById(row.userId);
    return {
      id: row.id,
      organizationId: row.organizationId,
      userId: row.userId,
      role: this.#readRole(row.role, row.organizationId, row.userId),
      name: user?.name ?? '',
      email: user?.email ?? '',
      image: user?.image ?? null,
    };
  }

  async listMembers(organizationId: string): Promise<Member[]> {
    const ctx = await this.#directoryContext();
    const rows = await ctx.adapter.findMany<Required<MemberRow> & { id: string }>({
      model: 'member',
      where: [{ field: 'organizationId', value: organizationId }],
      sortBy: { field: 'createdAt', direction: 'asc' },
    });
    return Promise.all(rows.map(row => this.#memberView(ctx, row)));
  }

  async addMember(organizationId: string, userId: string, role: AssignableRole): Promise<Member> {
    if (!isAssignableRole(role)) throw new Error(`Cannot add a member with the role ${String(role)}.`);
    const ctx = await this.#directoryContext();
    const existing = (await this.#findMember(ctx, organizationId, userId)) as (Required<MemberRow> & { id: string }) | null;
    if (existing) return this.#memberView(ctx, existing);
    const created = await ctx.adapter.create<Record<string, unknown>, Required<MemberRow> & { id: string }>({
      model: 'member',
      data: { organizationId, userId, role, createdAt: new Date() },
    });
    this.#events.membershipChanged(organizationId, userId);
    return this.#memberView(ctx, created);
  }

  async #memberById(ctx: BetterAuthContext, organizationId: string, memberId: string) {
    const row = await ctx.adapter.findOne<Required<MemberRow> & { id: string }>({
      model: 'member',
      where: [
        { field: 'id', value: memberId },
        { field: 'organizationId', value: organizationId },
      ],
    });
    if (!row) throw new Error(`No member ${memberId} in organization ${organizationId}.`);
    return row;
  }

  async changeRole(organizationId: string, memberId: string, role: AssignableRole): Promise<Member> {
    if (!isAssignableRole(role)) throw new Error(`Cannot give the role ${String(role)}.`);
    const ctx = await this.#directoryContext();
    const row = await this.#memberById(ctx, organizationId, memberId);
    if (row.role === OWNER_ROLE) throw new Error('The owner keeps their role.');
    await ctx.adapter.update({ model: 'member', where: [{ field: 'id', value: memberId }], update: { role } });
    this.#events.membershipChanged(organizationId, row.userId);
    return this.#memberView(ctx, { ...row, role });
  }

  async remove(organizationId: string, memberId: string): Promise<void> {
    const ctx = await this.#directoryContext();
    const row = await this.#memberById(ctx, organizationId, memberId);
    if (row.role === OWNER_ROLE) throw new Error('The owner cannot be removed.');
    await ctx.adapter.delete({ model: 'member', where: [{ field: 'id', value: memberId }] });
    this.#events.membershipChanged(organizationId, row.userId);
  }

  async leave(organizationId: string, userId: string): Promise<void> {
    const ctx = await this.#directoryContext();
    const row = (await this.#findMember(ctx, organizationId, userId)) as (Required<MemberRow> & { id: string }) | null;
    if (!row) return;
    if (row.role === OWNER_ROLE) throw new Error('The owner cannot leave their organization.');
    await ctx.adapter.delete({ model: 'member', where: [{ field: 'id', value: row.id }] });
    this.#events.membershipChanged(organizationId, userId);
  }

  async person(userId: string): Promise<Person | null> {
    const ctx = await this.#directoryContext();
    const user = await ctx.internalAdapter.findUserById(userId);
    return user ? { id: user.id, email: user.email, emailVerified: user.emailVerified, name: user.name } : null;
  }

  async organization(organizationId: string): Promise<{ id: string; name: string; logo: string | null } | null> {
    const ctx = await this.#directoryContext();
    const row = await ctx.adapter.findOne<{ id: string; name: string; logo?: string | null }>({
      model: 'organization',
      where: [{ field: 'id', value: organizationId }],
    });
    return row ? { id: row.id, name: row.name, logo: row.logo ?? null } : null;
  }

  async invite(organizationId: string, email: string, role: AssignableRole, inviterUserId: string): Promise<Invitation> {
    if (!isAssignableRole(role)) throw new Error(`Cannot invite with the role ${String(role)}.`);
    const ctx = await this.#directoryContext();
    const row = await ctx.adapter.create<Record<string, unknown>, Record<string, unknown> & { id: string }>({
      model: 'invitation',
      data: {
        organizationId,
        email: email.trim().toLowerCase(),
        role,
        status: 'pending',
        inviterId: inviterUserId,
        expiresAt: new Date(Date.now() + INVITATION_EXPIRES_IN_SECONDS * 1000),
        createdAt: new Date(),
      },
    });
    return this.#invitationView(row);
  }

  async cancel(organizationId: string, invitationId: string): Promise<void> {
    const ctx = await this.#directoryContext();
    await ctx.adapter.update({
      model: 'invitation',
      where: [
        { field: 'id', value: invitationId },
        { field: 'organizationId', value: organizationId },
      ],
      update: { status: 'canceled' },
    });
  }

  async list(organizationId: string): Promise<Invitation[]> {
    const ctx = await this.#directoryContext();
    const rows = await ctx.adapter.findMany<Record<string, unknown> & { id: string }>({
      model: 'invitation',
      where: [{ field: 'organizationId', value: organizationId }],
    });
    return rows.map(row => this.#invitationView(row));
  }

  #invitationView(row: Record<string, unknown> & { id: string }): Invitation {
    const role = String(row.role);
    if (!isAssignableRole(role)) throw new Error(`[BetterAuth] Invitation ${row.id} has the unknown role "${role}".`);
    return {
      id: row.id,
      organizationId: String(row.organizationId),
      email: String(row.email),
      role,
      status: String(row.status),
      expiresAt: new Date(row.expiresAt as string | Date).toISOString(),
    };
  }

  // ============================================
  // IUserProvider implementation
  // ============================================

  /**
   * Get current user from request.
   *
   * Supports both cookie-based sessions and `Authorization: Bearer <token>`
   * requests.
   *
   * @param request - Incoming HTTP request
   * @returns The user profile or null if not authenticated
   */
  async getCurrentUser(request: Request): Promise<BetterAuthProfile | null> {
    try {
      await this.#ensureDbReady();
      const headers = new Headers(request.headers);

      // If the request authenticates via Bearer token instead of cookies,
      // convert the token to a signed session cookie so getSession accepts it.
      const authHeader = headers.get('Authorization');
      const bearerToken =
        authHeader && authHeader.slice(0, 7).toLowerCase() === 'bearer ' ? authHeader.slice(7).trim() : undefined;
      await this.ensureSessionCookie(headers, bearerToken);

      const result = await this.auth.api.getSession({
        headers,
      });

      if (!result?.user) return null;
      return mapBetterAuthUser(result.user);
    } catch {
      return null;
    }
  }

  /**
   * Get user by ID.
   *
   * Uses Better Auth's internal adapter to look up the user record,
   * so it works with whichever database Better Auth is configured with.
   *
   * @param userId - User identifier
   * @returns The user profile or null if not found
   */
  async getUser(userId: string): Promise<BetterAuthProfile | null> {
    try {
      const ctx = await this.getAuthContext();
      if (!ctx) return null;

      const user = await ctx.internalAdapter.findUserById(userId);
      if (!user) return null;
      return mapBetterAuthUser(user);
    } catch {
      return null;
    }
  }

  /**
   * Get multiple users by ID.
   * Optional IUserProvider method used for batch author enrichment.
   *
   * @param userIds - User identifiers
   * @returns User profiles (null for missing users, order preserved)
   */
  async getUsers(userIds: string[]): Promise<Array<BetterAuthProfile | null>> {
    return Promise.all(userIds.map(userId => this.getUser(userId)));
  }

  /**
   * Get URL to user's profile page.
   * Optional IUserProvider method.
   */
  getUserProfileUrl(user: BetterAuthProfile): string {
    return `/profile/${user.id}`;
  }

  /**
   * Get the resolved Better Auth context, or null when the instance has none
   * (e.g. a partial mock without `$context`). A context that fails to resolve
   * (database unreachable) throws instead of reading as "no context".
   */
  private async getAuthContext(): Promise<BetterAuthContext | null> {
    return (await Promise.resolve(this.auth.$context)) ?? null;
  }

  /**
   * Ensure the Cookie header on `headers` carries a Better Auth session cookie
   * for the given token.
   *
   * Better Auth's `getSession` reads the session from a *signed* cookie
   * (`<token>.<HMAC-SHA256 signature>`). Mirroring Better Auth's bearer
   * plugin, unsigned tokens are signed with the instance secret before being
   * set as the session cookie.
   */
  private async ensureSessionCookie(headers: Headers, token: string | undefined): Promise<void> {
    if (!token) return;

    const ctx = await this.getAuthContext();
    const cookieName = ctx?.authCookies.sessionToken.name ?? this.sessionCookieName;
    const secret = ctx?.secret;

    const cookieHeader = headers.get('Cookie');
    const hasSessionCookie = !!cookieHeader?.split(';').some(pair => {
      const [key] = pair.trim().split('=');
      return key?.trim() === cookieName;
    });
    if (hasSessionCookie) return;

    // Tokens containing "." are already signed (and may be URI-encoded).
    let cookieValue = token.includes('.') ? (token.includes('%') ? tryDecode(token) : token) : token;
    if (!token.includes('.') && secret) {
      cookieValue = `${token}.${await makeSignature(token, secret)}`;
    }

    const existingCookies = cookieHeader ? `${cookieHeader}; ` : '';
    headers.set('Cookie', `${existingCookies}${cookieName}=${encodeURIComponent(cookieValue)}`);
  }

  /**
   * Authenticate a bearer token by verifying the session with Better Auth.
   *
   * This method extracts the session from the request headers using
   * Better Auth's `api.getSession()` endpoint. Raw (unsigned) session tokens
   * are signed before being passed to Better Auth as a session cookie,
   * matching the bearer plugin's semantics.
   *
   * `null` means no valid session. When the session or the user's
   * organizations cannot be read (database down), it logs and throws instead:
   * the host answers 503 rather than sending the person to sign in, and the
   * request never runs in another organization than the one asked for.
   *
   * @param token - The bearer token (session token) to authenticate
   * @param request - The request containing headers
   * @returns The authenticated user and session, or null if authentication fails
   */
  async authenticateToken(token: string, request: MastraAuthRequest): Promise<BetterAuthUser | null> {
    const result = isOAuthAccessToken(token)
      ? await this.#sessionForAccessToken(token)
      : await this.#sessionForCookie(token, request);
    if (!result || !result.session || !result.user) {
      return null;
    }

    // Better-auth sets `activeOrganizationId` only through the organization
    // plugin (`set-active`, accepting an invitation). Resolve a default from
    // the user's existing memberships when the session has none, or names one
    // the user has since been removed from (read-only; the session row is not
    // mutated). See mastra-ai/mastra#21481.
    const userId = result.user.id;
    let session: BetterAuthUser['session'] = result.session;
    const active = session.activeOrganizationId;
    let organizationMembershipIds: string[] | undefined;
    try {
      if (active && !(await this.#isMember(userId, active))) {
        session = { ...session, activeOrganizationId: null };
      }
      if (!session.activeOrganizationId) {
        const organizationId = await this.#resolveActiveOrganizationId(userId);
        if (organizationId) session = { ...session, activeOrganizationId: organizationId };
      }
      if (isOAuthAccessToken(token)) organizationMembershipIds = await this.#memberOrganizationIds(userId);
    } catch (error) {
      console.error(
        `[BetterAuth] Could not read the organizations of user ${userId} (active organization: ${active ?? 'none'}); ` +
          'the request is refused instead of running in another organization.',
        error,
      );
      throw error;
    }

    return {
      session,
      user: result.user,
      ...(organizationMembershipIds ? { organizationMembershipIds } : {}),
    };
  }

  /** Every organization the user belongs to (cached like the default organization). */
  async #memberOrganizationIds(userId: string): Promise<string[] | undefined> {
    const cached = this.#membershipsCache.get(userId);
    if (cached) return cached;
    const ctx = await this.getAuthContext();
    if (!ctx) return undefined; // e.g. a partial mock without `$context`
    const memberships = await ctx.adapter.findMany<MemberRow>({ model: 'member', where: [{ field: 'userId', value: userId }] });
    const ids = memberships.flatMap(m => (m.organizationId ? [m.organizationId] : []));
    this.#membershipsCache.set(userId, ids);
    return ids;
  }

  /**
   * An MCP client's OAuth access token (`oauthProvider`, see
   * {@link factoryMcpResource}): a JWS for this server's MCP resource, signed
   * with its JWKS, naming the user (`sub`) and the browser session they
   * allowed the client from (`sid`). That session must still be live: signing
   * out revokes the client's access too (and an access token expires within
   * an hour anyway; refresh tokens are revoked at `/oauth2/revoke`). An invalid
   * token is `null`; a server failure throws (503 at the host).
   */
  async #sessionForAccessToken(token: string): Promise<{ session: BetterAuthUser['session']; user: User } | null> {
    await this.#ensureDbReady();
    const baseURL = (this.auth.options as BetterAuthOptions).baseURL;
    // Without a public URL the provider runs no authorization server, so it issued no access tokens.
    if (typeof baseURL !== 'string') return null;
    const jwksFetch: JwksFetch = async () =>
      (await (this.auth.api as unknown as { getJwks(): Promise<Awaited<ReturnType<Exclude<JwksFetch, string>>>> }).getJwks());
    let payload: { sub?: unknown; sid?: unknown };
    try {
      payload = await verifyJwsAccessToken(token, {
        jwksFetch,
        jwksCacheKey: this.#jwksCacheKey,
        verifyOptions: { audience: factoryMcpResource(baseURL), issuer: factoryAuthorizationServer(baseURL) },
      });
    } catch (error) {
      if (isRejectedToken(error)) return null;
      console.error('[BetterAuth] Could not verify an OAuth access token; the request cannot be authenticated now.', error);
      throw error;
    }
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    const ctx = await this.#requireAuthContext();
    const session = await ctx.adapter.findOne<BetterAuthUser['session']>({
      model: 'session',
      where: [{ field: 'id', value: payload.sid }],
    });
    if (!session || session.userId !== payload.sub || new Date(session.expiresAt).getTime() <= Date.now()) return null;
    const user = await ctx.internalAdapter.findUserById(payload.sub);
    return user ? { session, user } : null;
  }

  /** The browser's session cookie, or a session token sent as a bearer token. */
  async #sessionForCookie(
    token: string,
    request: MastraAuthRequest,
  ): Promise<{ session: BetterAuthUser['session']; user: User } | null> {
    try {
      await this.#ensureDbReady();

      // Better Auth's api.getSession() reads session tokens from the Cookie header
      const headers = new Headers();

      const cookieHeader = getRequestHeader(request, 'Cookie');
      if (cookieHeader) {
        headers.set('Cookie', cookieHeader);
      }

      // Convert Bearer token to a signed session cookie if not already present.
      // better-auth ignores the Authorization header — it only reads from Cookie.
      await this.ensureSessionCookie(headers, token);

      return await this.auth.api.getSession({
        headers,
      });
    } catch (error) {
      // better-auth rejecting the session itself (4xx) is "not signed in".
      if (error instanceof APIError && error.statusCode < 500) return null;
      console.error('[BetterAuth] Could not read the session; the request cannot be authenticated now.', error);
      throw error;
    }
  }

  /**
   * Authorize a user for access.
   *
   * By default, any authenticated user with a valid session is authorized.
   * You can override this behavior by providing a custom `authorizeUser` function
   * in the constructor options.
   *
   * @param user - The authenticated user and session
   * @returns True if the user is authorized, false otherwise
   */
  async authorizeUser(user: BetterAuthUser): Promise<boolean> {
    // By default, any authenticated user with a valid session is authorized
    return !!user?.session?.id && !!user?.user?.id;
  }

  /**
   * Get the underlying Better Auth instance.
   * Useful for accessing Better Auth APIs directly.
   */
  getAuth(): Auth {
    return this.auth;
  }

  /**
   * Get headers to clear the session cookies on logout.
   * Partial ISessionProvider implementation for logout support.
   *
   * Clears Better Auth's default session cookies.
   */
  getClearSessionHeaders(): Record<string, string> {
    // Cross-site deploys set the session cookie with SameSite=None; Secure —
    // the clearing cookie must match those attributes to overwrite it.
    const sameSite = this.#crossSite ? 'None; Secure' : 'Lax';
    // Clear both the session token and its signature cookie
    const cookies = [
      `${this.sessionCookieName}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0`,
      `${this.sessionCookieName}_sig=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0`,
    ];
    return {
      'Set-Cookie': cookies.join(', '),
    };
  }
}
