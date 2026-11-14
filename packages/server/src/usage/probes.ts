/**
 * What the sign-in harnesses' usage facets share (`../claude/usage.ts`, `../codex/usage.ts`): how
 * much of a sign-in's allowance is used now, read from the provider with the sign-in's own access
 * token. They read what the CLIs' own usage views read; nothing here spends usage.
 */
import type { AccountUsageLimits } from '@factory/harness/usage';
import type { SignInOAuth } from '@factory/store';

const PROBE_TIMEOUT_MS = 10_000;

export interface UsageProbeOptions {
  /** The account's sign-in, refreshed when due (the harness's credentials' `signIn`). */
  signIn(orgId: string, accountId: string): Promise<SignInOAuth | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function failed(checkedAt: string, message: string): AccountUsageLimits {
  return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'failed', message } };
}

export async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, message: `The provider answered HTTP ${response.status}.` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function probe(
  options: UsageProbeOptions,
  account: { orgId: string; accountId: string },
  read: (oauth: SignInOAuth, checkedAt: string, fetchImpl: typeof fetch) => Promise<AccountUsageLimits>,
): Promise<AccountUsageLimits> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  let oauth: SignInOAuth | undefined;
  try {
    oauth = await options.signIn(account.orgId, account.accountId);
  } catch (error) {
    return failed(checkedAt, error instanceof Error ? error.message : String(error));
  }
  if (!oauth) return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'signed_out' } };
  return read(oauth, checkedAt, options.fetch ?? fetch);
}

