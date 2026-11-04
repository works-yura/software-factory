import type { ExternalWorkItemSource } from '../card.ts';
import type { RuleFacts } from '../rules/rule-group.ts';
import { authorTrusted } from '../rules/types.ts';

/** The card fields a condition reads; a stored work item row satisfies it. */
type FactsCard = {
  readonly title: string;
  readonly metadata: Record<string, unknown> | null;
  readonly externalSource: ExternalWorkItemSource | null;
};

/** What a condition (`autoStartWhen`, `exitTool.autoApproveWhen`, an intake route's `when`) can test about a card. */
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
    'author.trusted': authorTrusted(metadata),
    ...(source
      ? {
          'source.kind': source.type === 'pull-request' ? 'pull_request' : source.type,
          'source.integration': source.integrationId,
        }
      : {}),
  };
}
