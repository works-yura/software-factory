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
| `@factory/harness-handoff/mastra` | `createThreadReadTool(sourceFor)` (`factory_thread_read` as a Mastra tool) and `FactoryContextHandoffProcessor` |

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
| `memoryHistory.ts` | a memory thread's messages as turn items; `createMemoryHistorySource` |
| `sessionHandoffs.ts` | `createSessionHandoffs`: a session's handoffs on its thread, the marker, delivery per turn |
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
  harness injects history natively: every delivery is inline context.

## Wiring

How v4 uses it.

**History.** Every harness keeps a session's conversation in its memory thread (thread = session id):
Mastra its own messages, Claude Code and Codex their transcript, projected by the chat channel
(`@factory/harness-claude-code-ui`). `memoryHistory.ts` maps those messages to runs and turn items
(`turnItemsFromMessages`; a person's input or a notification starts a run; shell calls become
`command_execution`, other tools `dynamic_tool`) and `createMemoryHistorySource` serves them as a
`HandoffHistorySource`, for all three harnesses.

**Session state.** `createSessionHandoffs` (`sessionHandoffs.ts`) keeps a session's handoff records
on its memory thread's metadata (`factoryContextHandoff`), the one place all harnesses share.
`prepare` builds a `full_thread_summary` handoff and writes a timeline marker (a
`factory-context-handoff` signal with `metadata.contextHandoff`, which the chat draws as a divider:
pending, delivered, failed). Each handoff opens a new native conversation key, so `forTurn` delivers
it once per key through `deliverContextHandoffs`; `delivered` / `unsent` follow whether the provider
took the prompt.

**Moving a session between harnesses** (`packages/server/src/handoff/harness-switch.ts`). The model
registry hands a pick on another harness's instance to its `HarnessSwitch`
(`@factory/harness/models/registry`); the server registers `createHarnessSwitch`. The session keeps
its id, chat URL, source-control row and thread: the source gives it up (a Claude Code or Codex
store record is removed, its chat channel detached; Mastra holds every session no other harness
does) and the target adopts it with no native conversation. The plan is
`makeProviderSwitchService(...).plan` (each harness its own continuation key, so
`create_with_handoff`); a running session or one without a Factory row is refused.

**Delivery.** Mastra: `FactoryContextHandoffProcessor` (`./mastra`) adds the context as a system
message of the run and confirms it after the model's first response. Claude Code and Codex:
`handoffContextFor` (`TurnHandoffHook`, `@factory/harness/turn-handoff`) is asked before each turn;
the context goes ahead of the prompt as `withInlineContext` does, and is confirmed once the CLI
reports init / Codex accepts `turn/start`.

**Lost native conversations.** A Claude Code `unknown_session` resume, or a Codex `thread/resume`
that fails, asks the hook again with `resume_failed`: the server prepares a same-harness handoff of
the thread (without the turn's own request) and the fresh conversation gets it.

**`factory_thread_read`.** In `createFactoryTools` for every session kind, so Claude Code and Codex
get it over the Factory MCP route. Access: the caller's own thread, or a session of the same Factory
that is not another person's private one (`scopedThreadReadSource` in `@factory/harness-mastra`).

**Not wired.** v4 has no "fork this session" entry point, so `planThreadFork` stays unused; side
sessions (`factory_start_session`) still report back with `factory-session` notifications, not
`prepareForkDelta`.

## Tests

`pnpm --filter @factory/harness-handoff check` and `pnpm --filter @factory/harness-handoff test`.
62 cases, including `threadRead.test.ts` and an unavailable-target case in
`ProviderSwitchService.test.ts`.
