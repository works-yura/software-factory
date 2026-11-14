import type { ClaudeCodeUserSessions } from '@factory/api';
import type { OpenCodeHarness } from '@factory/harness-opencode';

import { CLAUDE_THREAD_SETTINGS } from '../claude/start-coordinator.ts';

export interface OpenCodeUserSessionsOptions {
  harness: Pick<OpenCodeHarness, 'getSession' | 'createSession'>;
  /** Whether this server can give a new OpenCode session a working directory (see the Claude Code one). */
  checkout: { custom: true } | { custom: false; sandboxProvider: string | undefined };
  /** Why OpenCode cannot run sessions now (the CLI is missing); asked per start. */
  unavailable?: () => string | undefined;
}

/**
 * Personal sessions (New session in the chat) of an OpenCode Factory: created in the OpenCode store,
 * their thread the session id, as a Codex Factory's are.
 */
export function createOpenCodeUserSessions({ harness, checkout, unavailable }: OpenCodeUserSessionsOptions): ClaudeCodeUserSessions {
  const checkoutReason =
    checkout.custom || checkout.sandboxProvider === 'local'
      ? undefined
      : checkout.sandboxProvider
        ? `OpenCode chats run on the server host and need a local sandbox to check the repository out in; this server's '${checkout.sandboxProvider}' sandbox is not supported yet.`
        : 'OpenCode chats need a sandbox to check the repository out in, and this server has none configured.';
  return {
    harnesses: ['opencode'],
    async get(sessionId) {
      const session = await harness.getSession(sessionId);
      return session ? { harness: 'opencode', ...(session.resourceId ? { resourceId: session.resourceId } : {}) } : undefined;
    },
    async start({ session: row, resourceId }) {
      const session =
        (await harness.getSession(row.sessionId)) ??
        (await harness.createSession({ sessionId: row.sessionId, threadId: row.sessionId, resourceId }));
      await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.sessionId, value: row.sessionId });
      if (row.title) await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.title, value: row.title });
    },
    ...(checkoutReason ? { unavailableReason: checkoutReason } : {}),
    unavailableReasonFor: () => checkoutReason ?? unavailable?.(),
  };
}
