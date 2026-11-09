import type { ClaudeNotificationRecord } from './events.ts';

/** How a notification reaches the agent, in the shape Mastra's delivery policy answers. */
export type ClaudeNotificationDecision =
  | { action: 'deliver'; reason: string }
  | { action: 'summarize'; summaryAt: Date; deliverAt?: Date; reason: string };

/**
 * Mastra's default notification delivery policy (`defaultNotificationDeliveryDecision`
 * in `@mastra/core/notifications`), which every Mastra Factory session uses:
 * urgent is delivered at once; high is delivered to an idle thread and, while
 * a run is active, summarized now and delivered in full once the run ends;
 * medium is delivered to an idle thread and summarized while active; low is
 * always summarized. Copied rather than imported so this harness stays free
 * of Mastra; a parity test in the UI package holds the two together.
 */
export function claudeNotificationDecision(input: {
  record: Pick<ClaudeNotificationRecord, 'priority'>;
  threadState: 'active' | 'idle';
  now: Date;
}): ClaudeNotificationDecision {
  const { record, threadState, now } = input;
  if (record.priority === 'urgent') return { action: 'deliver', reason: 'urgent' };
  if (record.priority === 'high') {
    return threadState === 'active'
      ? { action: 'summarize', summaryAt: now, deliverAt: now, reason: 'active-high-summary-then-full' }
      : { action: 'deliver', reason: 'idle-high' };
  }
  if (record.priority === 'medium') {
    return threadState === 'active'
      ? { action: 'summarize', summaryAt: now, reason: 'active-batch-summary' }
      : { action: 'deliver', reason: 'idle-medium' };
  }
  return { action: 'summarize', summaryAt: now, reason: threadState === 'active' ? 'active-batch-summary' : 'idle-low-summary' };
}
