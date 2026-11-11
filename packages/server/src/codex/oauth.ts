/**
 * The OAuth refresh of a ChatGPT sign-in for Codex, done by the server alone, as for a Claude
 * sign-in (`../claude/oauth.ts`): the token endpoint rotates the refresh token, so exactly one place
 * may hold and use it, the server, under the account row's lock. A run's `codex app-server` gets
 * the access token and its workspace alone (`account/login/start` with `chatgptAuthTokens`, which
 * Codex keeps in memory) and asks the server again when the backend refuses it.
 *
 * The endpoint, client id, scope and request shape are the `codex` CLI's own (its sign-in and
 * `auth.json` refresh; read from CLI 0.166.0): a JSON `refresh_token` grant answered with a new
 * `access_token` and, usually, a new `refresh_token` and `id_token`. The answer carries no lifetime:
 * the access token's JWT `exp` says when it runs out.
 */

import type { SignInOAuth } from '@factory/store';

export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_SCOPE = 'openid profile email';

/** A run starts with at least this long left on its access token; sooner, the server refreshes first. */
export const CODEX_OAUTH_REFRESH_MARGIN_MS = 10 * 60_000;

/** How long the token endpoint gets before the refresh counts as failed. */
const REFRESH_TIMEOUT_MS = 15_000;

/** The claims OpenAI puts under this key: the ChatGPT plan, workspace and user. */
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

/** The sign-in no longer works (`refresh_token_expired`, reused, revoked): a person must sign in again. */
export class CodexSignInExpiredError extends Error {
  constructor(detail: string) {
    super(`The ChatGPT sign-in for Codex expired or was revoked (${detail}); sign in with ChatGPT again under Settings → Models.`);
    this.name = 'CodexSignInExpiredError';
  }
}

/** A JWT's claims, unverified: the server only reads what the provider itself issued to it. */
export function decodeJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const payload = token?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Who a ChatGPT sign-in is and what it may use, from its id and access tokens' claims. */
export function codexSignInIdentity(tokens: { idToken?: string; accessToken: string }): Pick<
  SignInOAuth,
  'email' | 'accountUuid' | 'workspaceId' | 'subscriptionType' | 'expiresAt'
> {
  const id = decodeJwtClaims(tokens.idToken) ?? {};
  const access = decodeJwtClaims(tokens.accessToken) ?? {};
  const auth = { ...((access[OPENAI_AUTH_CLAIM] ?? {}) as Record<string, unknown>), ...((id[OPENAI_AUTH_CLAIM] ?? {}) as Record<string, unknown>) };
  const email = text(id.email) ?? text((access['https://api.openai.com/profile'] as Record<string, unknown> | undefined)?.email);
  const user = text(auth.chatgpt_user_id) ?? text(auth.user_id) ?? text(id.sub);
  const workspace = text(auth.chatgpt_account_id);
  const plan = text(auth.chatgpt_plan_type);
  const exp = access.exp;
  return {
    ...(email ? { email } : {}),
    ...(user ? { accountUuid: workspace ? `${user}:${workspace}` : user } : {}),
    ...(workspace ? { workspaceId: workspace } : {}),
    ...(plan ? { subscriptionType: plan } : {}),
    // No expiry in the token: due now, so the first run refreshes it.
    expiresAt: typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : 0,
  };
}

/** The sign-in in a `codex login` home's `auth.json`, or `undefined` when it holds none (an API key, nothing). */
export function parseCodexAuthJson(raw: string): SignInOAuth | undefined {
  let tokens: Record<string, unknown> | undefined;
  try {
    tokens = (JSON.parse(raw) as { tokens?: Record<string, unknown> } | null)?.tokens;
  } catch {
    return undefined;
  }
  if (!tokens || typeof tokens !== 'object') return undefined;
  const accessToken = text(tokens.access_token);
  const refreshToken = text(tokens.refresh_token);
  if (!accessToken || !refreshToken) return undefined;
  const idToken = text(tokens.id_token);
  const identity = codexSignInIdentity({ accessToken, ...(idToken ? { idToken } : {}) });
  const workspaceId = text(tokens.account_id) ?? identity.workspaceId;
  return {
    accessToken,
    refreshToken,
    scopes: CODEX_OAUTH_SCOPE.split(' '),
    ...(idToken ? { idToken } : {}),
    ...identity,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export function codexOAuthIsFresh(oauth: SignInOAuth, now: number, marginMs = CODEX_OAUTH_REFRESH_MARGIN_MS): boolean {
  return Number.isFinite(oauth.expiresAt) && oauth.expiresAt - now >= marginMs;
}

export interface RefreshCodexOAuthOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Exchange the refresh token for a new pair. A refusal of the grant (400 or 401) throws
 * {@link CodexSignInExpiredError}; anything else (network, 5xx, a malformed answer) throws a plain
 * error, and the stored pair stays.
 */
export async function refreshCodexOAuth(
  current: SignInOAuth,
  { fetch: fetchImpl = fetch }: RefreshCodexOAuthOptions = {},
): Promise<SignInOAuth> {
  const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      scope: CODEX_OAUTH_SCOPE,
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (response.status === 400 || response.status === 401) {
    const error = body?.error;
    const code =
      typeof error === 'string' ? error : typeof (error as { code?: unknown } | undefined)?.code === 'string' ? (error as { code: string }).code : undefined;
    throw new CodexSignInExpiredError(code ?? `HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`The ChatGPT token endpoint answered HTTP ${response.status}.`);
  const accessToken = text(body?.access_token);
  if (!accessToken) throw new Error('The ChatGPT token endpoint answered without an access token.');
  const idToken = text(body?.id_token) ?? current.idToken;
  const refreshToken = text(body?.refresh_token);
  const identity = codexSignInIdentity({ accessToken, ...(idToken ? { idToken } : {}) });
  // Who signed in does not change with a refresh: what the new tokens leave out stays as the sign-in recorded it.
  return {
    ...current,
    ...identity,
    accessToken,
    ...(idToken ? { idToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
  };
}
