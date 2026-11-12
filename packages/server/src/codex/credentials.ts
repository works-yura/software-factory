import { CodexError } from '@factory/harness-codex';
import type { CodexChatGptTokens, CodexCredentialRequest, CodexTurnCredentials } from '@factory/harness-codex';
import type { ModelCredentialsStorage, SignInOAuth } from '@factory/store';

import { createSignInAccountPool } from '../accounts/pool.ts';
import type { AccountTenant } from '../accounts/pool.ts';
import { codexOAuthIsFresh, CodexSignInExpiredError, refreshCodexOAuth } from './oauth.ts';

/** The provider whose accounts Codex turns use: the members' ChatGPT sign-ins. */
export const CODEX_ACCOUNT_PROVIDER = 'openai-codex';

export class CodexCredentialMissingError extends CodexError {
  constructor(orgId: string) {
    super(
      'auth',
      `No ChatGPT sign-in is set for organization ${orgId}. Sign in with ChatGPT under Settings → Connections → Codex to run Codex sessions.`,
    );
    this.name = 'CodexCredentialMissingError';
  }
}

export interface CodexCredentials {
  /** The sign-in a run uses (its access token and workspace alone). */
  credentials(tenant: AccountTenant, request?: CodexCredentialRequest): Promise<CodexTurnCredentials>;
  /** A fresh access token after Codex said the run's was refused; `undefined` when the sign-in is gone. */
  refresh(tenant: AccountTenant, input: { accountId: string | undefined; accessToken: string }): Promise<CodexChatGptTokens | undefined>;
  /** A run's account ran out of usage (it sits out until it resets) or was refused (turned off). */
  onCredentialFailure(tenant: AccountTenant, failure: { accountId: string; error: CodexError }): Promise<void>;
  /** Whether this person has a ChatGPT sign-in a run could use (now or after a reset). */
  usable(tenant: AccountTenant): Promise<boolean>;
  /** The account's ChatGPT sign-in, refreshed when due, for reading its usage; `undefined` when there is none. */
  signIn?(orgId: string, accountId: string): Promise<SignInOAuth | undefined>;
}

function tokensOf(oauth: SignInOAuth): CodexChatGptTokens {
  if (!oauth.workspaceId) throw new CodexError('auth', 'The ChatGPT sign-in names no workspace; sign in with ChatGPT again under Settings → Connections.');
  return { accessToken: oauth.accessToken, chatgptAccountId: oauth.workspaceId, ...(oauth.subscriptionType ? { planType: oauth.subscriptionType } : {}) };
}

/**
 * The credentials every Codex run asks for, on the shared sign-in pool (`createSignInAccountPool`,
 * which Claude Code turns use too): only ChatGPT sign-ins (`codex_login`, Settings → Connections) run
 * Codex, one of the run owner's, refreshed here under the row lock when due; one that runs out of
 * usage sits out until it resets while the turn goes on with the next; one the token endpoint
 * refuses is turned off. The run's `codex app-server` gets the access token and workspace alone
 * and asks again (`refresh`) when the backend refuses it. This server's own `codex login`
 * (`~/.codex`) is never used.
 */
export function createCodexCredentials({
  credentials,
  now = () => new Date(),
  fetch: fetchImpl,
}: {
  credentials: ModelCredentialsStorage | undefined;
  now?: () => Date;
  fetch?: typeof fetch;
}): CodexCredentials {
  const pool = createSignInAccountPool({
    credentials,
    provider: CODEX_ACCOUNT_PROVIDER,
    kind: 'codex_login',
    name: 'Codex',
    now,
    isFresh: (oauth, at) => codexOAuthIsFresh(oauth, at),
    refresh: oauth => refreshCodexOAuth(oauth, fetchImpl ? { fetch: fetchImpl } : {}),
    isRefusal: (error): error is Error => error instanceof CodexSignInExpiredError,
    errors: {
      limited: resetsAt =>
        new CodexError('rate_limit', `Every ChatGPT account this run may use is out of usage; the first comes back at ${resetsAt.toISOString()}.`, {
          resetsAt,
        }),
      noOther: () => new CodexError('auth', 'No other ChatGPT account is available for this run.'),
      missing: orgId => new CodexCredentialMissingError(orgId),
    },
  });

  return {
    async credentials(tenant, request = { exclude: [] }) {
      const picked = await pool.pick(tenant, request);
      return { tokens: tokensOf(picked.oauth), accountId: picked.accountId, credential: picked.credential };
    },
    async refresh(tenant, { accountId, accessToken }) {
      if (!accountId) return undefined;
      const oauth = await pool.refreshAfterRefusal(tenant, accountId, accessToken);
      return oauth ? tokensOf(oauth) : undefined;
    },
    onCredentialFailure: (tenant, { accountId, error }) =>
      pool.onFailure(tenant, { accountId, error: { kind: error.kind, message: error.message, ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}) } }),
    usable: tenant => pool.usable(tenant),
    signIn: (orgId, accountId) => pool.signIn(orgId, accountId),
  };
}
