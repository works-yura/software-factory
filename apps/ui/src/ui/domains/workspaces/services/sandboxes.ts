/**
 * A Factory's local sandboxes (Settings › Environment › Sandboxes, ADR-0039):
 * each card's or session's folder, its repositories, size, last activity and
 * whether it is awake, and putting an idle one to sleep.
 */

import { translator } from '../../../i18n/t';
import { readJsonOrThrow } from './http';

const tk = translator('workspaces');

export type FactorySandboxState = 'active' | 'idle' | 'asleep';
export type FactorySandboxProblemKind = 'save-failed' | 'superseded' | 'public-repository' | 'processes-unchecked';

export interface FactorySandboxProblem {
  kind: FactorySandboxProblemKind;
  message: string;
  at: string;
  occurrence: string;
}

export interface FactorySandbox {
  key: string;
  kind: 'card' | 'session';
  sessionIds: string[];
  repos: string[];
  sizeBytes?: number;
  lastActivityAt?: string;
  state: FactorySandboxState;
  sleptAt?: string;
  sleepReason?: 'idle' | 'limit' | 'manual';
  problems: FactorySandboxProblem[];
}

export interface FactorySandboxList {
  sandboxes: FactorySandbox[];
  canManage: boolean;
}

function sandboxesUrl(baseUrl: string, factoryProjectId: string): string {
  return `${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/sandboxes`;
}

export async function listSandboxes(baseUrl: string, factoryProjectId: string): Promise<FactorySandboxList> {
  const res = await fetch(sandboxesUrl(baseUrl, factoryProjectId), {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  return readJsonOrThrow<FactorySandboxList>(res, tk('errors.listSandboxes'));
}

/** Save the sandbox's work and stop it; the server says why when it will not (an agent works in it, a save failed). */
export async function sleepSandbox(baseUrl: string, factoryProjectId: string, key: string): Promise<void> {
  const res = await fetch(`${sandboxesUrl(baseUrl, factoryProjectId)}/sleep`, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  const error = new Error(body.message ?? `${tk('errors.sleepSandbox')} (${res.status})`) as Error & { status?: number };
  error.status = res.status;
  throw error;
}
