/*
 * Derived from @mastra/auth-better-auth 1.1.8 (auth/better-auth/src/index.ts),
 * Copyright (c) Mastra AI, Inc., licensed under the Apache License 2.0.
 * Changed for Factory v4: Google is the only way in (no email/password, no
 * ICredentialsProvider), organizations come without email sending and users
 * cannot create them through the API, invitations last 7 days, Google sign-in
 * links to an existing user row with the same email, and a session's active
 * organization is honored only while the user is still a member of it.
 * See THIRD_PARTY_NOTICES.md and MIGRATION.md.
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
import { makeSignature } from 'better-auth/crypto';
import { getMigrations } from 'better-auth/db/migration';
import { organization } from 'better-auth/plugins';

export type BetterAuthContext = Awaited<Auth['$context']>;

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
}

/** The user shape this provider reports to `IUserProvider` consumers. */
export interface BetterAuthProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  metadata: { emailVerified: boolean; createdAt: Date; updatedAt: Date };
}

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

/** How long an invitation link stays valid. */
export const INVITATION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

export interface MastraAuthBetterAuthOptions extends MastraAuthProviderOptions<BetterAuthUser> {
  /**
   * A configured Better Auth instance (tests, custom hosts). When omitted, the
   * provider builds its own in `init()` on the host's auth database from
   * `secret` and `google`, and owns its schema migrations.
   */
  auth?: Auth;

  /** Secret used for session signing by the provider-built instance. Ignored when `auth` is provided. */
  secret?: string;

  /** Google sign-in, the only way in for the provider-built instance. Ignored when `auth` is provided. */
  google?: GoogleClientOptions;
}

/** Host context the provider-built better-auth instance needs. */
export interface FactoryBetterAuthConfig {
  database: BetterAuthOptions['database'];
  secret: string;
  google: GoogleClientOptions;
  publicUrl?: string;
  allowedOrigins?: string[];
}

/**
 * The better-auth options Factory runs on: Google only, organizations without
 * email sending, account linking for rows that already carry the person's
 * email (users moved over from the previous sign-in).
 */
export function factoryBetterAuthOptions(config: FactoryBetterAuthConfig): BetterAuthOptions {
  const allowedOrigins = config.allowedOrigins ?? [];
  const crossSite = allowedOrigins.length > 0;
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
      // `requireLocalEmailVerified` default).
      accountLinking: { enabled: true, trustedProviders: ['google'], updateUserInfoOnLink: true },
    },
    plugins: [
      organization({
        // Personal organizations are created by this provider (ensureOrganization);
        // nobody creates further ones through the API.
        allowUserToCreateOrganization: false,
        invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
        // The invitation id travels in a link the inviter sends by hand, so a
        // verified email (Google's) is what proves the recipient.
        requireEmailVerificationOnInvitation: true,
      }),
    ],
    // Cross-origin SPA deploys need SameSite=None; Secure for the browser to
    // send the session cookie.
    ...(crossSite ? { advanced: { defaultCookieAttributes: { sameSite: 'none', secure: true } } } : {}),
  };
}

/**
 * How long a resolved `userId → orgId` mapping (and a confirmed membership)
 * stays cached. Bounded so an administrator revoking a membership takes effect
 * within a minute, rather than persisting until process restart.
 */
const ORG_CACHE_TTL_MS = 60_000;

interface MemberRow {
  organizationId?: string;
  role?: string;
  userId?: string;
}
interface OrganizationRow {
  id: string;
}

/**
 * Tagged auth-database handle shape hosts pass as `AuthInitContext.database`
 * (the factory's storage backends: `{ dialect: 'postgres', pool }` or
 * `{ dialect: 'libsql', client }`).
 */
interface TaggedAuthDatabase {
  dialect?: string;
  pool?: unknown;
  client?: unknown;
  database?: unknown;
}

/** Map the host's tagged auth-database handle onto better-auth's `database` option. */
function betterAuthDatabase(authDb: TaggedAuthDatabase): BetterAuthOptions['database'] {
  if (authDb.dialect === 'postgres') return authDb.pool as Extract<BetterAuthOptions['database'], { query: unknown }>;
  if (authDb.dialect === 'libsql') {
    return {
      dialect: new LibsqlDialect({ client: authDb.client } as ConstructorParameters<typeof LibsqlDialect>[0]),
      type: 'sqlite' as const,
    };
  }
  return authDb.database as BetterAuthOptions['database'];
}

/** A TTL cache kept in expiry order (every entry uses the same TTL). */
class ExpiringMap<V> {
  #entries = new Map<string, { value: V; expiresAt: number }>();

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
   * Writes delete-then-set so refreshed entries move to the back; iteration
   * order is therefore ascending `expiresAt` and the sweep stops at the first
   * live entry, making each write amortized O(1).
   */
  set(key: string, value: V): void {
    const now = Date.now();
    for (const [existing, entry] of this.#entries) {
      if (now < entry.expiresAt) break;
      this.#entries.delete(existing);
    }
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: now + ORG_CACHE_TTL_MS });
  }

  get size(): number {
    return this.#entries.size;
  }
}

/**
 * Factory authentication provider on Better Auth: Google sign-in, a personal
 * organization for every new user, organizations and invitation links.
 */
export class MastraAuthBetterAuth
  extends MastraAuthProvider<BetterAuthUser>
  implements IUserProvider<BetterAuthProfile>, IOrganizationsProvider, IAuthInit, IAuthHttpHandler
{
  #auth: Auth | undefined;
  #secret: string | undefined;
  #google: GoogleClientOptions | undefined;
  /** True when `init()` built the instance — then we also own its migrations. */
  #ownsInstance = false;
  /** Once-per-process migration latch; reset on failure so a later call retries. */
  #migrated: Promise<void> | undefined;
  /**
   * In-process `userId → orgId` cache, shared by `ensureOrganization` and the
   * `authenticateToken` default-org resolution. Only successes are cached, so
   * membership-less users re-run the lookup per request.
   */
  #orgCache = new ExpiringMap<string>();
  /** `userId|orgId` pairs confirmed as memberships (positive results only). */
  #membershipCache = new ExpiringMap<true>();
  /** Set from `init()`: cross-origin SPA deploys need SameSite=None; Secure cookies. */
  #crossSite = false;

  /** @internal Test hook: current org-cache cardinality. */
  get orgCacheSize(): number {
    return this.#orgCache.size;
  }

  constructor(options: MastraAuthBetterAuthOptions) {
    super({ name: options?.name ?? 'better-auth' });

    if (!options.auth && !options.secret) {
      throw new Error(
        'Better Auth instance is required. Provide the auth option with a Better Auth instance, ' +
          'or provide `secret` and `google` so the provider can build its own instance in init() on the host database.',
      );
    }
    if (!options.auth && !options.google) {
      throw new Error('Better Auth needs the Google client (`google: { clientId, clientSecret }`): Google is the only sign-in.');
    }

    this.#auth = options.auth;
    this.#secret = options.secret;
    this.#google = options.google;

    this.registerOptions(options);
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
   * once-per-process latch on first use (or eagerly through `authContext()`).
   */
  async init(ctx: AuthInitContext): Promise<void> {
    this.#crossSite = (ctx.allowedOrigins?.length ?? 0) > 0;
    if (this.#auth) return; // bring-your-own instance: nothing to build

    const authDb = ctx.database as TaggedAuthDatabase | undefined;
    if (!authDb) {
      throw new Error(
        'MastraAuthBetterAuth needs a database to build its own better-auth instance, but the host passed none. ' +
          'Use a storage backend that exposes an auth database, or pass your own configured `auth` instance.',
      );
    }
    this.#auth = betterAuth(
      factoryBetterAuthOptions({
        database: betterAuthDatabase(authDb),
        secret: this.#secret!,
        google: this.#google!,
        publicUrl: ctx.publicUrl,
        allowedOrigins: ctx.allowedOrigins,
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

  /**
   * The better-auth context with its tables ready, for host-side maintenance
   * that writes rows directly (moving existing users over at boot). Throws when
   * the database is not reachable or migrations fail.
   */
  async authContext(): Promise<BetterAuthContext> {
    await this.#ensureDbReady();
    return await Promise.resolve(this.auth.$context);
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

  /**
   * Read-only half of org resolution: the user's oldest existing membership,
   * cached in `#orgCache`. Never creates anything. Ordered by `createdAt` so
   * the resolved default is stable across processes for multi-org users.
   */
  async #findMembershipOrgId(ctx: BetterAuthContext, userId: string): Promise<string | undefined> {
    const memberships = (await ctx.adapter.findMany({
      model: 'member',
      where: [{ field: 'userId', value: userId }],
      sortBy: { field: 'createdAt', direction: 'asc' },
    })) as MemberRow[];
    const orgId = memberships.find(m => m.organizationId)?.organizationId;
    if (orgId) this.#orgCache.set(userId, orgId);
    return orgId;
  }

  /**
   * Resolve the organization a session should act under when better-auth's
   * `activeOrganizationId` was never set. Read-only and best-effort: an
   * existing membership or nothing.
   *
   * Callers must run `#ensureDbReady` first (authenticateToken does); this
   * method deliberately swallows failures, so an unmigrated DB would
   * otherwise fail silently.
   */
  async #resolveActiveOrganizationId(userId: string): Promise<string | undefined> {
    const cached = this.#orgCache.get(userId);
    if (cached) return cached;
    try {
      const ctx = await this.getAuthContext();
      if (!ctx) return undefined;
      return await this.#findMembershipOrgId(ctx, userId);
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the user still belongs to the organization a session names as
   * active. A member removed by an owner keeps that id on their session row;
   * honoring it would keep them inside the organization until the session
   * expires. Fails closed.
   */
  async #isMember(userId: string, organizationId: string): Promise<boolean> {
    const key = `${userId}|${organizationId}`;
    if (this.#membershipCache.get(key)) return true;
    try {
      const ctx = await this.getAuthContext();
      if (!ctx) return false;
      const membership = (await ctx.adapter.findOne({
        model: 'member',
        where: [
          { field: 'organizationId', value: organizationId },
          { field: 'userId', value: userId },
        ],
      })) as MemberRow | null;
      if (!membership) return false;
      this.#membershipCache.set(key, true);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure the user belongs to an organization (personal-org bootstrap on
   * better-auth's organization tables): ≥1 membership → oldest org id; 0 →
   * create a personal org with an idempotent slug derived from the user id,
   * the user its `owner`.
   *
   * Concurrent/retried first logins recover via the unique slug instead of
   * creating duplicates. The slug-matched org is only adopted when nobody else
   * is a member; otherwise a fresh org with an unguessable slug is created.
   *
   * Best-effort: any failure is swallowed and leaves the user no-org.
   */
  async ensureOrganization(userId: string): Promise<string | undefined> {
    const cached = this.#orgCache.get(userId);
    if (cached) return cached;

    try {
      await this.#ensureDbReady();
      const ctx = await this.getAuthContext();
      if (!ctx) return undefined;

      const firstExisting = await this.#findMembershipOrgId(ctx, userId);
      if (firstExisting) return firstExisting;

      // Build a predictable personal-org name from the user's profile.
      const userRecord = await ctx.internalAdapter.findUserById(userId).catch(() => null);
      const label = userRecord?.email ?? userRecord?.name ?? userId;
      const orgName = `${label}'s org`;
      const orgData = () => ({
        name: orgName,
        createdAt: new Date(),
        metadata: JSON.stringify({ mastraPersonalOrg: 'true' }),
      });

      const slug = `personal-${userId}`;
      let organizationId: string;
      try {
        const created = (await ctx.adapter.create({
          model: 'organization',
          data: { ...orgData(), slug },
        })) as OrganizationRow;
        organizationId = created.id;
      } catch (error) {
        const existing = (await ctx.adapter.findOne({
          model: 'organization',
          where: [{ field: 'slug', value: slug }],
        })) as OrganizationRow | null;
        if (!existing) throw error;
        const existingMembers = (await ctx.adapter.findMany({
          model: 'member',
          where: [{ field: 'organizationId', value: existing.id }],
        })) as MemberRow[];
        const foreignMember = existingMembers.some(m => m.userId !== userId);
        if (foreignMember) {
          const fallback = (await ctx.adapter.create({
            model: 'organization',
            data: { ...orgData(), slug: `personal-${userId}-${crypto.randomUUID()}` },
          })) as OrganizationRow;
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
          data: { organizationId, userId, role: 'owner', createdAt: new Date() },
        });
      } catch (error) {
        const member = await ctx.adapter.findOne({
          model: 'member',
          where: [
            { field: 'organizationId', value: organizationId },
            { field: 'userId', value: userId },
          ],
        });
        if (!member) throw error;
      }

      this.#orgCache.set(userId, organizationId);
      return organizationId;
    } catch (error) {
      console.warn(
        `[BetterAuth] Failed to bootstrap personal organization for user ${userId}. ` +
          'The user will see organization_required until this succeeds.',
        error,
      );
      return undefined;
    }
  }

  /**
   * Whether the user holds an admin-equivalent role (`owner` or `admin`) in
   * the organization. Provider errors resolve to `false`.
   */
  async isOrganizationAdmin(organizationId: string, userId: string): Promise<boolean> {
    try {
      await this.#ensureDbReady();
      const ctx = await this.getAuthContext();
      if (!ctx) return false;
      const membership = (await ctx.adapter.findOne({
        model: 'member',
        where: [
          { field: 'organizationId', value: organizationId },
          { field: 'userId', value: userId },
        ],
      })) as MemberRow | null;
      return membership?.role === 'owner' || membership?.role === 'admin';
    } catch {
      return false;
    }
  }

  // ============================================
  // IUserProvider implementation
  // ============================================

  /**
   * Get current user from request. Supports both cookie-based sessions and
   * `Authorization: Bearer <token>` requests.
   */
  async getCurrentUser(request: Request): Promise<BetterAuthProfile | null> {
    try {
      await this.#ensureDbReady();
      const headers = new Headers(request.headers);

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

  /** Get user by ID through Better Auth's internal adapter. */
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

  /** Get multiple users by ID (null for missing users, order preserved). */
  async getUsers(userIds: string[]): Promise<Array<BetterAuthProfile | null>> {
    return Promise.all(userIds.map(userId => this.getUser(userId)));
  }

  /** Get URL to user's profile page. */
  getUserProfileUrl(user: BetterAuthProfile): string {
    return `/profile/${user.id}`;
  }

  /**
   * Get the resolved Better Auth context, or null when unavailable
   * (e.g. a partial mock without `$context`).
   */
  private async getAuthContext(): Promise<BetterAuthContext | null> {
    try {
      return (await Promise.resolve(this.auth.$context)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Ensure the Cookie header on `headers` carries a Better Auth session cookie
   * for the given token. Unsigned tokens are signed with the instance secret
   * (mirroring Better Auth's bearer plugin) before being set as the cookie.
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
   * Authenticate a request by verifying the session with Better Auth (cookie,
   * or a bearer token converted to a signed session cookie).
   */
  async authenticateToken(token: string, request: MastraAuthRequest): Promise<BetterAuthUser | null> {
    try {
      await this.#ensureDbReady();

      // Better Auth's api.getSession() reads session tokens from the Cookie header
      const headers = new Headers();

      const cookieHeader = getRequestHeader(request, 'Cookie');
      if (cookieHeader) {
        headers.set('Cookie', cookieHeader);
      }

      // better-auth ignores the Authorization header — it only reads from Cookie.
      await this.ensureSessionCookie(headers, token);

      const result = await this.auth.api.getSession({
        headers,
      });

      if (!result || !result.session || !result.user) {
        return null;
      }

      // Resolve a default organization from the user's memberships when the
      // session has none, or names one the user has since been removed from
      // (read-only; the session row is not mutated). See mastra-ai/mastra#21481.
      let session: BetterAuthUser['session'] = result.session;
      const active = session.activeOrganizationId;
      if (active && !(await this.#isMember(result.user.id, active))) {
        session = { ...session, activeOrganizationId: null };
      }
      if (!session.activeOrganizationId) {
        const organizationId = await this.#resolveActiveOrganizationId(result.user.id);
        if (organizationId) session = { ...session, activeOrganizationId: organizationId };
      }

      return {
        session,
        user: result.user,
      };
    } catch {
      return null;
    }
  }

  /**
   * Authorize a user for access. By default, any authenticated user with a
   * valid session is authorized; override with `authorizeUser` in the options.
   */
  async authorizeUser(user: BetterAuthUser): Promise<boolean> {
    return !!user?.session?.id && !!user?.user?.id;
  }

  /** The underlying Better Auth instance. */
  getAuth(): Auth {
    return this.auth;
  }

  /**
   * Headers that clear the session cookies on logout (partial
   * ISessionProvider implementation for logout support).
   */
  getClearSessionHeaders(): Record<string, string> {
    // Cross-site deploys set the session cookie with SameSite=None; Secure —
    // the clearing cookie must match those attributes to overwrite it.
    const sameSite = this.#crossSite ? 'None; Secure' : 'Lax';
    const cookies = [
      `${this.sessionCookieName}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0`,
      `${this.sessionCookieName}_sig=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0`,
    ];
    return {
      'Set-Cookie': cookies.join(', '),
    };
  }
}
