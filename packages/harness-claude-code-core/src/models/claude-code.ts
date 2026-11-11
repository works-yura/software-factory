// Claude Code's side of model selection: the instance id its selections carry, the CLI aliases a
// Factory may pin, and the CLI's view of a selection (`--model`, `--effort`, `--settings`, the
// Ultrathink prompt prefix). Pure: the facet (`./harness-models.ts`) and the UI both read it.
import type { ModelSelection, ProviderOptionSelection, ServerProviderModel } from '@factory/harness/models/contracts';
import { checkOptionSelections, EFFORT_OPTION_ID, type ModelSelectionCheck } from '@factory/harness/models/selection';

import { BUNDLED_CLAUDE_MODEL_CATALOG, resolveClaudeModelSlug, type ClaudeModelCatalog } from './ClaudeModelCatalog.ts';
import { compileClaudeModelSelection } from './claudeModelOptions.ts';
import { CLAUDE_CODE_INSTANCE_ID, CLAUDE_CODE_MODELS, isClaudeCodeModel } from './aliases.ts';

export * from './aliases.ts';

/** The Claude Code models a session can pick: the bundled catalog, current ones first, legacy flagged. */
export function claudeCodeModels(catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG): ServerProviderModel[] {
  const models = catalog.models.map(entry => entry.model);
  return [...models.filter(model => !model.isLegacy), ...models.filter(model => model.isLegacy)];
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * A Factory's thinking level as a Claude Code effort. `off` has no CLI counterpart; the lowest
 * effort is the closest.
 */
export function claudeEffortForThinkingLevel(level: string | null | undefined): string | undefined {
  if (!level) return undefined;
  if (level === 'off') return 'low';
  return CLAUDE_EFFORTS.includes(level) ? level : undefined;
}

/** What one Claude Code turn passes to the CLI. */
export interface ClaudeCodeTurnSelection {
  /** The selection the turn runs, with the Factory defaults filled in: what a model-switch marker shows. */
  selection: ModelSelection | null;
  /** `--model`; unset leaves the CLI's own default. */
  model?: string;
  /** `--effort`. */
  effort?: string;
  /** An effort the CLI takes in the prompt (`ultrathink`): see `applyClaudePromptEffortPrefix`. */
  promptEffort?: string;
  /** Merged into `--settings` (`fastMode`, `ultracode`, `alwaysThinkingEnabled`). */
  settings?: Record<string, boolean>;
}

/**
 * The CLI flags for a Claude Code turn: the session's own selection when it has one, else the
 * Factory's `claudeCodeModel`; the Factory's thinking level when the selection names no effort.
 * A CLI alias (`opus`) stays an alias on the command line, so it follows the CLI's current model,
 * unless an option (a `[1m]` context window) needs the full id.
 */
export function compileClaudeCodeTurn(
  input: {
    selection?: ModelSelection | null;
    projectModel?: string | null;
    factoryThinkingLevel?: string | null;
  },
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): ClaudeCodeTurnSelection {
  const model = input.selection?.model?.trim() || input.projectModel?.trim() || undefined;
  const fallbackEffort = claudeEffortForThinkingLevel(input.factoryThinkingLevel);
  const explicit = input.selection?.options ?? [];
  const options: ProviderOptionSelection[] = [
    ...explicit,
    ...(fallbackEffort && !explicit.some(option => option.id === EFFORT_OPTION_ID)
      ? [{ id: EFFORT_OPTION_ID, value: fallbackEffort }]
      : []),
  ];
  if (!model) {
    const effort = options.find(option => option.id === EFFORT_OPTION_ID)?.value;
    const cliEffort = typeof effort === 'string' && CLAUDE_EFFORTS.includes(effort) ? effort : undefined;
    return { selection: null, ...(cliEffort ? { effort: cliEffort } : {}) };
  }
  const selection: ModelSelection = {
    instanceId: CLAUDE_CODE_INSTANCE_ID,
    model,
    ...(options.length ? { options } : {}),
  };
  const compiled = compileClaudeModelSelection(selection, catalog);
  const slug = resolveClaudeModelSlug(catalog, model);
  const cliModel = isClaudeCodeModel(model) && compiled.apiModelId === slug ? model : compiled.apiModelId;
  return {
    selection,
    model: cliModel,
    ...(compiled.effort ? { effort: compiled.effort } : {}),
    ...(compiled.promptEffort ? { promptEffort: compiled.promptEffort } : {}),
    ...(Object.keys(compiled.settings).length ? { settings: { ...compiled.settings } } : {}),
  };
}

/**
 * A Claude Code session's selection, checked against the catalog: the model must be one it lists
 * (by slug or alias) and the options its own. A CLI alias is kept; another alias becomes the slug.
 */
export function checkClaudeCodeModelSelection(
  input: { model: string; options?: ReadonlyArray<ProviderOptionSelection> | undefined },
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): ModelSelectionCheck {
  const requested = input.model.trim();
  const slug = resolveClaudeModelSlug(catalog, requested);
  const entry = catalog.models.find(candidate => candidate.model.slug === slug);
  if (!entry) {
    const known = catalog.models.filter(candidate => !candidate.model.isLegacy).map(candidate => candidate.model.slug);
    return {
      ok: false,
      error: `Unknown Claude Code model ${requested}. Models: ${[...CLAUDE_CODE_MODELS, ...known].join(', ')}.`,
    };
  }
  const options = checkOptionSelections(entry.model, input.options);
  if (!options.ok) return options;
  return {
    ok: true,
    selection: {
      instanceId: CLAUDE_CODE_INSTANCE_ID,
      model: isClaudeCodeModel(requested) ? requested : slug,
      ...(options.options.length ? { options: options.options } : {}),
    },
  };
}
