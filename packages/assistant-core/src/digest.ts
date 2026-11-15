/**
 * Digests (ADR-0051 phase 3): on the person's schedule — hourly, or daily at an hour of their time
 * zone; off by default — the assistant writes one request summing up what is open. The timer is
 * the same tick loop the ClickUp poller and the retention sweep use: each tick, the owners whose
 * digest is due get theirs, one after another; each sets its own next time.
 */
import type { DigestSettings } from './types.ts';

const HOUR_MS = 60 * 60 * 1000;

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function hourIn(at: Date, timeZone: string): number {
  const text = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(at);
  return Number(text) % 24;
}

/**
 * When the next digest is due after `from`: the next full hour (hourly), or the next full hour that
 * is `hour` o'clock in `timeZone` (daily); `null` when digests are off.
 */
export function nextDigestAt(from: Date, digest: DigestSettings): Date | null {
  if (digest.frequency === 'off') return null;
  const nextHour = new Date(Math.floor(from.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
  if (digest.frequency === 'hourly') return nextHour;
  // Full hours only: every zone in use today is offset by whole or half hours, so walk hour by hour
  // (and half hour by half hour) for two days; a DST gap that skips the hour lands on the next day.
  for (let step = 0; step < 96; step += 1) {
    const candidate = new Date(nextHour.getTime() + (step * HOUR_MS) / 2);
    const minutes = Number(new Intl.DateTimeFormat('en-US', { timeZone: digest.timeZone, minute: 'numeric' }).format(candidate));
    if (minutes === 0 && hourIn(candidate, digest.timeZone) === digest.hour) return candidate;
  }
  return new Date(nextHour.getTime() + 24 * HOUR_MS);
}

export interface DigestJob {
  /** One tick now (the timer's work; tests call it directly). */
  tick(): Promise<number>;
  stop(): void;
}

/** The digest timer: every tick, the owners whose digest is due (at most `ownersPerTick`) get one. */
export function startAssistantDigests(
  service: { runDueDigests(limit: number): Promise<number> },
  options: { tickMs?: number; ownersPerTick?: number; firstTickAfterMs?: number } = {},
): DigestJob {
  let running: Promise<number> | undefined;
  const tick = async () => {
    if (running) return running;
    running = (async () => {
      try {
        return await service.runDueDigests(options.ownersPerTick ?? 20);
      } catch (error) {
        console.error('[assistant] The digest tick failed; it runs again next tick:', error instanceof Error ? error.message : error);
        return 0;
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
  const first = setTimeout(() => void tick(), options.firstTickAfterMs ?? 60_000);
  const timer = setInterval(() => void tick(), options.tickMs ?? 60_000);
  first.unref?.();
  timer.unref?.();
  return {
    tick,
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
