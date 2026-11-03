import { FACTORY_INTERACTIVE_KEY } from '@factory/harness-mastra';

import { CLAUDE_THREAD_SETTINGS } from './start-coordinator.ts';

/**
 * Marks a Claude Code session's next turn as a person's when the request that
 * brought their message or answer is interactive (`FACTORY_INTERACTIVE_KEY`,
 * set by the auth gate for a signed-in person, as on a Mastra turn over HTTP).
 * The turn's Factory MCP token then carries `interactive`, so the tools only a
 * person may use are open to it. Wakes, webhooks and the dispatcher never mark it.
 */
export async function markClaudePersonTurn(
  c: { get(key: 'requestContext'): unknown },
  session: { thread: { setSetting(input: { key: string; value: unknown }): Promise<void> } },
): Promise<void> {
  const requestContext = c.get('requestContext') as { get(key: string): unknown } | undefined;
  if (requestContext?.get(FACTORY_INTERACTIVE_KEY) !== true) return;
  await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.personTurn, value: true });
}
