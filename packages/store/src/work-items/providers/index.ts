import type { ExternalWorkItemSource } from '../base.ts';
import { externalAdapter } from './base.ts';
import { factoryWorkItemAdapter } from './factory.ts';
import { githubWorkItemAdapter } from './github.ts';
import { gitlabWorkItemAdapter } from './gitlab.ts';
import { stringValue } from './metadata-keys.ts';
import type { WorkItemProviderAdapter } from './types.ts';

export type { ProviderWorkItemSource, WorkItemProviderAdapter } from './types.ts';
export { BOARD_METADATA_KEYS, SHARED_PROVIDER_METADATA_KEYS, splitCardMetadata } from './metadata-keys.ts';

/** Integrations without an adapter of their own (ClickUp, and any app integration): keyed by the identifier, shared keys only. */
const customWorkItemAdapter = externalAdapter('custom', {
  providerFromSource: true,
  providerMetadataKeys: [],
  key: (_source, metadata) => stringValue(metadata.identifier),
});

export const WORK_ITEM_PROVIDER_ADAPTERS: readonly WorkItemProviderAdapter[] = [
  githubWorkItemAdapter,
  gitlabWorkItemAdapter,
  factoryWorkItemAdapter,
];

/** The adapter that maps a card with this source onto a work item. */
export function workItemProviderAdapter(source: ExternalWorkItemSource | null): WorkItemProviderAdapter {
  if (!source) return factoryWorkItemAdapter;
  return (
    WORK_ITEM_PROVIDER_ADAPTERS.find(
      adapter => adapter !== factoryWorkItemAdapter && adapter.provider === source.integrationId,
    ) ?? customWorkItemAdapter
  );
}
