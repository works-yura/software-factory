// Contract of the run-end backstop, copied from v3 `tools/reports.ts` and `tools/deliver.ts`.
// The reporter itself delivers through Mastra notifications and moves with the harness.

export interface FactoryReportSender {
  sessionId: string;
  threadId: string;
  userId: string;
}

export type FactoryRunOutcome =
  | { status: 'done' }
  | { status: 'failed'; reason: string; failureCode?: string }
  | { status: 'blocked'; toolName?: string; approval?: boolean };

export type FactoryDeliveryResult =
  /**
   * `woken`: the target was idle and the notification started a run.
   * `mid-run`: the target was already running; it reads the notification when that run
   * next checks its inbox, not now.
   */
  | { delivered: 'woken' | 'mid-run' | 'persisted' | 'summarized'; notificationId: string; reason?: string }
  | {
      delivered: 'skipped';
      notificationId?: string;
      reason: 'thread-not-found' | 'thread-not-owned' | 'session-not-found' | 'offline' | 'discarded';
    };

/** `waiting`: the session is waiting for an answer, so a later run owes the final report. */
export interface FactoryRunEndResult {
  waiting: boolean;
  deliveries?: FactoryDeliveryResult[];
}

export interface FactoryRunEndInput {
  orgId: string;
  factoryProjectId: string;
  workItemId: string;
  role: string;
  sender: FactoryReportSender;
  since: Date;
  outcome: FactoryRunOutcome;
}

export type FactoryRunEndReporter = (input: FactoryRunEndInput) => Promise<FactoryRunEndResult>;
