import { randomUUID } from 'node:crypto';

import { ClaudeCodeRunContext } from '@factory/harness-claude-code';
import type { ClaudeCodeSession } from '@factory/harness-claude-code';

/**
 * A worker on Claude Code, as the Factory chat's `factory_signal_session`
 * messages it (`messageWorkerSession`): the guidance is the session's input.
 * Both deliveries hand it over without waiting for the worker's run: a run in
 * flight takes it on its next turn (`queue`: after the current run), an idle
 * session wakes on it. Waiting for the run would hold the Factory chat's tool
 * call for the whole of the worker's work.
 */
export function claudeWorkerSession(session: Pick<ClaudeCodeSession, 'sendSignal'>) {
  const send = async (input: { content: string }): Promise<void> => {
    await session.sendSignal(
      { id: randomUUID(), type: 'user', tagName: 'user', contents: input.content },
      { requestContext: new ClaudeCodeRunContext() },
    ).accepted;
  };
  return { sendMessage: send, queueMessage: send };
}
