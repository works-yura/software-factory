import type { ExternalWorkItemSource, WorkItemSourceRow } from '../card.ts';
import { INTAKE_RULE_SOURCE_KIND, intakeRuleOrigin } from '../intake/card-origin.ts';
import type { RuleFacts } from '../rules/rule-group.ts';
import { authorTrusted } from '../rules/types.ts';
import { openChangeRequests } from '../change-requests.ts';
import { newestOpenPullRequestNumber } from './semantics.ts';

/** The provider facts a condition reads; the stored card's `workItem` satisfies it. */
export type CardSourceFacts = {
  readonly labels: readonly string[];
  readonly author: string | null;
  /** The card's sources, so a condition can see an attached open pull request. */
  readonly sources?: readonly WorkItemSourceRow[];
  /** The provider's key for the item: `acme/app#42`, `group/project!7`. */
  readonly key?: string | null;
  /** The item's state at its provider (`open`, `closed`, `merged`). */
  readonly state?: string | null;
  /** Which provider holds the item (`github`, `gitlab`, `clickup`). */
  readonly provider?: string;
  /** What the provider reported beyond the shared fields, such as `assignees`. */
  readonly metadata?: Record<string, unknown> | null;
};

/**
 * Where an item lives at its provider, read from its key: a GitHub repository (`acme/app` from
 * `acme/app#12`) or a GitLab project path, subgroups included (`acme/platform/api` from
 * `acme/platform/api#3` or `…!7`). Null when the key doesn't say or the provider has no such scope.
 */
export function sourceRepository(provider: string | undefined, key: string | null | undefined): string | null {
  if (!key) return null;
  if (provider === 'github') return /^([^/#]+\/[^/#]+)#\d+$/.exec(key)?.[1] ?? null;
  if (provider === 'gitlab') return /^([^#!]+\/[^#!]+)[#!]\d+$/.exec(key)?.[1] ?? null;
  return null;
}

/** Who an item is assigned to, as its metadata says: a list, or the one assignee. */
function assignees(metadata: Record<string, unknown> | null | undefined): string[] {
  const listed = Array.isArray(metadata?.assignees)
    ? metadata.assignees.flatMap((entry: unknown) => {
        if (typeof entry === 'string') return entry ? [entry] : [];
        const login = entry && typeof entry === 'object' ? (entry as { login?: unknown }).login : undefined;
        return typeof login === 'string' && login ? [login] : [];
      })
    : [];
  if (listed.length > 0) return listed;
  const one = metadata?.assignee;
  return typeof one === 'string' && one ? [one] : [];
}

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
  const key = provider?.key ?? null;
  const state = provider?.state ?? null;
  const providerName = provider?.provider ?? source?.integrationId;
  const repository = source ? sourceRepository(providerName, key) : null;
  const listValue = provider?.metadata?.listId ?? metadata.listId;
  const list = source && typeof listValue === 'string' && listValue ? listValue : null;
  // The open change request: the newest one Factory opened for the card, else an attached open one.
  const pullRequest =
    openChangeRequests(item.metadata).at(-1)?.number ?? newestOpenPullRequestNumber({ workItem: item.workItem ?? null });
  // A card an intake rule filed has no provider record; its rule stands in as the source.
  const ruleOrigin = source ? undefined : intakeRuleOrigin(item.metadata);
  return {
    'item.labels': labels,
    'item.title': item.title,
    ...(author !== null ? { 'item.author': author } : {}),
    ...(key !== null ? { 'item.key': key } : {}),
    ...(state !== null ? { 'item.state': state } : {}),
    'item.assignees': assignees(provider?.metadata ?? metadata),
    // Trust is Factory's stamp, so it stays on the board item.
    'author.trusted': authorTrusted(item.metadata),
    ...(pullRequest !== null ? { 'item.pullRequest': pullRequest } : {}),
    ...(source
      ? {
          'source.kind': source.type === 'pull-request' ? 'pull_request' : source.type,
          'source.integration': source.integrationId,
          ...(providerName ? { 'source.provider': providerName } : {}),
          ...(repository !== null ? { 'source.repository': repository } : {}),
          ...(list !== null ? { 'source.list': list } : {}),
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
