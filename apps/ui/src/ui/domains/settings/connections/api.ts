/**
 * Settings › Підключення's one API (ADR-0035): every connector's connections, methods, removal
 * impact and detail come from `/web/connections`, already in the person's language. Nothing here
 * knows a provider.
 */

import type {
  AuthorizationStatusResponse,
  ConnectionActivityResponse,
  ConnectionDetailView,
  ConnectionErrorBody,
  ConnectionRemoved,
  ConnectionSettingsValues,
  ConnectionsListResponse,
  ConnectorsResponse,
  ConnectResult,
  ConnectSession,
  RemovalImpact,
} from '@factory/contracts';
import i18next from 'i18next';

import { runHeadlessAuth } from '../../factory/services/platformConnect';

/** A refusal from the connections API: its message, per-field messages, and a removal's impact. */
export class ConnectionApiError extends Error {
  readonly status: number;
  readonly body: Partial<ConnectionErrorBody>;

  constructor(status: number, body: Partial<ConnectionErrorBody>) {
    super(body.message ?? body.error ?? `HTTP ${status}`);
    this.name = 'ConnectionApiError';
    this.status = status;
    this.body = body;
  }
}

/** A URL a connect step returned: the server's own routes are relative to the API's origin. */
export function connectionRedirectUrl(baseUrl: string, url: string): string {
  return url.startsWith('/') ? `${baseUrl}${url}` : url;
}

/**
 * How the page leaves for an `authorize` URL (an App install, OAuth) or runs a provider session in
 * place (a Nango connect session, headlessly). An object so tests can stand in for both.
 */
export const connectionNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
  async runSession(session: ConnectSession, authId: string | undefined): Promise<void> {
    await runHeadlessAuth({
      session: {
        connectionId: authId ?? '',
        integrationId: session.integrationId,
        connectUrl: '',
        sessionToken: session.token,
        expiresAt: session.expiresAt ?? '',
      },
    });
  },
};

const AUTH_POLL_INTERVAL_MS = 2_000;
const AUTH_POLL_DEADLINE_MS = 60_000;

/**
 * Finishes an `authorize` result: opens its URL (the page leaves: `redirected`), or runs its session
 * here — or, for a `waiting` flow, waits on it — and then asks the connector about `authId` until the
 * account is active (`completed`), or the time passes (`pending`: the provider still confirms; a minute,
 * or the flow's `timeoutMs`). A failed flow throws with the connector's reason.
 */
export async function finishAuthorize(
  baseUrl: string,
  connector: string,
  result: Extract<ConnectResult, { type: 'authorize' }>,
  options: {
    intervalMs?: number;
    deadlineMs?: number;
    /** Each status asked, as it comes: a `pending` flow's `prompt` (the page to open, a code) shows here. */
    onStatus?: (status: AuthorizationStatusResponse) => void;
    /** Stops asking (the person went back or cancelled): settles as `pending`. */
    signal?: AbortSignal;
  } = {},
): Promise<'redirected' | 'completed' | 'pending'> {
  if (result.session) {
    await connectionNavigation.runSession(result.session, result.authId);
  } else if (!result.waiting) {
    if (result.url) connectionNavigation.assign(connectionRedirectUrl(baseUrl, result.url));
    return 'redirected';
  }
  // A `waiting` flow finishes where the page cannot follow (a CLI's sign-in the server runs): only asked about;
  // its status brings the page to open and a code to enter or paste (`onStatus`).
  if (!result.authId) return 'completed';
  const deadline = Date.now() + (options.deadlineMs ?? result.waiting?.timeoutMs ?? AUTH_POLL_DEADLINE_MS);
  for (;;) {
    if (options.signal?.aborted) return 'pending';
    const answer = await connectionsApi.authStatus(baseUrl, connector, result.authId);
    if (options.signal?.aborted) return 'pending';
    options.onStatus?.(answer);
    const { status, message } = answer;
    if (status === 'completed') return 'completed';
    if (status === 'failed') throw new ConnectionApiError(409, { error: 'auth_failed', ...(message ? { message } : {}) });
    if (Date.now() >= deadline) return 'pending';
    await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? AUTH_POLL_INTERVAL_MS));
  }
}

const path = (id: string, suffix = '') => `/web/connections/${encodeURIComponent(id)}${suffix}`;

async function request<T>(baseUrl: string, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      // The server writes connection copy in the language the person chose here.
      'Accept-Language': i18next.resolvedLanguage ?? i18next.language ?? 'en',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new ConnectionApiError(res.status, (data ?? {}) as Partial<ConnectionErrorBody>);
  return data as T;
}

export const connectionsApi = {
  list: (baseUrl: string, factoryProjectId: string) =>
    request<ConnectionsListResponse>(baseUrl, 'GET', `/web/connections?${new URLSearchParams({ factoryProjectId })}`),
  connectors: (baseUrl: string) => request<ConnectorsResponse>(baseUrl, 'GET', '/web/connections/methods'),
  connect: (baseUrl: string, input: { connector: string; method: string; input: Record<string, string> }) =>
    request<ConnectResult>(baseUrl, 'POST', '/web/connections', input),
  reconnect: (baseUrl: string, id: string, input: Record<string, string>) =>
    request<ConnectResult>(baseUrl, 'POST', path(id, '/reconnect'), { input }),
  rename: (baseUrl: string, id: string, name: string) => request<{ name: string }>(baseUrl, 'PATCH', path(id), { name }),
  impact: (baseUrl: string, id: string) => request<RemovalImpact>(baseUrl, 'GET', path(id, '/impact')),
  remove: (baseUrl: string, id: string, confirm: boolean) =>
    request<ConnectionRemoved>(baseUrl, 'DELETE', path(id, confirm ? '?confirm=1' : '')),
  unlink: (baseUrl: string, id: string) => request<{ message: string }>(baseUrl, 'POST', path(id, '/unlink')),
  authStatus: (baseUrl: string, connector: string, authId: string) =>
    request<AuthorizationStatusResponse>(baseUrl, 'GET', `/web/connections/authorizations/${encodeURIComponent(authId)}?${new URLSearchParams({ connector })}`),
  /** Hands the code the provider's page showed the person to their pending flow. */
  submitAuthCode: (baseUrl: string, connector: string, authId: string, code: string) =>
    request<AuthorizationStatusResponse>(
      baseUrl,
      'POST',
      `/web/connections/authorizations/${encodeURIComponent(authId)}/code?${new URLSearchParams({ connector })}`,
      { code },
    ),
  /** Stops the person's own pending flow (the CLI the server runs for it). */
  cancelAuth: (baseUrl: string, connector: string, authId: string) =>
    request<AuthorizationStatusResponse>(baseUrl, 'DELETE', `/web/connections/authorizations/${encodeURIComponent(authId)}?${new URLSearchParams({ connector })}`),
  updateSettings: (baseUrl: string, id: string, section: string, values: ConnectionSettingsValues) =>
    request<{ message: string }>(baseUrl, 'PATCH', path(id, '/settings'), { section, values }),
  detail: (baseUrl: string, id: string) => request<ConnectionDetailView>(baseUrl, 'GET', path(id, '/detail')),
  activity: (baseUrl: string, factoryProjectId: string, hours: number) =>
    request<ConnectionActivityResponse>(baseUrl, 'GET', `/web/connections/activity?${new URLSearchParams({ factoryProjectId, hours: String(hours) })}`),
};
