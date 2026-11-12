import { translator } from '../../../i18n/t';

const tk = translator('board');

/**
 * Browser-side helpers for the ClickUp intake source (polling). Each organization connects its own
 * API token (ADR-0032); the token goes to the server once and never comes back.
 */

export interface ClickUpStatus {
  /** The organization stored a token. False also when the status could not be read (`reason`). */
  configured: boolean;
  /** ClickUp accepted the stored token just now. */
  connected: boolean;
  workspaces: string[];
  /** The ClickUp account the token belongs to. */
  account?: { username: string };
  intervalSeconds: number;
  /** The caller may connect, replace or disconnect the token (an organization admin). */
  canManage?: boolean;
  /** The organization's own name for the connection; absent shows «ClickUp». */
  name?: string;
  /** When the token was first connected and who connected it (absent on older connections). */
  connectedAt?: string;
  connectedBy?: string;
  error?: string;
  reason?: 'not_configured' | 'auth_required' | 'organization_required' | 'unavailable';
}

export interface ClickUpList {
  id: string;
  name: string;
  /** `Space` or `Space / Folder`. */
  path: string;
  workspaceId: string;
}

const UNAVAILABLE: ClickUpStatus = {
  configured: false,
  connected: false,
  workspaces: [],
  intervalSeconds: 0,
  reason: 'unavailable',
};

/**
 * A server without the ClickUp integration has no status route: it answers with its HTML app shell
 * (200), not a 404, so a response that is not JSON counts as "not configured" too. Everything else
 * that fails is "unavailable".
 */
export async function fetchClickUpStatus(baseUrl: string): Promise<ClickUpStatus> {
  try {
    const res = await fetch(`${baseUrl}/web/clickup/status`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (res.status === 404) return { ...UNAVAILABLE, reason: 'not_configured' };
    if (res.status === 401) return { ...UNAVAILABLE, reason: 'auth_required' };
    if (res.status === 403) return { ...UNAVAILABLE, reason: 'organization_required' };
    if (!res.ok) return UNAVAILABLE;
    if (!res.headers.get('content-type')?.includes('application/json')) return { ...UNAVAILABLE, reason: 'not_configured' };
    return (await res.json()) as ClickUpStatus;
  } catch {
    return UNAVAILABLE;
  }
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    credentials: 'include',
  });
  if (!res.ok) {
    let message = tk('errors.requestFailed', { status: res.status });
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      /* ignore non-JSON */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function fetchClickUpLists(baseUrl: string): Promise<ClickUpList[]> {
  return (await request<{ lists: ClickUpList[] }>(baseUrl, '/web/clickup/lists')).lists;
}

/** A ClickUp List's statuses, in the List's order (`type` is ClickUp's: `open`, `custom`, `done`, `closed`). */
export interface ClickUpListStatus {
  name: string;
  type: string;
}

export async function fetchClickUpListStatuses(baseUrl: string, listId: string): Promise<ClickUpListStatus[]> {
  return (
    await request<{ statuses: ClickUpListStatus[] }>(baseUrl, `/web/clickup/lists/${encodeURIComponent(listId)}/statuses`)
  ).statuses;
}

/** Connect or replace the organization's token; ClickUp checks it first, and a refusal says why. */
export async function connectClickUp(baseUrl: string, token: string): Promise<ClickUpStatus> {
  return request<ClickUpStatus>(baseUrl, '/web/clickup/connection', { method: 'PUT', body: JSON.stringify({ token }) });
}

export async function disconnectClickUp(baseUrl: string): Promise<ClickUpStatus> {
  return request<ClickUpStatus>(baseUrl, '/web/clickup/connection', { method: 'DELETE' });
}

/** «Перейменувати»: the organization's own name for its ClickUp connection (`null` goes back to «ClickUp»). */
export async function renameClickUp(baseUrl: string, name: string | null): Promise<ClickUpStatus> {
  return request<ClickUpStatus>(baseUrl, '/web/clickup/connection/name', { method: 'PATCH', body: JSON.stringify({ name }) });
}

/** The organization's Factories whose intake routes read ClickUp Lists: what stops when the token goes. */
export interface ClickUpUsage {
  factories: Array<{ id: string; name: string; lists: number }>;
}

export async function fetchClickUpUsage(baseUrl: string): Promise<ClickUpUsage> {
  return request<ClickUpUsage>(baseUrl, '/web/clickup/usage');
}
