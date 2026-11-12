import { translator } from '../../../i18n/t';

const tk = translator('auth');

/**
 * Allowing an MCP client (Claude Code, Cursor) on Factory's own OAuth server (better-auth's OAuth
 * provider under `/auth/api/oauth2/*`). The server sends the person to `/oauth/consent?<signed
 * authorization request>`; the page shows who asks and answers with that same query.
 */

/** The client's public fields, as the provider shows them before consent. */
export interface OAuthClientInfo {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(tk('consent.requestFailed', { status: res.status }));
  }
  if (!res.ok) {
    const error = data as { error_description?: string; message?: string; error?: string };
    throw new Error(error.error_description || error.message || error.error || tk('consent.requestFailed', { status: res.status }));
  }
  return data as T;
}

/** Whether a query string is the OAuth provider's signed authorization request (login or consent page). */
export function isSignedOAuthQuery(query: string): boolean {
  const params = new URLSearchParams(query);
  return params.has('sig') && params.has('client_id');
}

export async function getOAuthClient(baseUrl: string, clientId: string): Promise<OAuthClientInfo> {
  const res = await fetch(`${baseUrl}/auth/api/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  return readJson<OAuthClientInfo>(res);
}

/** Allows or denies the client; answers the address to send the browser to (the client's redirect). */
export async function answerOAuthConsent(baseUrl: string, oauthQuery: string, accept: boolean): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/api/oauth2/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ accept, oauth_query: oauthQuery }),
  });
  const { url } = await readJson<{ url?: string }>(res);
  if (!url) throw new Error(tk('consent.requestFailed', { status: res.status }));
  return url;
}

/**
 * Full-page navigation back to the client (its loopback callback). Service-level because jsdom's
 * `window.location.assign` cannot be spied on.
 */
export function returnToOAuthClient(url: string): void {
  window.location.assign(url);
}
