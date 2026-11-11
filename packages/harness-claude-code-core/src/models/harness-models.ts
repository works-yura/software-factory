// Claude Code's model facet (`HarnessModels`): the bundled Claude catalog, a session's own pick kept
// as a thread setting, and the per-turn CLI flags it compiles to. The host supplies where sessions
// live and what a session defaults to (its Factory's `harnessModelDefaults['claude-code']`).
import { ModelSelection, ProviderOptionSelections, type ProviderOptionSelection } from '@factory/harness/models/contracts';
import type { HarnessModelContext, HarnessModels, ModelSwitchResult } from '@factory/harness/models/facet';
import { modelSelectionsEqual } from '@factory/harness/models/model';
import { resolveModelDefault } from '@factory/harness/models/defaults';
import { EFFORT_OPTION_ID, modelSwitchBetween } from '@factory/harness/models/selection';

import type { ClaudeTurnSelection } from '../session.ts';
import { BUNDLED_CLAUDE_MODEL_CATALOG, type ClaudeModelCatalog } from './ClaudeModelCatalog.ts';
import {
  CLAUDE_CODE_INSTANCE_ID,
  checkClaudeCodeModelSelection,
  claudeCodeCatalogDefault,
  claudeCodeModels,
  claudeEffortForThinkingLevel,
  compileClaudeCodeTurn,
} from './claude-code.ts';

/** The thread settings a session's selection lives in. */
interface SelectionSettings {
  getSetting(input: { key: string }): Promise<unknown>;
  setSetting(input: { key: string; value: unknown }): Promise<void>;
}

export interface ClaudeCodeHarnessModelsOptions<Session extends { thread: SelectionSettings }> {
  /** The harness id sessions report (`HarnessDescriptor.id`). */
  harnessId?: string;
  displayName?: string;
  owns(sessionId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<Session | undefined>;
  /**
   * The session's Factory default (its `harnessModelDefaults['claude-code']`), read per turn, so a
   * default changed in Settings applies from the next turn.
   */
  defaults(session: Session): Promise<ModelSelection | null>;
  /** The Factory default outside a session (Settings, a new chat of a Factory). */
  factoryDefaults?(ctx: HarnessModelContext): Promise<ModelSelection | null>;
  /** Thread-setting keys: the session's own pick, and the selection its last turn ran. */
  settingKeys: { selection: string; lastSelection: string };
  catalog?: ClaudeModelCatalog;
}

export interface ClaudeCodeHarnessModels<Session> extends HarnessModels {
  /** The CLI flags for the session's next turn; remembers what it runs, so a switch marks the turn. */
  turnSelection(session: Session): Promise<ClaudeTurnSelection>;
  /** The selection the session's next turn runs on, defaults filled in. */
  effectiveSelection(session: Session): Promise<ModelSelection | null>;
}

function parseSelection(value: unknown): ModelSelection | null {
  const parsed = ModelSelection.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A Claude Code harness's models, as the Factory server registers them. */
export function createClaudeCodeHarnessModels<Session extends { thread: SelectionSettings }>(
  options: ClaudeCodeHarnessModelsOptions<Session>,
): ClaudeCodeHarnessModels<Session> {
  const catalog = options.catalog ?? BUNDLED_CLAUDE_MODEL_CATALOG;
  const keys = options.settingKeys;

  const own = async (session: Session) => parseSelection(await session.thread.getSetting({ key: keys.selection }));
  const compile = async (session: Session) =>
    compileClaudeCodeTurn({ selection: await own(session), factoryDefault: await options.defaults(session) }, catalog);
  const effectiveSelection = async (session: Session) => (await compile(session)).selection;
  const catalogDefault = async () => claudeCodeCatalogDefault(catalog);
  const factoryDefault = async (ctx: HarnessModelContext): Promise<ModelSelection | null> => {
    if (ctx.sessionId) {
      const session = await options.getSession(ctx.sessionId);
      if (session) return options.defaults(session);
    }
    return (await options.factoryDefaults?.(ctx)) ?? null;
  };

  return {
    instanceId: CLAUDE_CODE_INSTANCE_ID,
    harnessId: options.harnessId ?? 'claude-code',
    displayName: options.displayName ?? 'Claude Code',
    owns: sessionId => options.owns(sessionId),
    list: async () => claudeCodeModels(catalog),
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
        const effort = claudeEffortForThinkingLevel(request.thinkingLevel);
        if (!effort) return { ok: false, error: `Unknown thinking level ${JSON.stringify(request.thinkingLevel)}.` };
        selected.push({ id: EFFORT_OPTION_ID, value: effort });
      }
      return checkClaudeCodeModelSelection({ model: request.model, options: selected }, catalog);
    },
    async getSelection(sessionId) {
      const session = await options.getSession(sessionId);
      return session ? effectiveSelection(session) : null;
    },
    // The CLI takes `--model` per turn, so a running turn finishes on its model.
    async setSelection(sessionId, selection): Promise<ModelSwitchResult> {
      const session = await options.getSession(sessionId);
      if (!session) return { ok: false, status: 404, error: 'That Claude Code session was not found.' };
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
        ...(turn.settings ? { settings: turn.settings } : {}),
        ...(turn.promptEffort ? { promptEffort: turn.promptEffort } : {}),
        ...modelSwitchBetween(last, turn.selection),
      };
    },
    effectiveSelection,
  };
}
