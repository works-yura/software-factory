import type { MessageAuthor } from '@mastra/core/agent-controller';
import { MASTRA_MESSAGE_AUTHOR_KEY } from '@mastra/core/request-context';
import {
  registerApiRoute,
  isAuthHttpHandler,
  isCredentialsProvider,
  isOrganizationsProvider,
  isSessionProvider,
  isSSOProvider,
} from '@mastra/core/server';
import type { ApiRoute, IMastraAuthProvider, ISessionProvider } from '@mastra/core/server';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { RouteAuth } from '@factory/http';
import { actorFromAuthUser } from '@factory/store';
import { isFactoryTelemetryEnabled } from '@factory/observability';
import { timedAboveThreshold } from '@factory/observability';

const ORGANIZATION_ID_HEADER = 'X-Mastra-Organization-Id';

/**
 * Provider-neutral factory auth gating for the MastraCode web server.
 *
 * When an auth provider is active (a `MastraAuthProvider` instance passed to
 * `MastraFactory`'s `auth` slot), every route on the web server is placed
 * behind it: unauthenticated browser navigations are
 * redirected to the SPA's `/signin` page, API/XHR calls receive a 401, and a
 * small set of public routes stay reachable while signed out — the provider's
 * `/auth/*` routes plus `/auth/me`, the `/signin` page, its `/assets/*` bundle,
 * and the SPA manifest metadata. When no provider is active, `mountFactoryAuth` is a no-op and the server
 * behaves exactly as it does without auth.
 *
 * Provider specifics stay in the providers (`@mastra/auth-better-auth`, the
 * local dev provider, or any custom `IMastraAuthProvider`); this
 * module composes them capability-first via the core type guards:
 * - `authenticateToken` — session/bearer validation (all providers)
 * - `ISSOProvider` — hosted-login `/auth/login`, `/auth/callback`, `/auth/logout`
 * - `IAuthHttpHandler` — provider-owned `/auth/api/*` endpoints (better-auth)
 * - `IOrganizationsProvider` — personal-org bootstrap + admin checks
 * - `ICredentialsProvider.isSignUpEnabled` — SPA sign-up affordance
 * - `getClearSessionHeaders` — session cookie clearing on logout
 */

/** Minimal shape of the signed-in user surfaced to the SPA (no tokens). */
export interface FactoryAuthUser {
  /** Stable provider user id used to scope per-user data (GitHub installs etc.). */
  id?: string;
  email?: string;
  name?: string;
  /** Provider-supplied profile picture URL, when the auth provider exposes one. */
  avatarUrl?: string;
  /**
   * Organization id. The org is the top-level tenant: it owns the GitHub
   * App installation and connected projects, while each user inside the org gets
   * isolated building instances. Absent for personal (no-org) accounts.
   */
  organizationId?: string;
  /** Organization ids proven by the provider's authenticated membership response. */
  organizationMembershipIds?: string[];
}

/**
 * Tenant identity: the org is the top-level tenant, and each user inside it is
 * an isolated builder. Agent state, worktrees and sandboxes are scoped per
 * `(orgId, userId)`. Personal (no-org) users have `orgId === undefined`.
 */
export interface FactoryAuthTenant {
  /** Organization id, or `undefined` for personal (no-org) accounts. */
  orgId?: string;
  /** Stable provider user id. */
  userId: string;
}

/**
 * Validate that a `returnTo` value is a safe same-site path, to prevent
 * open-redirect attacks. Only absolute local paths (`/foo`) are allowed;
 * protocol-relative (`//evil.com`) and absolute URLs are rejected.
 */
export function sanitizeReturnTo(raw: string | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  // Reject protocol-relative URLs like "//evil.com" and "/\evil.com".
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

/** Extract a bearer token from the Authorization header, if present. */
export function getBearerToken(authorization: string | undefined): string {
  if (!authorization) return '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? '';
}

/**
 * Whether the SPA is served cross-origin from this API (platform deploy). When
 * `MASTRACODE_ALLOWED_ORIGINS` is set the browser talks to us cross-site, so
 * session cookies must be `SameSite=None; Secure` for the browser to send them.
 * Same-origin local dev leaves this unset and keeps the stricter `SameSite=Lax`.
 */
export function isCrossSiteAuth(): boolean {
  return Boolean(process.env.MASTRACODE_ALLOWED_ORIGINS?.trim());
}

/** Hono context variables set by the auth gate. */
export interface FactoryAuthVariables {
  factoryAuthUser: FactoryAuthUser;
}

/** Context key under which the gate stashes the authenticated user. */
const FACTORY_AUTH_USER_KEY = 'factoryAuthUser';

/**
 * Read the authenticated user the gate stashed on the context, or
 * `undefined` when unauthenticated / auth disabled. Used by downstream routes
 * (e.g. GitHub) to scope rows per user.
 */
export function getFactoryAuthUser(c: Context): FactoryAuthUser | undefined {
  return c.get(FACTORY_AUTH_USER_KEY) as FactoryAuthUser | undefined;
}

/**
 * Read the authenticated user off a request context, normalizing whatever the
 * active auth provider put there.
 *
 * The server's auth layer writes the provider's `authenticateToken` result into
 * the request context's `user` slot verbatim, so the value's shape follows the
 * provider: flat providers write a flat user, better-auth writes a `{ session, user }`
 * wrapper whose org lives on the session. Reading that slot as a
 * {@link FactoryAuthUser} therefore yields `undefined` for both the id and the
 * org under better-auth, which reads as "this session belongs to somebody else"
 * at every ownership check. Normalize on the way in instead.
 */
export function getFactoryAuthUserFromContext(
  requestContext: { get: (key: string) => unknown } | undefined,
): FactoryAuthUser | undefined {
  if (!requestContext || typeof requestContext.get !== 'function') return undefined;
  return toFactoryAuthUser(requestContext.get('user')) ?? undefined;
}

/** Resolve the stable user id from an authenticated user shape. */
export function getFactoryAuthUserId(user: FactoryAuthUser | undefined): string | undefined {
  return user?.id;
}

/** Resolve the organization id from a user shape, if present. */
export function getFactoryAuthOrgId(user: FactoryAuthUser | undefined): string | undefined {
  return user?.organizationId;
}

/**
 * The org rung a user's rows are keyed by: the organization they belong to, or a
 * per-user rung for personal (no-org) accounts so their rows never land in the
 * shared `local` scope. Every writer and reader of a `(org, user)` row must
 * agree on this, so it lives here rather than being re-derived per call site.
 */
export function factoryUserOrgId(user: FactoryAuthUser | undefined): string | undefined {
  const userId = getFactoryAuthUserId(user);
  if (!userId) return undefined;
  return getFactoryAuthOrgId(user) ?? `user:${userId}`;
}

/**
 * Resolve the tenant identity `(orgId, userId)` from the authenticated user on
 * the context. Returns `undefined` when there is no signed-in user (auth
 * disabled or unauthenticated). `orgId` is `undefined` for personal accounts;
 * callers gate org-scoped GitHub features on its presence while agent state
 * falls back to a user-only tenant.
 */
export function factoryAuthTenant(c: Context): FactoryAuthTenant | undefined {
  const user = getFactoryAuthUser(c);
  const userId = getFactoryAuthUserId(user);
  if (!userId) return undefined;
  return { orgId: getFactoryAuthOrgId(user), userId };
}

function messageAuthor(user: FactoryAuthUser): MessageAuthor | undefined {
  const userId = getFactoryAuthUserId(user);
  if (!userId) return undefined;
  const actor = actorFromAuthUser(userId, user);
  return {
    id: actor.id,
    ...(actor.displayName ? { name: actor.displayName } : {}),
    ...(actor.avatarUrl ? { avatarUrl: actor.avatarUrl } : {}),
  };
}

/**
 * Map a provider `authenticateToken` result onto the neutral SPA user shape.
 *
 * Two result families exist today:
 * - flat provider users (local dev auth, custom providers): `id`/`email`/
 *   `name`/`organizationId` directly on the object;
 * - session-shaped results (better-auth `BetterAuthUser`): `{ session, user }`
 *   with the active org on the session.
 */
function toFactoryAuthUser(result: unknown): FactoryAuthUser | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;

  // Session-shaped results: { session, user }. A result carrying both halves and
  // top-level identity fields is read as session-shaped: the session half is the
  // authenticated one, and preferring it keeps the org and the id from coming
  // from two different places.
  if (record.user && typeof record.user === 'object' && record.session && typeof record.session === 'object') {
    const user = record.user as { id?: unknown; email?: unknown; name?: unknown; avatarUrl?: unknown; image?: unknown };
    const session = record.session as { activeOrganizationId?: unknown };
    if (typeof user.id !== 'string') return null;
    return {
      id: user.id,
      email: typeof user.email === 'string' ? user.email : undefined,
      name: typeof user.name === 'string' ? user.name : undefined,
      // better-auth keeps the profile picture (Google's) in `image`.
      avatarUrl:
        typeof user.avatarUrl === 'string' ? user.avatarUrl : typeof user.image === 'string' ? user.image : undefined,
      organizationId: typeof session.activeOrganizationId === 'string' ? session.activeOrganizationId : undefined,
    };
  }

  // Flat provider users.
  const flat = record as {
    id?: unknown;
    email?: unknown;
    name?: unknown;
    avatarUrl?: unknown;
    organizationId?: unknown;
    memberships?: unknown;
    memberOrgIds?: unknown;
  };
  const id = typeof flat.id === 'string' ? flat.id : undefined;
  if (!id) return null;
  const membershipOrganizationIds = Array.isArray(flat.memberships)
    ? flat.memberships.flatMap(membership => {
        if (!membership || typeof membership !== 'object') return [];
        const organizationId = (membership as { organizationId?: unknown }).organizationId;
        return typeof organizationId === 'string' ? [organizationId] : [];
      })
    : [];
  const memberOrgIds = Array.isArray(flat.memberOrgIds)
    ? flat.memberOrgIds.filter((organizationId): organizationId is string => typeof organizationId === 'string')
    : [];
  const organizationMembershipIds = [...new Set([...membershipOrganizationIds, ...memberOrgIds])];
  return {
    id,
    email: typeof flat.email === 'string' ? flat.email : undefined,
    name: typeof flat.name === 'string' ? flat.name : undefined,
    avatarUrl: typeof flat.avatarUrl === 'string' ? flat.avatarUrl : undefined,
    organizationId: typeof flat.organizationId === 'string' ? flat.organizationId : undefined,
    organizationMembershipIds,
  };
}

/**
 * The auth provider could not answer (its database or identity service failed),
 * which is not the same as "signed out": requests are refused with 503
 * {@link AUTH_UNAVAILABLE_BODY}, never sent to sign in. Providers signal it by
 * throwing from `authenticateToken`, `ensureOrganization` or
 * `isOrganizationAdmin`; a missing or invalid session is `null`, not a throw.
 */
export class AuthUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthUnavailableError';
  }
}

/** What every 503 for an unavailable auth provider answers (gate, `/auth/me`, routes). */
export const AUTH_UNAVAILABLE_BODY = {
  error: 'auth_unavailable',
  message: 'Factory could not check your access right now. Try again in a moment.',
} as const;

const AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS = '5';

function authUnavailableResponse(): Response {
  return Response.json(AUTH_UNAVAILABLE_BODY, {
    status: 503,
    headers: { 'Retry-After': AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS },
  });
}

/**
 * A browser opening a page gets a small page instead of JSON; it reloads itself, and the SPA's
 * own unavailable screen takes over once the page loads.
 */
function authUnavailablePage(): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="${AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS}"><title>Factory</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem"><h1>Factory тимчасово недоступна</h1><p>Не вдалося перевірити ваш доступ. Сторінка оновиться сама.</p><p lang="en">Factory could not check your access right now. This page reloads by itself.</p></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS },
  });
}

function authUnavailableException(error: AuthUnavailableError): HTTPException {
  return new HTTPException(503, { res: authUnavailableResponse(), cause: error });
}

function describeRequest(raw: Request): string {
  return `${raw.method} ${new URL(raw.url).pathname}`;
}

/**
 * Resolve the authenticated user for a request via the provider: `null` for a
 * missing or invalid session. A provider that throws could not check the
 * session at all — logged with the request and thrown as
 * {@link AuthUnavailableError} (503), never read as signed out.
 */
async function authenticateRequest(
  provider: IMastraAuthProvider,
  token: string,
  raw: Request,
): Promise<FactoryAuthUser | null> {
  let result: unknown;
  try {
    result = await provider.authenticateToken(token, raw);
  } catch (error) {
    console.error(
      `[auth] Provider ${provider.name ?? 'unknown'} could not check the session of ${describeRequest(raw)}; answering 503 auth_unavailable.`,
      error,
    );
    throw new AuthUnavailableError(`Provider ${provider.name ?? 'unknown'} could not check the session`, { cause: error });
  }
  return toFactoryAuthUser(result);
}

/**
 * Bootstrap a personal org for no-org accounts so org-scoped features (GitHub
 * connect) work without leaving the app. Mutates the resolved user so the
 * current request sees the org immediately; subsequent requests resolve it via
 * the provider's own session/membership lookup (providers cache internally).
 *
 * A provider that answers `undefined` leaves the user genuinely no-org. A
 * provider that throws fails the request with 503 (logged): running it
 * without the org would key its rows to the personal `user:<id>` scope instead.
 */
async function ensureUserOrg(provider: IMastraAuthProvider, user: FactoryAuthUser, raw: Request): Promise<void> {
  if (getFactoryAuthOrgId(user)) return;
  if (!isOrganizationsProvider(provider)) return;
  const userId = getFactoryAuthUserId(user);
  if (!userId) return;
  let orgId: string | undefined;
  try {
    orgId = await provider.ensureOrganization(userId);
  } catch (error) {
    console.error(
      `[auth] Provider ${provider.name ?? 'unknown'} could not resolve the organization of user ${userId} for ${describeRequest(raw)}; answering 503 auth_unavailable.`,
      error,
    );
    throw new AuthUnavailableError(`Could not resolve the organization of user ${userId}`, { cause: error });
  }
  if (orgId) user.organizationId = orgId;
}

/**
 * The `org_id` claim of a JWT bearer token. Read only after the provider has
 * verified the token, and only adopted when the user is a verified member of
 * that org — so it picks among orgs the user already has, never grants one.
 */
export function bearerTokenOrgClaim(token: string | undefined): string | undefined {
  const payload = token?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { org_id?: unknown };
    return typeof claims.org_id === 'string' && claims.org_id ? claims.org_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Picks the request's org: an explicit `X-Mastra-Organization-Id` header, else
 * a bearer token's `org_id` claim (MCP clients such as ChatGPT can't send the
 * header, and the verify endpoint otherwise reports the user's default org).
 * Either must name an org the user belongs to, else `false` — never fall back
 * to another org than the one asked for. With neither, bootstraps the user's org.
 */
async function applyRequestedOrganization(
  provider: IMastraAuthProvider,
  c: Context,
  token: string | undefined,
  user: FactoryAuthUser,
): Promise<boolean> {
  const requested = (token ? c.req.header(ORGANIZATION_ID_HEADER)?.trim() : undefined) || bearerTokenOrgClaim(token);
  if (requested) return selectRequestedOrganization(user, requested);
  await ensureUserOrg(provider, user, c.req.raw);
  return true;
}

function selectRequestedOrganization(user: FactoryAuthUser, requestedOrganizationId: string): boolean {
  if (user.organizationId === requestedOrganizationId) return true;
  if (!user.organizationMembershipIds?.includes(requestedOrganizationId)) return false;
  user.organizationId = requestedOrganizationId;
  return true;
}

/**
 * `Set-Cookie` values that clear the provider's session cookie(s), from the
 * provider's (possibly partial) `ISessionProvider.getClearSessionHeaders`.
 */
function providerClearCookies(provider: IMastraAuthProvider): string[] {
  const getClearSessionHeaders = (provider as Partial<ISessionProvider>).getClearSessionHeaders;
  if (typeof getClearSessionHeaders !== 'function') return [];
  const headers = getClearSessionHeaders.call(provider) ?? {};
  const setCookie = headers['Set-Cookie'];
  if (!setCookie) return [];
  // A provider may join several clearing cookies into one header value.
  return setCookie.split(/,(?=\s*[^;=,\s]+=)/).map(cookie => cookie.trim());
}

/**
 * Fail-closed authorization for organization-level administrative mutations.
 * The caller must belong to the same active organization and the provider must
 * explicitly confirm an admin/owner role.
 */
export async function isOrganizationAdmin(
  provider: IMastraAuthProvider | undefined,
  c: Context,
  organizationId: string,
): Promise<boolean> {
  const user = await ensureFactoryAuthUser(provider, c);
  if (!user || user.organizationId !== organizationId || !provider || !isOrganizationsProvider(provider)) {
    return false;
  }
  const userId = getFactoryAuthUserId(user);
  if (!userId) return false;
  try {
    return await provider.isOrganizationAdmin(organizationId, userId);
  } catch (error) {
    console.error(
      `[auth] Provider ${provider.name ?? 'unknown'} could not check whether user ${userId} administers organization ${organizationId} (${describeRequest(c.req.raw)}); answering 503 auth_unavailable.`,
      error,
    );
    throw authUnavailableException(new AuthUnavailableError('Could not check the organization role', { cause: error }));
  }
}

/**
 * Build the factory's implementation of the `RouteAuth` seam over the
 * resolved provider (`undefined` = auth disabled). Constructed once per boot
 * by `MastraFactory.prepare()` and handed to factory route modules at
 * construction — they never import the factory auth module directly.
 */
export function createFactoryRouteAuth(provider: IMastraAuthProvider | undefined): RouteAuth {
  return {
    enabled: () => provider !== undefined,
    ensureUser: (c: Context) => ensureFactoryAuthUser(provider, c),
    tenant: (c: Context) => factoryAuthTenant(c),
    isOrganizationAdmin: (c: Context, organizationId: string) => isOrganizationAdmin(provider, c, organizationId),
  };
}

/**
 * Resolve the authenticated user for a request, stashing it on the context.
 *
 * The gate only authenticates non-`/auth/*` requests via the `Authorization`
 * header, so cookie-based browser navigations to public `/auth/*` routes (the
 * GitHub connect/callback flow) arrive without a gate-stashed user. This reads
 * the session cookie from the raw request the same way `/auth/me` does,
 * caches the result on the context, and returns it so downstream helpers like
 * {@link factoryAuthTenant} work uniformly on both gated and public routes.
 *
 * Returns `undefined` when there is no valid session (or auth is disabled).
 */
function forwardPendingResponseHeaders(provider: IMastraAuthProvider, c: Context): void {
  // Forward a renewed session cookie (e.g. rotated by the shared API during
  // verification) so the browser's cookie stays current. Best-effort.
  try {
    const pending = provider.consumePendingResponseHeaders?.(c.req.raw);
    for (const [name, value] of Object.entries(pending ?? {})) {
      c.header(name, value, { append: true });
    }
  } catch {
    // never fail a request over header forwarding
  }
}

export async function ensureFactoryAuthUser(
  provider: IMastraAuthProvider | undefined,
  c: Context,
): Promise<FactoryAuthUser | undefined> {
  const existing = getFactoryAuthUser(c);
  if (existing) return existing;
  if (!provider) return undefined;

  const token = getBearerToken(c.req.header('Authorization'));
  let user: FactoryAuthUser | null;
  let allowed: boolean;
  try {
    user = await authenticateRequest(provider, token, c.req.raw);
    // Routes declared `requiresAuth: false` skip the gate, so this is their only
    // authentication — forward a renewed session cookie from here too.
    forwardPendingResponseHeaders(provider, c);
    if (!user) return undefined;
    allowed = await applyRequestedOrganization(provider, c, token, user);
  } catch (error) {
    if (error instanceof AuthUnavailableError) throw authUnavailableException(error);
    throw error;
  }
  if (!allowed) {
    throw new HTTPException(403, { message: 'organization_forbidden' });
  }

  c.set(FACTORY_AUTH_USER_KEY, user);
  return user;
}

export interface MountFactoryAuthOptions {
  /** Auth provider to mount. When omitted, auth stays off (no-op). */
  provider?: IMastraAuthProvider;
  /** Browser-facing origin used to derive the SSO callback URL. */
  publicUrl?: string;
}

/**
 * Decide whether a request is a top-level browser navigation (which should be
 * redirected to `/signin`) versus an API/XHR call (which should get a 401 JSON
 * response the SPA can react to).
 */
function isNavigationRequest(path: string, accept: string | undefined): boolean {
  if (path.startsWith('/api/')) return false;
  return (accept ?? '').includes('text/html');
}

/**
 * Handle the provider-neutral `/auth/me` route: validate the session with the
 * active provider and report the signed-in user (no tokens) to the SPA.
 * `/auth/me` is public (the gate skips `/auth/*`), so it validates the session
 * itself rather than reading a value the gate would have stashed.
 */
async function handleAuthMe(provider: IMastraAuthProvider, c: Context): Promise<Response> {
  try {
    return await authMeResponse(provider, c);
  } catch (error) {
    if (error instanceof AuthUnavailableError) return authUnavailableResponse();
    throw error;
  }
}

async function authMeResponse(provider: IMastraAuthProvider, c: Context): Promise<Response> {
  const token = getBearerToken(c.req.header('Authorization'));
  const user = await authenticateRequest(provider, token, c.req.raw);
  // Provider identity for the SPA: `/signin` renders the hosted-login button
  // for SSO providers and an email/password form for better-auth (with sign-up
  // hidden when the provider disables it).
  const signUpDisabled = isCredentialsProvider(provider) && provider.isSignUpEnabled?.() === false;
  const meta = {
    provider: provider.name,
    ...(signUpDisabled ? { signUpDisabled: true } : {}),
  };
  if (!user) {
    return c.json({ authenticated: false, user: null, ...meta });
  }
  // Resolve the org the same way gated requests do (providers cache, so this
  // is a lookup — not a create — after first bootstrap).
  await ensureUserOrg(provider, user, c.req.raw);
  return c.json({
    authenticated: true,
    telemetryEnabled: isFactoryTelemetryEnabled(provider.name),
    user: {
      userId: getFactoryAuthUserId(user),
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      organizationId: user.organizationId,
    },
    ...meta,
  });
}

/**
 * Encode a validated returnTo path into the OAuth `state` parameter as
 * `uuid|encodedPath` ({@link decodeState} reads it back).
 */
function encodeState(returnTo: string): string {
  return `${crypto.randomUUID()}|${encodeURIComponent(returnTo)}`;
}

/** Decode the OAuth `state` parameter back into a sanitized returnTo path. */
function decodeState(state: string | undefined): string {
  if (!state) return '/';
  const pipeIndex = state.indexOf('|');
  if (pipeIndex !== -1) {
    try {
      return sanitizeReturnTo(decodeURIComponent(state.slice(pipeIndex + 1)));
    } catch {
      return '/';
    }
  }
  return '/';
}

/**
 * Short-lived cookie stashing the post-login destination across the hosted
 * OAuth round-trip. Providers/platforms differ in whether they echo `state`
 * back to the callback, so the cookie is the reliable channel; `state` (when
 * echoed) takes precedence only if the cookie is missing.
 */
const RETURN_TO_COOKIE = 'mastra_factory_return_to';

function returnToCookieHeader(returnTo: string): string {
  const crossSite = isCrossSiteAuth() ? '; SameSite=None; Secure' : '; SameSite=Lax';
  return `${RETURN_TO_COOKIE}=${encodeURIComponent(returnTo)}; Path=/; Max-Age=600; HttpOnly${crossSite}`;
}

function clearReturnToCookieHeader(): string {
  const crossSite = isCrossSiteAuth() ? '; SameSite=None; Secure' : '; SameSite=Lax';
  return `${RETURN_TO_COOKIE}=; Path=/; Max-Age=0; HttpOnly${crossSite}`;
}

function readReturnToCookie(c: Context): string | undefined {
  const header = c.req.header('Cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === RETURN_TO_COOKIE) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** HTTP methods supported for public auth routes. */
type AuthRouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'ALL';

/** A public `/auth/*` route derived from the provider's capabilities. */
interface AuthRouteSpec {
  path: string;
  method: AuthRouteMethod;
  handler: (c: Context) => Response | Promise<Response>;
}

/**
 * Derive the public `/auth/*` routes from the provider's capabilities:
 *
 * - `IAuthHttpHandler` → `ALL /auth/api/*` proxy to the provider's own HTTP
 *   surface (better-auth sign-in/up/out/session — what the SPA's
 *   email/password form posts to).
 * - `ISSOProvider` → hosted-login `GET /auth/login` / `GET /auth/callback` /
 *   `GET /auth/logout` (returnTo preserved through the OAuth `state` param).
 * - handler-shaped, non-SSO providers → `GET /auth/login` redirects to the
 *   SPA's `/signin` form, `GET /auth/logout` revokes via the provider's
 *   sign-out endpoint and clears the session cookie.
 */
function providerAuthRoutes(provider: IMastraAuthProvider, publicUrl?: string): AuthRouteSpec[] {
  const routes: AuthRouteSpec[] = [];

  if (isAuthHttpHandler(provider)) {
    routes.push({
      path: '/auth/api/*',
      method: 'ALL',
      handler: c => provider.handleAuthRequest(c.req.raw),
    });
  }

  if (isSSOProvider(provider)) {
    routes.push(
      {
        path: '/auth/login',
        method: 'GET',
        handler: async c => {
          const returnTo = sanitizeReturnTo(c.req.query('returnTo'));
          const state = encodeState(returnTo);
          // Build the callback URL from the browser-facing public origin so
          // the OAuth round-trip lands back on the SPA's origin (in dev the
          // SPA is on :5173 and Vite proxies /auth/* to the API on :4111 —
          // deriving from c.req.url would use :4111 and the post-callback
          // redirect to `/` would miss the SPA). Providers that ignore the
          // caller's URI in favor of their own config still take precedence.
          const redirectUri = publicUrl ? new URL('/auth/callback', publicUrl).toString() : '';
          const loginUrl = await provider.getLoginUrl(redirectUri, state);
          for (const cookie of (await provider.getLoginCookies?.(redirectUri, state)) ?? []) {
            c.header('Set-Cookie', cookie, { append: true });
          }
          // Stash the destination in a cookie too: not every provider/platform
          // echoes `state` back to the callback.
          if (returnTo !== '/') {
            c.header('Set-Cookie', returnToCookieHeader(returnTo), { append: true });
          }
          return c.redirect(loginUrl);
        },
      },
      {
        path: '/auth/callback',
        method: 'GET',
        handler: async c => {
          const code = c.req.query('code');
          const stateReturnTo = decodeState(c.req.query('state'));
          const cookieReturnTo = sanitizeReturnTo(readReturnToCookie(c));
          const returnTo = cookieReturnTo !== '/' ? cookieReturnTo : stateReturnTo;
          c.header('Set-Cookie', clearReturnToCookieHeader(), { append: true });
          const idpError = c.req.query('error');
          if (idpError) {
            // IdP denial (e.g. access_denied for a non-org-member): bouncing to
            // /auth/login would re-enter the IdP in a redirect loop.
            const query = new URLSearchParams({ error: idpError.slice(0, 64) });
            const description = c.req.query('error_description');
            if (description) query.set('error_description', description.slice(0, 256));
            if (returnTo !== '/') query.set('returnTo', returnTo);
            return c.redirect(`/signin?${query.toString()}`);
          }
          if (!code) {
            return c.redirect('/auth/login');
          }
          try {
            const result = await provider.handleCallback(code, c.req.query('state') ?? '');
            if (result.cookies?.length) {
              // Provider populated cookies directly (it built its own session
              // cookie inside handleCallback).
              for (const cookie of result.cookies) {
                c.header('Set-Cookie', cookie, { append: true });
              }
            } else if (isSessionProvider(provider) && result.tokens) {
              // Fallback for providers that expose ISessionProvider but leave
              // cookie construction to the server: mint the session and let
              // the provider's getSessionHeaders shape the cookie.
              // Mirrors packages/server/src/server/handlers/auth.ts:492-503.
              const resultUser = result.user as { id: string; organizationId?: string };
              const session = await provider.createSession(resultUser.id, {
                accessToken: result.tokens.accessToken,
                refreshToken: result.tokens.refreshToken,
                expiresAt: result.tokens.expiresAt,
                organizationId: resultUser.organizationId,
              });
              for (const [key, value] of Object.entries(provider.getSessionHeaders(session))) {
                c.header(key, value, { append: true });
              }
            }
            return c.redirect(returnTo);
          } catch {
            // Code exchange failed (expired/replayed code, misconfig). Send the
            // user back to login rather than surfacing a raw error.
            return c.redirect('/auth/login');
          }
        },
      },
      {
        path: '/auth/logout',
        method: 'GET',
        handler: async c => {
          let logoutUrl: string | null = null;
          try {
            logoutUrl = (await provider.getLogoutUrl?.('/', c.req.raw)) ?? null;
          } catch {
            logoutUrl = null;
          }
          // Clear the session cookie regardless of whether the provider
          // returned a logout URL.
          for (const cookie of providerClearCookies(provider)) {
            c.header('Set-Cookie', cookie, { append: true });
          }
          return c.redirect(logoutUrl ?? '/');
        },
      },
    );
  } else if (isAuthHttpHandler(provider)) {
    routes.push(
      {
        // Hosted-login equivalent: no hosted page, so send the browser to the
        // SPA's /signin form, preserving returnTo.
        path: '/auth/login',
        method: 'GET',
        handler: c => {
          const returnTo = sanitizeReturnTo(c.req.query('returnTo'));
          return c.redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
        },
      },
      {
        path: '/auth/logout',
        method: 'GET',
        handler: async c => {
          // Revoke the session server-side through the provider's own sign-out
          // endpoint and forward its clearing cookies; fall back to our clear
          // cookies regardless.
          try {
            const origin = new URL(c.req.url).origin;
            const response = await provider.handleAuthRequest(
              new Request(`${origin}/auth/api/sign-out`, { method: 'POST', headers: c.req.raw.headers }),
            );
            for (const cookie of response.headers.getSetCookie()) {
              c.header('Set-Cookie', cookie, { append: true });
            }
          } catch {
            // No/invalid session: nothing to revoke.
          }
          for (const cookie of providerClearCookies(provider)) {
            c.header('Set-Cookie', cookie, { append: true });
          }
          return c.redirect('/');
        },
      },
    );
  }

  return routes;
}

/**
 * Register the public `/auth/*` routes on a Hono app: the capability-derived
 * provider routes (login/callback/logout/provider APIs) plus the
 * provider-neutral `/auth/me`. Split out from `mountFactoryAuth` so both the local
 * Hono server and the platform Mastra entry can reuse the exact same handlers.
 */
export function registerAuthRoutes(
  app: Hono<any>,
  provider: IMastraAuthProvider,
  options: { publicUrl?: string } = {},
): void {
  for (const route of providerAuthRoutes(provider, options.publicUrl)) {
    const methods = route.method === 'ALL' ? ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] : [route.method];
    app.on(methods, route.path, c => route.handler(c));
  }
  app.get('/auth/me', c => handleAuthMe(provider, c));
}

/**
 * Build the public `/auth/*` routes (provider routes + `/auth/me`) as Mastra
 * `server.apiRoutes`. Used by the platform Mastra entry (`src/mastra/index.ts`),
 * which can't register plain Hono routes on the deployer-generated app the way
 * the local server does via {@link registerAuthRoutes}.
 *
 * Handlers are identical to {@link registerAuthRoutes}. All are `requiresAuth: false`
 * (they must be reachable while unauthenticated), and the gate middleware skips
 * `/auth/*` so it never blocks them. `/auth/*` is not under `/api`, so it is a
 * valid custom-route path.
 */
export function buildAuthRoutes(provider: IMastraAuthProvider, options: { publicUrl?: string } = {}): ApiRoute[] {
  return [
    // `registerApiRoute` handlers see @mastra/core's bundled hono Context type,
    // which is structurally identical to (but nominally distinct from) the
    // local hono version the route handlers are typed against — cast across
    // the seam.
    ...providerAuthRoutes(provider, options.publicUrl).map(route =>
      registerApiRoute(route.path, {
        method: route.method,
        requiresAuth: false,
        handler: c => route.handler(c as unknown as Context),
      }),
    ),
    registerApiRoute('/auth/me', {
      method: 'GET',
      requiresAuth: false,
      handler: c => handleAuthMe(provider, c as unknown as Context),
    }),
  ];
}

/**
 * `/auth/*` routes for auth-disabled mode (`auth: null`). Only `/auth/me`, answering
 * 404 — the UI's "auth disabled" signal. Without it the deployer's HTML catch-all
 * answers `/auth/me` with 200 text/html and the UI retries forever.
 */
export function buildAuthDisabledRoutes(): ApiRoute[] {
  return [
    registerApiRoute('/auth/me', {
      method: 'GET',
      requiresAuth: false,
      handler: c => c.json({ authEnabled: false, authenticated: false }, 404),
    }),
  ];
}

/**
 * Channel webhook paths whose adapter verifies the platform's request signature,
 * making the delivery self-authenticating. Add a platform here only once its
 * adapter rejects unsigned or mis-signed requests.
 */
const SIGNATURE_VERIFYING_CHANNEL_WEBHOOK = /^\/api\/agent-controllers\/[^/]+\/channels\/slack\/webhook$/;

/**
 * The header an agent session's MCP token travels in (`@factory/mcp` session tokens; it lives here
 * because the gate needs it and `@factory/mcp` depends on this package). Separate from
 * `Authorization` so auth providers never see it.
 */
export const FACTORY_SESSION_TOKEN_HEADER = 'x-factory-session-token';

/**
 * A Factory's MCP endpoint (`FACTORY_MCP_PATH` in `@factory/mcp`). Agent sessions the Factory runs
 * itself (the `claude` and `codex` CLIs) call it with a session token and no sign-in session; the
 * route verifies the token and never falls through to the signed-in-person path.
 */
const FACTORY_MCP_ENDPOINT = /^\/web\/factory\/projects\/[^/]+\/mcp$/;

// Fetched by tabs that may already be signed out. Enumerated, not prefix-matched,
// so a future route under the same prefix does not inherit the pass.
const SESSION_FAVICON_PATHS = new Set([
  '/favicon-session-initializing.svg',
  '/favicon-session-working.svg',
  '/favicon-session-awaiting.svg',
  '/favicon-session-error.svg',
]);

/**
 * Request-context key marking an authenticated interactive turn. HTTP requests
 * and linked Slack senders verified against their session owner can carry it;
 * wakes, webhooks, and dispatcher turns cannot.
 */
export const FACTORY_INTERACTIVE_KEY = 'factoryInteractive';

/** With auth disabled there is no gate; this marks every HTTP request as interactive instead. */
export function createFactoryInteractiveMarker() {
  return async (c: Context, next: () => Promise<void>): Promise<void> => {
    c.get('requestContext')?.set(FACTORY_INTERACTIVE_KEY, true);
    await next();
  };
}

/**
 * Build the auth gate as a plain Hono middleware handler `(c, next)`. Protects
 * everything that is not a public `/auth/*` route: authenticated requests stash
 * the user on the context and continue; unauthenticated navigations redirect to
 * login and XHR/API calls get a 401 JSON. Shared by the local Hono server
 * (`mountFactoryAuth`) and the platform Mastra entry (`server.middleware`).
 */
export function createFactoryAuthGate(provider: IMastraAuthProvider) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const path = c.req.path;
    if (path.startsWith('/auth/')) {
      return next();
    }
    if (c.req.method === 'POST' && (path === '/web/github/webhook' || path === '/web/gitlab/webhook')) {
      return next();
    }
    // Inbound chat-channel webhooks (Slack events) carry no user session: they
    // authenticate by platform signature, the adapter verifying the request
    // against its signing secret. The routes declare `requiresAuth: false`, but
    // this gate is `use()` middleware — it runs before route matching, so that
    // metadata is not readable here and the path needs an explicit pass.
    //
    // The platform is allowlisted rather than matched as a wildcard: a pass
    // keyed on path shape alone would silently extend to any future adapter,
    // including one that does not verify signatures. Controller id stays a
    // wildcard because it is whatever the host registered.
    if (c.req.method === 'POST' && SIGNATURE_VERIFYING_CHANNEL_WEBHOOK.test(path)) {
      return next();
    }
    // An agent session's MCP call authenticates by its session token, which the MCP route checks
    // itself (a bad token is a 401 there). Only that endpoint, and only with the header: people
    // calling it still pass the gate.
    if (FACTORY_MCP_ENDPOINT.test(path) && c.req.header(FACTORY_SESSION_TOKEN_HEADER) !== undefined) {
      return next();
    }
    // The Slack account-linking deep link and the Sign-in-with-Slack OIDC
    // start/callback do their own auth (friendly login-redirect for signed-out
    // visitors; the OIDC callback authenticates via its signed `state`) — see
    // connect-route.ts.
    if (c.req.method === 'GET' && (path === '/connect/slack' || path.startsWith('/connect/slack/'))) {
      return next();
    }
    // The platform's deploy-auth flow lands IdP denials on `/login`
    // (`error=access_denied&error_description=...`); the SPA serves sign-in at
    // `/signin`, so forward the query there instead of burying it in returnTo.
    if (c.req.method === 'GET' && path === '/login') {
      return c.redirect(`/signin${new URL(c.req.url).search}`);
    }
    // The SPA sign-in page, its static bundle, and browser-fetched metadata
    // must be reachable while signed out; no user is stashed, so `/api/*`
    // stays protected.
    if (
      path === '/signin' ||
      path.startsWith('/assets/') ||
      path === '/manifest.webmanifest' ||
      path === '/mastra.svg' ||
      path === '/pwa-192.png' ||
      path === '/pwa-512.png' ||
      path === '/apple-touch-icon.png' ||
      (c.req.method === 'GET' && SESSION_FAVICON_PATHS.has(path))
    ) {
      return next();
    }

    const token = getBearerToken(c.req.header('Authorization'));
    let user: FactoryAuthUser | null;
    let allowed = false;
    try {
      // A slow verification here delays EVERY protected request — surface
      // outliers so auth-backend latency is attributable from server logs.
      user = await timedAboveThreshold('auth.gate.authenticate', 1_000, () =>
        authenticateRequest(provider, token, c.req.raw),
      );
      forwardPendingResponseHeaders(provider, c);
      // Without a requested org, no-org accounts get a bootstrapped personal org
      // so the org id resolves on this request (see ensureFactoryAuthUser).
      if (user) allowed = await applyRequestedOrganization(provider, c, token, user);
    } catch (error) {
      if (!(error instanceof AuthUnavailableError)) throw error;
      // The provider could not answer: not "signed out", so no sign-in redirect.
      return isNavigationRequest(path, c.req.header('Accept')) ? authUnavailablePage() : authUnavailableResponse();
    }

    if (user) {
      if (!allowed) {
        return c.json({ error: 'organization_forbidden' }, 403);
      }
      c.set(FACTORY_AUTH_USER_KEY, user);
      const requestContext = c.get('requestContext');
      requestContext?.set('user', user);
      requestContext?.set(MASTRA_MESSAGE_AUTHOR_KEY, messageAuthor(user));
      requestContext?.set(FACTORY_INTERACTIVE_KEY, true);
      return next();
    }

    if (isNavigationRequest(path, c.req.header('Accept'))) {
      const url = new URL(c.req.url);
      const returnTo = sanitizeReturnTo(url.pathname + url.search);
      return c.redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
    }

    return c.json({ error: 'unauthorized' }, 401);
  };
}

/**
 * Mount factory auth gating onto the host app. No-op when auth is disabled
 * (no provider active).
 *
 * Must be called before the Mastra adapter routes, the `/web/*` routes, and
 * the static UI handlers so the gate covers every request. Composes the shared
 * `registerAuthRoutes` + `createFactoryAuthGate` factories so the local Hono server
 * and the platform Mastra entry stay behavior-identical.
 */
export function mountFactoryAuth(app: Hono<any>, options: MountFactoryAuthOptions = {}): boolean {
  const provider = options.provider;
  if (!provider) return false;

  registerAuthRoutes(app, provider, { publicUrl: options.publicUrl });
  app.use('*', createFactoryAuthGate(provider));
  return true;
}
