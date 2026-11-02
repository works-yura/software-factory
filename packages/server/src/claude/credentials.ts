import { getTenantCredentialsStorage, pickCredentialAccount } from '@factory/credentials';
import { ClaudeCodeError } from '@factory/harness-claude-code';
import type { ClaudeCredentialFailure, ClaudeCredentialRequest, ClaudeTurnCredentials } from '@factory/harness-claude-code';
import type { CredentialAccount, ModelCredentialsStorage } from '@factory/store';

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

/** How long an account sits out when the provider gave no reset time. */
export const DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS = 60 * 60_000;

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
}

/**
 * The credentials every Claude Code turn asks for, harness-agnostic on purpose.
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
  /** A sign-in's access token, refreshed first when it is about to run out; `undefined` when the sign-in was refused. */
  const signInToken = async (storage: ModelCredentialsStorage, orgId: string, account: CredentialAccount) => {
    try {
      const oauth = await storage.refreshAccountOAuth(orgId, account.id, {
        isFresh: current => claudeOAuthIsFresh(current, now().getTime()),
        refresh: current => refreshClaudeOAuth(current, { ...(fetchImpl ? { fetch: fetchImpl } : {}), now: () => now().getTime() }),
      });
      return oauth?.accessToken;
    } catch (error) {
      if (!(error instanceof ClaudeSignInExpiredError)) throw error;
      await storage.markAccountFailed(orgId, account.id, error.message);
      console.warn('[factory] Claude sign-in refused by the token endpoint; it needs a new sign-in', { orgId, accountId: account.id });
      return undefined;
    }
  };

  return {
    async credentials(tenant, request = { exclude: [] }) {
      const storage = await getTenantCredentialsStorage(credentials);
      // Sign-ins refused while picking: skipped like accounts the turn already tried, but not counted as tried.
      const refused: string[] = [];
      for (;;) {
        const listed = storage ? await storage.listAccounts(tenant.orgId, CLAUDE_CODE_ACCOUNT_PROVIDER) : [];
        // Only sign-ins run Claude Code: a pasted setup token or API key from before is never used.
        const accounts = listed.filter(account => account.kind === 'claude_login');
        const at = now();
        const picked = pickCredentialAccount(accounts, {
          userId: tenant.userId,
          ...(request.preferredAccountId ? { preferredId: request.preferredAccountId } : {}),
          exclude: [...request.exclude, ...refused],
          now: at,
        });
        if (!picked.account) {
          if (picked.resetsAt) {
            throw new ClaudeCodeError(
              'rate_limit',
              `Every Claude account this run may use is out of usage; the first comes back at ${picked.resetsAt.toISOString()}.`,
              { resetsAt: picked.resetsAt, now: at },
            );
          }
          if (request.exclude.length > 0 || refused.length > 0) {
            throw new ClaudeCodeError('auth', 'No other Claude account is available for this run.');
          }
          throw new ClaudeCodeCredentialMissingError(tenant.orgId);
        }
        const { account } = picked;
        // A sign-in was picked from the storage's own listing, so the storage is there.
        const accessToken = await signInToken(storage!, tenant.orgId, account);
        if (accessToken === undefined) {
          refused.push(account.id);
          continue;
        }
        await storage!.markAccountUsed(tenant.orgId, account.id, at).catch(() => {});
        return { env: { CLAUDE_CODE_OAUTH_TOKEN: accessToken }, accountId: account.id };
      }
    },

    async onCredentialFailure(tenant, { accountId, error }) {
      const storage = await getTenantCredentialsStorage(credentials);
      if (!storage) return;
      if (error.kind === 'rate_limit') {
        const until = error.resetsAt ?? new Date(now().getTime() + DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS);
        await storage.markAccountLimited(tenant.orgId, accountId, { until, error: error.message });
      } else if (error.kind === 'auth') {
        await storage.markAccountFailed(tenant.orgId, accountId, error.message);
      } else {
        return;
      }
      console.warn('[factory] Claude account taken out of rotation', {
        orgId: tenant.orgId,
        accountId,
        kind: error.kind,
        ...(error.resetsAt ? { resetsAt: error.resetsAt.toISOString() } : {}),
      });
    },
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
