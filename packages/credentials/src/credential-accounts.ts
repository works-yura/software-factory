/**
 * Which of an organization's credential accounts a run uses.
 *
 * Rules, in order:
 * 1. Disabled accounts, accounts the run already tried, and accounts out of
 *    usage (`limitedUntil` in the future) are skipped.
 * 2. A subscription or Claude sign-in is used only by its owner's runs, and by
 *    the Factory's card runs when its owner shared it with them; organization
 *    API keys by any run.
 * 3. The account the session used last goes first while it is usable, so the
 *    provider's prompt cache keeps working; then the caller's own
 *    subscriptions and sign-ins; then organization keys; each by priority, then age.
 *
 * When nothing is usable because every candidate is out of usage, the earliest
 * reset tells the caller when to try again.
 */

import { isFactoryPrincipalId, isPersonalCredentialKind } from '@factory/store';
import type { CredentialAccount } from '@factory/store';

export interface PickCredentialAccountInput {
  /** The person the run works for. */
  userId: string;
  /** The account the session used last. */
  preferredId?: string;
  /** Accounts this turn already tried. */
  exclude?: readonly string[];
  now?: Date;
}

export type PickedCredentialAccount =
  | { account: CredentialAccount }
  | {
      account?: undefined;
      /** Every account this run may use is out of usage; the earliest comes back then. */
      resetsAt?: Date;
      /** Whether the run may use any account at all, limited or not. */
      hasCandidates: boolean;
    };

/**
 * Organization API keys serve every run. A sign-in serves its owner's runs, and a run the
 * Factory owns (`factoryPrincipalId`) only when its owner shared it with the Factory's card
 * runs: the Factory never borrows a person's sign-in on its own.
 */
export function usableBy(account: CredentialAccount, userId: string): boolean {
  if (account.kind === 'api_key') return true;
  if (isFactoryPrincipalId(userId)) return account.factoryRuns;
  return account.ownerUserId === userId;
}

export function pickCredentialAccount(
  accounts: readonly CredentialAccount[],
  { userId, preferredId, exclude = [], now = new Date() }: PickCredentialAccountInput,
): PickedCredentialAccount {
  const excluded = new Set(exclude);
  const eligible = accounts.filter(account => !account.disabled && usableBy(account, userId));
  const ready = eligible.filter(account => !excluded.has(account.id)).filter(account => !account.limitedUntil || account.limitedUntil.getTime() <= now.getTime());
  const rank = (account: CredentialAccount) =>
    account.id === preferredId ? 0 : isPersonalCredentialKind(account.kind) ? 1 : 2;
  const [best] = [...ready].sort(
    (a, b) =>
      rank(a) - rank(b) || a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  if (best) return { account: best };
  // Tried accounts count too: the one that just ran out may be the first to come back.
  const resets = eligible.flatMap(account =>
    account.limitedUntil && account.limitedUntil.getTime() > now.getTime() ? [account.limitedUntil.getTime()] : [],
  );
  return {
    hasCandidates: eligible.length > 0,
    ...(resets.length ? { resetsAt: new Date(Math.min(...resets)) } : {}),
  };
}
