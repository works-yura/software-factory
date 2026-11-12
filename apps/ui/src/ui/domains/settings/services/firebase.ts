/**
 * Browser-side calls for Settings › Logs and crashes (Firebase): the org's Google Cloud accounts and
 * the bindings Factory → account → Google Cloud project. A key is sent once, on upload; the server
 * never sends it back — only who it belongs to.
 */

import { translator } from '../../../i18n/t';

const tk = translator('settings');

/** A Google Cloud service account, as the server lists it. */
export interface FirebaseAccount {
  id: string;
  name: string;
  clientEmail: string;
  /** The Google Cloud project the key was created in. */
  projectId: string;
  keyId: string;
  /** The bindings that read through it. */
  bindingIds: string[];
}

export type FirebasePlatform = 'android' | 'ios' | 'web';

export interface FirebaseApp {
  appId: string;
  platform: FirebasePlatform;
  label?: string;
}

/** What a binding reads: a Factory reads one Google Cloud project through one account. */
export interface FirebaseBindingInput {
  /** A name people give the connection; absent shows the project id. */
  name?: string;
  factoryProjectId: string;
  accountId: string;
  projectId: string;
  projectNumber?: string;
  logs: boolean;
  crashes: boolean;
  apps: FirebaseApp[];
  /** «База»: agents read the project's Firestore through MCP Toolbox (an MCP server the integration manages). */
  database?: { enabled: boolean; databaseId?: string };
}

export interface FirebaseBinding extends FirebaseBindingInput {
  id: string;
  /** When and by whom it was made; absent on bindings saved before that was recorded. */
  createdAt?: string;
  createdBy?: string;
}

export interface FirebaseState {
  accounts: FirebaseAccount[];
  bindings: FirebaseBinding[];
}

export interface FirebaseCheck {
  check: 'logs' | 'crashes' | 'database';
  target: string;
  ok: boolean;
  message?: string;
  missingRole?: string;
  fix?: string;
}

export interface FirebaseCheckResult {
  ok: boolean;
  checks: FirebaseCheck[];
}

/** The server refused: its message, and the body for callers that need more (the bindings in use). */
export class FirebaseRequestError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    credentials: 'include',
  });
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    const message = (body.message as string | undefined) ?? (body.error as string | undefined) ?? tk('observability.requestFailed', { status: res.status });
    throw new FirebaseRequestError(message, res.status, body);
  }
  return (await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

/** Answers with the whole state and the account it added. */
export const addFirebaseAccount = (baseUrl: string, input: { serviceAccountJson: string; name?: string }) =>
  request<FirebaseState & { account: FirebaseAccount }>(baseUrl, '/web/firebase/accounts', json('POST', input));
