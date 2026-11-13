/**
 * Which sandboxes go to sleep (ADR-0039): every awake sandbox idle longer
 * than `idleMs`, then, while more than `maxActive` stay awake, the ones idle
 * longest. A sandbox where an agent works is never chosen, nor one with work
 * seen within `graceMs` (another replica's run, a setup just starting). Pure,
 * so the rule is tested on its own.
 */

export interface SleepPolicy {
  /** At most this many sandboxes stay awake (on disk). */
  maxActive: number;
  /** An awake sandbox without work for this long sleeps. */
  idleMs: number;
}

export const DEFAULT_SLEEP_POLICY: SleepPolicy = { maxActive: 5, idleMs: 2 * 60 * 60_000 };

export interface SleepCandidate {
  key: string;
  /** An agent runs in it, or its setup is under way. */
  active: boolean;
  lastActivityAt: number;
}

export interface SleepChoice {
  sleep: Array<{ key: string; reason: 'idle' | 'limit' }>;
  /** Still over the limit after choosing: every remaining sandbox is active. */
  overLimit: number;
}

export function chooseSandboxesToSleep(
  candidates: readonly SleepCandidate[],
  policy: SleepPolicy,
  { now, graceMs }: { now: number; graceMs: number },
): SleepChoice {
  const resting = (candidate: SleepCandidate) => !candidate.active && now - candidate.lastActivityAt >= graceMs;
  const sleep: SleepChoice['sleep'] = [];
  const chosen = new Set<string>();
  for (const candidate of candidates) {
    if (resting(candidate) && now - candidate.lastActivityAt >= policy.idleMs) {
      sleep.push({ key: candidate.key, reason: 'idle' });
      chosen.add(candidate.key);
    }
  }
  let awake = candidates.length - chosen.size;
  const longestIdleFirst = candidates
    .filter(candidate => !chosen.has(candidate.key) && resting(candidate))
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt || a.key.localeCompare(b.key));
  for (const candidate of longestIdleFirst) {
    if (awake <= policy.maxActive) break;
    sleep.push({ key: candidate.key, reason: 'limit' });
    awake--;
  }
  return { sleep, overLimit: Math.max(0, awake - policy.maxActive) };
}
