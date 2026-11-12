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
| `events.ts` | `CodexTurnTranslator`: app-server notifications into the Factory transcript (`TranscriptEntry`) and the turn's outcome; MCP elicitations become question cards through `@factory/harness/elicitation` |
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
4. **Server.** Register the harness (routing, model facet, session UI) wherever it is configured.
   The `codex` it spawns comes from the server's resolver (`@factory/harness/executable`,
   ADR-0038: `FACTORY_CODEX_COMMAND`, PATH, then where CLIs install); while it is missing the facet
   reports it unavailable (`reasonCode: 'executable_missing'`), and without a sign-in of the
   viewer's it needs setup. A Factory's harness can be `codex`; sessions start on it like Claude Code ones. Moving a
   session between harnesses stays a 409 (a handoff, not a model switch).

## Parity with Claude Code

What a Codex session does where a Claude Code session does the same, and what is left out.

| Claude Code | Codex | How |
|---|---|---|
| `AskUserQuestion` (up to 4) | `request_user_input` (up to 3) | One `AskUserQuestion` card (ADR 0006). The tool is offered in every mode (`features.default_mode_request_user_input`); the Factory's developer instructions name it as the skills' question tool. A card's reply is split back per question. A card the session no longer waits on is cancelled (`tool_suspension_cancelled`). A question Codex marks secret carries a note that the answer stays in the chat. |
| MCP elicitation | `mcpServer/elicitation/request` | A form's fields become the card's questions (enums and booleans as choices, the default first and recommended; text and numbers as free answers), a link as Done / Decline; answers go back typed. Codex's own MCP tool approval (`_meta.codex_approval_kind = "mcp_tool_call"`) parks as a permission; its tool is read from the message (`Allow <server> to run tool "<tool>"?`), since `_meta` carries only `tool_title`, `connector_*` and `tool_params` (CLI 0.166). Device-verification challenges (`openai/userVerification`) are declined. |
| `Task`/`Agent` subagents | collab `spawnAgent`, multi-agent v2 `subAgentActivity` | An `Agent` call per subagent thread; the thread's items, deltas and approvals are recorded under it (`parentToolCallId`) and route to the turn that started it; `wait`'s agent states, the `completed`/`interrupted` activity or the subagent's turn end settle it. Other collab calls (`wait`, `sendInput`, …) are not drawn: their effect shows on the subagent cards. |
| Background `Bash` / `BashOutput` | unified exec terminals | A command whose terminal keeps running says so in its result (with its process id); a later call to that terminal reads as `get_process_output`. The terminals end with the run's process. |
| — | `imageGeneration` | A `generate_image` call; the saved image goes to the host (`onImageGenerated`), which keeps it as the card's or the session's attachment. |
| Edit card | `fileChange` | One call per file with the unified diff and its line counts; an approval shows every file's diff, each under an `@@ <kind> <path> @@` header. |
| Steer (stop and restart) | `turn/steer` | The message joins the turn in flight; when no turn can take it, the run stops and starts over with it, as Claude Code's does. |
| Account rotation | `account/login/start` per account | A turn that runs out of usage moves to the next account in the same thread, also after a parked approval or question was answered. |

Left out, and why:

- **Compaction**: Codex compacts its context on its own; the Factory has no compact command or compaction marker for Claude Code either, so `thread/compact/start` and `contextCompaction` items are not surfaced.
- **Fork, rollback, revert** (`thread/fork`, `thread/revert`): the Factory exposes none of these for Claude Code sessions.
- **MCP apps** (`mcpAppUi` resources on MCP tool calls): the chat has no renderer for MCP app UIs; such calls show as ordinary MCP tool calls.
- **Command output streaming** (`item/commandExecution/outputDelta`): the chat shows a command's output when it completes, as for Claude Code.

