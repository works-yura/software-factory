import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it } from 'vitest';

import { WorkItemsStorage } from './base.js';
import type { FactoryDeferredDecisionRecord, FactoryPendingStartRecord } from './base.js';

const SCOPE = { orgId: 'org1', factoryProjectId: 'p1' };
const NOW = new Date('2030-01-01T00:00:00.000Z');
const LEASE = { ownerId: 'worker-1', now: NOW, leaseExpiresAt: new Date(NOW.getTime() + 30_000), limit: 1 };
const HOUR = 60 * 60_000;

async function makeStorage() {
  const backend = new LibSQLFactoryStorage({ id: `usage-limit-waits-${Math.random()}`, url: ':memory:' });
  const storage = backend.registerDomain(new WorkItemsStorage());
  await backend.init();
  return storage;
}

async function queueRun(storage: WorkItemsStorage): Promise<void> {
  const { item } = await storage.upsert({
    ...SCOPE,
    userId: 'u',
    input: { title: 'Fix login', stages: ['intake'], sessions: {}, metadata: {} },
  });
  await storage.commitRuleEvaluation({
    ...SCOPE,
    workItemId: item.id,
    ingress: { identity: 'run', triggerType: 'test' },
    configVersion: 'rules-v1',
    expectedRevision: item.revision,
    actor: { type: 'system', id: 'rules' },
    outcome: { status: 'accepted' },
    decisions: [{ type: 'invokeSkill', role: 'triage', skillName: 'factory-triage', idempotencyKey: 'run' }],
    causalChain: [],
    now: NOW,
  });
}

async function claimAt(storage: WorkItemsStorage, now: Date): Promise<FactoryDeferredDecisionRecord | undefined> {
  const [claimed] = await storage.claimDeferredDecisions({
    ...LEASE,
    now,
    leaseExpiresAt: new Date(now.getTime() + 30_000),
  });
  return claimed;
}

function leaseOf(record: { id: string; orgId: string; factoryProjectId: string }) {
  return { id: record.id, orgId: record.orgId, factoryProjectId: record.factoryProjectId, ownerId: 'worker-1' };
}

describe('waiting out a model usage limit', () => {
  it('hands a decision back until the reset without spending its attempt, and keeps when the waits began', async () => {
    const storage = await makeStorage();
    await queueRun(storage);
    const claimed = (await claimAt(storage, NOW))!;
    expect(claimed.attempts).toBe(1);

    const resumeAt = new Date(NOW.getTime() + 5 * HOUR);
    const waiting = await storage.waitDeferredDecisionForUsageReset({
      ...leaseOf(claimed),
      now: NOW,
      availableAt: resumeAt,
      lastError: 'Every Claude account this run may use is out of usage.',
      advanceDeliveryGeneration: true,
    });

    expect(waiting).toMatchObject({
      status: 'retry',
      attempts: 0,
      failureCode: 'run_usage_limited',
      lastError: 'Every Claude account this run may use is out of usage.',
      deliveryGeneration: claimed.deliveryGeneration + 1,
      usageWaits: 1,
      usageLimitedSince: NOW,
      completedAt: null,
    });
    expect(waiting?.availableAt.getTime()).toBe(resumeAt.getTime());
    // Not before the reset.
    expect(await claimAt(storage, new Date(resumeAt.getTime() - 1))).toBeUndefined();

    const again = (await claimAt(storage, resumeAt))!;
    expect(again).toMatchObject({ attempts: 1, usageWaits: 1 });
    const later = new Date(resumeAt.getTime() + HOUR);
    const waitingAgain = await storage.waitDeferredDecisionForUsageReset({
      ...leaseOf(again),
      now: resumeAt,
      availableAt: later,
      lastError: 'still out',
      advanceDeliveryGeneration: false,
    });
    // The first limit still dates the waits; an attempt that never took its kickoff keeps its id.
    expect(waitingAgain).toMatchObject({
      usageWaits: 2,
      usageLimitedSince: NOW,
      deliveryGeneration: again.deliveryGeneration,
      attempts: 0,
    });
  });

  it('starts counting the waits afresh after any other outcome', async () => {
    const storage = await makeStorage();
    await queueRun(storage);
    const claimed = (await claimAt(storage, NOW))!;
    await storage.waitDeferredDecisionForUsageReset({
      ...leaseOf(claimed),
      now: NOW,
      availableAt: NOW,
      lastError: 'out of usage',
    });
    const reclaimed = (await claimAt(storage, NOW))!;

    const failed = await storage.failDeferredDecision({
      ...leaseOf(reclaimed),
      now: NOW,
      availableAt: NOW,
      lastError: 'ECONNRESET',
      failureCode: 'run_failed',
      terminal: false,
    });

    expect(failed).toMatchObject({ status: 'retry', failureCode: 'run_failed', usageLimitedSince: null, usageWaits: 1 });
  });

  it('counts a usage-wait requeue of a failed decision, so the sweep requeues it once', async () => {
    const storage = await makeStorage();
    await queueRun(storage);
    const claimed = (await claimAt(storage, NOW))!;
    const failed = (await storage.failDeferredDecision({
      ...leaseOf(claimed),
      now: NOW,
      availableAt: NOW,
      lastError: 'Factory skill run ended in error: Every Claude account this run may use is out of usage.',
      failureCode: 'run_failed',
      terminal: true,
    }))!;

    expect(await storage.listUsageLimitFailureCandidates({ since: new Date(NOW.getTime() - HOUR), limit: 10 })).toEqual([
      expect.objectContaining({ id: failed.id, status: 'failed', usageWaits: 0 }),
    ]);
    // Older than the window: not a candidate.
    expect(await storage.listUsageLimitFailureCandidates({ since: new Date(NOW.getTime() + 1), limit: 10 })).toEqual([]);

    const retried = await storage.retryDeferredDecision(SCOPE.orgId, SCOPE.factoryProjectId, failed.id, NOW, {
      usageWait: true,
    });
    expect(retried).toMatchObject({ status: 'retry', usageWaits: 1, failureCode: null, lastError: null });
  });

  it('hands a pending start back until the reset without spending its attempt', async () => {
    const storage = await makeStorage();
    await storage.prepareRunStart({
      orgId: SCOPE.orgId,
      userId: 'u',
      factoryProjectId: SCOPE.factoryProjectId,
      workItem: { input: { title: 'Fix login', stages: ['intake'], sessions: {}, metadata: {} } },
      role: 'work',
      session: { sessionId: 'session-1', branch: 'factory/1', threadId: 'thread-1' },
      resourceId: 'resource-1',
      kickoffKey: 'kickoff-1',
      kickoffMessage: 'Start.',
    });
    const [claimed] = await storage.claimPendingStarts(LEASE);
    expect(claimed?.attempts).toBe(1);

    const resumeAt = new Date(NOW.getTime() + 2 * HOUR);
    const waiting: FactoryPendingStartRecord | null = await storage.waitPendingStartForUsageReset({
      ...leaseOf(claimed!),
      now: NOW,
      availableAt: resumeAt,
      lastError: 'out of usage',
    });

    expect(waiting).toMatchObject({
      status: 'retry',
      attempts: 0,
      failureCode: 'run_usage_limited',
      usageWaits: 1,
      usageLimitedSince: NOW,
    });
    expect(await storage.claimPendingStarts({ ...LEASE, now: new Date(resumeAt.getTime() - 1) })).toEqual([]);
    expect(await storage.claimPendingStarts({ ...LEASE, now: resumeAt })).toEqual([
      expect.objectContaining({ id: claimed!.id, usageWaits: 1 }),
    ]);
  });

  it('leaves a row it does not hold alone', async () => {
    const storage = await makeStorage();
    await queueRun(storage);
    const claimed = (await claimAt(storage, NOW))!;

    expect(
      await storage.waitDeferredDecisionForUsageReset({
        ...leaseOf(claimed),
        ownerId: 'someone-else',
        now: NOW,
        availableAt: NOW,
        lastError: 'out of usage',
      }),
    ).toBeNull();
  });
});
