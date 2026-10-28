/**
 * Which of an organization's credential accounts a run uses.
 *
 * Rules, in order:
 * 1. Disabled accounts, accounts the run already tried, and accounts out of
 *    usage (`limitedUntil` in the future) are skipped.
 * 2. A subscription is used only by its owner's runs; organization API keys by
 *    any run.
 * 3. The account the session used last goes first while it is usable, so the
 *    provider's prompt cache keeps working; then the caller's own
 *    subscriptions; then organization keys; each by priority, then age.
 *
 * When nothing is usable because every candidate is out of usage, the earliest
 * reset tells the caller when to try again.
 */

import type { CredentialAccount, CredentialAccountKind } from '@factory/store';

/** `claude setup-token` and subscription OAuth tokens start with this; API keys with `sk-ant-api`. */
export const ANTHROPIC_SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat';

/** What a pasted Anthropic secret is: a subscription token or an API key. */
export function anthropicSecretKind(secret: string): CredentialAccountKind {
  return secret.trim().startsWith(ANTHROPIC_SUBSCRIPTION_TOKEN_PREFIX) ? 'subscription' : 'api_key';
}

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

export function usableBy(account: CredentialAccount, userId: string): boolean {
  return account.kind === 'api_key' || account.ownerUserId === userId;
}

export function pickCredentialAccount(
  accounts: readonly CredentialAccount[],
  { userId, preferredId, exclude = [], now = new Date() }: PickCredentialAccountInput,
): PickedCredentialAccount {
  const excluded = new Set(exclude);
  const eligible = accounts.filter(account => !account.disabled && usableBy(account, userId));
  const ready = eligible.filter(account => !excluded.has(account.id)).filter(account => !account.limitedUntil || account.limitedUntil.getTime() <= now.getTime());
  const rank = (account: CredentialAccount) =>
    account.id === preferredId ? 0 : account.kind === 'subscription' ? 1 : 2;
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
