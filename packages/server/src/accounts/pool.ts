import { getTenantCredentialsStorage, pickCredentialAccount } from '@factory/credentials';
import { isFactoryPrincipalId } from '@factory/store';
import type { CredentialAccount, ModelCredentialsStorage, SignInCredentialKind, SignInOAuth } from '@factory/store';

/** Who a turn runs for: the organization whose sign-in pays, and the session's owner. */
export interface AccountTenant {
  orgId: string;
  userId: string;
}

/** What a turn asks the pool (the harnesses' credential request). */
export interface AccountRequest {
  /** The account the session used last; staying on it keeps the provider's prompt cache. */
  preferredAccountId?: string;
  /** Accounts this turn already tried and lost to a limit or a refusal. */
  exclude: string[];
}

/** One sign-in picked for a turn: its fresh OAuth pair (the server's), and how the chat names it. */
export interface PickedSignIn {
  accountId: string;
  oauth: SignInOAuth;
  credential: { label: string; ownerId?: string };
}

/** Why a turn's account stopped: out of usage (until `resetsAt`, when known) or refused. */
export interface AccountFailure {
  accountId: string;
  error: { kind: string; message: string; resetsAt?: Date };
}

/** Why a card's run, which belongs to the Factory, cannot start: no sign-in is shared with the Factory's runs. */
export function factoryRunsNeedSharedSignIn(name: string): string {
  return `This Factory runs its cards as the Factory, and no ${name} sign-in is shared with its card runs. Under Settings → Connections, open a ${name} account and turn on "Runs Factory cards", then retry.`;
}

/** How long an account sits out when the provider gave no reset time. */
export const DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS = 60 * 60_000;

export interface SignInAccountPoolOptions {
  credentials: ModelCredentialsStorage | undefined;
  /** The provider the accounts are filed under (`anthropic`, `openai-codex`). */
  provider: string;
  /** The only kind a turn runs on; pasted tokens and keys from before are never used. */
  kind: SignInCredentialKind;
  /** Whether the pair can run a turn as it is; otherwise it is refreshed first. */
  isFresh(oauth: SignInOAuth, now: number): boolean;
  /** Exchange the refresh token; throws {@link SignInOAuthRefusal} when the sign-in is gone for good. */
  refresh(oauth: SignInOAuth, now: () => number): Promise<SignInOAuth>;
  /** Tells a refused sign-in (`invalid_grant`, revoked) from a refresh that failed for now. */
  isRefusal(error: unknown): error is Error;
  /** The errors a turn ends with: every account limited, none other left, none at all. */
  errors: {
    limited(resetsAt: Date, now: Date): Error;
    noOther(): Error;
    missing(orgId: string): Error;
  };
  /** How the logs name the provider ("Claude", "Codex"). */
  name: string;
  now?: () => Date;
}

export interface SignInAccountPool {
  /** A fresh sign-in for the turn (see {@link pickCredentialAccount} for which), refreshed first when due. */
  pick(tenant: AccountTenant, request?: AccountRequest): Promise<PickedSignIn>;
  /**
   * The account's pair after the provider refused `staleAccessToken` mid-run: refreshed under the
   * row lock unless another turn already did. `undefined` when the sign-in was refused (turned off).
   */
  refreshAfterRefusal(tenant: AccountTenant, accountId: string, staleAccessToken: string): Promise<SignInOAuth | undefined>;
  /** A turn's account ran out of usage (it sits out until it resets) or was refused (turned off). */
  onFailure(tenant: AccountTenant, failure: AccountFailure): Promise<void>;
  /** Whether a turn of this person could run now or after a reset: an enabled sign-in it may use. */
  usable(tenant: AccountTenant): Promise<boolean>;
  /**
   * The account's sign-in, refreshed first when due, for a read on the account's behalf (its usage);
   * `undefined` when it is not one of the pool's sign-ins or the token endpoint refused it.
   */
  signIn(orgId: string, accountId: string): Promise<SignInOAuth | undefined>;
}

/**
 * The sign-ins a turn-based harness runs on, harness-agnostic on purpose (Claude Code's
 * `claude_login`s, Codex's `codex_login`s):
 *
 * - Only the pool's kind runs: the turn gets one of its owner's sign-ins (see
 *   `pickCredentialAccount` for which), and one that runs out of usage sits out until it resets
 *   while the turn goes on with the next.
 * - A sign-in is refreshed here first when `isFresh` says it is due, under the account row's lock;
 *   a sign-in the token endpoint refuses is turned off with a message asking for a new sign-in,
 *   and the turn goes on with the next one.
 * - With no sign-in the turn may use, it fails asking for one; when every one is out of usage, it
 *   fails with the `limited` error that says when the first comes back.
 */
export function createSignInAccountPool(options: SignInAccountPoolOptions): SignInAccountPool {
  const now = options.now ?? (() => new Date());
  const clock = () => now().getTime();

  /** The sign-in's pair, refreshed first when due; `undefined` when the sign-in was refused. */
  const freshPair = async (
    storage: ModelCredentialsStorage,
    orgId: string,
    accountId: string,
    isFresh: (current: SignInOAuth) => boolean,
  ): Promise<SignInOAuth | undefined> => {
    try {
      return await storage.refreshAccountOAuth(orgId, accountId, { isFresh, refresh: current => options.refresh(current, clock) });
    } catch (error) {
      if (!options.isRefusal(error)) throw error;
      await storage.markAccountFailed(orgId, accountId, error.message);
      console.warn(`[factory] ${options.name} sign-in refused by the token endpoint; it needs a new sign-in`, { orgId, accountId });
      return undefined;
    }
  };

  const listed = async (storage: ModelCredentialsStorage | undefined, orgId: string): Promise<CredentialAccount[]> =>
    storage ? (await storage.listAccounts(orgId, options.provider)).filter(account => account.kind === options.kind) : [];

  return {
    async pick(tenant, request = { exclude: [] }) {
      const storage = await getTenantCredentialsStorage(options.credentials);
      // Sign-ins refused while picking: skipped like accounts the turn already tried, but not counted as tried.
      const refused: string[] = [];
      for (;;) {
        const accounts = await listed(storage, tenant.orgId);
        const at = now();
        const picked = pickCredentialAccount(accounts, {
          userId: tenant.userId,
          ...(request.preferredAccountId ? { preferredId: request.preferredAccountId } : {}),
          exclude: [...request.exclude, ...refused],
          now: at,
        });
        if (!picked.account) {
          if (picked.resetsAt) throw options.errors.limited(picked.resetsAt, at);
          if (request.exclude.length > 0 || refused.length > 0) throw options.errors.noOther();
          // A card's run belongs to the Factory: it runs only on sign-ins their owners shared with it.
          if (isFactoryPrincipalId(tenant.userId)) throw new Error(factoryRunsNeedSharedSignIn(options.name));
          throw options.errors.missing(tenant.orgId);
        }
        const { account } = picked;
        // A sign-in was picked from the storage's own listing, so the storage is there.
        const oauth = await freshPair(storage!, tenant.orgId, account.id, current => options.isFresh(current, clock()));
        if (oauth === undefined) {
          refused.push(account.id);
          continue;
        }
        await storage!.markAccountUsed(tenant.orgId, account.id, at).catch(() => {});
        return {
          accountId: account.id,
          oauth,
          credential: { label: account.label, ...(account.ownerUserId ? { ownerId: account.ownerUserId } : {}) },
        };
      }
    },

    async refreshAfterRefusal(tenant, accountId, staleAccessToken) {
      const storage = await getTenantCredentialsStorage(options.credentials);
      if (!storage) return undefined;
      // Another turn refreshed it already when the stored token is no longer the refused one.
      return freshPair(storage, tenant.orgId, accountId, current => current.accessToken !== staleAccessToken && options.isFresh(current, clock()));
    },

    async onFailure(tenant, { accountId, error }) {
      const storage = await getTenantCredentialsStorage(options.credentials);
      if (!storage) return;
      if (error.kind === 'rate_limit') {
        const until = error.resetsAt ?? new Date(clock() + DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS);
        await storage.markAccountLimited(tenant.orgId, accountId, { until, error: error.message });
      } else if (error.kind === 'auth') {
        await storage.markAccountFailed(tenant.orgId, accountId, error.message);
      } else {
        return;
      }
      console.warn(`[factory] ${options.name} account taken out of rotation`, {
        orgId: tenant.orgId,
        accountId,
        kind: error.kind,
        ...(error.resetsAt ? { resetsAt: error.resetsAt.toISOString() } : {}),
      });
    },

    async signIn(orgId, accountId) {
      const storage = await getTenantCredentialsStorage(options.credentials);
      if (!storage) return undefined;
      const account = await storage.getAccount(orgId, accountId);
      if (!account || account.provider !== options.provider || account.kind !== options.kind) return undefined;
      return freshPair(storage, orgId, accountId, current => options.isFresh(current, clock()));
    },

    async usable(tenant) {
      const storage = await getTenantCredentialsStorage(options.credentials);
      const accounts = await listed(storage, tenant.orgId);
      const picked = pickCredentialAccount(accounts, { userId: tenant.userId, now: now() });
      return picked.account !== undefined || picked.resetsAt !== undefined;
    },
  };
}
