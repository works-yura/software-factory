// Generic helpers over a `ModelSelection`, shared by every harness's model facet.
import type { ModelSelection, ProviderOptionDescriptor, ProviderOptionSelection, ServerProviderModel } from './contracts.ts';
import { modelSelectionsEqual, withLegacyUltracodeEffort } from './model.ts';

/** The option id of a model's reasoning level in every harness's selections (`REASONING_EFFORT_OPTION_IDS`). */
export const EFFORT_OPTION_ID = 'effort';

export type ModelSelectionCheck =
  | { readonly ok: true; readonly selection: ModelSelection }
  | { readonly ok: false; readonly error: string };

function describeDescriptor(descriptor: ProviderOptionDescriptor): string {
  return descriptor.type === 'boolean'
    ? `${descriptor.id} (true or false)`
    : `${descriptor.id} (${descriptor.options.map(option => option.id).join(', ')})`;
}

/**
 * Checks a selection against a model's descriptors: every option must be one the model has, with
 * a value it offers. A legacy `effort: "ultracode"` reads as Extra High plus the Ultracode toggle.
 */
export function checkOptionSelections(
  model: Pick<ServerProviderModel, 'slug' | 'capabilities'>,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): { ok: true; options: ProviderOptionSelection[] } | { ok: false; error: string } {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const selections = withLegacyUltracodeEffort(descriptors, options) ?? [];
  for (const selection of selections) {
    const descriptor = descriptors.find(candidate => candidate.id === selection.id);
    const valid =
      descriptor?.type === 'boolean'
        ? typeof selection.value === 'boolean'
        : descriptor?.type === 'select' &&
          typeof selection.value === 'string' &&
          descriptor.options.some(option => option.id === selection.value);
    if (!valid) {
      const accepted = descriptors.length ? `Options: ${descriptors.map(describeDescriptor).join('; ')}.` : 'It has no options.';
      return {
        ok: false,
        error: descriptor
          ? `${model.slug} has no ${selection.id} ${JSON.stringify(selection.value)}. ${accepted}`
          : `${model.slug} has no option ${selection.id}. ${accepted}`,
      };
    }
  }
  return { ok: true, options: selections.map(selection => ({ ...selection })) };
}

/**
 * A selection checked against a catalog: the model must be one it lists (by slug or alias) and the
 * options its own. What a harness whose catalog is plain data (no aliases to keep, no defaults to
 * fill) needs for `HarnessModels.check`.
 */
export function checkModelSelection(
  instanceId: string,
  models: ReadonlyArray<ServerProviderModel>,
  input: { model: string; options?: ReadonlyArray<ProviderOptionSelection> | undefined },
): ModelSelectionCheck {
  const requested = input.model.trim();
  const model =
    models.find(candidate => candidate.slug === requested) ??
    models.find(candidate => candidate.aliases?.includes(requested));
  if (!model) {
    return { ok: false, error: `Unknown model ${requested}. Models: ${models.map(candidate => candidate.slug).join(', ')}.` };
  }
  const options = checkOptionSelections(model, input.options);
  if (!options.ok) return options;
  return {
    ok: true,
    selection: { instanceId, model: model.slug, ...(options.options.length ? { options: options.options } : {}) },
  };
}

/** The `modelSwitch` marker for a turn that runs `to` after a turn that ran `from`; none for the first. */
export function modelSwitchBetween(
  from: ModelSelection | null | undefined,
  to: ModelSelection | null | undefined,
): { modelSwitch: { from: ModelSelection; to: ModelSelection } } | Record<string, never> {
  return !from || !to || modelSelectionsEqual(from, to) ? {} : { modelSwitch: { from, to } };
}
