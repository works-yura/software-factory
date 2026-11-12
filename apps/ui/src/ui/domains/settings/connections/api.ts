/**
 * Settings › Підключення's one API (ADR-0035): every connector's connections, methods, removal
 * impact and detail come from `/web/connections`, already in the person's language. Nothing here
 * knows a provider.
 */

import type {
  AuthorizationStatusResponse,
  ConnectionDetailView,
  ConnectionErrorBody,
  ConnectionRemoved,
  ConnectionsListResponse,
  ConnectorsResponse,
  ConnectResult,
  RemovalImpact,
} from '@factory/contracts';
import i18next from 'i18next';

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

/** Leaves the page for an `authorize` URL (an App install, OAuth). An object so tests can watch it. */
export const connectionNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

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
  detail: (baseUrl: string, id: string) => request<ConnectionDetailView>(baseUrl, 'GET', path(id, '/detail')),
};
