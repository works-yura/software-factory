import { sourceExternalId } from '@factory/core/boards/semantics';
import { AUTO_TRIAGED_LABEL, NEEDS_APPROVAL_LABEL } from '@factory/core/rules/types';
import { workItemBranch, workItemThreadTitle } from '@factory/pipelines/shared/work-item-branch';
import { isValid } from 'date-fns';

import type { InstalledPhaseInfo } from '../../../api/types';
import { relativeTime } from '../../../lib/date/relativeTime';
import { phaseTitle } from '../../i18n/boardLabels';
import { lazyLabels } from '../../i18n/lazy';
import { translator } from '../../i18n/t';
import type { WorkItem, WorkItemSessionRef, WorkItemSource } from './services/workItems';

export const HIDDEN_CARD_LABELS = new Set([AUTO_TRIAGED_LABEL, NEEDS_APPROVAL_LABEL]);

const tk = translator('board');

const WORK_ITEM_SOURCES = [
  'github-issue',
  'github-pr',
  'gitlab-issue',
  'gitlab-pr',
  'clickup-task',
  'github-dependabot-alert',
  'manual',
] as const satisfies readonly WorkItemSource[];

export const SOURCE_LABELS: Readonly<Record<WorkItemSource, string>> = lazyLabels(
  WORK_ITEM_SOURCES,
  source => `board:sources.${source}`,
);

export function hasLabel(labels: readonly string[], label: string): boolean {
  return labels.some(item => item.toLowerCase() === label);
}

/** Native cards and unfiled candidates keep their facts in placement metadata. */
export function sourceMetadata(item: Pick<WorkItem, 'metadata' | 'workItem'>): Record<string, unknown> {
  if (!item.workItem || item.workItem.provider === 'factory') return item.metadata;
  return {
    ...item.workItem.metadata,
    labels: item.workItem.labels,
    author: item.workItem.author,
    state: item.workItem.state,
    identifier: item.workItem.key,
  };
}

export function metadataLabelColors(metadata: Record<string, unknown>): Record<string, string> {
  if (!metadata.labelColors || typeof metadata.labelColors !== 'object' || Array.isArray(metadata.labelColors))
    return {};
  return Object.fromEntries(
    Object.entries(metadata.labelColors).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(entry[1]) || /^[a-z]+$/i.test(entry[1])),
    ),
  );
}

export function githubNumberForItem(item: Pick<WorkItem, 'source' | 'workItem' | 'metadata'>): number | undefined {
  const metadata = sourceMetadata(item);
  if (item.source !== 'github-issue' && item.source !== 'github-pr') return;
  const metadataKey = item.source === 'github-issue' ? 'githubIssueNumber' : 'githubPullRequestNumber';
  const itemNumber = metadata[metadataKey] ?? metadata.number;
  if (typeof itemNumber !== 'number' || !Number.isInteger(itemNumber) || itemNumber <= 0) return;
  return itemNumber;
}

/** The change-request number a review card carries: a GitHub PR number or a GitLab MR iid. */
export function changeRequestNumberForItem(
  item: Pick<WorkItem, 'source' | 'workItem' | 'metadata'>,
): number | undefined {
  const metadata = sourceMetadata(item);
  if (item.source === 'github-pr') return githubNumberForItem(item);
  if (item.source !== 'gitlab-pr') return;
  const iid = metadata.gitlabMergeRequestIid;
  return typeof iid === 'number' && Number.isSafeInteger(iid) && iid > 0 ? iid : undefined;
}

export function gitlabIdentifierForItem(item: Pick<WorkItem, 'source' | 'workItem' | 'metadata'>): string | undefined {
  const metadata = sourceMetadata(item);
  if (item.source === 'gitlab-issue' && typeof metadata.identifier === 'string') return metadata.identifier;
  if (item.source !== 'gitlab-pr') return;
  const iid = metadata.gitlabMergeRequestIid;
  return typeof iid === 'number' && Number.isSafeInteger(iid) && iid > 0 ? `!${iid}` : undefined;
}

export type PullRequestStatus = 'draft' | 'open' | 'closed' | 'merged';

export const PULL_REQUEST_STATUS_LABELS: Readonly<Record<PullRequestStatus, string>> = lazyLabels(
  ['draft', 'open', 'closed', 'merged'],
  status => `board:pullRequestStatus.${status}`,
);

export function pullRequestStatusForItem(item: Pick<WorkItem, 'workItem' | 'metadata' | 'stages'>): PullRequestStatus {
  const metadata = sourceMetadata(item);
  if (metadata.state === 'merged' || metadata.merged === true) return 'merged';
  if (metadata.state === 'closed') return 'closed';
  if (metadata.state === 'open') return metadata.draft === true ? 'draft' : 'open';
  if (item.stages.includes('done')) return 'merged';
  if (item.stages.includes('canceled')) return 'closed';
  return metadata.draft === true ? 'draft' : 'open';
}

/** Status of a pull request attached to an issue card, read from that source alone. */
export function pullRequestStatusForSource(source: {
  state: string | null;
  metadata: Record<string, unknown> | null;
}): PullRequestStatus {
  const metadata = source.metadata ?? {};
  const state = source.state ?? metadata.state;
  if (state === 'merged' || metadata.merged === true) return 'merged';
  if (state === 'closed') return 'closed';
  return metadata.draft === true ? 'draft' : 'open';
}

/**
 * Source key for a GitHub issue or pull request. Numbers repeat across a
 * project's repositories, so the key is repository-scoped whenever the
 * repository is known; the bare-number form remains for legacy callers.
 */
export function githubSourceKey(kind: 'issue' | 'pull-request', itemNumber: number, repositoryId?: number): string {
  if (repositoryId !== undefined) return `github:${repositoryId}:${kind}:${itemNumber}`;
  return kind === 'issue' ? `github-issue:${itemNumber}` : `github-pr:${itemNumber}`;
}

/**
 * The candidate source key a card stands for. Cards stamped with their
 * repository match only that repository's candidate, even when the card
 * itself still carries a bare-number key from before keys were scoped.
 */
export function candidateSourceKeyForItem(item: WorkItem): string | undefined {
  const metadata = sourceMetadata(item);
  const itemNumber = githubNumberForItem(item);
  if (itemNumber === undefined) return;
  const repositoryId = typeof metadata.githubRepositoryId === 'number' ? metadata.githubRepositoryId : undefined;
  if (item.source === 'github-issue') return githubSourceKey('issue', itemNumber, repositoryId);
  if (item.source === 'github-pr') return githubSourceKey('pull-request', itemNumber, repositoryId);
  return;
}

/** Aria label for the icon-only external link next to a card title. */
export function externalLinkLabel(source: WorkItemSource): string {
  if (source === 'gitlab-issue' || source === 'gitlab-pr') return tk('externalLink.gitlab');
  if (source === 'clickup-task') return tk('externalLink.clickup');
  if (source === 'manual') return tk('externalLink.manual');
  return tk('externalLink.github');
}

/** When the issue/PR was opened upstream; `createdAt` is only when the factory first saw it, "just now" for every backfilled card. */
export function sourceCreatedAt(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.sourceCreatedAt;
  return typeof value === 'string' && isValid(new Date(value)) ? value : undefined;
}

/** The upstream key a card is known by: `#123` on GitHub. */
export function workItemKey(item: Pick<WorkItem, 'source' | 'workItem' | 'metadata'>): string | undefined {
  if (item.workItem?.provider !== 'factory' && item.workItem?.key) return item.workItem.key;
  const githubNumber = githubNumberForItem(item);
  if (githubNumber !== undefined) return `#${githubNumber}`;
  const cardNumber = item.source === 'manual' ? sourceMetadata(item).cardNumber : undefined;
  if (typeof cardNumber === 'number' && Number.isInteger(cardNumber) && cardNumber > 0) return `#${cardNumber}`;
  return gitlabIdentifierForItem(item);
}

export function workItemMeta(item: WorkItem): string {
  const metadata = sourceMetadata(item);
  const author = typeof metadata.author === 'string' ? metadata.author : undefined;
  const assignee = typeof metadata.assignee === 'string' ? metadata.assignee : undefined;
  const age = relativeTime(sourceCreatedAt(metadata) ?? item.createdAt);
  const key = workItemKey(item);
  if (key === undefined) return `${SOURCE_LABELS[item.source]} · ${age}`;
  const owner = githubNumberForItem(item) === undefined ? (assignee ?? author) : author;
  return `${key}${owner ? ` · ${owner}` : ''} · ${age}`;
}

/**
 * Branch + thread title for a card's session, shared with the server's runs
 * (`workItemBranch`), so the title click and a later run converge on one
 * worktree.
 */
export function itemSessionSpec(item: WorkItem): { branch: string; threadTitle: string } {
  const input = { ...item, metadata: { ...item.metadata, ...sourceMetadata(item) } };
  return { branch: workItemBranch(input), threadTitle: workItemThreadTitle(input) };
}

/**
 * The card's single conversation. A work item keeps one threadId for its whole
 * lifecycle — every run reuses the worktree's thread — so the card title links
 * to exactly one thread. Items filed while session scoping was broken may
 * still carry divergent role refs; prefer the earliest lifecycle role because
 * JSON object key order is not a stable record of which ref was filed first.
 */
export function itemThreadSession(sessions: Record<string, WorkItemSessionRef>): WorkItemSessionRef | undefined {
  return (
    sessions.triage ?? sessions.plan ?? sessions.work ?? sessions.review ?? sessions.chat ?? Object.values(sessions)[0]
  );
}

export type ContextPhase = Pick<InstalledPhaseInfo, 'id' | 'title' | 'name' | 'context' | 'role'>;

export interface CardContextSession {
  context: string;
  label: string;
  ref: WorkItemSessionRef;
  /** The card's current phase runs in this context. */
  current: boolean;
}

const KNOWN_CONTEXTS = ['triage', 'work', 'review', 'plan', 'chat', 'product', 'audit'] as const;

const CONTEXT_LABELS: Readonly<Record<string, string>> = lazyLabels(
  KNOWN_CONTEXTS,
  context => `board:sessionContext.${context}`,
);

/** A phase's name, translated for built-in boards when the board is known. */
export function phaseLabel(phase: Pick<ContextPhase, 'id' | 'title' | 'name'>, boardId?: string): string {
  const fallback = phase.name ?? phase.title;
  return boardId === undefined ? fallback : phaseTitle(boardId, phase.id, fallback);
}

/** The session context a phase runs in; `role` is its deprecated name. */
export function phaseContext(phase: Pick<ContextPhase, 'context' | 'role'>): string | undefined {
  return phase.context ?? phase.role;
}

/** A context named after its one phase, else by its well-known name, else by its key. */
export function contextLabel(
  context: string,
  phases: readonly ContextPhase[] | undefined,
  boardId?: string,
): string {
  const running = phases?.filter(phase => phaseContext(phase) === context) ?? [];
  if (running.length === 1) return phaseLabel(running[0], boardId);
  if (Object.hasOwn(CONTEXT_LABELS, context)) return CONTEXT_LABELS[context];
  return context.charAt(0).toUpperCase() + context.slice(1);
}

/**
 * The session a card holds in a context. Cards planned before Planning moved
 * into `work` hold their planner under the old `plan` key, which stands in for
 * `work` until the card gets a `work` session, unless a phase runs in `plan`.
 */
function contextSession(
  item: Pick<WorkItem, 'sessions'>,
  phases: readonly ContextPhase[],
  context: string,
): WorkItemSessionRef | undefined {
  const legacyPlanner = context === 'work' && !phases.some(phase => phaseContext(phase) === 'plan');
  return item.sessions[context] ?? (legacyPlanner ? item.sessions.plan : undefined);
}

/** Contexts holding a session, by the card's current phase first, then its most recently visited phases. */
function visitedContexts(
  item: Pick<WorkItem, 'sessions' | 'stageHistory'>,
  phases: readonly ContextPhase[],
  columnStage: string,
): string[] {
  const contexts: string[] = [];
  for (const stage of [columnStage, ...item.stageHistory.map(entry => entry.stage).reverse()]) {
    const phase = phases.find(candidate => candidate.id === stage);
    const context = phase && phaseContext(phase);
    if (context !== undefined && contextSession(item, phases, context) && !contexts.includes(context)) {
      contexts.push(context);
    }
  }
  return contexts;
}

/**
 * Every session a card holds, one per context: the context its current phase
 * runs in first, then the contexts of its most recently visited phases, then
 * the rest. A session filed under two keys is listed once, under the first.
 */
export function cardContextSessions(
  item: Pick<WorkItem, 'sessions' | 'stageHistory'>,
  phases: readonly ContextPhase[] | undefined,
  columnStage: string,
  boardId?: string,
): CardContextSession[] {
  const currentPhase = phases?.find(phase => phase.id === columnStage);
  const currentContext = currentPhase && phaseContext(currentPhase);
  const visited = phases ? visitedContexts(item, phases, columnStage) : [];
  const order = [...new Set([...visited, ...Object.keys(item.sessions)])];
  const seen = new Set<string>();
  return order.flatMap(context => {
    const ref = (phases && contextSession(item, phases, context)) ?? item.sessions[context];
    if (!ref) return [];
    const key = `${ref.sessionId}:${ref.threadId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ context, label: contextLabel(context, phases, boardId), ref, current: context === currentContext }];
  });
}

/**
 * The session a card opens: its current phase's context, else the context of
 * the phase it last visited. Without a board catalog, or when no visited phase
 * holds a session, it keeps the lifecycle order of `itemThreadSession`.
 */
export function cardThreadSession(
  item: Pick<WorkItem, 'sessions' | 'stageHistory'>,
  phases: readonly ContextPhase[] | undefined,
  columnStage: string,
): WorkItemSessionRef | undefined {
  const context = phases && visitedContexts(item, phases, columnStage)[0];
  if (phases === undefined || context === undefined) return itemThreadSession(item.sessions);
  return contextSession(item, phases, context);
}

/** Source keys already materialized as cards, in either workflow — candidates matching one are dropped. */
export function persistedSourceKeys(items: readonly WorkItem[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.sourceKey) keys.add(item.sourceKey);
    const candidateSourceKey = candidateSourceKeyForItem(item);
    if (candidateSourceKey) keys.add(candidateSourceKey);
    // The URL names the repository, covering cards filed before they were stamped with one.
    if (item.url && (item.source === 'github-issue' || item.source === 'github-pr')) keys.add(item.url);
    // A pull request attached to an issue card is filed on that card.
    for (const source of item.workItem?.sources ?? []) {
      keys.add(sourceExternalId(source));
      if (source.url) keys.add(source.url);
    }
  }
  return keys;
}

/** Whether a live candidate is already one of the given persisted cards. */
export function isPersistedCandidate(
  keys: ReadonlySet<string>,
  candidate: { sourceKey: string; url: string },
): boolean {
  return keys.has(candidate.sourceKey) || keys.has(candidate.url);
}
