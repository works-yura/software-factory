import type { ExternalWorkItemSource } from '../card.ts';
import type { RuleFacts } from '../rules/rule-group.ts';

/** The card fields a phase condition reads; a stored work item row satisfies it. */
type FactsCard = {
  readonly title: string;
  readonly metadata: Record<string, unknown> | null;
  readonly externalSource: ExternalWorkItemSource | null;
};

/** What a phase condition (`autoStartWhen`, `exitTool.autoApproveWhen`) can test about a card. */
export function cardRuleFacts(item: FactsCard): RuleFacts {
  const metadata = item.metadata ?? {};
  const labels = Array.isArray(metadata.labels)
    ? metadata.labels.filter((label): label is string => typeof label === 'string')
    : [];
  const source = item.externalSource;
  return {
    'item.labels': labels,
    'item.title': item.title,
    ...(typeof metadata.author === 'string' ? { 'item.author': metadata.author } : {}),
    ...(source
      ? {
          'source.kind': source.type === 'pull-request' ? 'pull_request' : source.type,
          'source.integration': source.integrationId,
        }
      : {}),
  };
}
