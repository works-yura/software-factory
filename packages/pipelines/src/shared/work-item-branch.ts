import {
  isOpenPullRequestSource,
  pullRequestSourceNumber,
  pullRequestSources,
  workItemSource as workItemBranchSource,
} from '@factory/core';
import type { ExternalWorkItemSource, WorkItemSource, WorkItemSourceRow } from '@factory/core';

/**
 * Where a card came from, in the vocabulary branch naming reads: the work-item
 * sources plus `slack-thread`, which the UI shows and which names no provider
 * branch (it falls back to the id-derived one).
 */
export type WorkItemBranchSource = WorkItemSource | 'slack-thread';

export interface WorkItemBranchInput {
  id: string;
  source: WorkItemBranchSource;
  metadata?: Record<string, unknown> | null;
}

const PROVIDER_NUMBER_KEYS: Partial<Record<WorkItemBranchSource, string>> = {
  'github-issue': 'githubIssueNumber',
  'github-pr': 'githubPullRequestNumber',
  'gitlab-issue': 'gitlabIssueIid',
  'gitlab-pr': 'gitlabMergeRequestIid',
};

/** The provider number a GitHub or GitLab card carries — the `#12` or `!12` its runs name it by. */
export function workItemNumber(item: Pick<WorkItemBranchInput, 'source' | 'metadata'>): number | undefined {
  const key = PROVIDER_NUMBER_KEYS[item.source];
  if (key === undefined) return undefined;
  const value = item.metadata?.[key] ?? item.metadata?.number;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** How a card names its thread: a GitHub or GitLab card gets its number here, any other keeps its title. */
export function workItemThreadTitle(item: Pick<WorkItemBranchInput, 'source' | 'metadata'> & { title: string }): string {
  const number = workItemNumber(item);
  if (number === undefined) return item.title;
  const kind = item.source === 'github-pr' ? 'PR' : item.source === 'gitlab-pr' ? 'MR' : 'Issue';
  return `${kind} #${number}: ${item.title}`;
}

/**
 * The last twelve alphanumerics of a work item id: the per-item suffix that keeps
 * provider numbers from colliding across the repositories of one factory. Issue
 * #13 exists in every repository, and a factory's sessions are unique per
 * user and branch across all of its repositories, so a branch named by the
 * number alone can only be held once per factory.
 */
function idSuffix(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(-12);
}

function metadataIdentifier(item: WorkItemBranchInput): string | undefined {
  const identifier = item.metadata?.identifier;
  return typeof identifier === 'string' && identifier.trim() ? identifier.trim() : undefined;
}

/**
 * The git branch an item's runs and sessions share, one grammar for both sides
 * of the wire: the dispatcher names autonomous run branches with it and the
 * board opens card sessions on it, so both converge on one checkout per item.
 * Provider numbers are only unique within a repository, so GitHub and GitLab
 * branches carry the item suffix as well. Cards without a provider identity
 * (manual, Slack) and cards whose metadata lost their identifier fall back to
 * the id-derived branch.
 */
export function workItemBranch(item: WorkItemBranchInput): string {
  const number = workItemNumber(item);
  const identifier = metadataIdentifier(item);
  const suffix = idSuffix(item.id);

  if (number !== undefined && (item.source === 'github-issue' || item.source === 'github-pr')) {
    const kind = item.source === 'github-issue' ? 'issue' : 'pr';
    return suffix ? `factory/${kind}-${number}-${suffix}` : `factory/${kind}-${number}`;
  }
  if (number !== undefined && item.source === 'gitlab-pr' && suffix) return `factory/gitlab-mr-${number}-${suffix}`;
  if (item.source === 'gitlab-issue' && identifier !== undefined && suffix) {
    const slug = identifier.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    return `factory/gitlab-${slug.slice(0, 60)}-${suffix}`;
  }
  return `factory/item-${item.id}`;
}

/**
 * Whether `branch` is a card branch {@link workItemBranch} names, carrying the
 * card's identity (its id, or its per-item suffix). Sessions on such a branch
 * work that card, whichever path opened them, so they share the card's
 * sandbox folder. The pre-suffix GitHub branch (`factory/issue-12`) names a
 * number only, which several repositories of one factory can hold at once, so
 * it is not one: a session on it joins its card through the card's binding.
 */
export function isWorkItemBranch(branch: string): boolean {
  return (
    /^factory\/(?:issue|pr)-[1-9]\d*-[a-z0-9]{1,12}$/.test(branch) ||
    /^factory\/gitlab-[a-z0-9._-]{1,60}-[a-z0-9]{1,12}$/.test(branch) ||
    /^factory\/item-[A-Za-z0-9._-]+$/.test(branch)
  );
}

/**
 * The branch a card's pull or merge request is reviewed on. A PR's own card gets
 * the same name {@link workItemBranch} gives it; an issue card reviewing a PR
 * attached to it gets a branch apart from its builder's issue branch, so the
 * reviewer and the builder never share a checkout.
 */
export function pullRequestBranch(input: { id: string; provider: 'github' | 'gitlab'; number: number }): string {
  const suffix = idSuffix(input.id);
  if (input.provider === 'gitlab') {
    return suffix ? `factory/gitlab-mr-${input.number}-${suffix}` : `factory/item-${input.id}-mr-${input.number}`;
  }
  return suffix ? `factory/pr-${input.number}-${suffix}` : `factory/pr-${input.number}`;
}

/** The pre-suffix GitHub branch, for reusing sessions opened before card names were unique. */
export function legacyGithubWorkItemBranch(branch: string): string | undefined {
  const match = /^(factory\/(?:issue|pr)-[1-9]\d*)-[a-z0-9]{1,12}$/.exec(branch);
  return match?.[1];
}

/**
 * The pull request a `factory/pr-<number>-<item suffix>` branch was named after, the
 * inverse of {@link workItemBranch}. Branches from before the suffix (`factory/pr-<number>`)
 * still parse so existing checkouts can resolve their PR.
 */
export function pullRequestNumberFromBranch(branch: string): number | undefined {
  const match = /^factory\/pr-([1-9]\d*)(?:-[a-z0-9]{1,12})?$/.exec(branch);
  const number = match ? Number(match[1]) : undefined;
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

/** The GitLab MR IID encoded in Factory's collision-resistant review branch. */
export function mergeRequestNumberFromBranch(branch: string): number | undefined {
  const match = /^factory\/gitlab-mr-([1-9]\d*)-[a-z0-9]{1,12}$/.exec(branch);
  const number = match ? Number(match[1]) : undefined;
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

interface SessionedItem {
  readonly sessions: Readonly<Record<string, { readonly branch?: string | null } | undefined>>;
}

interface BranchedItem {
  readonly id: string;
  readonly externalSource: ExternalWorkItemSource | null;
  readonly workItem: { readonly metadata?: Record<string, unknown> | null; readonly sources?: readonly WorkItemSourceRow[] };
}

/**
 * Whether a pull request from `headBranch` was opened by the card's own sessions: the head is
 * one of its session branches, or the branch Factory builds the card on (stable even after its
 * session is deleted).
 */
export function cardOwnsBranch(item: SessionedItem & BranchedItem, headBranch: string | undefined): boolean {
  if (!headBranch) return false;
  const buildBranch = workItemBranch({
    id: item.id,
    source: workItemBranchSource(item.externalSource),
    metadata: item.workItem.metadata,
  });
  return buildBranch === headBranch || Object.values(item.sessions).some(session => session?.branch === headBranch);
}

/** The newest open pull request the card's own sessions opened, other than `except`. */
export function newestOwnedOpenPullRequestNumber(item: SessionedItem & BranchedItem, except?: number): number | null {
  const open = pullRequestSources(item).filter(
    source =>
      isOpenPullRequestSource(source) &&
      pullRequestSourceNumber(source) !== except &&
      typeof source.metadata?.headBranch === 'string' &&
      cardOwnsBranch(item, source.metadata.headBranch),
  );
  return (open.length ? pullRequestSourceNumber(open.at(-1)!) : undefined) ?? null;
}
