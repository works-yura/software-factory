# @factory/harness

The agent harness contract: the sessions, runs, events, human gates and **model choice** the
Factory runtime drives, independent of any agent framework (`src/contract.ts`). Mastra
(`@factory/harness-mastra`) and Claude Code (`@factory/harness-claude-code`) implement it.

## Model selection (`@factory/harness/models`)

Ported from t3code (MIT, `vendor/t3code/LICENSE`; source commit in `vendor/t3code/COMMIT`) with
`effect` removed. A model's options (reasoning effort, fast mode, context window, …) are **data**,
`ProviderOptionDescriptor`s; a session's pick is a
`ModelSelection { instanceId, model, options: [{ id, value }] }`. Clients render pickers from the
descriptors; each harness compiles a selection into what it runs. Browser-safe (zod only): the UI
imports it directly.

| File | What | From t3code |
|---|---|---|
| `models/contracts.ts` | zod schemas and types: `ProviderOptionDescriptor`, `ModelCapabilities`, `ProviderOptionSelection(s)`, `ModelSelection`, `ServerProviderModel` | `packages/contracts/src/{model,modelSelection,server}.ts` (subset, Schema → zod) |
| `models/model.ts` | descriptor helpers, `modelSelectionsEqual`, `resolvePromptInjectedEffort`, … | `packages/shared/src/model.ts` (98%) |
| `models/Array.ts`, `models/searchRanking.ts` | | `packages/shared/src` (100%) |
| `models/modelTraits.ts`, `models/modelSearch.ts` | picker trait labels and search | `packages/client-runtime/src` (98–99%) |
| `models/threadExecution.ts` | `REASONING_EFFORT_OPTION_IDS`, `formatModelSelectionEffort` | `client-runtime/src/state/threadExecution.ts` (those two) |
| `models/ModelCatalog.ts` | `classifyCatalogModels`, `applyCatalogDefault`, `applyModelCatalog` | `packages/provider-core/src/server/ModelCatalog.ts` (85%) |
| `models/selection.ts` | `EFFORT_OPTION_ID`, `checkOptionSelections`, `checkModelSelection`, `modelSwitchBetween` | new |
| `models/facet.ts` | `HarnessModels`, the model facet of the contract | new |
| `models/registry.ts` | `createHarnessModelRegistry`: the server's harnesses by model instance | new |

`vendor/t3code/` holds the untouched originals of the ported files; it is not compiled. The
Claude-only files (catalog, manifest, `model-manifest.json`, CLI compilation, `semver.ts`) live in
`@factory/harness-claude-code` (`src/models/`, its own `vendor/t3code/`); Mastra's descriptors from
its thinking levels in `@factory/credentials/mastra-models`.

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
   For Codex, t3code's `apps/server/src/provider/CodexProvider.ts` (and the `codex` section of
   `model-manifest.json`, already in `@factory/harness-claude-code/src/models/`) is the source to
   port, as `ClaudeModelCatalog.ts` was for Claude.
2. **Facet.** Implement `HarnessModels` in the harness package: `owns` (its session store),
   `list` / `defaultSelection`, `check` (`checkModelSelection(instanceId, models, request)` covers a
   plain catalog; map `request.thinkingLevel` onto your reasoning option if you accept it),
   `getSelection` / `setSelection` (keep the pick where the harness reads it each turn, e.g. a
   thread setting, and compile it into the CLI flags or API params of the next turn; mark a
   changed turn with `modelSwitchBetween(last, next)` for the chat's divider).
3. **Expose it** as `AgentHarness.models` and register it where the server builds the harness:
   `harnessModels.register(models)` in `packages/server/src/factory.ts` (next to the Claude Code
   one). Add its `HarnessDescriptor` to `@factory/contracts` `HARNESSES` for its label and
   capabilities.

That is all: `/web/config/models` lists its instance, the picker shows its models and descriptors
(`toProviderInstances` reads `instances` as they come), and the chat route, the agent tool and
`switchModel` reach its facet. `models/registry.testFixtures.ts` (`codexStubModels`) is a minimal
example; `models/registry.test.ts`, `@factory/session`'s `model-switch-route.test.ts` and
`@factory/api`'s `config.test.ts` run it through the registry, the route and the catalog.
