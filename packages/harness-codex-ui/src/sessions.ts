// One chat for every turn-based harness: the session routes ask each harness's resolver in turn,
// and read a session's model selection from the facet of the harness that runs it.
import type { ModelSelection } from '@factory/harness/models/contracts';
import type { ChatTranscriptSession } from '@factory/harness-claude-code-ui';
import { CodexSession } from '@factory/harness-codex';

export type ChatSessionResolver = (sessionId: string) => Promise<ChatTranscriptSession | undefined>;

/** The first session any resolver finds; resolvers are asked in order, so each harness's own store decides. */
export function chainSessionResolvers(...resolvers: Array<ChatSessionResolver | undefined>): ChatSessionResolver {
  const active = resolvers.filter((resolve): resolve is ChatSessionResolver => resolve !== undefined);
  return async sessionId => {
    for (const resolve of active) {
      const session = await resolve(sessionId);
      if (session) return session;
    }
    return undefined;
  };
}

export function isCodexSession(session: unknown): session is CodexSession {
  return session instanceof CodexSession;
}

/**
 * The state route's model selection for a chat session: a Codex session's from Codex's facet,
 * any other from `fallback` (Claude Code's).
 */
export function codexAwareModelSelectionReader(
  codex: { effectiveSelection(session: CodexSession): Promise<ModelSelection | null> },
  fallback?: (session: ChatTranscriptSession) => Promise<ModelSelection | null>,
): (session: ChatTranscriptSession) => Promise<ModelSelection | null> {
  return async session => {
    if (isCodexSession(session)) return codex.effectiveSelection(session);
    return fallback ? fallback(session) : null;
  };
}
