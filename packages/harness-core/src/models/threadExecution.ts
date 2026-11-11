// From t3code packages/client-runtime/src/state/threadExecution.ts: the reasoning option ids and
// `formatModelSelectionEffort` only (the rest is t3code's thread projection).
import type { ModelSelection, ServerProviderModel } from "./contracts.ts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionStatedValue,
  withLegacyUltracodeEffort,
} from "./model.ts";

export const REASONING_EFFORT_OPTION_IDS: ReadonlyArray<string> = [
  "reasoningEffort",
  "effort",
  "reasoning",
  "variant",
  "reasoning_effort",
  "thinking_level",
];

export function formatModelSelectionEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> = [],
  reportedSelection?: ModelSelection | null,
): string | null {
  const caps = models.find((model) => model.slug === selection.model)?.capabilities;
  if (!caps) return null;
  const options = withLegacyUltracodeEffort(caps.optionDescriptors, selection.options);
  const current = options ? { ...selection, options } : selection;
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const descriptor = caps.optionDescriptors?.find((candidate) => candidate.id === id);
    if (descriptor?.type !== "select") continue;
    const value = getProviderOptionStatedValue(id, current, reportedSelection);
    if (value === undefined && id !== "variant") continue;
    if (typeof value === "boolean") continue;
    // Bypass picker normalization so an obsolete choice cannot become a catalog default.
    const label = getProviderOptionCurrentLabel(
      { ...descriptor, currentValue: value },
      current,
      reportedSelection,
    );
    if (label) return label;
  }
  return null;
}
