# @factory/harness-handoff

Portable context handoff for harness sessions. When a thread switches provider or model,
is forked, or a child thread merges back, the new conversation gets a budgeted selection of
**real** history: whole messages with their role, order and attribution, never an agent-written
summary. The user's new request is never shortened to make history fit. Omitted items are named
in a coverage block, so the agent can fetch them with `factory_thread_read`.

Dependencies: `zod` (catalog) and `@mastra/core` at the version the workspace already pins.

## How it works

1. **Budget** (`handoffBudget`). Cap = `FACTORY_CONTEXT_HANDOFF_TOKEN_CAP` (default 16,000,
   clamped to 1,024–64,000). One token per UTF-8 byte,
   including JSON escaping and attribution. Window = known model window, else reported
   `maxTokens`, else 128,000; never above reported `maxTokens` or `autoCompactThreshold`.
   It subtracts existing native context (telemetry or an estimate), the new request's JSON
   bytes, 8,192 per image and 4,096 per other attachment, and a reserve of max(16,000, window/4)
   for instructions, tools and later work. 0 means no room: start a fresh provider session.
2. **Select** (`selectHistory`). The latest user message, the latest assistant message and the
   first user message go first. Then everything else is taken newest to oldest while it fits.
   An item that does not fit is left out whole, never cut. The context line records
   `Selected N intact items; omitted M items` and how to recover them.
3. **Prepare** (`makeContextHandoffService`): `prepareProviderHandoff` (switch or fresh session),
   `prepareForkDelta` (merge-back), `prepareSideChatContext`, `prepareLegacyImport`. Each returns an
   `OrchestrationV2ContextHandoff` record for the host to persist.
4. **Deliver** (`deliverContextHandoffs`). It merges all pending handoffs into one budgeted
   selection and skips items already delivered. If the harness can inject history natively it
   does; otherwise it returns inline `context` for the prompt. It records delivery as
   `pending` → `injected` | `inline` per native thread. An injection that failed mid-way is not
   retried into the same native thread (`ContextHandoffDeliveryUncertainError`). If even the
   coverage block cannot fit, it throws `ContextHandoffBudgetError` and the request is left intact.
5. **Recover** (`readThread` / `createThreadReadTool`). The agent pages the thread with
   `afterPosition=nextPosition`, and pages one long item with `itemId` + `textOffset`.

## Layout

| Entry | What |
|---|---|
| `@factory/harness-handoff` | everything below |
| `@factory/harness-handoff/contracts` | zod schemas and types (`OrchestrationV2ContextHandoff`, `…TurnItem`, `…HistoricalMessage`, thread-read input/result) |
| `@factory/harness-handoff/mastra` | `createThreadReadTool(sourceFor)`: `factory_thread_read` as a Mastra tool |

| File | What |
|---|---|
| `handoffBudget.ts` | the token budget, history selection and rendering; `handoffTokenCapFromEnv()` |
| `ContextHandoffService.ts` | `makeContextHandoffService({ idAllocator, tokenCap })`: builds handoff records |
| `ContextHandoffDelivery.ts` | `deliverContextHandoffs`: native injection or inline context, delivery state |
| `ThreadForkService.ts` | `planThreadFork(input)`: the target thread and context transfer of a fork |
| `ProviderSwitchService.ts` | `makeProviderSwitchService(adapterRegistry)`: plans a provider or model switch |
| `ProviderSessionTransitionPolicy.ts` | whether a switch stays in the session, restarts it, or hands off |
| `selectionTransition.ts` | how a session applies a new model selection |
| `modelSwitch.ts` | `modelSwitchSince`: the "model a → b" divider |
| `orchestrationV2Timeline.ts` | which turn items the timeline shows |
| `model.ts` | `modelSelectionsEqual`, run ordering |
| `WireProjection.ts` | `projectContextHandoffForWire` |
| `threadRead.ts` | `readThread` and the `factory_thread_read` tool description |
| `historySource.ts` | `HandoffHistorySource`, the host's thread reads, and an in-memory timeline page |
| `contracts.ts`, `errors.ts` | zod schemas; `Error` subclasses with a `_tag` |

### Conventions

- Services are factories with injected dependencies: `makeContextHandoffService({ idAllocator, tokenCap })`,
  `makeProviderSwitchService(adapterRegistry)` and `planThreadFork(input)`. `delivered`/`unsent`
  are thunks the caller runs once the provider accepted or refused the prompt.
- Errors are `Error` subclasses with a `_tag`, their fields and a message, so a host can switch on
  `_tag` and send them over the wire. Ids are plain strings and timestamps ISO strings.
- `handoffTokenCapFromEnv()` reads `FACTORY_CONTEXT_HANDOFF_TOKEN_CAP`. An unset or non-integer
  value means the default.
- Coverage and footer strings name `THREAD_READ_TOOL_NAME` (`factory_thread_read`). The
  legacy-import header says "previous harness".
- A host's thread store is `HandoffHistorySource.getThreadRecords`; a thread it does not have
  throws `HandoffThreadNotFoundError`.

### Limitations

- **Turn item types.** The schema models the 16 types the handoff and thread-read code render. A
  host maps the rest to `dynamic_tool` or leaves them out.
- **App thread UI fields.** Pin, snooze, settle, guest share, title jobs and PR watch are not
  part of the schema. `OrchestrationV2AppThread` is a loose object, so `planThreadFork` still
  resets them when a host's threads have them.
- **Thread read.** It pages the timeline and long items only: no environments, thread detail or
  recent-runs header, message author lookup, or acknowledging delegated child-task results.
- **Ids and injection.** Handoff ids come from an injected allocator with a random default. No
  harness injects history natively yet: `inject` is the hook where a harness that supports it
  plugs in.

## Wiring

This package is not wired yet. These are the exact places in v4 where it plugs in.

**A host adapter (new code, in `packages/server`).** Implement `HandoffHistorySource` over Mastra
memory, the way `productReadThread` in `packages/server/src/factory.ts:1283` pages
`memory.listMessages` (ASC, 100 per page). Map each `MastraDBMessage` to a turn item: text parts
become `user_message` or `assistant_message`, and tool parts become `command_execution` or
`dynamic_tool`. Use `messageText` and `messageToolCalls` in `packages/supervisor/src/read-tools.ts:130`
and `:144` as the reference parsers. For Claude Code sessions, map the transcript entries
(`ClaudeTranscriptEntry`, `packages/harness-claude-code-core/src/events.ts:123`). A Factory run is
a `run`, and its ordinal is the turn index. Persist the returned handoff records with the
session; for Claude Code that is next to `ClaudeThreadState` in
`packages/harness-claude-code-core/src/store.ts:26`.

**1. Claude Code: fresh CLI session.**
- In `packages/harness-claude-code-core/src/session.ts:1288`, an `unknown_session` error on resume
  clears `thread.claudeSessionId` and starts a fresh CLI conversation with no history. This is the
  "start fresh provider session" case.
- Call `prepareProviderHandoff({ strategy: "full_thread_summary", items: visibleConversationItems(...) })`
  there.
- Deliver through the `turnContextFor` hook, configured in `packages/server/src/claude/harness.ts:392`
  and read in `session.ts:1128`. Its output is prepended as `${turnContext}\n\n${prompt}` at
  `session.ts:1166`. Append `deliverContextHandoffs(...).context` to the signals it returns. Use:
  - `providerThread.nativeThreadRef.nativeId` = `claudeSessionId`;
  - `inject` = undefined (the CLI has no native history API);
  - `budget = handoffBudget({ tokenCap: handoffTokenCapFromEnv(), userText: prompt, attachments, providerThread, nativeContextEstimate: 0, modelContextWindow })`.
- Call `delivered()` once the CLI has the prompt (`session.ts:1236`, "from here on the input counts
  as delivered"). Call `unsent()` if the spawn fails before that. Both points need a small
  callback added to `ClaudeCodeSessionConfig` in harness-claude-code-core.

**2. Model or provider switch.**
- `factory_switch_session_model` (`packages/harness-mastra/src/tools/session-tools.ts:197`, calling
  `controller.setThreadModel` at `:237`) and the UI path
  (`apps/ui/src/hooks/useAgentControllerStateMutations.ts:49` → AgentController `switchModel`)
  switch Mastra threads in place. Mastra memory replays the thread to any model. That is the
  policy's `switch_model_in_session`, so no handoff is needed.
- Claude Code sessions refuse switches today: `claudeModelError()` at `session-tools.ts:121/225/293`,
  and `switchModel: !claude` at `packages/api/src/source-control-sessions.ts:322` and `:606`.
- To allow Mastra ↔ Claude Code, or a Claude model or account change that cannot `--resume`:
  1. Run `makeProviderSwitchService(registry).plan(...)` in place of those refusals. The
     registry's `continuationKey` is `claude:<account>` or `mastra`.
  2. On `create_with_handoff`, call `prepareProviderHandoff` with `"delta_since_target_last_seen"`
     (or `"full_thread_summary"` for a target that never saw the thread). Use the items since
     the target last ran, and `visibleDeltaRunOrdinals` for the covered run range.
  3. Deliver as in 1 (Claude Code), or for Mastra prepend `withInlineContext(context, text)` to
     the first `sendMessage` / `sendSignal` contents (`AgentSession` in
     `packages/harness-core/src/contract.ts`).
- `modelSwitchSince` gives the "model a → b" divider for the switching run's user message.

**3. Fork.** v4 has no thread fork yet. Mastra's `memory.cloneThread`
(`@mastra/core/dist/memory/memory.d.ts:401`) copies rows for a Mastra → Mastra fork; that is a
native fork. For a portable fork, use `planThreadFork(...)` to get the target thread and
transfer, then `readForkHistoryItems(source, …, throughRun)` to get what the fork carries.
`prepareProviderHandoff({ strategy: "full_thread_summary" })` builds the handoff, and it is
delivered as in 1 or 2.

**4. Merge back / side sessions.**
- `factory_start_session` (`packages/harness-mastra/src/tools/session-tools.ts:243`) starts a
  side session. Its results come back as `factory-session` notifications through
  `deliverFactorySessionNotification` (`packages/harness-mastra/src/tools/deliver.ts:58`), which
  calls `sendNotificationSignal` at `:101`.
- To hand the origin the child's real activity instead of a report, call `prepareForkDelta`. Use
  `deltaItems` = the child's visible items since it started and `coveredRunOrdinals` from
  `visibleDeltaRunOrdinals`. Put `deliverContextHandoffs(...).context` (or the handoff's
  `summaryText`) in the notification payload.
- A side session started "beside" a running thread can take `prepareSideChatContext`.

**5. The read tool.**
- Add `createThreadReadTool(requestContext => source)` from `@factory/harness-handoff/mastra` to
  `createFactoryTools` (`packages/harness-mastra/src/tools/index.ts:42`). Claude Code sessions get
  the same Mastra tools over MCP through `buildFactoryMcpRoutes` (`packages/server/src/factory.ts:2564`).
- `sourceFor` must enforce access the way `factory_read_session`
  (`packages/harness-mastra/src/rules/product-tools.ts:524`) does: same Factory, and no other
  person's private session. Its `getThread` throws `HandoffThreadNotFoundError` otherwise.
  `threadReadSourceFromHistory(history)` builds the source from the adapter above.

**6. UI.** When a handoff record goes to clients, send it through `projectContextHandoffForWire`,
so the transcript and delivery state stay on the server.

## Tests

`pnpm --filter @factory/harness-handoff check` and `pnpm --filter @factory/harness-handoff test`.
51 cases, including `threadRead.test.ts` and an unavailable-target case in
`ProviderSwitchService.test.ts`.
