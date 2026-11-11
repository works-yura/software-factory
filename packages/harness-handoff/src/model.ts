// Ported from t3code packages/shared/src/{model,Array}.ts: only `modelSelectionsEqual` and
// what it calls.
import type { ModelSelection } from "./contracts.ts";

export function copySorted<T>(
  values: ReadonlyArray<T>,
  compareFn?: (left: T, right: T) => number,
): T[] {
  return [...values].sort(compareFn);
}

function canonicalModelSelectionOptions(
  modelSelection: ModelSelection,
): ReadonlyArray<readonly [id: string, value: string | boolean]> {
  return copySorted(
    (modelSelection.options ?? []).map(
      (selection): readonly [id: string, value: string | boolean] => [
        selection.id,
        selection.value,
      ],
    ),
    (
      [leftId, leftValue]: readonly [id: string, value: string | boolean],
      [rightId, rightValue]: readonly [id: string, value: string | boolean],
    ) => {
      const idOrder = leftId.localeCompare(rightId);
      return idOrder !== 0 ? idOrder : String(leftValue).localeCompare(String(rightValue));
    },
  );
}

export function modelSelectionsEqual(left: ModelSelection, right: ModelSelection): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) {
    return false;
  }
  const leftOptions = canonicalModelSelectionOptions(left);
  const rightOptions = canonicalModelSelectionOptions(right);
  return (
    leftOptions.length === rightOptions.length &&
    leftOptions.every(
      ([id, value], index) => id === rightOptions[index]?.[0] && value === rightOptions[index]?.[1],
    )
  );
}

/**
 * From t3code packages/shared/src/orchestrationV2ThreadError.ts. `completedAt` is an ISO string
 * here, not `DateTime.Utc`.
 */
/** Held queues can execute out of ordinal order; unfinished runs count as latest. */
export function runRanAfter(
  run: { readonly ordinal: number; readonly completedAt: string | null },
  other: { readonly ordinal: number; readonly completedAt: string | null },
): boolean {
  const end = (candidate: typeof run) =>
    !candidate.completedAt ? Number.POSITIVE_INFINITY : Date.parse(candidate.completedAt);
  return end(run) === end(other) ? run.ordinal > other.ordinal : end(run) > end(other);
}
