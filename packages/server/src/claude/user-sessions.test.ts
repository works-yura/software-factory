import { describe, expect, it } from 'vitest';

import { createClaudeCodeHarness, createInMemorySessionStore } from '@factory/harness-claude-code';
import type { SourceControlSession } from '@factory/store';

import { CLAUDE_THREAD_SETTINGS } from './start-coordinator.ts';
import { createClaudeUserSessions } from './user-sessions.ts';

function harness() {
  // No turn is ever run here, so nothing spawns the CLI.
  return createClaudeCodeHarness({
    store: createInMemorySessionStore(),
    cwdFor: () => '/tmp/never-used',
    credentials: async () => ({}),
  });
}

const row = {
  sessionId: 'session-1',
  orgId: 'org-1',
  userId: 'user-1',
  factoryProjectId: 'factory-1',
  title: 'Fix the login page',
} as SourceControlSession;

describe('createClaudeUserSessions', () => {
  it('creates the session on its own thread under the given resource, once', async () => {
    const claude = harness();
    const sessions = createClaudeUserSessions({
      harness: claude,
      checkout: { custom: false, sandboxProvider: 'local' },
    });
    expect(sessions.unavailableReason).toBeUndefined();
    await expect(sessions.get('session-1')).resolves.toBeUndefined();

    await sessions.start({ session: row, resourceId: 'user-1' });
    await sessions.start({ session: row, resourceId: 'factory-1' });

    const session = await claude.getSession('session-1');
    expect(session?.thread.getId()).toBe('session-1');
    // The second start finds the session; it keeps the resource it was created on.
    await expect(sessions.get('session-1')).resolves.toEqual({ resourceId: 'user-1' });
    await expect(session?.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.sessionId })).resolves.toBe('session-1');
    await expect(session?.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.title })).resolves.toBe('Fix the login page');
  });

  it('says why chats cannot run without a local sandbox, unless the host checks out itself', () => {
    const claude = harness();
    expect(
      createClaudeUserSessions({ harness: claude, checkout: { custom: false, sandboxProvider: 'e2b' } }).unavailableReason,
    ).toMatch(/local sandbox.*'e2b'/);
    expect(
      createClaudeUserSessions({ harness: claude, checkout: { custom: false, sandboxProvider: undefined } })
        .unavailableReason,
    ).toMatch(/no(ne)? configured|has none/);
    expect(createClaudeUserSessions({ harness: claude, checkout: { custom: true } }).unavailableReason).toBeUndefined();
  });
});
