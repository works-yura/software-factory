/**
 * Picking up after a server restart (ADR-0051): once per server start, a little after the server is
 * ready (the model catalog must be there to run turns), `AssistantService.resumeAfterRestart` runs
 * with this start's id. Like a Factory session's `resume_failed` handoff, nothing new is stored to
 * make it work: the requests, threads and the agent's memory already are; what died with the
 * process (a turn in flight, the wait for a Factory's answer) is read back from them.
 */
import { randomUUID } from 'node:crypto';

import type { AssistantService } from './service.ts';

export interface ResumeJob {
  /** This server start's id (`resumed:<bootId>` in the threads it picked up). */
  readonly bootId: string;
  /** Runs the pick-up now (at most once per job; a second call gets the first one's result). */
  run(): Promise<number>;
  stop(): void;
}

export function startAssistantResume(
  service: Pick<AssistantService, 'resumeAfterRestart'>,
  options: { afterMs?: number; bootId?: string } = {},
): ResumeJob {
  const bootId = options.bootId ?? randomUUID();
  let running: Promise<number> | undefined;
  const run = () => {
    running ??= service.resumeAfterRestart(bootId).then(
      outcomes => {
        const picked = outcomes.filter(entry => entry.outcome !== 'already');
        if (picked.length) {
          const counts = new Map<string, number>();
          for (const entry of picked) counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
          console.info(`[assistant] After the restart: ${[...counts].map(([outcome, count]) => `${outcome} ${count}`).join(', ')}.`);
        }
        return picked.length;
      },
      error => {
        console.error('[assistant] Picking up after the restart failed:', error instanceof Error ? error.message : error);
        return 0;
      },
    );
    return running;
  };
  const timer = setTimeout(() => void run(), options.afterMs ?? 15_000);
  timer.unref?.();
  return {
    bootId,
    run,
    stop() {
      clearTimeout(timer);
    },
  };
}
