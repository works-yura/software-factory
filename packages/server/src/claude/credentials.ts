import { getTenantCredentialsStorage, pickCredentialAccount, TenantCredentialStore } from '@factory/credentials';
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

/** `claude setup-token` and Claude subscription OAuth tokens; the CLI takes them as `CLAUDE_CODE_OAUTH_TOKEN`. */
const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

export class ClaudeCodeCredentialMissingError extends Error {
  constructor(orgId: string) {
    super(
      `No Anthropic credential is set for organization ${orgId}. Add an Anthropic API key or a Claude setup token under Settings → Models to run Claude Code sessions.`,
    );
    this.name = 'ClaudeCodeCredentialMissingError';
  }
}

/**
 * Local development with no account: the CLI keeps its sessions in the
 * session's own config dir, but reads its credentials from the default place
 * (`~/.claude` and its Keychain item), i.e. the person's own `claude` login.
 * The CLI takes an empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` as that default.
 */
export const LOCAL_LOGIN_CREDENTIAL_ENV: Readonly<Record<string, string>> = { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' };

/** The env for one Anthropic credential: an API key, or an OAuth/setup token. */
export function claudeCodeCredentialEnv(credential: {
  type: 'api_key' | 'oauth';
  secret: string;
}): Record<string, string> {
  if (credential.type === 'oauth' || credential.secret.startsWith(OAUTH_TOKEN_PREFIX)) {
    return { CLAUDE_CODE_OAUTH_TOKEN: credential.secret };
  }
  return { ANTHROPIC_API_KEY: credential.secret };
}

export interface ClaudeCodeCredentials {
  credentials: ClaudeCodeCredentialsHook;
  onCredentialFailure: ClaudeCodeCredentialFailureHook;
}

/**
 * The credentials every Claude Code turn asks for, harness-agnostic on purpose.
 *
 * - The organization's Anthropic accounts (Settings → Models) come first: the
 *   turn gets one (see `pickCredentialAccount` for which), and an account that
 *   runs out of usage sits out until it resets while the turn goes on with the
 *   next. A subscription account serves only its owner's runs.
 * - A Claude sign-in (`claude_login`) is refreshed here first when its access
 *   token has less than `CLAUDE_OAUTH_REFRESH_MARGIN_MS` left, under the
 *   account row's lock; the turn gets the access token alone. A sign-in the
 *   token endpoint refuses is turned off with a message asking for a new
 *   sign-in, and the turn goes on with the next account.
 * - With no account this run may use, the old single credential applies: in
 *   local development the CLI reads the person's own `claude` login (see
 *   {@link LOCAL_LOGIN_CREDENTIAL_ENV}); otherwise the organization's Anthropic credential (an API
 *   key as `ANTHROPIC_API_KEY`, an OAuth or setup token as
 *   `CLAUDE_CODE_OAUTH_TOKEN`, refreshed first like a Mastra run's).
 * - When every account the run may use is out of usage, the turn fails with a
 *   `rate_limit` error that says when the first one comes back.
 */
export function createClaudeCodeCredentials({
  localDevelopment,
  credentials,
  now = () => new Date(),
  fetch: fetchImpl,
}: {
  localDevelopment: boolean;
  credentials: ModelCredentialsStorage | undefined;
  now?: () => Date;
  /** The OAuth refresh's transport; the global `fetch` by default. */
  fetch?: typeof fetch;
}): ClaudeCodeCredentials {
  const single = async ({ orgId, userId }: ClaudeCodeCredentialTenant): Promise<Record<string, string>> => {
    if (localDevelopment) return { ...LOCAL_LOGIN_CREDENTIAL_ENV };
    const store = new TenantCredentialStore(orgId, userId, credentials, 'factory');
    await store.ensureFresh();
    const stored = store.get(CLAUDE_CODE_ACCOUNT_PROVIDER);
    const secret = stored ? await store.getApiKey(CLAUDE_CODE_ACCOUNT_PROVIDER) : undefined;
    if (!stored || !secret) throw new ClaudeCodeCredentialMissingError(orgId);
    return claudeCodeCredentialEnv({ type: stored.type, secret });
  };

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
        const accounts = storage ? await storage.listAccounts(tenant.orgId, CLAUDE_CODE_ACCOUNT_PROVIDER) : [];
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
          // An account already failed this turn and no other is left: the old credential is not a fallback for it.
          if (request.exclude.length > 0 || refused.length > 0) {
            throw new ClaudeCodeError('auth', 'No other Claude account is available for this run.');
          }
          return single(tenant);
        }
        const { account } = picked;
        const secret =
          account.kind === 'claude_login' && storage
            ? await signInToken(storage, tenant.orgId, account)
            : await storage?.getAccountSecret(tenant.orgId, account.id);
        if (account.kind === 'claude_login' && storage && secret === undefined) {
          refused.push(account.id);
          continue;
        }
        // Removed between the listing and now: the next turn lists again.
        if (!storage || !secret) throw new ClaudeCodeError('auth', `Claude account ${account.label} is no longer available.`);
        await storage.markAccountUsed(tenant.orgId, account.id, at).catch(() => {});
        return {
          env: claudeCodeCredentialEnv({ type: account.kind === 'api_key' ? 'api_key' : 'oauth', secret }),
          accountId: account.id,
        };
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
  localDevelopment: boolean;
  credentials: ModelCredentialsStorage | undefined;
}): ClaudeCodeCredentialsHook {
  return createClaudeCodeCredentials(options).credentials;
}
