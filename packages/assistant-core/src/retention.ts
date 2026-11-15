/**
 * The daily retention sweep (ADR-0051): closed requests older than their owner's retention go,
 * with their threads, memory and files. One sweep at a time; a failed sweep is logged loudly and
 * the next day's runs again.
 */
import type { AssistantService } from './service.ts';

export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RetentionJob {
  /** Runs one sweep now (the timer's work; tests call it directly). */
  runOnce(): Promise<void>;
  stop(): void;
}

export function startAssistantRetention(
  service: Pick<AssistantService, 'sweepRetention'>,
  options: { intervalMs?: number; firstRunAfterMs?: number } = {},
): RetentionJob {
  let running: Promise<void> | undefined;
  const runOnce = async () => {
    if (running) return running;
    running = (async () => {
      try {
        const swept = await service.sweepRetention();
        if (swept.requests > 0) {
          console.info(`[assistant] Retention erased ${swept.requests} closed request(s) and ${swept.files} file(s).`);
        }
      } catch (error) {
        console.error('[assistant] The retention sweep failed; it runs again tomorrow:', error);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
  const interval = options.intervalMs ?? RETENTION_INTERVAL_MS;
  const first = setTimeout(() => void runOnce(), options.firstRunAfterMs ?? 5 * 60 * 1000);
  const timer = setInterval(() => void runOnce(), interval);
  first.unref?.();
  timer.unref?.();
  return {
    runOnce,
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
