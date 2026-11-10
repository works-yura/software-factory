/**
 * Browser-side calls for Settings › Logs and crashes (Firebase). The key is sent once, on upload;
 * the server never sends it back — only who it belongs to.
 */

import { translator } from '../../../i18n/t';

const tk = translator('settings');

export interface FirebaseAccount {
  clientEmail: string;
  projectId: string;
  keyId: string;
}

export interface FirebaseStatus {
  connected: boolean;
  account?: FirebaseAccount;
}

export type FirebasePlatform = 'android' | 'ios' | 'web';

export interface FirebaseApp {
  appId: string;
  platform: FirebasePlatform;
  label?: string;
}

export interface FirebaseMapping {
  projectId: string;
  projectNumber?: string;
  logs: boolean;
  apps: FirebaseApp[];
}

export interface FirebaseCheck {
  check: 'logs' | 'crashes';
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

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    credentials: 'include',
  });
  if (!res.ok) {
    let message = tk('observability.requestFailed', { status: res.status });
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const fetchFirebaseStatus = (baseUrl: string) => request<FirebaseStatus>(baseUrl, '/web/firebase/status');

export const uploadFirebaseKey = (baseUrl: string, serviceAccountJson: string) =>
  request<FirebaseStatus>(baseUrl, '/web/firebase/connection', { method: 'PUT', body: JSON.stringify({ serviceAccountJson }) });

export const disconnectFirebase = (baseUrl: string) =>
  request<FirebaseStatus>(baseUrl, '/web/firebase/connection', { method: 'DELETE' });

export async function fetchFirebaseMapping(baseUrl: string, factoryId: string): Promise<FirebaseMapping | null> {
  return (await request<{ mapping: FirebaseMapping | null }>(baseUrl, `/web/firebase/factories/${encodeURIComponent(factoryId)}`)).mapping;
}

export async function saveFirebaseMapping(baseUrl: string, factoryId: string, mapping: FirebaseMapping | null): Promise<FirebaseMapping | null> {
  const path = `/web/firebase/factories/${encodeURIComponent(factoryId)}`;
  const result = mapping
    ? await request<{ mapping: FirebaseMapping }>(baseUrl, path, { method: 'PUT', body: JSON.stringify(mapping) })
    : await request<{ mapping: null }>(baseUrl, path, { method: 'DELETE' });
  return result.mapping;
}

export const checkFirebase = (baseUrl: string, factoryId: string, mapping: FirebaseMapping) =>
  request<FirebaseCheckResult>(baseUrl, `/web/firebase/factories/${encodeURIComponent(factoryId)}/check`, {
    method: 'POST',
    body: JSON.stringify({ mapping }),
  });
