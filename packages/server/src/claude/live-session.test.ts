import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { describe, expect, it } from 'vitest';

import { createSessionNotifier, LiveSessions } from '@factory/session';

import { claudeLiveSession } from './live-session.ts';
import type { ClaudeLiveChannel } from './live-session.ts';

function fakeChannel() {
  const listeners = new Set<(event: AgentControllerEvent) => void>();
  const pendingSuspensions = new Map<string, { toolName: string }>();
  const pendingApprovals = new Map<string, { toolName: string }>();
  let running = false;
  const channel: ClaudeLiveChannel = {
    session: { id: 'session-1' },
    get running() {
      return running;
    },
    displayState: () => ({ pendingSuspensions, pendingApprovals }),
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (event: AgentControllerEvent) => listeners.forEach(listener => listener(event));
  return { channel, pendingSuspensions, pendingApprovals, emit, setRunning: (value: boolean) => (running = value) };
}

describe('claudeLiveSession', () => {
  it('shows a card’s Claude Code session running, then waiting on its plan or on a permission', () => {
    const fake = fakeChannel();
    const notifier = createSessionNotifier();
    const registry = new LiveSessions(notifier);
    const changes: string[] = [];
    registry.onRunChanged(session => changes.push(session.identity.getId()));
    notifier.created(claudeLiveSession(fake.channel, { orgId: 'org-1', factoryProjectId: 'factory-1' }));

    fake.setRunning(true);
    expect(registry.isRunning('session-1')).toBe(true);

    fake.pendingApprovals.set('call-1', { toolName: 'Write' });
    fake.emit({ type: 'tool_approval_required', toolCallId: 'call-1', toolName: 'Write', args: {} } as AgentControllerEvent);
    expect(registry.parkedIn('factory-1')).toEqual([
      { sessionId: 'session-1', run: { toolName: 'Write', suspendedAt: expect.any(Number) } },
    ]);
    expect(changes).toEqual(['session-1']);

    fake.pendingApprovals.clear();
    fake.pendingSuspensions.set('plan-1', { toolName: 'submit_plan' });
    fake.emit({ type: 'tool_suspended', toolCallId: 'plan-1', toolName: 'submit_plan', args: {}, suspendPayload: {} });
    expect(registry.parked('session-1')?.toolName).toBe('submit_plan');
    expect(changes).toEqual(['session-1', 'session-1']);
  });

  it('belongs to its Factory, and to none when the session has none', () => {
    const fake = fakeChannel();
    expect(claudeLiveSession(fake.channel, { orgId: 'org-1', factoryProjectId: 'factory-1' }).state.get()).toEqual({
      factoryOrgId: 'org-1',
      factoryProjectId: 'factory-1',
    });
    expect(claudeLiveSession(fake.channel, { orgId: 'org-1', factoryProjectId: null }).state.get()).toEqual({
      factoryOrgId: 'org-1',
    });
  });

  it('passes other events through unchanged, and stops when unsubscribed', () => {
    const fake = fakeChannel();
    const seen: AgentControllerEvent[] = [];
    const off = claudeLiveSession(fake.channel, { orgId: 'org-1', factoryProjectId: null }).subscribe(event =>
      seen.push(event),
    );
    fake.emit({ type: 'agent_end', reason: 'complete' } as AgentControllerEvent);
    off();
    fake.emit({ type: 'agent_end', reason: 'complete' } as AgentControllerEvent);
    expect(seen).toEqual([{ type: 'agent_end', reason: 'complete' }]);
  });
});
