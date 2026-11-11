# @factory/harness-codex

The Codex harness: a Factory session runs as a thread of the `codex app-server` process (the
`codex` CLI's JSON-RPC server over stdio), resumed per session. It implements the harness contract
(`@factory/harness`) at the same level as Claude Code (`@factory/harness-claude-code`) and shows in
the chat, the model picker and Settings only through the generic layers.

The `codex` CLI is an external binary on the host, like `claude`. A host signs each run in with
tokens it holds (`credentials`: `account/login/start` with `chatgptAuthTokens`, which Codex keeps in
memory and asks the host to refresh with `account/chatgptAuthTokens/refresh`), in a `CODEX_HOME` of
the session's own (`codexHomeFor`), so a host's own `codex login` is never read. A turn that runs out
of usage or is refused moves to the host's next account in the same thread, as a Claude Code turn
does. Nothing here stores OpenAI credentials: the Factory server keeps the members' ChatGPT sign-ins
(`openai-codex` accounts) and refreshes them.

## Layout

| File | What |
|---|---|
| `protocol/errors.ts` | The protocol's errors (`_tag`ged `Error` subclasses) |
| `protocol/protocol.ts` | Line-delimited JSON-RPC over a duplex stream: requests, notifications, server requests and their answers, termination |
| `protocol/schema.ts` | The app-server types this harness reads and sends (initialize, account, `model/list`, threads, turns, items, approvals, questions, token usage, rate limits) |
| `protocol/client.ts` | `CodexAppServerClient`: typed requests and handlers over the protocol; `spawnCodexAppServer` starts `codex app-server` |
| `launchArgs.ts` | Extra `codex` launch arguments (`FACTORY_CODEX_LAUNCH_ARGS`) |
| `tokenUsage.ts` | A turn's token usage from the thread-wide totals Codex reports |
| `usageLimits.ts` | Codex's rate-limit windows (session/weekly/monthly) and when an exhausted allowance resets |
| `models/codexModelCatalog.ts` | The catalog: `model/list` mapped to `ServerProviderModel`s, the bundled manifest's `codex` section as the fallback |
| `models/codexModelOptions.ts` | Descriptors (`effort`, `role: 'reasoning'`; `serviceTier` Standard/Fast/Ultrafast where a model has tiers) and a selection compiled into `turn/start` params |
| `models/probe.ts` | Probes the CLI: version, account, models (`initialize`, `account/read`, `model/list`) |
| `models/harness-models.ts` | `createCodexHarnessModels`: the `HarnessModels` facet |
| `events.ts` | `CodexTurnTranslator`: app-server notifications into the Factory transcript (`TranscriptEntry`) and the turn's outcome |
| `store.ts` | Session records (in memory, one JSON file per session) |
| `session.ts` | `CodexSession`: the contract's session over app-server threads and turns |
| `harness.ts` | `createCodexHarness` |
| `testkit.ts` | A fake app-server peer for tests |

## Plan

1. **Protocol + models.** Port the protocol client of the reference app-server package without
   `effect`: a plain class over a child process's stdio, zod only where input is parsed, errors
   as `Error` subclasses with `_tag`. Only the methods and types the harness uses. The model
   catalog comes from `model/list` when the CLI is installed and signed in, else from the bundled
   manifest's `codex` section; each model carries an `effort` select (`role: 'reasoning'`) from
   its supported reasoning efforts and, where the model offers tiers, a `serviceTier` select
   (Standard, Fast, Ultrafast). The facet reads a Factory's default from
   `harnessModelDefaults.codex` and applies a session's pick from its next turn.
2. **Session adapter.** Port the turn lifecycle of the reference Codex adapter onto the Claude
   Code session's model: a run is a chain of turns; `thread/start` (or `thread/resume` after a
   restart) then `turn/start` with the turn's model, effort and service tier; notifications become
   transcript entries (text, reasoning, commands, file changes, MCP and web-search calls, the plan
   list as the task panel); `turn/interrupt` aborts; token usage becomes `usage_update`.
   Approvals and `request_user_input` park the run as the Factory's permission and question gates
   (the app-server request stays open while the process lives, so an answer resumes the same turn;
   after a restart the answer goes in as the next turn, as Claude Code's does). Planning runs in
   Codex's plan collaboration mode with a read-only sandbox; its plan parks as a plan gate.
3. **Chat UI.** Codex sessions emit the same transcript the Claude Code session does, so the chat
   channel, routes and projector of `@factory/harness-claude-code-ui` serve them unchanged
   (their session type is structural); `@factory/harness-codex-ui` holds the Codex glue.
4. **Server.** Register the harness (routing, model facet, session UI) when the `codex` CLI is
   found; otherwise the facet reports it unavailable with a reason (`needsSetup` when not signed
   in). A Factory's harness can be `codex`; sessions start on it like Claude Code ones. Moving a
   session between harnesses stays a 409 (a handoff, not a model switch).
