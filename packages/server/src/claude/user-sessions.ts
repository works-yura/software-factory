import type { ClaudeCodeUserSessions } from '@factory/api';
import type { ClaudeCodeHarness } from '@factory/harness-claude-code';

import { CLAUDE_THREAD_SETTINGS } from './start-coordinator.ts';

export interface ClaudeUserSessionsOptions {
  harness: Pick<ClaudeCodeHarness, 'getSession' | 'createSession'>;
  /**
   * Whether this server can give a new Claude Code session a working
   * directory. The default checkout needs a local sandbox (the CLI runs on this
   * host); a host-provided `cwdFor` decides on its own.
   */
  checkout: { custom: true } | { custom: false; sandboxProvider: string | undefined };
}

/**
 * Personal sessions (New session in the chat) of a Claude Code Factory: the
 * session routes create them in the Claude Code store instead of starting a
 * Mastra conversation. The session's thread is its id (the one the chat
 * opens) and its resource the one its visibility gives it, so the session
 * access guard and the Claude session UI apply unchanged. Its working
 * directory comes from the harness's `cwdFor` (the repository checked out on
 * the session branch) on its first turn, and its model from the Factory's
 * Claude Code default (`harnessModelDefaults`), read before each turn.
 */
export function createClaudeUserSessions({ harness, checkout }: ClaudeUserSessionsOptions): ClaudeCodeUserSessions {
  const unavailableReason =
    checkout.custom || checkout.sandboxProvider === 'local'
      ? undefined
      : checkout.sandboxProvider
        ? `Claude Code chats run on the server host and need a local sandbox to check the repository out in; this server's '${checkout.sandboxProvider}' sandbox is not supported yet.`
        : 'Claude Code chats need a sandbox to check the repository out in, and this server has none configured.';
  return {
    async get(sessionId) {
      const session = await harness.getSession(sessionId);
      return session ? { resourceId: session.resourceId } : undefined;
    },
    async start({ session: row, resourceId }) {
      const session =
        (await harness.getSession(row.sessionId)) ??
        (await harness.createSession({ sessionId: row.sessionId, threadId: row.sessionId, resourceId }));
      await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.sessionId, value: row.sessionId });
      if (row.title) await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.title, value: row.title });
    },
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}
