/**
 * Browser-side helpers for factory user sessions — the conversations listed in
 * the sidebar. Listing is per Factory; creation goes through a repository link,
 * which resolves its source-control provider; individual-session routes resolve
 * the provider from the durable session row.
 */
import type { FailedDraft } from '../../chat/services/handoffFiles';
import { postSourceControlRepositoryOp, readJsonOrThrow } from './http';
import { translator } from '../../../i18n/t';
import type { SessionSandboxStartError } from '../../../../api/types';

const tk = translator('workspaces');

export const USER_SESSION_BRANCH_PREFIX = 'user/';
export const SLACK_SESSION_BRANCH_PREFIX = 'slack/';

export interface FactoryUserSessionOwner {
  id: string;
  name: string;
  avatarUrl?: string;
}

export interface FactoryUserSession {
  id: string;
  sessionId: string;
  projectRepositoryId: string;
  orgId: string;
  userId: string;
  /**
   * Memory resource the session runs under (the Factory for runs and Slack
   * sessions, the owner for user sessions). Only the single-session read reports it.
   */
  resourceId?: string;
  owner?: FactoryUserSessionOwner;
  visibility: 'org' | 'private';
  title?: string;
  branch: string;
  baseBranch: string;
  sandboxId: string | null;
  sandboxWorkdir: string | null;
  materializedAt: string | null;
  /** When the session's first conversational message went out; a session nobody wrote to has none. */
  firstMessageAt?: string | null;
  createdAt: string;
  updatedAt: string;
  /** What the viewer may do with this session, computed by the server. */
  capabilities?: { recreateSandbox: boolean; switchModel?: boolean };
  /** Set when the session runs on Claude Code or Codex (its Factory's model for that harness); absent for Mastra sessions. */
  harness?: 'claude-code' | 'codex';
}

type FactoryUserSessionPayload = Omit<FactoryUserSession, 'title'> & { title?: string | null };

/**
 * The session's checkout is being prepared: a message went out and the
 * workspace is not there yet. A session nobody wrote to is idle, not preparing,
 * even though it has no checkout.
 */
export function sessionCheckoutPending(session: Pick<FactoryUserSession, 'materializedAt' | 'firstMessageAt'>): boolean {
  return !session.materializedAt && Boolean(session.firstMessageAt);
}

function normalizeUserSession({ title, ...session }: FactoryUserSessionPayload): FactoryUserSession {
  return { ...session, title: title ?? undefined };
}

/** Every session of the Factory the viewer can see, across all of its repositories and providers. */
export async function listUserSessions(
  baseUrl: string,
  factoryId: string,
  signal?: AbortSignal,
): Promise<FactoryUserSession[]> {
  const res = await fetch(`${baseUrl}/web/factory/projects/${encodeURIComponent(factoryId)}/sessions`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
    signal,
  });
  const body = await readJsonOrThrow<{ sessions: FactoryUserSessionPayload[] }>(res, tk('errors.listSessions'));
  return body.sessions.map(normalizeUserSession);
}

export type CreateUserSessionOptions = (
  | { branch: string; baseBranch?: string; sessionId?: never; title?: never }
  | { sessionId: string; title: string; branch?: never; baseBranch?: never }
) & {
  /** Defaults to `org`. A session someone opens for themselves with New session is created `private`. */
  visibility?: 'private' | 'org';
};

/**
 * A draft's session failed to start after its thread opened. The thread route
 * sends the person back to the draft with what they had picked; the draft's
 * images stay stashed under its id.
 */
export class DraftSessionCreateError extends Error {
  constructor(
    message: string,
    readonly draft: FailedDraft,
    readonly draftPath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DraftSessionCreateError';
  }
}

export async function createUserSession(
  baseUrl: string,
  projectRepositoryId: string,
  options: CreateUserSessionOptions,
): Promise<FactoryUserSession> {
  const result = await postSourceControlRepositoryOp<{ session: FactoryUserSessionPayload }>(
    baseUrl,
    projectRepositoryId,
    'sessions',
    options,
  );
  return normalizeUserSession(result.session);
}

export async function getUserSession(baseUrl: string, sessionId: string): Promise<FactoryUserSession> {
  const res = await fetch(`${baseUrl}/web/user-sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  const body = await readJsonOrThrow<{ session: FactoryUserSessionPayload }>(res, tk('errors.loadSession'));
  return normalizeUserSession(body.session);
}

/** The server answers a missing session and a teammate's private one with the same 404. */
export function isSessionNotFound(error: Error): boolean {
  return 'status' in error && error.status === 404;
}

export async function deleteUserSession(baseUrl: string, sessionId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/web/user-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok && res.status !== 404) throw new Error(tk('errors.deleteSession', { status: res.status }));
}

/** Destroy the session's sandbox (stopping any active run) so the next message boots a fresh one. */
export async function recreateSessionSandbox(
  baseUrl: string,
  sessionId: string,
): Promise<{ recreated: boolean; aborted: boolean }> {
  const res = await fetch(`${baseUrl}/web/user-sessions/${encodeURIComponent(sessionId)}/sandbox/recreate`, {
    method: 'POST',
    credentials: 'include',
  });
  const body: { recreated?: boolean; aborted?: boolean; error?: string } = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? tk('errors.recreateSandbox', { status: res.status }));
  return { recreated: body.recreated === true, aborted: body.aborted === true };
}

/**
 * Start the session's sandbox without sending it a message. Resolves once the server has begun:
 * `starting` while it clones in the background (the workspace tree reports how it ends), or
 * already running.
 */
export async function startSessionSandbox(baseUrl: string, sessionId: string): Promise<{ starting: boolean }> {
  const res = await fetch(`${baseUrl}/web/user-sessions/${encodeURIComponent(sessionId)}/sandbox/start`, {
    method: 'POST',
    credentials: 'include',
  });
  const body: { starting?: boolean; error?: string; message?: string } = await res.json().catch(() => ({}));
  if (!res.ok) throw sandboxStartRequestError(res.status, body);
  return { starting: body.starting === true };
}

/** A start request the server refused or failed, with the kind of failure the page names. */
export class SandboxStartRequestError extends Error {
  readonly code: SessionSandboxStartError['code'];
  constructor(code: SessionSandboxStartError['code'], message: string) {
    super(message);
    this.name = 'SandboxStartRequestError';
    this.code = code;
  }
}

/** A machine code (`internal_error`, `gateway_timeout`) is never a message to show. */
const ERROR_CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

function sandboxStartRequestError(status: number, body: { error?: string; message?: string }) {
  const text = body.error && !ERROR_CODE.test(body.error) ? body.error : body.message;
  if (status === 504 || body.error === 'gateway_timeout') return new SandboxStartRequestError('timeout', text ?? '');
  return new SandboxStartRequestError('unknown', text ?? tk('errors.startSandbox', { status }));
}

/** Ask the title model to re-name a session's conversation. Resolves to the new title. */
export async function regenerateSessionTitle(baseUrl: string, sessionId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/web/user-sessions/${encodeURIComponent(sessionId)}/title`, {
    method: 'POST',
    credentials: 'include',
  });
  const body: { title?: string; error?: string } = await res.json().catch(() => ({}));
  if (!res.ok || !body.title) throw new Error(body.error ?? tk('errors.renameSession', { status: res.status }));
  return body.title;
}

export type UserSessionVisibility = FactoryUserSession['visibility'];

/** Owner-only: share a session with the organization or make it private again. */
export async function setUserSessionVisibility(
  baseUrl: string,
  sessionId: string,
  visibility: UserSessionVisibility,
): Promise<FactoryUserSession> {
  const res = await fetch(`${baseUrl}/web/user-sessions/${encodeURIComponent(sessionId)}/visibility`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ visibility }),
  });
  // The server explains refusals (a running session, a Factory run, storage still starting); show its words.
  if (!res.ok) {
    const reason = await res
      .json()
      .then((payload: { error?: unknown }) => (typeof payload.error === 'string' ? payload.error : null))
      .catch(() => null);
    if (reason) throw Object.assign(new Error(reason), { status: res.status });
  }
  const body = await readJsonOrThrow<{ session: FactoryUserSessionPayload }>(
    res,
    tk('sharing.changeFailed'),
  );
  return normalizeUserSession(body.session);
}
