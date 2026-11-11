/**
 * Claude Code sessions in the chat UI.
 *
 * The chat page talks to `/api/agent-controller/code/sessions/:sessionId/...`
 * for every session. For a Claude Code session those routes are answered by
 * {@link ClaudeSessionUi.middleware} with the shapes the Mastra handlers use,
 * so the page needs no change: the history comes from the session's memory
 * thread, which {@link ClaudeSessionUiChannel} fills from the transcript as
 * the session runs, and the stream carries the same events a Mastra session
 * emits. Any other session falls through to Mastra.
 *
 * Wiring (the server owns one `ClaudeSessionUi`, `MastraFactory.claudeSessionUi`):
 *
 * ```ts
 * const harness = createClaudeCodeHarness({
 *   ...config,
 *   // Every session object, created or rehydrated, records and streams from the start.
 *   onSession: session => factory.claudeSessionUi.attach(session),
 * });
 * // Lets the routes find a Claude session this process has not loaded yet (e.g. after a restart).
 * factory.claudeSessionUi.setSessionResolver(sessionId => harness.getSession(sessionId));
 * ```
 *
 * Requirements: the Claude session's `threadId` is the thread the chat opens
 * for it (the Factory's convention is `threadId === sessionId`) and its
 * `resourceId` is the memory resource the Factory gives the session (the
 * Factory id when shared, the owner's user id when private), so the session
 * access guard applies unchanged. A session the resolver does not know is
 * served by Mastra, so the Claude session must exist before the chat opens it.
 *
 * Outside the server, {@link attachClaudeSessionToUi} records a session into
 * any Mastra store without the routes.
 */
export * from './channel.ts';
export * from './projector.ts';
export * from './routes.ts';
export * from './session.ts';
