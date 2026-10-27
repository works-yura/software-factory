import type { WorkItemSource } from '@factory/core';

export interface WorkItemBranchInput {
  id: string;
  source: WorkItemSource;
  metadata?: Record<string, unknown> | null;
}

const PROVIDER_NUMBER_KEYS: Partial<Record<WorkItemSource, string>> = {
  'github-issue': 'githubIssueNumber',
  'github-pr': 'githubPullRequestNumber',
  'gitlab-issue': 'gitlabIssueIid',
  'gitlab-pr': 'gitlabMergeRequestIid',
};

const IDENTIFIER_PROVIDERS: Partial<Record<WorkItemSource, string>> = {
  'linear-issue': 'linear',
  'jira-issue': 'jira',
  'incidentio-follow-up': 'incidentio',
};

/** The provider number a GitHub or GitLab card carries — the `#12` or `!12` its runs name it by. */
export function workItemNumber(item: Pick<WorkItemBranchInput, 'source' | 'metadata'>): number | undefined {
  const key = PROVIDER_NUMBER_KEYS[item.source];
  if (key === undefined) return undefined;
  const value = item.metadata?.[key] ?? item.metadata?.number;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Last 12 alphanumerics of the card id: keeps provider-named branches unique across projects. */
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
 * Cards without a provider identity (manual, Slack) and cards whose metadata
 * lost their identifier fall back to the id-derived branch.
 */
export function workItemBranch(item: WorkItemBranchInput): string {
  const number = workItemNumber(item);
  const identifier = metadataIdentifier(item);
  const suffix = idSuffix(item.id);
  const provider = IDENTIFIER_PROVIDERS[item.source];

  if (number !== undefined && item.source === 'github-issue') return `factory/issue-${number}`;
  if (number !== undefined && item.source === 'github-pr') return `factory/pr-${number}`;
  if (provider !== undefined && identifier !== undefined) return `factory/${provider}-${identifier.toLowerCase()}`;
  if (number !== undefined && item.source === 'gitlab-pr' && suffix) return `factory/gitlab-mr-${number}-${suffix}`;
  if (item.source === 'gitlab-issue' && identifier !== undefined && suffix) {
    const slug = identifier.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    return `factory/gitlab-${slug.slice(0, 60)}-${suffix}`;
  }
  return `factory/item-${item.id}`;
}

/** The pull request a `factory/pr-<number>` branch was named after, the inverse of {@link workItemBranch}. */
export function pullRequestNumberFromBranch(branch: string): number | undefined {
  const match = /^factory\/pr-([1-9]\d*)$/.exec(branch);
  return match ? Number(match[1]) : undefined;
}

/** The GitLab MR IID encoded in Factory's collision-resistant review branch. */
export function mergeRequestNumberFromBranch(branch: string): number | undefined {
  const match = /^factory\/gitlab-mr-([1-9]\d*)-[a-z0-9]{1,12}$/.exec(branch);
  const number = match ? Number(match[1]) : undefined;
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}
