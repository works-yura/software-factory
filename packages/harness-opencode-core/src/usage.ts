// An OpenCode account's allowance, as the Factory's usage views read every harness's: OpenCode Go's
// rolling 5-hour, weekly and monthly windows, from the endpoint OpenCode's own clients read with the
// account's key. A key without a Go subscription (Zen alone, pay as you go) has no windows. The free
// models report none at all: they say only that their allowance ran out (ADR-0043).
import type { AccountUsageLimits, UsageWindow } from '@factory/harness/usage';
import { clampPercent, isoFromString } from '@factory/harness/usage';

/** OpenCode Go's usage endpoint, read with the account's key (`Authorization: Bearer`). */
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function goWindow(value: unknown, window: Pick<UsageWindow, 'id' | 'kind'> & { windowDurationMins?: number }): UsageWindow | undefined {
  const raw = record(value);
  const percent = raw?.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined;
  const resetsAt = isoFromString(raw?.resetsAt);
  return {
    ...window,
    usedPercent: clampPercent(percent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** The Go usage answer (`{ usage: { rolling, weekly, monthly } }`) as allowance windows. */
export function openCodeGoUsageToLimits(body: unknown, checkedAt: string): AccountUsageLimits {
  const usage = record(record(body)?.usage);
  const windows = [
    goWindow(usage?.rolling, { id: 'go_rolling', kind: 'session', windowDurationMins: 5 * 60 }),
    goWindow(usage?.weekly, { id: 'go_weekly', kind: 'weekly', windowDurationMins: 7 * 24 * 60 }),
    goWindow(usage?.monthly, { id: 'go_monthly', kind: 'monthly' }),
  ].filter((window): window is UsageWindow => window !== undefined);
  // The key has Go (no 403), yet nothing reads as a window: the answer is broken, not "no Go".
  return windows.length > 0
    ? { checkedAt, windows, source: 'probe' }
    : { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'failed', message: 'OpenCode answered with no usage windows it could read.' } };
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Reads an OpenCode account's Go windows now. 403: the key is good but has no Go subscription
 * (`unsupported`); 401: the key is refused (`signed_out`); anything else that fails is `failed`.
 */
export async function readOpenCodeAccountLimits(
  apiKey: string,
  { fetch: fetchImpl = fetch, now = () => new Date() }: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<AccountUsageLimits> {
  const checkedAt = now().toISOString();
  let response: Response;
  try {
    response = await fetchImpl(OPENCODE_GO_USAGE_URL, {
      headers: { authorization: `Bearer ${apiKey.trim()}`, accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'failed', message: error instanceof Error ? error.message : String(error) } };
  }
  if (response.status === 403) {
    return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'unsupported', message: 'This OpenCode account has no OpenCode Go subscription, so it has no usage windows.' } };
  }
  if (response.status === 401) {
    return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'signed_out', message: 'OpenCode refused this account key.' } };
  }
  if (!response.ok) {
    return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'failed', message: `OpenCode answered HTTP ${response.status}.` } };
  }
  try {
    return openCodeGoUsageToLimits(await response.json(), checkedAt);
  } catch (error) {
    return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'failed', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** When a used-up window comes back: the latest reset among windows at their limit, if any is. */
export function exhaustedUntil(limits: AccountUsageLimits, now = new Date()): Date | undefined {
  const resets = limits.windows
    .filter(window => window.usedPercent >= 100 && window.resetsAt)
    .map(window => Date.parse(window.resetsAt!))
    .filter(at => Number.isFinite(at) && at > now.getTime());
  return resets.length > 0 ? new Date(Math.max(...resets)) : undefined;
}
