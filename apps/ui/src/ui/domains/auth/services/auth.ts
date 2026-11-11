import { translator } from '../../../i18n/t';

const tk = translator('auth');
/**
 * Client-side glue for the optional web auth gate (see src/web/auth.ts).
 *
 * The server protects the whole surface; this module makes the SPA cooperate:
 * - `fetchAuthState()` reads `/auth/me` to decide whether to show the splash
 *   (unauthenticated) or the app, and to render identity / sign-out. Degrades
 *   gracefully to "auth disabled" when the route is absent.
 * - `loginUrl()` / `redirectToLogin()` build/navigate to the provider's hosted
 *   login URL (used by the /signin page).
 * - `redirectToLogout()` / `logoutUrl()` send the user through the server logout route.
 *
 * Every helper takes the API base URL injected by `ApiConfigProvider` (empty
 * string when the app is served same-origin) so the frontend dev server on a
 * different port still reaches the Mastra server — same pattern as the shared
 * API client and `use-fs`.
 */

export interface FactoryAuthState {
  /** Whether the server has web auth configured (any provider). */
  authEnabled: boolean;
  authenticated: boolean;
  /** Explicit server capability; absent on older servers. */
  telemetryEnabled?: boolean;
  user?: { userId?: string; email?: string; name?: string; avatarUrl?: string; organizationId?: string };
  /** Active identity provider: 'better-auth' (Google) | 'factory-local-dev' | custom adapter kind. */
  provider?: string;
}

/** The resourceId under which a user's personal (non-factory) sessions live. */
export function userSessionResourceId(state: FactoryAuthState | undefined): string {
  const userId = state?.user?.userId;
  if (!userId) throw new Error('Authenticated user is missing a user id');
  return userId;
}

/**
 * Build the hosted-login URL. `returnTo` is where the server sends the user
 * after authenticating; it defaults to the current location so contexts that
 * are not `/signin` (which would loop back to itself) round-trip in place.
 */
export function loginUrl(
  baseUrl: string,
  returnTo: string = window.location.pathname + window.location.search,
): string {
  return `${baseUrl}/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Full-page navigation to the hosted login (see `loginUrl` for `returnTo`). */
export function redirectToLogin(baseUrl: string, returnTo?: string): void {
  window.location.assign(loginUrl(baseUrl, returnTo));
}

export function logoutUrl(baseUrl: string): string {
  return `${baseUrl}/auth/logout`;
}

export function clearMastraCodeStorage(): void {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith('mastracode')) localStorage.removeItem(key);
  }
}

export function redirectToLogout(baseUrl: string): void {
  window.location.assign(logoutUrl(baseUrl));
}

/**
 * Full-page navigation (to Google, or into the app after sign-in). Service-level
 * (like `redirectToLogin`) because jsdom's `window.location.assign` is
 * unforgeable in tests.
 */
export function navigateAfterSignIn(url: string): void {
  window.location.assign(url);
}

/**
 * "Sign in with Google" on better-auth: asks the server for Google's sign-in URL, which the page
 * then leaves for (`navigateAfterSignIn`). Google returns to the server's callback, which sets the
 * session cookie and sends the browser to `returnTo`; a failure lands back on `/signin` with
 * `?error=<code>`.
 */
export async function signInWithGoogle(baseUrl: string, returnTo: string): Promise<string> {
  const errorCallbackURL = `/signin?returnTo=${encodeURIComponent(returnTo)}`;
  const res = await fetch(`${baseUrl}/auth/api/sign-in/social`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ provider: 'google', callbackURL: returnTo, errorCallbackURL, disableRedirect: true }),
  });
  let data: { url?: string; message?: string } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    // Non-JSON body — handled below.
  }
  if (!res.ok || !data.url) throw new Error(data.message || tk('errors.authenticationFailed'));
  return data.url;
}

/**
 * Fetch the current auth state from `/auth/me`. When the route is missing (auth
 * disabled), reports `authEnabled: false` so the UI hides all auth affordances.
 */
export async function fetchAuthState(baseUrl: string): Promise<FactoryAuthState> {
  const res = await fetch(`${baseUrl}/auth/me`, { headers: { Accept: 'application/json' }, credentials: 'include' });
  if (res.status === 404) {
    return { authEnabled: false, authenticated: false };
  }
  if (res.status === 401 || res.status === 403) {
    return { authEnabled: true, authenticated: false };
  }
  if (!res.ok) {
    throw new Error(tk('errors.authCheckFailed', { status: res.status }));
  }
  const data = (await res.json()) as {
    authenticated?: boolean;
    telemetryEnabled?: boolean;
    user?: FactoryAuthState['user'] | null;
    provider?: string;
  };
  return {
    authEnabled: true,
    authenticated: Boolean(data.authenticated),
    ...(typeof data.telemetryEnabled === 'boolean' ? { telemetryEnabled: data.telemetryEnabled } : {}),
    user: data.user ?? undefined,
    provider: data.provider,
  };
}
