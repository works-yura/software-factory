import { translator } from '../../../i18n/t';

const tk = translator('board');

/** Browser-side helpers for the ClickUp intake source (polling, API token on the server). */

export interface ClickUpStatus {
  /** False when the server has no ClickUp token (the status route is not mounted). */
  configured: boolean;
  connected: boolean;
  workspaces: string[];
  intervalSeconds: number;
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
 * No ClickUp token means the status route is not mounted. The server then answers with its HTML
 * app shell (200), not a 404, so a response that is not JSON counts as "not configured" too.
 * Everything else that fails is "unavailable".
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
