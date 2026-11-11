/**
 * The usage facets of the turn harnesses: how much of a Claude or ChatGPT sign-in's allowance is
 * used now, read from the provider with the sign-in's own access token. They read what the CLIs'
 * own usage views read (Claude Code's `/usage`, Codex's `/status`); nothing here spends usage.
 */
import { claudeOAuthUsageToLimits } from '@factory/harness-claude-code';
import { codexRateLimitsToWindows } from '@factory/harness-codex';
import type { RateLimitSnapshot } from '@factory/harness-codex';
import type { AccountUsageLimits, HarnessUsage } from '@factory/harness/usage';
import type { SignInOAuth } from '@factory/store';

/** The Claude usage endpoint the CLI's `/usage` reads with its sign-in. */
export const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** The ChatGPT backend's usage endpoint Codex reads with its sign-in. */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const PROBE_TIMEOUT_MS = 10_000;

export interface UsageProbeOptions {
  /** The account's sign-in, refreshed when due (the harness's credentials' `signIn`). */
  signIn(orgId: string, accountId: string): Promise<SignInOAuth | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
}

function failed(checkedAt: string, message: string): AccountUsageLimits {
  return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'failed', message } };
}

async function getJson(
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

async function probe(
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

/** Claude Code's accounts: Claude sign-ins, whose 5-hour, weekly and model windows the usage endpoint reports. */
export function createClaudeHarnessUsage(options: UsageProbeOptions): HarnessUsage {
  return {
    harnessId: 'claude-code',
    displayName: 'Claude Code',
    accountProvider: 'anthropic',
    readAccountLimits: account =>
      probe(options, account, async (oauth, checkedAt, fetchImpl) => {
        const answer = await getJson(fetchImpl, CLAUDE_OAUTH_USAGE_URL, {
          authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          accept: 'application/json',
        });
        return answer.ok ? claudeOAuthUsageToLimits(answer.body, checkedAt) : failed(checkedAt, answer.message);
      }),
  };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A `wham/usage` window (`used_percent`, `limit_window_seconds`, `reset_at` or `reset_after_seconds`) as Codex's own. */
function whamWindow(value: unknown, now: Date): RateLimitSnapshot['primary'] {
  const window = record(value);
  const usedPercent = finite(window?.used_percent);
  if (!window || usedPercent === undefined) return null;
  const seconds = finite(window.limit_window_seconds);
  const resetAfter = finite(window.reset_after_seconds);
  const resetsAt = finite(window.reset_at) ?? (resetAfter !== undefined ? Math.round(now.getTime() / 1000 + resetAfter) : undefined);
  return {
    usedPercent,
    ...(seconds !== undefined ? { windowDurationMins: Math.round(seconds / 60) } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/** The ChatGPT backend's usage answer as Codex's own rate-limit snapshot. */
export function codexWhamUsageToLimits(body: unknown, checkedAt: string): AccountUsageLimits {
  const usage = record(body);
  const rateLimit = record(usage?.rate_limit);
  if (!usage || !rateLimit) return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'unsupported' } };
  const now = new Date(checkedAt);
  const snapshot: RateLimitSnapshot = {
    limitId: 'codex',
    planType: typeof usage.plan_type === 'string' ? usage.plan_type : null,
    primary: whamWindow(rateLimit.primary_window, now),
    secondary: whamWindow(rateLimit.secondary_window, now),
  };
  const windows = codexRateLimitsToWindows(snapshot).map(({ label, ...window }) => {
    void label;
    return window;
  });
  return windows.length > 0
    ? { checkedAt, windows, source: 'probe' }
    : { checkedAt, windows, source: 'probe', unavailable: { reason: 'unsupported' } };
}

/** Codex's accounts: ChatGPT sign-ins, whose session and weekly windows the backend reports. */
export function createCodexHarnessUsage(options: UsageProbeOptions): HarnessUsage {
  return {
    harnessId: 'codex',
    displayName: 'Codex',
    accountProvider: 'openai-codex',
    readAccountLimits: account =>
      probe(options, account, async (oauth, checkedAt, fetchImpl) => {
        const answer = await getJson(fetchImpl, CODEX_USAGE_URL, {
          authorization: `Bearer ${oauth.accessToken}`,
          ...(oauth.workspaceId ? { 'chatgpt-account-id': oauth.workspaceId } : {}),
          accept: 'application/json',
        });
        return answer.ok ? codexWhamUsageToLimits(answer.body, checkedAt) : failed(checkedAt, answer.message);
      }),
  };
}
