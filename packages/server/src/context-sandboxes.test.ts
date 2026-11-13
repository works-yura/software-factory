import { describe, expect, it, vi } from 'vitest';

import type { Card } from '@factory/store';

import { createContextSandboxStops } from './context-sandboxes.ts';
import type { CardPlace } from './context-sandboxes.ts';

function card(revision: number, stage: string, sessions: string[]): Card {
  return {
    id: 'card-1',
    orgId: 'org-1',
    revision,
    stages: [stage],
    sessions: Object.fromEntries(sessions.map((sessionId, index) => [`role-${index}`, { sessionId }])),
  } as unknown as Card;
}

function setup(initial: Card, { running = [] as string[] } = {}) {
  let current: Card | null = initial;
  const runningNow = new Set(running);
  const contexts: Record<string, string | undefined> = { triage: 'triage', planning: 'work', waiting: undefined };
  const stopSession = vi.fn(async (_input: { orgId: string; sessionId: string }) => {});
  const stop = createContextSandboxStops({
    workItems: { get: async () => current },
    placeOf: async (value): Promise<CardPlace> =>
      value.stages[0] === 'done' ? { kind: 'terminal' } : { kind: 'phase', context: contexts[value.stages[0]!] },
    isRunning: sessionId => runningNow.has(sessionId),
    stopSession,
    pollMs: 5,
  });
  return {
    stop,
    stopSession,
    move: (next: Card | null) => {
      current = next;
    },
    end: (sessionId: string) => runningNow.delete(sessionId),
  };
}

const stopped = (stopSession: ReturnType<typeof setup>['stopSession']) =>
  stopSession.mock.calls.map(([input]) => input.sessionId).sort();

describe('stopping a card sandbox when it runs in no context', () => {
  // One folder serves every context of the card: the next context keeps using it.
  it('stops nothing when the card moves on into another context', async () => {
    const { stop, stopSession } = setup(card(2, 'planning', ['triage-session']));

    await stop({ orgId: 'org-1', workItemId: 'card-1', revision: 2, toContext: 'work' });

    expect(stopSession).not.toHaveBeenCalled();
  });

  it("stops every session of the card when it waits on a person, keeping the card's files", async () => {
    const { stop, stopSession } = setup(card(3, 'waiting', ['triage-session', 'work-session']));

    await stop({ orgId: 'org-1', workItemId: 'card-1', revision: 3, toContext: undefined });

    expect(stopped(stopSession)).toEqual(['triage-session', 'work-session']);
  });

  it('leaves the card to a later move that already decided for it', async () => {
    const { stop, stopSession } = setup(card(4, 'planning', ['work-session']));

    await stop({ orgId: 'org-1', workItemId: 'card-1', revision: 3, toContext: undefined });

    expect(stopSession).not.toHaveBeenCalled();
  });

  // The agent whose own tool call moved the card is still running: the move must not wait on it.
  it('waits for a run in flight to end, then stops, unless the card came back meanwhile', async () => {
    const env = setup(card(3, 'waiting', ['work-session']), { running: ['work-session'] });

    await env.stop({ orgId: 'org-1', workItemId: 'card-1', revision: 3, toContext: undefined });
    expect(env.stopSession).not.toHaveBeenCalled();

    env.end('work-session');
    await vi.waitFor(() => expect(stopped(env.stopSession)).toEqual(['work-session']));

    const back = setup(card(3, 'waiting', ['work-session']), { running: ['work-session'] });
    await back.stop({ orgId: 'org-1', workItemId: 'card-1', revision: 3, toContext: undefined });
    back.move(card(4, 'planning', ['work-session']));
    back.end('work-session');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(back.stopSession).not.toHaveBeenCalled();
  });
});
