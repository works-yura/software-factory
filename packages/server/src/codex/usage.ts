/**
 * Codex's usage facet: how much of a ChatGPT sign-in's allowance is used now, as the CLI's own
 * `/status` reads it, with the sign-in's own access token.
 */
import { codexRateLimitsToWindows } from '@factory/harness-codex';
import type { RateLimitSnapshot } from '@factory/harness-codex';
import type { AccountUsageLimits, HarnessUsage } from '@factory/harness/usage';

import { failed, getJson, probe } from '../usage/probes.ts';
import type { UsageProbeOptions } from '../usage/probes.ts';

/** The ChatGPT backend's usage endpoint Codex reads with its sign-in. */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

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
