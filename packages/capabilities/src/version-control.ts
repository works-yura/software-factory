import type { FactoryRepositoryAccess } from '@mastra/core/workspace';
import type {
  SourceControlInstallation,
  SourceControlRepository,
  SourceControlStorageHandle,
} from '@factory/store';
import type { IntegrationConnection } from './connection.ts';

export interface InstallationInput {
  externalId: string;
  accountName?: string | null;
  accountType?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RepositoryInput {
  externalId: string;
  slug: string;
  defaultBranch: string;
  metadata?: Record<string, unknown>;
}

export type RepositoryAccess = FactoryRepositoryAccess;
/** One credential for a set of repositories, plus each repository's own access under it. */
export type RepositoriesAccess = RepositoryAccess & {
  /** Keyed by repository id: that repository's clone URL with the shared credential. */
  repositories?: Record<string, RepositoryAccess>;
};
export interface RepositoryTarget {
  connection: IntegrationConnection;
  sourceId: string;
}

export type PullRequestState = 'open' | 'closed';

export interface PullRequest {
  id: string;
  title: string;
  url: string;
  author: string | null;
  assignees?: string[];
  requestedReviewers?: string[];
  labels?: string[];
  body: string | null;
  state: PullRequestState;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestPage {
  pullRequests: PullRequest[];
  nextCursor: string | null;
}

export interface PullRequestRef {
  connection: IntegrationConnection;
  sourceId: string;
  pullRequestId: string;
  /** End user the write should be attributed to, when the provider supports acting on a user's behalf. */
  actingUserId?: string;
}

export interface ListPullRequestsInput {
  connection: IntegrationConnection;
  sourceId: string;
  state?: PullRequestState | 'all';
  includeDrafts?: boolean;
  cursor?: string;
}

export interface CreatePullRequestInput {
  connection: IntegrationConnection;
  sourceId: string;
  title: string;
  body?: string;
  baseBranch: string;
  headBranch: string;
  draft?: boolean;
  /** End user the write should be attributed to, when the provider supports acting on a user's behalf. */
  actingUserId?: string;
}

export interface UpdatePullRequestInput extends PullRequestRef {
  title?: string;
  body?: string | null;
  baseBranch?: string;
  state?: PullRequestState;
}

export interface MergePullRequestInput extends PullRequestRef {
  commitTitle?: string;
  commitMessage?: string;
  method?: 'merge' | 'squash' | 'rebase';
}

export interface MergePullRequestResult {
  merged: boolean;
  message: string;
  sha: string | null;
}

export interface PullRequestComment {
  id: string;
  url: string;
  author: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestCommentPage {
  comments: PullRequestComment[];
  nextCursor: string | null;
}

export interface ListPullRequestCommentsInput extends PullRequestRef {
  cursor?: string;
}

export interface CreatePullRequestCommentInput extends PullRequestRef {
  body: string;
}

export interface UpdatePullRequestCommentInput {
  connection: IntegrationConnection;
  sourceId: string;
  commentId: string;
  body: string;
  actingUserId?: string;
}

export interface DeletePullRequestCommentInput {
  connection: IntegrationConnection;
  sourceId: string;
  commentId: string;
  actingUserId?: string;
}

export type ReviewState = 'pending' | 'commented' | 'approved' | 'changes-requested' | 'dismissed';

export interface Review {
  id: string;
  url: string | null;
  author: string | null;
  body: string | null;
  state: ReviewState;
  commitId: string | null;
  submittedAt: string | null;
}

export interface ReviewPage {
  reviews: Review[];
  nextCursor: string | null;
}

export interface ListReviewsInput extends PullRequestRef {
  cursor?: string;
}

type CreateReviewBase = PullRequestRef & { commitId?: string };

type ReviewSubmission = { event: 'approve'; body?: string } | { event: 'request-changes' | 'comment'; body: string };

export type CreateReviewInput = CreateReviewBase & (ReviewSubmission | { event?: undefined; body?: string });

export interface ReviewRef extends PullRequestRef {
  reviewId: string;
}

export interface UpdateReviewInput extends ReviewRef {
  body: string;
}

export type SubmitReviewInput = ReviewRef & ReviewSubmission;

export interface DismissReviewInput extends ReviewRef {
  message: string;
}

export interface ReviewComment extends PullRequestComment {
  path: string;
  line: number | null;
  side: 'left' | 'right' | null;
  commitId: string;
  replyToId: string | null;
}

export interface ReviewCommentPage {
  comments: ReviewComment[];
  nextCursor: string | null;
}

export interface ListReviewCommentsInput extends PullRequestRef {
  cursor?: string;
}

interface CreateReviewCommentBase extends PullRequestRef {
  body: string;
}

export type CreateReviewCommentInput = CreateReviewCommentBase &
  (
    | {
        replyToId: string;
        commitId?: never;
        path?: never;
        line?: never;
        side?: never;
        startLine?: never;
        startSide?: never;
      }
    | {
        replyToId?: never;
        commitId: string;
        path: string;
        line: number;
        side: 'left' | 'right';
        startLine?: number;
        startSide?: 'left' | 'right';
      }
  );

export type UpdateReviewCommentInput = UpdatePullRequestCommentInput;
export type DeleteReviewCommentInput = DeletePullRequestCommentInput;
export interface ResolveReviewThreadInput extends DeleteReviewCommentInput {
  resolved: boolean;
}

export interface RequestedReviewers {
  users: string[];
  teams: string[];
}

export interface UpdateReviewersInput extends PullRequestRef {
  users?: string[];
  teams?: string[];
}

export type CommitCheckStatus = 'in-progress' | 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped';

export interface PublishCommitCheckInput {
  connection: IntegrationConnection;
  sourceId: string;
  /** Full commit SHA the check is attached to. */
  headSha: string;
  /** Source branch of the change request; GitLab needs it to show the status on the merge request. */
  ref?: string;
  /** Stable check name; publishing again with the same name updates the existing check. */
  name: string;
  status: CommitCheckStatus;
  title: string;
  summary: string;
  /** Optional long-form details (Markdown) such as per-command results. */
  details?: string;
  actingUserId?: string;
}

export interface CommitCheck {
  id: string;
  name: string;
  headSha: string;
  status: CommitCheckStatus;
  url: string | null;
}

/** Fixed repository, pull-request lifecycle, review, comment, and reviewer contract. */
/**
 * A read of the provider's API on the connection's credentials: a REST `GET`
 * relative to the API root (`repos/<owner>/<repo>/pulls/1` on GitHub,
 * `projects/<id>/merge_requests/1` on GitLab), or a GraphQL query. The caller
 * decides which paths an agent may read.
 */
export interface ReadApiInput {
  connection: IntegrationConnection;
  /** REST path relative to the API root, without a leading slash; ignored for `graphql`. */
  path?: string;
  query?: Record<string, string>;
  /** `diff` asks for a pull request's unified diff (GitHub) instead of JSON. */
  accept?: 'json' | 'diff';
  /** A GraphQL query (no mutations); GitHub only. */
  graphql?: { query: string; variables?: Record<string, unknown> };
}

/** An issue's (or a GitHub pull request's) labels, state and a comment, changed on the provider. */
export interface EditIssueInput {
  connection: IntegrationConnection;
  sourceId: string;
  /** Repository-local number (GitHub) or IID (GitLab). */
  issueId: string;
  addLabels?: string[];
  removeLabels?: string[];
  /** Labels to create first when the repository has none by that name; existing ones are left as they are. */
  createLabels?: Array<{ name: string; color?: string; description?: string }>;
  state?: 'open' | 'closed';
  comment?: string;
  actingUserId?: string;
}

export interface EditedIssue {
  labels: string[];
  state: string;
  commentUrl?: string;
}

export interface VersionControl {
  initialize(input: { storage: SourceControlStorageHandle }): void;
  registerInstallation(input: {
    orgId: string;
    userId: string;
    installation: InstallationInput;
  }): Promise<SourceControlInstallation>;
  registerRepositories(input: {
    orgId: string;
    installationId: string;
    repositories: RepositoryInput[];
  }): Promise<SourceControlRepository[]>;
  /** Resolve the provider-owned reference for a durably registered repository. */
  getRepositoryTarget(input: { orgId: string; repositoryId: string }): Promise<RepositoryTarget>;
  getRepositoryAccess(input: { orgId: string; repositoryId: string }): Promise<RepositoryAccess>;
  /**
   * One credential that reaches every listed repository, for providers whose
   * per-repository tokens would otherwise leave `gh` blind to the rest of an
   * environment. Resolves `undefined` when the provider cannot cover the set
   * (several installations, more repositories than one token allows); the
   * caller then falls back to `getRepositoryAccess` for the primary.
   */
  getRepositoriesAccess?(input: { orgId: string; repositoryIds: string[] }): Promise<RepositoriesAccess | undefined>;
  listPullRequests(input: ListPullRequestsInput): Promise<PullRequestPage>;
  getPullRequest(input: PullRequestRef): Promise<PullRequest | null>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  updatePullRequest(input: UpdatePullRequestInput): Promise<PullRequest>;
  closePullRequest(input: PullRequestRef): Promise<PullRequest>;
  mergePullRequest(input: MergePullRequestInput): Promise<MergePullRequestResult>;
  listComments(input: ListPullRequestCommentsInput): Promise<PullRequestCommentPage>;
  createComment(input: CreatePullRequestCommentInput): Promise<PullRequestComment>;
  updateComment(input: UpdatePullRequestCommentInput): Promise<PullRequestComment>;
  deleteComment(input: DeletePullRequestCommentInput): Promise<void>;
  listReviews(input: ListReviewsInput): Promise<ReviewPage>;
  getReview(input: ReviewRef): Promise<Review | null>;
  createReview(input: CreateReviewInput): Promise<Review>;
  updateReview(input: UpdateReviewInput): Promise<Review>;
  submitReview(input: SubmitReviewInput): Promise<Review>;
  dismissReview(input: DismissReviewInput): Promise<Review>;
  deletePendingReview(input: ReviewRef): Promise<void>;
  /** Optional because not every provider exposes resolvable review threads. */
  resolveReviewThread?(input: ResolveReviewThreadInput): Promise<void>;
  listReviewComments(input: ListReviewCommentsInput): Promise<ReviewCommentPage>;
  createReviewComment(input: CreateReviewCommentInput): Promise<ReviewComment>;
  updateReviewComment(input: UpdateReviewCommentInput): Promise<ReviewComment>;
  deleteReviewComment(input: DeleteReviewCommentInput): Promise<void>;
  listRequestedReviewers(input: PullRequestRef): Promise<RequestedReviewers>;
  requestReviewers(input: UpdateReviewersInput): Promise<RequestedReviewers>;
  removeRequestedReviewers(input: UpdateReviewersInput): Promise<RequestedReviewers>;
  /** Optional because not every provider (or connection type) can publish commit checks. */
  publishCommitCheck?(input: PublishCommitCheckInput): Promise<CommitCheck>;
  /** Optional: agent reads of the provider API beyond the typed methods (see `ReadApiInput`). */
  readApi?(input: ReadApiInput): Promise<unknown>;
  /** Optional: labels, state and a comment on an issue. */
  editIssue?(input: EditIssueInput): Promise<EditedIssue>;
}
