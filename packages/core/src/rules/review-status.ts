/** A Factory review run's progress, as the dispatcher reports it to the pull request's status comment. */

export type FactoryReviewStatusPhase = 'queued' | 'reviewing' | 'retrying' | 'completed' | 'failed' | 'cancelled';

/** One step of a review run, identified by the decision that started it. */
export interface FactoryReviewStatusEvent {
  orgId: string;
  factoryProjectId: string;
  workItemId: string;
  run: string;
  requestedAt: Date;
  generation: number;
  attempt: number;
  phase: FactoryReviewStatusPhase;
  /** When the agent was handed the review; set on the 'reviewing' step. */
  startedAt?: Date;
  /** When the run ended; set on final steps. */
  endedAt?: Date;
  /** Why the run failed or will retry, already sanitized. */
  reason?: string;
  /** A final step for a run an earlier attempt started: the comment's recorded start still applies. */
  replayed?: true;
}

export type FactoryReviewStatusReporter = (event: FactoryReviewStatusEvent) => Promise<void>;
