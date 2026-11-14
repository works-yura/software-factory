import type { ExternalWorkItemSource, WorkItemSourceRow } from '../card.ts';
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
 * `acme/app#12`, or `acme/app/dependabot#3` for a Dependabot alert) or a GitLab project path, subgroups included (`acme/platform/api` from
 * `acme/platform/api#3` or `…!7`). Null when the key doesn't say or the provider has no such scope.
 */
export function sourceRepository(provider: string | undefined, key: string | null | undefined): string | null {
  if (!key) return null;
  // A Dependabot alert's key names its repository too: `acme/app/dependabot#3`.
  if (provider === 'github') return /^([^/#]+\/[^/#]+)(?:\/dependabot)?#\d+$/.exec(key)?.[1] ?? null;
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
export type FactsCard = {
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
  const alert = source?.type === DEPENDABOT_ALERT_SOURCE_TYPE ? (provider?.metadata ?? metadata) : undefined;
  const pullRequest =
    openChangeRequests(item.metadata).at(-1)?.number ?? newestOpenPullRequestNumber({ workItem: item.workItem ?? null });
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
          'source.kind': sourceKind(source.type),
          'source.integration': source.integrationId,
          ...(providerName ? { 'source.provider': providerName } : {}),
          ...(repository !== null ? { 'source.repository': repository } : {}),
          ...(list !== null ? { 'source.list': list } : {}),
        }
      : {}),
    ...(alert ? alertFacts(alert) : {}),
  };
}

/** The source type of a GitHub Dependabot alert card (`ExternalWorkItemSource.type`). */
export const DEPENDABOT_ALERT_SOURCE_TYPE = 'dependabot-alert';

/** What a condition's `source.kind` reads for a source type: `pull_request`, `dependabot_alert`, `issue`, `task`. */
function sourceKind(type: string): string {
  if (type === 'pull-request') return 'pull_request';
  if (type === DEPENDABOT_ALERT_SOURCE_TYPE) return 'dependabot_alert';
  return type;
}

/** A Dependabot alert's facts, read from the metadata its sweep stores (`dependabotSeverity`…). */
function alertFacts(metadata: Record<string, unknown>): RuleFacts {
  const text = (key: string) => (typeof metadata[key] === 'string' && metadata[key] ? (metadata[key] as string) : null);
  const severity = text('dependabotSeverity');
  const ecosystem = text('dependabotEcosystem');
  const pkg = text('dependabotPackage');
  return {
    ...(severity !== null ? { 'alert.severity': severity } : {}),
    ...(ecosystem !== null ? { 'alert.ecosystem': ecosystem } : {}),
    ...(pkg !== null ? { 'alert.package': pkg } : {}),
  };
}
