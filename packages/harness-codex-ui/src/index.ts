/**
 * Codex sessions in the chat UI.
 *
 * A Codex session records the same transcript a Claude Code session does
 * (`@factory/harness/transcript`), with the Factory's own tool names for its
 * commands, file changes and searches, `task_write` for its plan list,
 * `AskUserQuestion` for its questions and `submit_plan` for a plan-mode plan.
 * So the chat channel, the session routes and the projector of
 * `@factory/harness-claude-code-ui` serve it unchanged: their session type is
 * structural (`ChatTranscriptSession`). Its replies are stamped with OpenAI as
 * the provider (`CodexSession.modelProvider`).
 *
 * Wiring (the server's one session UI serves both harnesses):
 *
 * ```ts
 * const codex = createCodexHarness({ ...config, onSession: session => sessionUi.attach(session) });
 * sessionUi.setSessionResolver(chainSessionResolvers(id => claude.getSession(id), id => codex.getSession(id)));
 * sessionUi.setModelSelectionReader(codexAwareModelSelectionReader(codexModels, session => claudeModels.effectiveSelection(session)));
 * ```
 *
 * A Codex approval waits in its live turn: answering it from the chat
 * (`POST …/tool-approval`) gives Codex the decision and the same turn goes on;
 * a question (`POST …/tool-suspension`) gives it the answer.
 */
export * from './sessions.ts';
export { attachClaudeSessionToUi as attachCodexSessionToUi, createClaudeSessionUi as createChatSessionUi } from '@factory/harness-claude-code-ui';
