import { describe, expect, it } from 'vitest';

import {
  createClaudeCodeHarness,
  createInMemorySessionStore,
  ClaudeCodeError,
  emptyThreadState,
} from '@factory/harness-claude-code';
import type { UsageLimitPark, UsageLimitResumeResult } from '@factory/harness/usage-limit-park';

import { createUsageLimitResumer, storeParkedSessions, type ParkableSession } from './usage-limit-resume.ts';

const T0 = Date.parse('2026-11-11T12:00:00.000Z');

/** Timers the test fires by hand. */
function manualTimers() {
  const pending = new Map<number, { fire: () => void; ms: number }>();
  let next = 0;
  return {
    pending,
    setTimer: (fire: () => void, ms: number) => {
      next += 1;
      pending.set(next, { fire, ms });
      return next;
    },
    clearTimer: (timer: unknown) => void pending.delete(timer as number),
    async fireAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const timer of due) timer.fire();
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
    },
  };
}

function park(until: number, extra: Partial<UsageLimitPark> = {}): UsageLimitPark {
  return {
    reason: 'usage_limit',
    until: new Date(until).toISOString(),
    resetKnown: true,
    since: new Date(T0).toISOString(),
    attempts: 1,
    message: 'out',
    ...extra,
  };
}

/** A session parked until `until`, whose resume answers from `results`. */
function fakeSession(id: string, until: number, results: UsageLimitResumeResult[]) {
  const listeners = new Set<(event: { type: string }) => void>();
  const calls: number[] = [];
  const session: ParkableSession & { calls: number[]; current: UsageLimitPark | undefined; emit(event: { type: string }): void } = {
    id,
    calls,
    current: park(until),
    get usageLimitPark() {
      return this.current;
    },
    run: { isRunning: () => false },
    async resumeFromUsageLimit() {
      calls.push(1);
      const result = results.shift() ?? { action: 'resumed', runId: 'r' };
      session.current = result.action === 'parked' ? result.park : undefined;
      if (result.action === 'parked') session.emit({ type: 'usage_limit_parked', park: result.park } as never);
      return result;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
  return session;
}

describe('createUsageLimitResumer', () => {
  it('resumes a parked session at its time plus jitter, and parks it again while still limited', async () => {
    const timers = manualTimers();
    let now = T0;
    const resumer = createUsageLimitResumer({
      sources: [],
      now: () => now,
      random: () => 0.5,
      maxJitterMs: 10_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const later = T0 + 3 * 60 * 60_000;
    const session = fakeSession('s1', T0 + 60 * 60_000, [{ action: 'parked', park: park(later, { attempts: 2 }) }]);
    resumer.observe(session);
    session.emit({ type: 'usage_limit_parked', park: session.current } as never);
    expect(resumer.scheduled().get('s1')).toBe(T0 + 60 * 60_000 + 5_000);
    expect([...timers.pending.values()].map(timer => timer.ms)).toEqual([60 * 60_000 + 5_000]);

    now = T0 + 60 * 60_000 + 5_000;
    await timers.fireAll();
    expect(session.calls).toHaveLength(1);
    // Still limited: the next try waits for the new reset.
    expect(resumer.scheduled().get('s1')).toBe(later + 5_000);

    now = later + 5_000;
    await timers.fireAll();
    expect(session.calls).toHaveLength(2);
    expect(resumer.scheduled().has('s1')).toBe(false);
  });

  it('forgets a session a run took up meanwhile (a person wrote)', async () => {
    const timers = manualTimers();
    const resumer = createUsageLimitResumer({ sources: [], now: () => T0, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    const session = fakeSession('s1', T0 + 60_000, []);
    resumer.observe(session);
    expect(resumer.scheduled().has('s1')).toBe(true);
    session.emit({ type: 'usage_limit_cleared', reason: 'resumed' } as never);
    expect(resumer.scheduled().has('s1')).toBe(false);
    expect(timers.pending.size).toBe(0);
  });

  it('schedules the parks the stores hold on startup, skipping sessions bound to a card', async () => {
    const timers = manualTimers();
    let now = T0;
    const sessions = new Map([
      ['chat', fakeSession('chat', T0 + 60_000, [])],
      ['card', fakeSession('card', T0 + 60_000, [])],
    ]);
    const resumer = createUsageLimitResumer({
      sources: [
        {
          parked: async () => [...sessions.values()].map(session => ({ sessionId: session.id, until: session.current!.until })),
          get: async sessionId => sessions.get(sessionId),
        },
      ],
      handledElsewhere: async sessionId => sessionId === 'card',
      now: () => now,
      random: () => 0,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await resumer.start();
    expect([...resumer.scheduled().keys()]).toEqual(['chat']);
    now = T0 + 60_000;
    await timers.fireAll();
    expect(sessions.get('chat')!.calls).toHaveLength(1);
    expect(sessions.get('card')!.calls).toHaveLength(0);
  });

  it('does not resume a session that became a card run after it parked', async () => {
    const timers = manualTimers();
    let bound = false;
    const resumer = createUsageLimitResumer({
      sources: [],
      handledElsewhere: async () => bound,
      now: () => T0 + 120_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const session = fakeSession('s1', T0 + 60_000, []);
    resumer.observe(session);
    bound = true;
    await timers.fireAll();
    expect(session.calls).toHaveLength(0);
  });

  it('resumes a Claude Code session parked before a restart, from its store', async () => {
    const store = createInMemorySessionStore();
    const until = Date.now() - 1_000;
    await store.put({
      sessionId: 'chat-1',
      threadId: 'chat-1',
      threads: {
        'chat-1': {
          ...emptyThreadState(),
          pendingInputs: [{ kind: 'signal', text: 'go on' }],
          usageLimitPark: park(until, { since: new Date().toISOString() }),
        },
      },
      updatedAt: new Date().toISOString(),
    });
    const spawned: string[] = [];
    const resumerRef: { current?: ReturnType<typeof createUsageLimitResumer> } = {};
    const harness = createClaudeCodeHarness({
      store,
      cwdFor: () => '/work',
      parkOnUsageLimit: () => true,
      // Still limited after the restart: the session parks anew.
      credentials: async () => {
        spawned.push('asked');
        throw new ClaudeCodeError('rate_limit', 'Every account is out of usage.', { resetsAt: new Date(Date.now() + 60 * 60_000) });
      },
      onSession: session => resumerRef.current?.observe(session),
    });
    const timers = manualTimers();
    const resumer = createUsageLimitResumer({
      sources: [{ parked: storeParkedSessions(store), get: sessionId => harness.getSession(sessionId) }],
      random: () => 0,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    resumerRef.current = resumer;
    await resumer.start();
    expect([...resumer.scheduled().keys()]).toEqual(['chat-1']);
    await timers.fireAll();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(spawned).toEqual(['asked']);
    const record = await store.get('chat-1');
    expect(record!.threads['chat-1']!.usageLimitPark).toMatchObject({ attempts: 2 });
    expect(record!.threads['chat-1']!.pendingInputs.map(input => input.text)).toEqual(['go on']);
    expect(resumer.scheduled().has('chat-1')).toBe(true);
  });
});
