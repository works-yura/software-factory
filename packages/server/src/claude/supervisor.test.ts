import { describe, expect, it, vi } from 'vitest';

import { createClaudeCodeHarness, createInMemorySessionStore } from '@factory/harness-claude-code';
import { createFactorySupervisorReadTools, createFactorySupervisorWriteTools } from '@factory/supervisor';

import { CLAUDE_SUPERVISOR_WRITE_TOOLS, createClaudeSupervisorSessions } from './supervisor.ts';

const CLAUDE_FACTORY = '11111111-1111-4111-8111-111111111111';
const MASTRA_FACTORY = '22222222-2222-4222-8222-222222222222';

function harness() {
  return createClaudeCodeHarness({
    store: createInMemorySessionStore(),
    credentials: async () => ({}),
    cwdFor: () => '/nowhere',
    spawn: () => {
      throw new Error('The CLI must not be spawned in this test.');
    },
  });
}

describe('the Factory chat (supervisor) on Claude Code', () => {
  it('names exactly the supervisor tools that change something as the ones that ask', () => {
    const deps = { scope: { orgId: 'o', factoryProjectId: 'f' }, userId: 'u' } as never;
    expect(Object.keys(createFactorySupervisorWriteTools(deps)).sort()).toEqual([...CLAUDE_SUPERVISOR_WRITE_TOOLS].sort());
    for (const tool of Object.keys(createFactorySupervisorReadTools(deps))) {
      expect(CLAUDE_SUPERVISOR_WRITE_TOOLS).not.toContain(tool);
    }
  });

  it('creates the chat in the Claude store when it is first reached, only for a Claude Code Factory', async () => {
    const claude = harness();
    const projects = {
      getById: vi.fn(async ({ id }: { id: string }) =>
        id === CLAUDE_FACTORY
          ? ({ id, orgId: 'org', harness: 'claude-code' } as never)
          : id === MASTRA_FACTORY
            ? ({ id, orgId: 'org', harness: 'mastra' } as never)
            : null,
      ),
    };
    const sessions = createClaudeSupervisorSessions({ harness: claude, projects });

    const id = `factory-supervisor:${CLAUDE_FACTORY}`;
    const session = await sessions.resolve(id);
    expect(session?.id).toBe(id);
    expect(session?.thread.requireId()).toBe(id);
    expect(session?.resourceId).toBe(id);
    expect(await sessions.resolve(id)).toBe(session);

    // A Mastra Factory keeps its Mastra supervisor; an unknown Factory gets nothing.
    expect(await sessions.resolve(`factory-supervisor:${MASTRA_FACTORY}`)).toBeUndefined();
    expect(await sessions.resolve('factory-supervisor:33333333-3333-4333-8333-333333333333')).toBeUndefined();
    expect(await claude.getSession(`factory-supervisor:${MASTRA_FACTORY}`)).toBeUndefined();

    // Any other session is only found, never created.
    expect(await sessions.resolve('card-1')).toBeUndefined();
    await claude.createSession({ sessionId: 'card-1', threadId: 'card-1' });
    expect((await sessions.resolve('card-1'))?.id).toBe('card-1');
  });

  it('stops serving an existing chat once the Factory moved back to Mastra', async () => {
    const claude = harness();
    let kind = 'claude-code';
    const sessions = createClaudeSupervisorSessions({
      harness: claude,
      projects: { getById: async ({ id }) => ({ id, orgId: 'org', harness: kind }) as never },
    });
    const id = `factory-supervisor:${CLAUDE_FACTORY}`;
    expect(await sessions.resolve(id)).toBeDefined();
    kind = 'mastra';
    expect(await sessions.resolve(id)).toBeUndefined();
  });
});
