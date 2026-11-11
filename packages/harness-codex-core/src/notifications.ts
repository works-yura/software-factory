import type { NotificationRecord } from '@factory/harness/transcript';

/** How a notification reaches the agent, in the shape Mastra's delivery policy answers. */
export type CodexNotificationDecision =
  | { action: 'deliver'; reason: string }
  | { action: 'summarize'; summaryAt: Date; deliverAt?: Date; reason: string };

/**
 * Mastra's default notification delivery policy, which every Mastra Factory session uses (and a
 * Claude Code session follows too): urgent is delivered at once; high is delivered to an idle
 * thread and, while a run is active, delivered in full once the run ends; medium is delivered to an
 * idle thread and held while active; low is always held for the next run.
 */
export function codexNotificationDecision(input: {
  record: Pick<NotificationRecord, 'priority'>;
  threadState: 'active' | 'idle';
  now: Date;
}): CodexNotificationDecision {
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
