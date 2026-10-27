import { describe, expect, it, vi } from 'vitest';

import type { AgentHarness, AgentSession } from './contract.ts';
import { createRoutingHarness } from './routing.ts';

function fakeHarness(name: string, sessionIds: string[], runs: Array<{ threadId: string }> = []) {
  const sessions = new Map(sessionIds.map(id => [id, { name, id } as unknown as AgentSession]));
  return {
    getSession: vi.fn(async (id: string) => sessions.get(id)),
    listActiveThreadRuns: vi.fn(() => runs),
    runContext: vi.fn(() => ({
      get: (key: string) => (key === 'harness' ? name : undefined),
    })),
    findSkill: vi.fn(async (_session: AgentSession, skill: string) => ({
      name: skill,
      userInvocable: true,
      activation: `${name}:${skill}`,
    })),
  } satisfies AgentHarness;
}

const context = {
  userId: 'user-1',
  orgId: 'org-1',
  threadId: 'thread-1',
  resourceId: 'resource-1',
};

describe('createRoutingHarness', () => {
  it('sends an owned session to its harness and never asks the fallback for it', async () => {
    const claude = fakeHarness('claude', ['claude-1']);
    const mastra = fakeHarness('mastra', ['mastra-1', 'claude-1']);
    const harness = createRoutingHarness({
      routes: [{ harness: claude, owns: async id => id === 'claude-1' }],
      fallback: mastra,
    });

    const session = await harness.getSession('claude-1');
    expect(session).toMatchObject({ name: 'claude' });
    expect(mastra.getSession).not.toHaveBeenCalled();
    expect(harness.runContext(session!, context).get('harness')).toBe('claude');
    await expect(harness.findSkill(session!, 'factory-plan')).resolves.toMatchObject({
      activation: 'claude:factory-plan',
    });
  });

  it('falls back for sessions no route owns', async () => {
    const claude = fakeHarness('claude', []);
    const mastra = fakeHarness('mastra', ['mastra-1']);
    const harness = createRoutingHarness({
      routes: [{ harness: claude, owns: async () => false }],
      fallback: mastra,
    });

    const session = await harness.getSession('mastra-1');
    expect(session).toMatchObject({ name: 'mastra' });
    expect(claude.getSession).not.toHaveBeenCalled();
    expect(harness.runContext(session!, context).get('harness')).toBe('mastra');
    await expect(harness.findSkill(session!, 'factory-plan')).resolves.toMatchObject({
      activation: 'mastra:factory-plan',
    });
    await expect(harness.getSession('missing')).resolves.toBeUndefined();
  });

  it('does not fall back when the owning harness has lost the session', async () => {
    const claude = fakeHarness('claude', []);
    const mastra = fakeHarness('mastra', ['claude-1']);
    const harness = createRoutingHarness({
      routes: [{ harness: claude, owns: async () => true }],
      fallback: mastra,
    });

    await expect(harness.getSession('claude-1')).resolves.toBeUndefined();
    expect(mastra.getSession).not.toHaveBeenCalled();
  });

  it('lists the runs in flight across every harness', () => {
    const harness = createRoutingHarness({
      routes: [
        {
          harness: fakeHarness('claude', [], [{ threadId: 'a' }]),
          owns: async () => false,
        },
      ],
      fallback: fakeHarness('mastra', [], [{ threadId: 'b' }]),
    });
    expect(harness.listActiveThreadRuns()).toEqual([{ threadId: 'a' }, { threadId: 'b' }]);
  });
});
