# @factory/harness

The agent harness contract: the sessions, runs, events, human gates and **model choice** the
Factory runtime drives, independent of any agent framework (`src/contract.ts`). Mastra
(`@factory/harness-mastra`) and Claude Code (`@factory/harness-claude-code`) implement it.

## Model selection (`@factory/harness/models`)

A model's options (reasoning effort, fast mode, context window, …) are **data**,
`ProviderOptionDescriptor`s; a session's pick is a
`ModelSelection { instanceId, model, options: [{ id, value }] }`. Clients render pickers from the
descriptors; each harness compiles a selection into what it runs. Browser-safe (zod only): the UI
imports it directly.

| File | What |
|---|---|
| `models/contracts.ts` | zod schemas and types: `ProviderOptionDescriptor`, `ModelCapabilities`, `ProviderOptionSelection(s)`, `ModelSelection`, `ServerProviderModel` |
| `models/model.ts` | descriptor helpers, `modelSelectionsEqual`, `resolvePromptInjectedEffort`, … |
| `models/Array.ts`, `models/searchRanking.ts` | array helpers and search ranking |
| `models/modelTraits.ts`, `models/modelSearch.ts` | picker trait labels and search |
| `models/threadExecution.ts` | `REASONING_EFFORT_OPTION_IDS`, `formatModelSelectionEffort` |
| `models/ModelCatalog.ts` | `classifyCatalogModels`, `applyCatalogDefault`, `applyModelCatalog` |
| `models/selection.ts` | `EFFORT_OPTION_ID`, `checkOptionSelections`, `checkModelSelection`, `modelSwitchBetween` |
| `models/facet.ts` | `HarnessModels`, the model facet of the contract |
| `models/registry.ts` | `createHarnessModelRegistry`: the server's harnesses by model instance |

The Claude-only files (catalog, manifest, `model-manifest.json`, CLI compilation, `semver.ts`) live
in `@factory/harness-claude-code` (`src/models/`); Codex's (the `model/list` catalog with the
manifest's `codex` section as fallback, its effort and service-tier descriptors, the facet) in
`@factory/harness-codex` (`src/models/`); Mastra's descriptors from its thinking levels in
`@factory/credentials/mastra-models`.

`executable.ts` (`@factory/harness/executable`, Node only) resolves the CLI a harness spawns (ADR-0038):
the deployment's configured command, else PATH, else where agent CLIs install (`~/.local/bin`,
`~/.claude/local`, the server's and nvm's node bin, `/opt/homebrew/bin`, `/usr/local/bin`). A found
path is kept; a missing one is looked up again on the next ask, so an install after boot needs no
restart. `createHarnessExecutable` is the `HarnessCommandSource` the Claude Code and Codex cores
spawn; `withExecutableAvailability` (in `models/facet.ts`) makes the harness unavailable with
`reasonCode: 'executable_missing'` while it is missing; `isHarnessExecutableUnavailable` tells the
dispatcher a run failed on a missing CLI, which no retry fixes.

`transcript.ts` (`@factory/harness/transcript`) is the transcript the turn-based harnesses (Claude
Code, Codex) record and the chat's session UI projects. `elicitation.ts`
(`@factory/harness/elicitation`) turns an MCP server's elicitation (a form or a link) into that
transcript's question card and the person's answers back into the typed content the server asked
for; both harnesses park it as an `AskUserQuestion`.

### The facet

```ts
interface HarnessModels {
  readonly instanceId: string;   // ModelSelection.instanceId of its selections
  readonly harnessId: string;    // HarnessDescriptor.id
  readonly displayName: string;
  owns(sessionId: string): Promise<boolean>;
  availability?(ctx: HarnessModelContext): Promise<HarnessModelAvailability>;
  list(ctx: HarnessModelContext): Promise<ServerProviderModel[]>;
  defaultSelection(ctx: HarnessModelContext): Promise<ModelSelection | null>;
  check(request: ModelSwitchRequest & { model: string }, ctx: HarnessModelContext): Promise<ModelSelectionCheck>;
  getSelection(sessionId: string, ctx: HarnessModelContext): Promise<ModelSelection | null>;
  setSelection(sessionId: string, selection: ModelSelection | null, ctx: HarnessModelContext): Promise<ModelSwitchResult>;
}
```

`AgentHarness.models` carries it. The server registers every harness's facet in one
`HarnessModelRegistry` (the default harness, Mastra, as the fallback) and only goes through it:

- `GET /web/config/models` → `instances: HarnessModelInstanceInfo[]` (`registry.describe`), one per
  harness: `{ instanceId, harnessId, displayName, available, needsSetup, reason?, defaultModel,
  defaultSelection, models }`. Mastra's legacy fields (`models`, `defaultModelId`,
  `fallbackModelId`) stay for the Settings pickers; its instance is built from them.
- `POST /api/agent-controller/:id/sessions/:sessionId/model` `{ modelId: string | null, options?,
  thinkingLevel?, instanceId? }` (`createModelSwitchRoute` in `@factory/session`) →
  `registry.switchSessionModel` → `{ ok: true, modelSelection, appliesFrom: 'now' | 'next-turn' }`
  or `{ error }` (400 refused pick, 404 no harness runs it, 409 another harness's instance, 503 not
  ready). Owner-only: mount it after the session access guard.
- The agent tool `factory_switch_session_model` → the same `switchSessionModel`.
- `GET /web/user-sessions/:id` → `capabilities.switchModel` (a facet runs it) and `modelInstanceId`.

A pick from another harness's instance is refused (409): moving a session between harnesses is a
handoff, not a model switch. `@factory/harness-handoff` is the place to hook that in, in
`HarnessModelRegistry.switchSessionModel` where the instance ids differ.

## Adding a harness

To give a new harness (e.g. Codex) model choice, without touching the server, the API or the UI:

1. **Catalog.** Describe its models as `ServerProviderModel`s with their `optionDescriptors`
   (a `select` with `role: 'reasoning'` for its reasoning control, `boolean`s for toggles).
   For Codex, the `codex` section of `model-manifest.json` (already in
   `@factory/harness-claude-code/src/models/`) is the starting point, read the way
   `ClaudeModelCatalog.ts` reads the Claude one.
2. **Facet.** Implement `HarnessModels` in the harness package: `owns` (its session store),
   `list`, `catalogDefault` (the harness's own default), `factoryDefault` (read the Factory's
   `harnessModelDefaults[instanceId]` through the host, e.g. `project.harnessModelDefaults`),
   `defaultSelection` (`resolveModelDefault({ session, factory, catalog })`: a session's own pick,
   else its Factory's default, else the catalog's), `check` (`checkModelSelection(instanceId,
   models, request)` covers a plain catalog; it must also answer outside a session, for a Factory
   default; map `request.thinkingLevel` onto your reasoning option if you accept it),
   `getSelection` / `setSelection` (keep the pick where the harness reads it each turn, e.g. a
   thread setting, and compile it into the CLI flags or API params of the next turn; mark a
   changed turn with `modelSwitchBetween(last, next)` for the chat's divider).
3. **Expose it** as `AgentHarness.models` and register it where the server builds the harness:
   `harnessModels.register(models)` in `packages/server/src/factory.ts` (next to the Claude Code
   one). Add its `HarnessDescriptor` to `@factory/contracts` `HARNESSES` for its label and
   capabilities.

   Optionally `applyDefaultToRunningSessions`, when its running sessions only pick a new default up
   if moved onto it (Settings then offers "Switch running sessions").

That is all: `/web/config/models` lists its instance, the picker shows its models and descriptors
(`toProviderInstances` reads `instances` as they come), Settings → Models shows its default-model
row (`HarnessModelDefaults`: model, the `role: 'reasoning'` select, a control per other descriptor,
"Use catalog default"), stored by `PUT/DELETE /web/factory/projects/:id/model-defaults/:instanceId`
after its `check`, and the chat route, the agent tool and `switchModel` reach its facet. `models/registry.testFixtures.ts` (`codexStubModels`) is a minimal
example; `models/registry.test.ts`, `@factory/session`'s `model-switch-route.test.ts` and
`@factory/api`'s `config.test.ts` run it through the registry, the route and the catalog.
