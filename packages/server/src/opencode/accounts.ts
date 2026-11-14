/**
 * OpenCode accounts: the organization's OpenCode keys (Settings → Connections → OpenCode), one per
 * account, kept encrypted in the credential accounts store (provider `opencode`, kind `api_key`).
 * Organization-wide like every connection: any run of the organization may use them. A run signs its
 * `opencode serve` in with one (inline `OPENCODE_AUTH_CONTENT`, never a file); without any it runs
 * signed in with nothing, on the free models alone (ADR-0043, amendment). The person's own OpenCode
 * login (`~/.local/share/opencode/auth.json`) is never read.
 *
 * Out of usage: the account sits out until its OpenCode Go window resets (read from Go's usage
 * endpoint), or an hour when nobody says; the next run takes another account. A refused key is
 * turned off until someone gives a new one.
 */
import { getTenantCredentialsStorage, pickCredentialAccount } from '@factory/credentials';
import {
  exhaustedUntil,
  OpenCodeError,
  readOpenCodeAccountLimits,
  type OpenCodeCatalogAccount,
  type OpenCodeCredentialRequest,
  type OpenCodeTurnCredentials,
} from '@factory/harness-opencode';
import type { AccountUsageLimits, HarnessUsage } from '@factory/harness/usage';
import type { CredentialAccount, ModelCredentialsStorage } from '@factory/store';

import { DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS, type AccountTenant } from '../accounts/pool.ts';

/** The provider OpenCode accounts are filed under; the connector of the same id lists them. */
export const OPENCODE_ACCOUNT_PROVIDER = 'opencode';

export interface OpenCodeAccounts {
  /** The key a run signs in with; `undefined` when the organization has no OpenCode account (free models only). */
  credentials(tenant: AccountTenant, request?: OpenCodeCredentialRequest): Promise<OpenCodeTurnCredentials | undefined>;
  /** A run's account ran out of usage (it sits out until it resets) or was refused (turned off). */
  onCredentialFailure(tenant: AccountTenant, failure: { accountId: string; error: OpenCodeError }): Promise<void>;
  /**
   * When usage comes back after a limit: now when another account can take the next run, else when
   * the run's account's Go window resets; `undefined` when nobody knows (the free models).
   */
  resetsAt(tenant: AccountTenant, failure: { accountId?: string }): Promise<Date | undefined>;
  /** The account the organization's catalog is listed for (its paid models then show). */
  catalogAccount(orgId: string): Promise<OpenCodeCatalogAccount | undefined>;
  /** The account's key, for reading its usage; `undefined` when it is not an OpenCode account. */
  secret(orgId: string, accountId: string): Promise<string | undefined>;
}

export function createOpenCodeAccounts({
  credentials,
  now = () => new Date(),
  fetch: fetchImpl,
}: {
  credentials: ModelCredentialsStorage | undefined;
  now?: () => Date;
  fetch?: typeof fetch;
}): OpenCodeAccounts {
  const storage = () => getTenantCredentialsStorage(credentials);
  const listed = async (orgId: string): Promise<{ store: ModelCredentialsStorage; accounts: CredentialAccount[] } | undefined> => {
    const store = await storage();
    if (!store) return undefined;
    const accounts = (await store.listAccounts(orgId, OPENCODE_ACCOUNT_PROVIDER)).filter(account => account.kind === 'api_key');
    return { store, accounts };
  };

  const secret = async (orgId: string, accountId: string): Promise<string | undefined> => {
    const store = await storage();
    const account = store ? await store.getAccount(orgId, accountId) : undefined;
    if (!store || !account || account.provider !== OPENCODE_ACCOUNT_PROVIDER || account.kind !== 'api_key') return undefined;
    return (await store.getAccountSecret(orgId, accountId))?.trim() || undefined;
  };

  return {
    async credentials(tenant, request = { exclude: [] }) {
      const found = await listed(tenant.orgId);
      if (!found || found.accounts.length === 0) return undefined;
      const at = now();
      const picked = pickCredentialAccount(found.accounts, {
        userId: tenant.userId,
        ...(request.preferredAccountId ? { preferredId: request.preferredAccountId } : {}),
        exclude: request.exclude,
        now: at,
      });
      if (!picked.account) {
        if (picked.resetsAt) {
          throw new OpenCodeError(
            'rate_limit',
            `Every OpenCode account of this organization is out of usage; the first comes back at ${picked.resetsAt.toISOString()}.`,
            { resetsAt: picked.resetsAt },
          );
        }
        // Every account is turned off: say so rather than quietly running on the free models.
        throw new OpenCodeError('auth', 'Every OpenCode account of this organization is turned off. Give one a new key under Settings → Connections → OpenCode, or remove them to run on the free models.');
      }
      const apiKey = (await found.store.getAccountSecret(tenant.orgId, picked.account.id))?.trim();
      if (!apiKey) throw new OpenCodeError('auth', `The OpenCode account "${picked.account.label}" has no key. Give it one under Settings → Connections → OpenCode.`);
      await found.store.markAccountUsed(tenant.orgId, picked.account.id, at).catch(() => {});
      return { accountId: picked.account.id, apiKey, credential: { label: picked.account.label } };
    },

    async onCredentialFailure(tenant, { accountId, error }) {
      const store = await storage();
      if (!store) return;
      if (error.kind === 'rate_limit') {
        const until = error.resetsAt && error.resetsAt.getTime() > now().getTime() ? error.resetsAt : new Date(now().getTime() + DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS);
        await store.markAccountLimited(tenant.orgId, accountId, { until, error: error.message });
      } else if (error.kind === 'auth') {
        await store.markAccountFailed(tenant.orgId, accountId, error.message);
      } else {
        return;
      }
      console.warn('[factory] OpenCode account taken out of rotation', { orgId: tenant.orgId, accountId, kind: error.kind });
    },

    async resetsAt(tenant, { accountId }) {
      if (!accountId) return undefined;
      const found = await listed(tenant.orgId);
      if (!found) return undefined;
      const at = now();
      // Another account can take the next run now.
      const other = pickCredentialAccount(found.accounts, { userId: tenant.userId, exclude: [accountId], now: at });
      if (other.account) return at;
      const key = await secret(tenant.orgId, accountId);
      if (!key) return undefined;
      const limits = await readOpenCodeAccountLimits(key, { ...(fetchImpl ? { fetch: fetchImpl } : {}), now });
      return exhaustedUntil(limits, at);
    },

    async catalogAccount(orgId) {
      const found = await listed(orgId);
      const account = found?.accounts.find(candidate => !candidate.disabled);
      if (!found || !account) return undefined;
      const apiKey = (await found.store.getAccountSecret(orgId, account.id))?.trim();
      return apiKey ? { cacheKey: `${orgId}:${account.id}`, apiKey } : undefined;
    },

    secret,
  };
}

/** OpenCode's usage facet: an account's OpenCode Go windows, read with its key. */
export function createOpenCodeHarnessUsage(
  accounts: Pick<OpenCodeAccounts, 'secret'>,
  options: { fetch?: typeof fetch; now?: () => Date } = {},
): HarnessUsage {
  return {
    harnessId: 'opencode',
    displayName: 'OpenCode',
    accountProvider: OPENCODE_ACCOUNT_PROVIDER,
    async readAccountLimits(account): Promise<AccountUsageLimits> {
      const checkedAt = (options.now?.() ?? new Date()).toISOString();
      let key: string | undefined;
      try {
        key = await accounts.secret(account.orgId, account.accountId);
      } catch (error) {
        return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'failed', message: error instanceof Error ? error.message : String(error) } };
      }
      if (!key) return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'signed_out' } };
      return readOpenCodeAccountLimits(key, options);
    },
  };
}
