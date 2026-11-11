// Codex's model facet (`HarnessModels`): the catalog the CLI lists (the bundled manifest's when it
// cannot), a session's own pick kept as a thread setting, and the `turn/start` fields it compiles to.
// The host supplies where sessions live and what a session defaults to (its Factory's
// `harnessModelDefaults.codex`).
import { ModelSelection, ProviderOptionSelections, type ProviderOptionSelection, type ServerProviderModel } from '@factory/harness/models/contracts';
import type { HarnessModelAvailability, HarnessModelContext, HarnessModels, ModelSwitchResult } from '@factory/harness/models/facet';
import { modelSelectionsEqual } from '@factory/harness/models/model';
import { resolveModelDefault } from '@factory/harness/models/defaults';
import { checkModelSelection, EFFORT_OPTION_ID, modelSwitchBetween } from '@factory/harness/models/selection';

import { bundledCodexModels } from './codexModelCatalog.ts';
import { CODEX_HARNESS_ID, CODEX_INSTANCE_ID, codexEffortForThinkingLevel, compileCodexTurn } from './codexModelOptions.ts';
import { probeCodex, type CodexProbeInput, type CodexProbeResult } from './probe.ts';
import { codexCatalogModels } from './codexModelCatalog.ts';

/** What the facet knows about the CLI: whether it runs, and the models it offers. */
export interface CodexCatalogState extends HarnessModelAvailability {
  readonly models: ServerProviderModel[];
  readonly version?: string;
}

/** Where the facet reads the catalog from; cached by {@link createCodexCatalogSource}. */
export type CodexCatalogSource = () => Promise<CodexCatalogState>;

export const CODEX_NOT_INSTALLED_REASON = 'The codex CLI is not installed on this server.';
export const CODEX_NEEDS_LOGIN_REASON = 'Codex is not signed in on this server: run `codex login` there.';

const DEFAULT_CATALOG_TTL_MS = 5 * 60_000;
const FAILED_PROBE_TTL_MS = 30_000;

/**
 * The CLI's catalog, probed once and kept for `ttlMs`: `model/list` when the CLI runs and is signed
 * in; the bundled models when it runs but could not list them; unavailable (with why) when it is
 * missing or not signed in.
 */
export function createCodexCatalogSource(options: {
  /** Whether the `codex` binary is there at all; asked before each probe. */
  installed: () => boolean | Promise<boolean>;
  probe?: (input: CodexProbeInput) => Promise<CodexProbeResult>;
  probeInput: () => CodexProbeInput | Promise<CodexProbeInput>;
  ttlMs?: number;
  now?: () => number;
}): CodexCatalogSource & { invalidate(): void } {
  const now = options.now ?? Date.now;
  const probe = options.probe ?? probeCodex;
  let cached: { state: CodexCatalogState; until: number } | undefined;
  let pending: Promise<CodexCatalogState> | undefined;

  const read = async (): Promise<{ state: CodexCatalogState; ttl: number }> => {
    if (!(await options.installed())) {
      return { state: { available: false, needsSetup: true, reason: CODEX_NOT_INSTALLED_REASON, models: [] }, ttl: FAILED_PROBE_TTL_MS };
    }
    try {
      const result = await probe(await options.probeInput());
      if (result.needsLogin) {
        return {
          state: { available: false, needsSetup: true, reason: CODEX_NEEDS_LOGIN_REASON, models: [], ...(result.version ? { version: result.version } : {}) },
          ttl: FAILED_PROBE_TTL_MS,
        };
      }
      const listed = codexCatalogModels({ models: result.models, ...(result.version ? { version: result.version } : {}) }).models;
      return {
        state: {
          available: true,
          models: listed.length ? [...listed] : bundledCodexModels(),
          ...(result.version ? { version: result.version } : {}),
        },
        ttl: options.ttlMs ?? DEFAULT_CATALOG_TTL_MS,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { state: { available: true, reason: `Codex could not list its models (${reason}); showing the bundled list.`, models: bundledCodexModels() }, ttl: FAILED_PROBE_TTL_MS };
    }
  };

  const source = async () => {
    if (cached && cached.until > now()) return cached.state;
    pending ??= read()
      .then(({ state, ttl }) => {
        cached = { state, until: now() + ttl };
        return state;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  return Object.assign(source, {
    invalidate() {
      cached = undefined;
    },
  });
}

/** The thread settings a session's selection lives in. */
interface SelectionSettings {
  getSetting(input: { key: string }): Promise<unknown>;
  setSetting(input: { key: string; value: unknown }): Promise<void>;
}

export interface CodexHarnessModelsOptions<Session extends { thread: SelectionSettings }> {
  harnessId?: string;
  displayName?: string;
  owns(sessionId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<Session | undefined>;
  /** The session's Factory default (its `harnessModelDefaults.codex`), read per turn. */
  defaults(session: Session): Promise<ModelSelection | null>;
  /** The Factory default outside a session (Settings, a new chat of a Factory). */
  factoryDefaults?(ctx: HarnessModelContext): Promise<ModelSelection | null>;
  /** Thread-setting keys: the session's own pick, and the selection its last turn ran. */
  settingKeys: { selection: string; lastSelection: string };
  catalog: CodexCatalogSource;
}

/** What one turn sends, from the facet: `turn/start`'s model fields and the switch marker. */
export interface CodexTurnModelSelection {
  model?: string;
  effort?: string;
  serviceTier?: string;
  modelSwitch?: { from: ModelSelection; to: ModelSelection };
}

export interface CodexHarnessModels<Session> extends HarnessModels {
  /** The fields for the session's next turn; remembers what it runs, so a switch marks the turn. */
  turnSelection(session: Session): Promise<CodexTurnModelSelection>;
  /** The selection the session's next turn runs on, defaults filled in. */
  effectiveSelection(session: Session): Promise<ModelSelection | null>;
}

function parseSelection(value: unknown): ModelSelection | null {
  const parsed = ModelSelection.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A Codex harness's models, as the Factory server registers them. */
export function createCodexHarnessModels<Session extends { thread: SelectionSettings }>(
  options: CodexHarnessModelsOptions<Session>,
): CodexHarnessModels<Session> {
  const keys = options.settingKeys;
  const own = async (session: Session) => parseSelection(await session.thread.getSetting({ key: keys.selection }));
  const compile = async (session: Session) =>
    compileCodexTurn({ selection: await own(session), factoryDefault: await options.defaults(session) });
  const effectiveSelection = async (session: Session) => (await compile(session)).selection;
  // The models a pick is checked against: the CLI's, or the bundled ones while it cannot list any.
  const checkable = async () => {
    const state = await options.catalog();
    return state.models.length ? state.models : bundledCodexModels();
  };
  const catalogDefault = async (): Promise<ModelSelection | null> => {
    const models = (await options.catalog()).models;
    const slug = (models.find(model => model.isDefault) ?? models.find(model => !model.isLegacy))?.slug;
    return slug ? { instanceId: CODEX_INSTANCE_ID, model: slug } : null;
  };
  const factoryDefault = async (ctx: HarnessModelContext): Promise<ModelSelection | null> => {
    if (ctx.sessionId) {
      const session = await options.getSession(ctx.sessionId);
      if (session) return options.defaults(session);
    }
    return (await options.factoryDefaults?.(ctx)) ?? null;
  };

  return {
    instanceId: CODEX_INSTANCE_ID,
    harnessId: options.harnessId ?? CODEX_HARNESS_ID,
    displayName: options.displayName ?? 'Codex',
    owns: sessionId => options.owns(sessionId),
    async availability() {
      const { available, needsSetup, reason } = await options.catalog();
      return { available, ...(needsSetup ? { needsSetup } : {}), ...(reason ? { reason } : {}) };
    },
    list: async () => (await options.catalog()).models,
    catalogDefault,
    factoryDefault,
    async defaultSelection(ctx) {
      const session = ctx.sessionId ? await options.getSession(ctx.sessionId) : undefined;
      return resolveModelDefault({
        session: session ? await effectiveSelection(session) : null,
        factory: session ? null : await factoryDefault(ctx),
        catalog: await catalogDefault(),
      });
    },
    async check(request) {
      let selected: ProviderOptionSelection[] = [];
      if (request.options !== undefined) {
        const parsed = ProviderOptionSelections.safeParse(request.options);
        if (!parsed.success) return { ok: false, error: 'options must be a list of { id, value }.' };
        selected = [...parsed.data];
      }
      // Mastra's thinking level, as the agent tool and older clients send it, is the `effort` option.
      if (request.thinkingLevel !== undefined && !selected.some(option => option.id === EFFORT_OPTION_ID)) {
        const effort = codexEffortForThinkingLevel(request.thinkingLevel);
        if (!effort) return { ok: false, error: `Unknown thinking level ${JSON.stringify(request.thinkingLevel)}.` };
        selected.push({ id: EFFORT_OPTION_ID, value: effort });
      }
      return checkModelSelection(CODEX_INSTANCE_ID, await checkable(), { model: request.model, options: selected });
    },
    async getSelection(sessionId) {
      const session = await options.getSession(sessionId);
      return session ? effectiveSelection(session) : null;
    },
    // Each `turn/start` names its model, effort and tier, so a running turn finishes on its own.
    async setSelection(sessionId, selection): Promise<ModelSwitchResult> {
      const session = await options.getSession(sessionId);
      if (!session) return { ok: false, status: 404, error: 'That Codex session was not found.' };
      await session.thread.setSetting({ key: keys.selection, value: selection });
      return { ok: true, modelSelection: await effectiveSelection(session), appliesFrom: 'next-turn' };
    },
    async turnSelection(session) {
      const turn = await compile(session);
      const last = parseSelection(await session.thread.getSetting({ key: keys.lastSelection }));
      if (turn.selection && !(last && modelSelectionsEqual(last, turn.selection))) {
        await session.thread.setSetting({ key: keys.lastSelection, value: turn.selection });
      }
      return {
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.effort ? { effort: turn.effort } : {}),
        ...(turn.serviceTier ? { serviceTier: turn.serviceTier } : {}),
        ...modelSwitchBetween(last, turn.selection),
      };
    },
    effectiveSelection,
  };
}
