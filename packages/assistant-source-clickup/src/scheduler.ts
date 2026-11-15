/**
 * The ClickUp poller (ADR-0051 phase 2): every tick, the people whose connection is due are polled,
 * one after another, at most `ownersPerTick` of them. Only people with an active connection are
 * ever due; a disconnected or erased person has no row and so is never polled again. Each poll
 * sets its own next time (the interval, or a backoff after failures, or ClickUp's rate-limit reset).
 */
import type { AssistantOwner } from '@factory/assistant-core';

import type { PollResult } from './source.ts';

export interface PollingSource {
  due(limit: number): Promise<AssistantOwner[]>;
  poll(owner: AssistantOwner): Promise<PollResult>;
}

export interface ClickUpPolling {
  /** One tick now (the timer's work; tests call it directly). */
  tick(): Promise<number>;
  stop(): void;
}

export function startClickUpPolling(
  source: PollingSource,
  options: { tickMs?: number; ownersPerTick?: number; firstTickAfterMs?: number } = {},
): ClickUpPolling {
  let running: Promise<number> | undefined;
  let stopped = false;
  const tick = async () => {
    if (running) return running;
    running = (async () => {
      let polled = 0;
      try {
        for (const owner of await source.due(options.ownersPerTick ?? 20)) {
          if (stopped) break;
          await source.poll(owner);
          polled += 1;
        }
      } catch (error) {
        console.error('[assistant] The ClickUp poller tick failed; it runs again next tick:', error instanceof Error ? error.message : error);
      } finally {
        running = undefined;
      }
      return polled;
    })();
    return running;
  };
  const first = setTimeout(() => void tick(), options.firstTickAfterMs ?? 30_000);
  const timer = setInterval(() => void tick(), options.tickMs ?? 30_000);
  first.unref?.();
  timer.unref?.();
  return {
    tick,
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
