import type { ExternalWorkItemSource } from '@factory/core/card';
import { workItemSource } from '@factory/core/rules/types';
import type { WorkItemSource } from '@factory/core/rules/types';

/**
 * Where a card came from, as the board shows and filters it. A card a trigger route filed is the
 * Factory's own, so it reads as `manual`, as the browser has always shown it.
 */
export type CardSource = Exclude<WorkItemSource, 'intake-route'>;

export function cardSource(externalSource: ExternalWorkItemSource | null): CardSource {
  const source = workItemSource(externalSource);
  return source === 'intake-route' ? 'manual' : source;
}
