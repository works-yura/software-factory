import type { AgentControllerEvent } from '@mastra/core/agent-controller';

import { onSandboxSetupProgress } from '@factory/sandbox';
import type { SandboxSetupProgressEvent } from '@factory/sandbox';

interface SessionStream {
  emit(event: AgentControllerEvent): void;
}

/**
 * Puts each session's sandbox setup progress on that session's own event
 * stream, so the chat shows it under the turn that waits on the setup: a turn
 * harness's chat channel (Claude Code, Codex) when the session has one, else
 * the live Mastra session. A session nobody streams drops it. Events of one
 * session keep their order while its Mastra session is looked up.
 */
export function forwardSandboxSetupProgress({
  turnChannel,
  mastraSession,
}: {
  turnChannel: (sessionId: string) => SessionStream | undefined;
  mastraSession: (sessionId: string) => Promise<SessionStream | undefined>;
}): () => void {
  const pending = new Map<string, Promise<void>>();
  return onSandboxSetupProgress((sessionId, event) => {
    // The stream carries events it does not model as they are; the chat reads this one by its type.
    const wire = event as SandboxSetupProgressEvent as unknown as AgentControllerEvent;
    const channel = turnChannel(sessionId);
    if (channel && !pending.has(sessionId)) {
      channel.emit(wire);
      return;
    }
    const next = (pending.get(sessionId) ?? Promise.resolve())
      .then(async () => (turnChannel(sessionId) ?? (await mastraSession(sessionId)))?.emit(wire))
      .catch(error => console.warn('[factory] Could not forward sandbox setup progress', { sessionId, error }))
      .finally(() => {
        if (pending.get(sessionId) === next) pending.delete(sessionId);
      });
    pending.set(sessionId, next);
  });
}
