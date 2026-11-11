/**
 * The OAuth refresh of a Claude sign-in (`claude auth login`), done by the
 * server alone. The token endpoint rotates the refresh token on every refresh,
 * so exactly one place may hold and use it: the server, under a row lock (see
 * `ModelCredentialsStorage.refreshAccountOAuth`). A run gets the access token
 * as `CLAUDE_CODE_OAUTH_TOKEN` and never the refresh token.
 *
 * The endpoint and client id are the `claude` CLI's own. They are not a
 * published API: both are read from the CLI 2.1.316 binary (`strings`), as is
 * the request shape (`grant_type=refresh_token`, form-encoded). If Anthropic
 * changes them, refresh fails and the account asks for a new sign-in.
 */

import type { ClaudeLoginOAuth } from '@factory/store';

export const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** A turn starts with at least this long left on its access token; sooner, the server refreshes first. */
export const CLAUDE_OAUTH_REFRESH_MARGIN_MS = 10 * 60_000;

/** How long the token endpoint gets before the refresh counts as failed. */
const REFRESH_TIMEOUT_MS = 15_000;

/** The sign-in no longer works (`invalid_grant`, revoked, expired): a person must sign in again. */
export class ClaudeSignInExpiredError extends Error {
  constructor(detail: string) {
    super(`The Claude sign-in expired or was revoked (${detail}); sign in to Claude again under Settings → Models.`);
    this.name = 'ClaudeSignInExpiredError';
  }
}

export function claudeOAuthIsFresh(oauth: ClaudeLoginOAuth, now: number, marginMs = CLAUDE_OAUTH_REFRESH_MARGIN_MS): boolean {
  return Number.isFinite(oauth.expiresAt) && oauth.expiresAt - now >= marginMs;
}

export interface RefreshClaudeOAuthOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Exchange the refresh token for a new pair. A refusal of the grant (400 or
 * 401) throws {@link ClaudeSignInExpiredError}; anything else (network,
 * 5xx, a malformed answer) throws a plain error, and the stored pair stays.
 */
export async function refreshClaudeOAuth(
  current: ClaudeLoginOAuth,
  { fetch: fetchImpl = fetch, now = Date.now }: RefreshClaudeOAuthOptions = {},
): Promise<ClaudeLoginOAuth> {
  const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (response.status === 400 || response.status === 401) {
    const error = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new ClaudeSignInExpiredError(error);
  }
  if (!response.ok) throw new Error(`The Claude token endpoint answered HTTP ${response.status}.`);
  const accessToken = body?.access_token;
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('The Claude token endpoint answered without an access token.');
  }
  const expiresIn = body?.expires_in;
  const refreshToken = body?.refresh_token;
  const scope = body?.scope;
  return {
    ...current,
    accessToken,
    // No lifetime in the answer: treat the token as due, so the next turn refreshes again rather than run on a guess.
    expiresAt: typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? now() + expiresIn * 1000 : now(),
    ...(typeof refreshToken === 'string' && refreshToken.trim() ? { refreshToken } : {}),
    ...(typeof scope === 'string' && scope.trim() ? { scopes: scope.split(' ') } : {}),
  };
}
