/**
 * Pull-request activity by polling, for an integration GitHub sends no
 * webhooks to (the access-token mode).
 *
 * The App learns that Factory's pull request opened, got a push, a comment,
 * a review or was merged from webhooks. Without them the card never records
 * the pull request, the authoring agent never hears about review feedback,
 * and a merge never settles the card. This sweep reads the same facts from
 * the REST API and replays each as the delivery GitHub would have sent, so
 * the rules ingress and the subscribed sessions handle it exactly as a
 * webhook: one policy for both.
 *
 * Which pull requests: the open ones Factory authored (a provenance row) or
 * that a card already tracks, plus the ones a card still has out that are no
 * longer open, to replay their merge or close. Activity is read from a cursor
 * kept per pull request, starting at its creation, so each comment and review
 * is delivered once.
 *
 * Factory writes through the token's own account, so it cannot tell its own
 * comments from a person's on the same account. Comments and reviews by that
 * account are skipped, except a request-changes verdict (the review handoff,
 * the one Factory post meant to reach the author); otherwise the agent's own
 * replies would wake it in a loop. Feedback meant for the agent has to come
 * from another account.
 */
import type { Octokit } from '@octokit/rest';

import { openChangeRequests } from '@factory/core';
import { requestsChangesVerdict } from '@factory/session';
import type { IntegrationStorageHandle, SourceControlStorageHandle, WorkItemsStorage } from '@factory/store';

import { provenanceTarget, RECONCILE_ERROR_SAMPLE_LIMIT } from './rules.ts';
import type { GithubPullRequestReconciler, ReconcileRepository, ReconcileSweepSummary } from './rules.ts';
import type { ParsedGithubWebhook } from './webhook.ts';

/** A GitHub REST object, passed on as the webhook payload carries it. */
export type GithubRestObject = Record<string, unknown>;

/** REST reads the sweep needs, all as the token. */
export interface PullRequestActivitySource {
  listOpenPullRequests(input: { installationId: number; repository: string }): Promise<GithubRestObject[]>;
  getPullRequest(input: { installationId: number; repository: string; number: number }): Promise<GithubRestObject>;
  listIssueComments(input: {
    installationId: number;
    repository: string;
    number: number;
    since: string;
  }): Promise<GithubRestObject[]>;
  listReviewComments(input: {
    installationId: number;
    repository: string;
    number: number;
    since: string;
  }): Promise<GithubRestObject[]>;
  listReviews(input: { installationId: number; repository: string; number: number }): Promise<GithubRestObject[]>;
}

export interface PullRequestActivityOptions {
  source: PullRequestActivitySource;
  sourceControl: Pick<SourceControlStorageHandle, 'projectRepositories'>;
  /** Provenance rows, and the per-pull-request cursors (in settings, outside any org). */
  integrationStorage: IntegrationStorageHandle;
  storage: Pick<WorkItemsStorage, 'list'>;
  /** The token's account; its comments and reviews are Factory's (see the module note). */
  selfLogin: () => Promise<string | undefined>;
  /** Runs one delivery through the rules ingress and the subscribed sessions. */
  deliver: (event: ParsedGithubWebhook) => Promise<void>;
}

/** Settings row holding the cursors, outside any real org. */
const CURSOR_ORG_ID = '__github_pull_request_activity__';

interface ActivityCursor {
  headSha: string;
  /** Activity at or before this time has been delivered. */
  since: string;
  /** Deliveries stamped exactly `since`, so one landing in the same second is still read once. */
  seen: string[];
  closed?: boolean;
}

function object(value: unknown): GithubRestObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as GithubRestObject) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cursorKey(repository: ReconcileRepository, pullRequestNumber: number): string {
  return `${repository.id}:${pullRequestNumber}`;
}

function isCursor(value: unknown): value is ActivityCursor {
  const cursor = object(value);
  return !!cursor && typeof cursor.headSha === 'string' && typeof cursor.since === 'string' && Array.isArray(cursor.seen);
}

/** The pull request as `issue_comment` carries it: the issue view, marked as a pull request. */
function issueOfPullRequest(pullRequest: GithubRestObject): GithubRestObject {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    html_url: pullRequest.html_url,
    state: pullRequest.state,
    user: pullRequest.user,
    created_at: pullRequest.created_at,
    updated_at: pullRequest.updated_at,
    assignees: pullRequest.assignees,
    labels: pullRequest.labels,
    pull_request: { html_url: pullRequest.html_url, url: pullRequest.url },
  };
}

function envelope(repository: ReconcileRepository, sender: unknown): GithubRestObject {
  return {
    installation: { id: repository.installationId },
    repository: { id: repository.id, full_name: repository.fullName },
    sender: object(sender) ?? { login: 'github' },
  };
}

interface Activity {
  /** When it happened, for the cursor. */
  at: string;
  /** Stable per observed version, so a replay dedupes at the ingress. */
  key: string;
  event: ParsedGithubWebhook;
}

function sameLogin(left: unknown, right: string | undefined): boolean {
  const login = string(object(left)?.login);
  return !!login && !!right && login.toLowerCase() === right.toLowerCase();
}

/** Comments, review comments and reviews newer than the cursor, oldest first. */
function activitySince(
  repository: ReconcileRepository,
  pullRequest: GithubRestObject,
  cursor: ActivityCursor,
  read: { issueComments: GithubRestObject[]; reviewComments: GithubRestObject[]; reviews: GithubRestObject[] },
  selfLogin: string | undefined,
): Activity[] {
  const activity: Activity[] = [];
  const fresh = (at: string | undefined, key: string): at is string =>
    !!at && (at > cursor.since || (at === cursor.since && !cursor.seen.includes(key)));
  const own = (author: unknown, body: unknown) =>
    sameLogin(author, selfLogin) && !requestsChangesVerdict(string(body));

  for (const comment of read.issueComments) {
    const id = number(comment.id);
    if (id === undefined || own(comment.user, comment.body)) continue;
    const created = string(comment.created_at);
    const updated = string(comment.updated_at) ?? created;
    // An edit counts only for an earlier comment: the review skill rewrites its
    // request-changes verdict in place, and that edit is the author's handoff.
    const edited = !!created && !!updated && updated > created && created <= cursor.since;
    const at = edited ? updated : created;
    const key = edited ? `comment:${id}:edited:${updated}` : `comment:${id}`;
    if (!fresh(at, key)) continue;
    activity.push({
      at,
      key,
      event: {
        event: 'issue_comment',
        deliveryId: `poll:${repository.id}:${key}`,
        payload: {
          action: edited ? 'edited' : 'created',
          ...envelope(repository, comment.user),
          issue: issueOfPullRequest(pullRequest),
          comment,
          ...(edited ? { changes: { body: { from: '' } } } : {}),
        },
      },
    });
  }

  for (const comment of read.reviewComments) {
    const id = number(comment.id);
    if (id === undefined || own(comment.user, comment.body)) continue;
    const key = `review-comment:${id}`;
    const at = string(comment.created_at);
    if (!fresh(at, key)) continue;
    activity.push({
      at,
      key,
      event: {
        event: 'pull_request_review_comment',
        deliveryId: `poll:${repository.id}:${key}`,
        payload: { action: 'created', ...envelope(repository, comment.user), pull_request: pullRequest, comment },
      },
    });
  }

  for (const review of read.reviews) {
    const id = number(review.id);
    const state = string(review.state)?.toLowerCase();
    // A pending review is a draft nobody else can see yet.
    if (id === undefined || !state || state === 'pending' || own(review.user, review.body)) continue;
    const key = `review:${id}`;
    const at = string(review.submitted_at);
    if (!fresh(at, key)) continue;
    activity.push({
      at,
      key,
      event: {
        event: 'pull_request_review',
        deliveryId: `poll:${repository.id}:${key}`,
        payload: {
          action: 'submitted',
          ...envelope(repository, review.user),
          pull_request: pullRequest,
          // Webhooks spell the state in lower case; the REST API in upper.
          review: { ...review, state },
        },
      },
    });
  }

  return activity.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function advance(cursor: ActivityCursor, activity: Activity): ActivityCursor {
  if (activity.at > cursor.since) return { ...cursor, since: activity.at, seen: [activity.key] };
  return { ...cursor, seen: [...cursor.seen, activity.key] };
}

function openedEvent(repository: ReconcileRepository, pullRequest: GithubRestObject): ParsedGithubWebhook {
  return {
    event: 'pull_request',
    // The id the backlog import uses for the same opening, so the two dedupe.
    deliveryId: `poll:${repository.id}:pull-request:${number(pullRequest.number)}:${string(pullRequest.created_at)}`,
    payload: { action: 'opened', ...envelope(repository, pullRequest.user), pull_request: pullRequest },
  };
}

function synchronizeEvent(repository: ReconcileRepository, pullRequest: GithubRestObject, sha: string): ParsedGithubWebhook {
  return {
    event: 'pull_request',
    deliveryId: `poll:${repository.id}:pull-request:${number(pullRequest.number)}:synchronize:${sha}`,
    // The pusher is unknown to the REST API; the head belongs to the author's branch.
    payload: { action: 'synchronize', ...envelope(repository, pullRequest.user), pull_request: pullRequest },
  };
}

function closedEvent(repository: ReconcileRepository, pullRequest: GithubRestObject): ParsedGithubWebhook {
  const merged = pullRequest.merged === true;
  return {
    event: 'pull_request',
    // The merge reconciler's id for the same outcome, so the two dedupe.
    deliveryId: `reconcile:${repository.id}:pull-request:${number(pullRequest.number)}:${merged ? 'merged' : 'closed'}`,
    payload: {
      action: 'closed',
      ...envelope(repository, merged ? pullRequest.merged_by : pullRequest.user),
      pull_request: pullRequest,
    },
  };
}

export function createGithubPullRequestActivitySweep(options: PullRequestActivityOptions): GithubPullRequestReconciler {
  const settings = options.integrationStorage.settings;
  const readCursor = async (
    repository: ReconcileRepository,
    pullRequestNumber: number,
  ): Promise<ActivityCursor | undefined> => {
    const stored = await settings.get(CURSOR_ORG_ID, cursorKey(repository, pullRequestNumber));
    return isCursor(stored) ? stored : undefined;
  };
  const saveCursor = (repository: ReconcileRepository, pullRequestNumber: number, cursor: ActivityCursor) =>
    settings.save(CURSOR_ORG_ID, cursorKey(repository, pullRequestNumber), { ...cursor });

  return async repositories => {
    const summary: ReconcileSweepSummary = { repositories: 0, checked: 0, merged: 0, closed: 0, failed: 0, errors: [] };
    const recordFailure = (repository: ReconcileRepository, error: unknown, pullRequestNumber?: number) => {
      summary.failed += 1;
      if (summary.errors.length < RECONCILE_ERROR_SAMPLE_LIMIT) {
        summary.errors.push({
          repository: repository.fullName,
          ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const selfLogin = await options.selfLogin().catch(() => undefined);

    for (const repository of repositories) {
      const read = { installationId: repository.installationId, repository: repository.fullName };
      let projectIds: Set<string>;
      let carded: Set<number>;
      let open: GithubRestObject[];
      try {
        const projects = await options.sourceControl.projectRepositories.listByExternalRepository({
          installationExternalId: String(repository.installationId),
          repositoryExternalId: String(repository.id),
        });
        if (projects.length === 0) continue;
        summary.repositories += 1;
        projectIds = new Set(projects.map(project => `${project.orgId}\u0000${project.factoryProjectId}`));
        // What cards have out in this repository: the merges still to replay.
        carded = new Set();
        for (const project of projects) {
          const items = await options.storage.list({ orgId: project.orgId, factoryProjectId: project.factoryProjectId });
          for (const item of items) {
            for (const entry of openChangeRequests(item.metadata)) {
              if (entry.repository.toLowerCase() === repository.fullName.toLowerCase()) carded.add(entry.number);
            }
          }
        }
        open = await options.source.listOpenPullRequests(read);
      } catch (error) {
        recordFailure(repository, error);
        continue;
      }

      const openNumbers = new Set<number>();
      for (const pullRequest of open) {
        const pullRequestNumber = number(pullRequest.number);
        if (pullRequestNumber === undefined) continue;
        openNumbers.add(pullRequestNumber);
        try {
          let cursor = await readCursor(repository, pullRequestNumber);
          if (!cursor && !carded.has(pullRequestNumber)) {
            const provenance = await options.integrationStorage.subscriptions.listByTarget(
              provenanceTarget(repository.id, pullRequestNumber),
              { status: 'active' },
            );
            const authored = provenance.some(row =>
              projectIds.has(`${row.orgId}\u0000${String(row.data?.factoryProjectId)}`),
            );
            if (!authored) continue;
          }
          summary.checked += 1;
          const headSha = string(object(pullRequest.head)?.sha) ?? '';
          if (!cursor) {
            await options.deliver(openedEvent(repository, pullRequest));
            cursor = { headSha, since: string(pullRequest.created_at) ?? new Date(0).toISOString(), seen: [] };
            await saveCursor(repository, pullRequestNumber, cursor);
          } else if (headSha && headSha !== cursor.headSha) {
            await options.deliver(synchronizeEvent(repository, pullRequest, headSha));
            cursor = { ...cursor, headSha };
            await saveCursor(repository, pullRequestNumber, cursor);
          }
          const target = { ...read, number: pullRequestNumber };
          const [issueComments, reviewComments, reviews] = await Promise.all([
            options.source.listIssueComments({ ...target, since: cursor.since }),
            options.source.listReviewComments({ ...target, since: cursor.since }),
            options.source.listReviews(target),
          ]);
          for (const activity of activitySince(
            repository,
            pullRequest,
            cursor,
            { issueComments, reviewComments, reviews },
            selfLogin,
          )) {
            await options.deliver(activity.event);
            cursor = advance(cursor, activity);
            await saveCursor(repository, pullRequestNumber, cursor);
          }
        } catch (error) {
          recordFailure(repository, error, pullRequestNumber);
        }
      }

      // A pull request a card still has out that is no longer open was merged
      // or closed between sweeps.
      for (const pullRequestNumber of carded) {
        if (openNumbers.has(pullRequestNumber)) continue;
        try {
          const pullRequest = await options.source.getPullRequest({ ...read, number: pullRequestNumber });
          summary.checked += 1;
          if (string(pullRequest.state) !== 'closed') continue;
          await options.deliver(closedEvent(repository, pullRequest));
          if (pullRequest.merged === true) summary.merged += 1;
          else summary.closed += 1;
          const cursor = await readCursor(repository, pullRequestNumber);
          if (cursor) await saveCursor(repository, pullRequestNumber, { ...cursor, closed: true });
        } catch (error) {
          recordFailure(repository, error, pullRequestNumber);
        }
      }
    }
    return summary;
  };
}

/** The REST reads, through the token's Octokit. */
export function octokitPullRequestActivitySource(
  octokitFor: (installationId: number) => Octokit,
): PullRequestActivitySource {
  const parts = (repository: string) => {
    const [owner = '', repo = ''] = repository.split('/');
    return { owner, repo };
  };
  return {
    listOpenPullRequests: async ({ installationId, repository }) => {
      const octokit = octokitFor(installationId);
      return (await octokit.paginate(octokit.pulls.list, {
        ...parts(repository),
        state: 'open',
        per_page: 100,
      })) as unknown as GithubRestObject[];
    },
    getPullRequest: async ({ installationId, repository, number: pullNumber }) => {
      const { data } = await octokitFor(installationId).pulls.get({ ...parts(repository), pull_number: pullNumber });
      return data as unknown as GithubRestObject;
    },
    listIssueComments: async ({ installationId, repository, number: issueNumber, since }) => {
      const octokit = octokitFor(installationId);
      return (await octokit.paginate(octokit.issues.listComments, {
        ...parts(repository),
        issue_number: issueNumber,
        since,
        per_page: 100,
      })) as unknown as GithubRestObject[];
    },
    listReviewComments: async ({ installationId, repository, number: pullNumber, since }) => {
      const octokit = octokitFor(installationId);
      return (await octokit.paginate(octokit.pulls.listReviewComments, {
        ...parts(repository),
        pull_number: pullNumber,
        since,
        per_page: 100,
      })) as unknown as GithubRestObject[];
    },
    listReviews: async ({ installationId, repository, number: pullNumber }) => {
      const octokit = octokitFor(installationId);
      return (await octokit.paginate(octokit.pulls.listReviews, {
        ...parts(repository),
        pull_number: pullNumber,
        per_page: 100,
      })) as unknown as GithubRestObject[];
    },
  };
}
