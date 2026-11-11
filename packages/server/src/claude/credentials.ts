import { ClaudeCodeError } from '@factory/harness-claude-code';
import type { ClaudeCredentialFailure, ClaudeCredentialRequest, ClaudeTurnCredentials } from '@factory/harness-claude-code';
import type { ModelCredentialsStorage, SignInOAuth } from '@factory/store';

import { createSignInAccountPool, DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS } from '../accounts/pool.ts';

import { claudeOAuthIsFresh, ClaudeSignInExpiredError, refreshClaudeOAuth } from './oauth.ts';

/** Who a Claude Code turn runs for: the organization whose credential pays, and the session's owner. */
export interface ClaudeCodeCredentialTenant {
  orgId: string;
  userId: string;
}

/** The env a turn's `claude` process authenticates with, and the account it came from when there are several. */
export type ClaudeCodeCredentialsHook = (
  tenant: ClaudeCodeCredentialTenant,
  request?: ClaudeCredentialRequest,
) => Promise<Record<string, string> | ClaudeTurnCredentials>;

/** Told when a turn's account ran out of usage or was refused. */
export type ClaudeCodeCredentialFailureHook = (
  tenant: ClaudeCodeCredentialTenant,
  failure: ClaudeCredentialFailure,
) => Promise<void>;

/** The provider whose accounts Claude Code turns use. */
export const CLAUDE_CODE_ACCOUNT_PROVIDER = 'anthropic';

/** How long an account sits out when the provider gave no reset time (shared by every harness's pool). */
export { DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS };

export class ClaudeCodeCredentialMissingError extends Error {
  constructor(orgId: string) {
    super(
      `No Claude sign-in is set for organization ${orgId}. Sign in to Claude under Settings → Models → Claude Code accounts to run Claude Code sessions.`,
    );
    this.name = 'ClaudeCodeCredentialMissingError';
  }
}

export interface ClaudeCodeCredentials {
  credentials: ClaudeCodeCredentialsHook;
  onCredentialFailure: ClaudeCodeCredentialFailureHook;
  /** The account's Claude sign-in, refreshed when due, for reading its usage; `undefined` when there is none. */
  signIn?(orgId: string, accountId: string): Promise<SignInOAuth | undefined>;
}

/**
 * The credentials every Claude Code turn asks for, on the shared sign-in pool
 * (`createSignInAccountPool`, which Codex turns use too).
 *
 * - Only Claude sign-ins (`claude_login`, Settings → Models) run Claude Code:
 *   the turn gets one of its owner's (see `pickCredentialAccount` for which),
 *   and a sign-in that runs out of usage sits out until it resets while the
 *   turn goes on with the next. Pasted setup tokens and API keys from before
 *   are ignored, and so is the organization's Anthropic key for Mastra runs.
 * - A sign-in is refreshed here first when its access token has less than
 *   `CLAUDE_OAUTH_REFRESH_MARGIN_MS` left, under the account row's lock; the
 *   turn gets the access token alone (`CLAUDE_CODE_OAUTH_TOKEN`). A sign-in
 *   the token endpoint refuses is turned off with a message asking for a new
 *   sign-in, and the turn goes on with the next one.
 * - With no sign-in this run may use, the turn fails asking for one. The
 *   person's own `claude` login (`~/.claude`, its Keychain item) is never
 *   used, locally either.
 * - When every sign-in the run may use is out of usage, the turn fails with a
 *   `rate_limit` error that says when the first one comes back.
 */
export function createClaudeCodeCredentials({
  credentials,
  now = () => new Date(),
  fetch: fetchImpl,
}: {
  credentials: ModelCredentialsStorage | undefined;
  now?: () => Date;
  /** The OAuth refresh's transport; the global `fetch` by default. */
  fetch?: typeof fetch;
}): ClaudeCodeCredentials {
  const pool = createSignInAccountPool({
    credentials,
    provider: CLAUDE_CODE_ACCOUNT_PROVIDER,
    kind: 'claude_login',
    name: 'Claude',
    now,
    isFresh: (oauth, at) => claudeOAuthIsFresh(oauth, at),
    refresh: (oauth, clock) => refreshClaudeOAuth(oauth, { ...(fetchImpl ? { fetch: fetchImpl } : {}), now: clock }),
    isRefusal: (error): error is Error => error instanceof ClaudeSignInExpiredError,
    errors: {
      limited: (resetsAt, at) =>
        new ClaudeCodeError(
          'rate_limit',
          `Every Claude account this run may use is out of usage; the first comes back at ${resetsAt.toISOString()}.`,
          { resetsAt, now: at },
        ),
      noOther: () => new ClaudeCodeError('auth', 'No other Claude account is available for this run.'),
      missing: orgId => new ClaudeCodeCredentialMissingError(orgId),
    },
  });

  return {
    async credentials(tenant, request = { exclude: [] }) {
      const picked = await pool.pick(tenant, request);
      return { env: { CLAUDE_CODE_OAUTH_TOKEN: picked.oauth.accessToken }, accountId: picked.accountId, credential: picked.credential };
    },
    onCredentialFailure: (tenant, { accountId, error }) =>
      pool.onFailure(tenant, { accountId, error: { kind: error.kind, message: error.message, ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}) } }),
    signIn: (orgId, accountId) => pool.signIn(orgId, accountId),
  };
}

/**
 * The credentials hook alone, for hosts that keep one credential per
 * organization; see {@link createClaudeCodeCredentials}.
 */
export function createClaudeCodeCredentialsHook(options: {
  credentials: ModelCredentialsStorage | undefined;
}): ClaudeCodeCredentialsHook {
  return createClaudeCodeCredentials(options).credentials;
}
