import type { ExternalWorkItemSource } from '../card.ts';
import { INTAKE_RULE_SOURCE_KIND, intakeRuleOrigin } from '../intake/card-origin.ts';
import type { RuleFacts } from '../rules/rule-group.ts';
import { authorTrusted } from '../rules/types.ts';

/** The provider facts a condition reads; the stored card's `workItem` satisfies it. */
export type CardSourceFacts = {
  readonly labels: readonly string[];
  readonly author: string | null;
};

/** The card fields a condition reads; a stored card satisfies it. */
type FactsCard = {
  readonly title: string;
  readonly metadata: Record<string, unknown> | null;
  readonly externalSource: ExternalWorkItemSource | null;
  /** The source's own facts (upstream #28960); without them, the intake metadata still carries labels and author. */
  readonly workItem?: CardSourceFacts;
};

/** Labels as an arrival carries them: plain names, or GitHub-shaped `{ name }` objects (as the store's adapters read them). */
function metadataLabels(metadata: Record<string, unknown>): string[] {
  if (!Array.isArray(metadata.labels)) return [];
  return metadata.labels.flatMap((label: unknown) => {
    if (typeof label === 'string') return [label];
    const name = label && typeof label === 'object' ? (label as { name?: unknown }).name : undefined;
    return typeof name === 'string' ? [name] : [];
  });
}

/** What a condition (`autoStartWhen`, `exitTool.autoApproveWhen`, an intake route's `when`) can test about a card. */
export function cardRuleFacts(item: FactsCard): RuleFacts {
  const source = item.externalSource;
  const metadata = item.metadata ?? {};
  // A sourced card reads its provider's facts; a Factory-native card keeps them in its metadata.
  const provider = source && item.workItem ? item.workItem : undefined;
  const labels = provider ? [...provider.labels] : metadataLabels(metadata);
  const author = provider ? provider.author : typeof metadata.author === 'string' ? metadata.author : null;
  // A card an intake rule filed has no provider record; its rule stands in as the source.
  const ruleOrigin = source ? undefined : intakeRuleOrigin(item.metadata);
  return {
    'item.labels': labels,
    'item.title': item.title,
    ...(author !== null ? { 'item.author': author } : {}),
    // Trust is Factory's stamp, so it stays on the board item.
    'author.trusted': authorTrusted(item.metadata),
    ...(source
      ? {
          'source.kind': source.type === 'pull-request' ? 'pull_request' : source.type,
          'source.integration': source.integrationId,
        }
      : ruleOrigin
        ? {
            'source.kind': INTAKE_RULE_SOURCE_KIND,
            'intake.rule': ruleOrigin.id,
            'intake.trigger': ruleOrigin.triggerKind,
          }
        : {}),
  };
}
