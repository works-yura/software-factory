import type { ClaudeCodeUserSessions, TurnHarnessKind } from '@factory/api';
import type { CodexHarness } from '@factory/harness-codex';

import { CLAUDE_THREAD_SETTINGS } from '../claude/start-coordinator.ts';

export interface CodexUserSessionsOptions {
  harness: Pick<CodexHarness, 'getSession' | 'createSession'>;
  /** Whether this server can give a new Codex session a working directory (see the Claude Code one). */
  checkout: { custom: true } | { custom: false; sandboxProvider: string | undefined };
  /** Why Codex cannot run sessions now (the CLI is missing or not signed in); asked per start. */
  unavailable?: () => string | undefined;
}

/**
 * Personal sessions (New session in the chat) of a Codex Factory: created in the Codex store, their
 * thread the session id and their resource the one their visibility gives them, so the session
 * access guard and the chat's session UI apply unchanged.
 */
export function createCodexUserSessions({ harness, checkout, unavailable }: CodexUserSessionsOptions): ClaudeCodeUserSessions {
  const checkoutReason =
    checkout.custom || checkout.sandboxProvider === 'local'
      ? undefined
      : checkout.sandboxProvider
        ? `Codex chats run on the server host and need a local sandbox to check the repository out in; this server's '${checkout.sandboxProvider}' sandbox is not supported yet.`
        : 'Codex chats need a sandbox to check the repository out in, and this server has none configured.';
  return {
    harnesses: ['codex'],
    async get(sessionId) {
      const session = await harness.getSession(sessionId);
      return session ? { harness: 'codex', ...(session.resourceId ? { resourceId: session.resourceId } : {}) } : undefined;
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

/**
 * The turn-based harnesses' personal sessions as the session routes take them: a session is the
 * harness's that holds it, and a new one starts on the harness its Factory names.
 */
export function combineTurnHarnessUserSessions(
  byHarness: Partial<Record<TurnHarnessKind, ClaudeCodeUserSessions>>,
): ClaudeCodeUserSessions | undefined {
  const entries = Object.entries(byHarness).filter((entry): entry is [TurnHarnessKind, ClaudeCodeUserSessions] => entry[1] !== undefined);
  if (entries.length === 0) return undefined;
  const of = (harness: TurnHarnessKind | undefined) => byHarness[harness ?? 'claude-code'];
  return {
    harnesses: entries.map(([harness]) => harness),
    async get(sessionId) {
      for (const [harness, sessions] of entries) {
        const held = await sessions.get(sessionId);
        if (held) return { ...held, harness: held.harness ?? harness };
      }
      return undefined;
    },
    async start(input) {
      const sessions = of(input.harness);
      if (!sessions) throw new Error(`This server runs no ${input.harness ?? 'claude-code'} sessions.`);
      await sessions.start(input);
    },
    unavailableReasonFor: harness => {
      const sessions = of(harness);
      return sessions?.unavailableReasonFor?.(harness) ?? sessions?.unavailableReason;
    },
  };
}
