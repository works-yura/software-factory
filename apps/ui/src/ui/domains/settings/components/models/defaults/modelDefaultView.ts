// What the default-model row of one harness instance shows and writes, from the instance alone
// (`ProviderInstanceEntry`: its catalog, descriptors and defaults). Nothing here knows a harness.
import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProviderModel,
} from '@factory/harness/models/contracts';
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from '@factory/harness/models/model';
import { isReasoningControl, selectableProviderOptionChoices } from '@factory/harness/models/modelTraits';

import { findProviderModel } from '../../../../chat/components/modelPicker/TraitsPicker';
import type { ProviderInstanceEntry } from '../../../../chat/components/modelPicker/providerInstances';

export type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: 'select' }>;
export type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: 'boolean' }>;

/** The row's state: what it shows, and whether that is the Factory's own pick or the catalog's. */
export interface ModelDefaultView {
  /** The selection the row shows: the Factory's default, else the catalog's. */
  selection: ModelSelection | null;
  /** The Factory set its own default; "Use catalog default" clears it. */
  isFactoryDefault: boolean;
  /** The catalog model of `selection`, when the catalog still lists it. */
  model: ServerProviderModel | undefined;
  /** The model's reasoning select (`role: 'reasoning'` or a known effort id), with its value. */
  reasoning: SelectDescriptor | null;
  /** Every other option of the model, in catalog order, with its value. */
  others: ReadonlyArray<ProviderOptionDescriptor>;
}

export function modelDefaultView(entry: ProviderInstanceEntry): ModelDefaultView {
  const selection = entry.factoryDefault ?? entry.catalogDefault;
  const model = selection ? findProviderModel(entry.models, selection.model) : undefined;
  const descriptors = model
    ? getProviderOptionDescriptors({ caps: model.capabilities ?? {}, selections: selection?.options ?? [] })
    : [];
  const reasoning =
    descriptors.find((descriptor): descriptor is SelectDescriptor => descriptor.type === 'select' && isReasoningControl(descriptor)) ??
    null;
  return {
    selection,
    isFactoryDefault: entry.factoryDefault !== null,
    model,
    reasoning: reasoning && selectableProviderOptionChoices(reasoning).length > 0 ? reasoning : null,
    others: descriptors.filter(descriptor => descriptor !== reasoning && optionHasChoice(descriptor)),
  };
}

function optionHasChoice(descriptor: ProviderOptionDescriptor): boolean {
  return descriptor.type === 'boolean' || selectableProviderOptionChoices(descriptor).length > 1;
}

/**
 * A select's shown value: the stored one, else the choice the model marks as its default; none
 * when the model leaves it to the harness (nothing shows as picked until the Factory picks).
 */
export function selectValue(descriptor: SelectDescriptor): string {
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === 'string' ? value : '';
}

export function booleanValue(descriptor: BooleanDescriptor): boolean {
  return getProviderOptionCurrentValue(descriptor) === true;
}

/** The selection with one option set: the others the Factory picked stay. */
export function withOption(selection: ModelSelection, id: string, value: string | boolean): ModelSelection {
  const options = [...(selection.options ?? []).filter(option => option.id !== id), { id, value }];
  return { ...selection, options };
}

/**
 * A new model, keeping the options the Factory picked that the new model also offers (an effort
 * it has, a toggle it knows); the rest fall back to the new model's defaults.
 */
export function withModel(
  selection: ModelSelection | null,
  instanceId: string,
  model: ServerProviderModel,
): ModelSelection {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const kept: ProviderOptionSelection[] = (selection?.options ?? []).filter(option => {
    const descriptor = descriptors.find(candidate => candidate.id === option.id);
    if (!descriptor) return false;
    return descriptor.type === 'boolean'
      ? typeof option.value === 'boolean'
      : selectableProviderOptionChoices(descriptor).some(choice => choice.id === option.value);
  });
  return { instanceId, model: model.slug, ...(kept.length ? { options: kept } : {}) };
}

/** The model's name as the catalog gives it, else its id. */
export function modelLabel(entry: ProviderInstanceEntry, selection: ModelSelection | null): string | null {
  if (!selection) return null;
  return findProviderModel(entry.models, selection.model)?.name ?? selection.model;
}
