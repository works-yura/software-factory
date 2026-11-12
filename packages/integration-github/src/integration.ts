/**
 * `GithubIntegration` — the injectable GitHub App integration for the web
 * factory.
 *
 * The deploy entry (`src/mastra/index.ts`) reads the `GITHUB_APP_*` env vars
 * once, constructs an instance, and passes it to `MastraFactory` (the same
 * dependency-injection pattern as the auth adapter and the sandbox machine).
 * The factory seeds it into the runtime-config registry for the feature gate
 * (`./config.ts`) and hands the instance to every consumer explicitly — route
 * handlers receive it through `routes()`, the webhook fan-out and session
 * subscription tools through their deps.
 *
 * The class owns:
 *   - the GitHub App credentials (validated + PEM-normalized at construction),
 *   - every GitHub API operation the web surface performs (Octokit factories,
 *     token minting, installation/repo/issue/PR listings, OAuth exchange),
 *   - the webhook secret used to verify GitHub webhook deliveries,
 *   - its own HTTP surface: `routes()` returns the `/web/github/*` +
 *     `/auth/github/*` Mastra `apiRoutes`.
 *
 * A custom integration (different app per tenant, custom Octokit config) can
 * subclass this and override individual methods — everything downstream only
 * talks to the instance.
 */

import type { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import type { MastraWorker } from '@mastra/core/worker';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

import type { IntegrationConnection } from '@factory/capabilities';
import type {
  CreateIntakeCommentInput,
  GetIntakeIssueInput,
  Intake,
  IntakeIssue,
  IntakeIssueDetail,
  ListIntakeIssuesInput,
  UpdateIntakeIssueInput,
} from '@factory/capabilities';
import type {
  CommitCheck,
  EditIssueInput,
  PullRequest,
  PullRequestComment,
  Review,
  ReviewComment,
  ReadApiInput,
  VersionControl,
} from '@factory/capabilities';
import type { FactoryIntegration, IntegrationConnections, IntegrationContext, IntegrationTools } from '@factory/integrations';
import { GithubConnections } from './connections.ts';
import type { GithubEventRules, GithubRuleOverrides } from './default-rules.ts';
import { resolveGithubRules } from './default-rules.ts';
import { attachGithubIssueReconciler } from './issue-reconciler.ts';
import type { GithubIssueReconciler } from './issue-reconciler.ts';
import {
  DEFAULT_GITHUB_PR_DISCOVERY_INTERVAL_MS,
  DEFAULT_GITHUB_RECONCILE_INTERVAL_MS,
  GithubReconcileWorker,
} from './reconcile-worker.ts';
import { reconcileInterval, reconciliationEnabled } from './reconciliation-config.ts';
import { buildGithubRoutes, ingestLinkedRepositoryBacklog } from './routes.ts';
import {
  attachGithubPullRequestDiscovery,
  attachGithubReconciler,
  attachGithubRules,
  openPullRequestLister,
  RECONCILE_ERROR_SAMPLE_LIMIT,
} from './rules.ts';
import type {
  GithubPullRequestReconciler,
  ReconcileIssueState,
  ReconcilePullRequestState,
  ReconcileRepository,
} from './rules.ts';
import { deliverGithubEvent } from './webhook.ts';
import type { ParsedGithubWebhook } from './webhook.ts';
import type { GitIdentity } from '@factory/sandbox';
import {
  createGithubSubscriptionTools,
  parseCreatedPullRequest,
  subscribeCurrentSessionToPullRequest,
} from './session-subscriptions.ts';
import { settleOrAbort } from './settle-or-abort.ts';
import type { GithubSubscriptionStorage } from './subscriptions.ts';
import { GithubTokenConnections } from './token-auth.ts';
import type { GithubInstallationAuth } from './token-auth.ts';
import { createGithubPullRequestActivitySweep, octokitPullRequestActivitySource } from './pull-request-activity.ts';
import { githubRulesOptions } from './rules.ts';
import { routedSourceScopes } from '@factory/core';

type InputOf<TMethod extends keyof VersionControl> =
  NonNullable<VersionControl[TMethod]> extends (input: infer TInput) => unknown ? TInput : never;

const GITHUB_CHECK_TITLE_LIMIT = 255;
const GITHUB_CHECK_TEXT_LIMIT = 65_535;

/**
 * Normalize a PEM private key supplied via env. Env tooling tends to mangle
 * multi-line PEMs, so two single-line forms are supported:
 *   - `\n`-escaped: literal `\n` sequences become real newlines
 *   - fully flattened: newlines stripped entirely — the PEM is rebuilt by
 *     re-wrapping the base64 body (Node's decoder rejects header/body/footer
 *     on one line with `error:1E08010C:DECODER routines::unsupported`)
 */
export function normalizePrivateKey(raw: string): string {
  const key = raw.replace(/\\n/g, '\n');
  if (key.includes('\n')) return key;
  const flattened = key.trim().match(/^(-----BEGIN [A-Z0-9 ]+-----)\s*(.+?)\s*(-----END [A-Z0-9 ]+-----)$/);
  if (!flattened) return key;
  const body = flattened[2]!.replace(/\s+/g, '');
  return `${flattened[1]}\n${body.match(/.{1,64}/g)!.join('\n')}\n${flattened[3]}\n`;
}

export interface UserInstallation {
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
}

export interface RepoSummary {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  defaultBranch: string;
  private: boolean;
  installationId: number;
}

export interface GithubTriageCommentUpsertInput {
  installationId: number;
  repository: string;
  issueNumber: number;
  body: string;
}

export interface GithubTriageCommentUpsertResult {
  action: 'created' | 'updated';
  commentId: string;
  url: string;
}

export type GithubRepositoryPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

/**
 * How long a collaborator permission lookup may be reused. The reconcile
 * sweep re-stamps every open card's author and webhook gating checks every
 * human sender, so one login can cost dozens of identical requests per cycle
 * against the installation's REST budget. Revoked access reads as trusted for
 * at most this long.
 */
const COLLABORATOR_PERMISSION_CACHE_TTL_MS = 30 * 60_000;
const COLLABORATOR_PERMISSION_CACHE_MAX_ENTRIES = 1000;
/** Bound on the shared upstream lookup; callers race their own signal against it. */
const COLLABORATOR_PERMISSION_LOOKUP_TIMEOUT_MS = 10_000;
/** Installations whose Octokit (and cached token) is kept; least recently used is evicted. */
const INSTALLATION_OCTOKIT_CACHE_MAX_ENTRIES = 1000;
/** Missed-open issue discovery reads at most this many pages per repository per sweep. */
const OPEN_ISSUE_DISCOVERY_MAX_PAGES = 5;
const OPEN_ISSUE_DISCOVERY_PAGE_SIZE = 100;

export interface IssueSummary {
  number: number;
  title: string;
  url: string;
  author: string | null;
  assignees: string[];
  labels: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
}

/** Page size for issue/PR listings; one GitHub API call per page. */
export const LIST_PAGE_SIZE = 30;

/** Allow GitHub OAuth token exchanges enough time to complete during installation callbacks. */
const GITHUB_OAUTH_TOKEN_TIMEOUT_MS = 10_000;

export interface IssuePage {
  issues: IssueSummary[];
  /** Next page number to request, or `null` when this was the last page. */
  nextPage: number | null;
}

export interface ListRepoOpenIssuesOptions {
  label?: string;
}

export interface GithubIntegrationConfig {
  /** Replace an event handler, or disable it with null; omitted events keep defaults. */
  rules?: GithubRuleOverrides;
  /**
   * The GitHub App fields below are all-or-nothing: give all five to offer the App install flow, or
   * none to run with access-token connections only (ADR-0034).
   */
  /** GitHub App id (the numeric id, as a string). */
  appId?: string;
  /**
   * App private key (PEM). Multi-line, `\n`-escaped, and fully flattened
   * single-line forms are all accepted (normalized at construction).
   */
  privateKey?: string;
  /** OAuth client id of the GitHub App. */
  clientId?: string;
  /** OAuth client secret of the GitHub App. */
  clientSecret?: string;
  /** App slug — the URL name used to build the install URL. */
  slug?: string;
  /**
   * Secret GitHub uses to sign webhook deliveries. Omitted → webhook
   * signature verification rejects all deliveries. Also serves as the default
   * replica-stable OAuth/install `state` secret (see `./config.ts`).
   */
  webhookSecret?: string;
  /**
   * Extra bot logins authorized to trigger author-gated PR notifications
   * (reviews and comments). Merged over the built-in defaults, matched
   * case-insensitively. Deployments running their own reviewer bots opt them
   * in here; every other bot stays gated.
   */
  authorizedBots?: string[];
  /**
   * Optional fallback access token (`GITHUB_ACCESS_TOKEN`): serves the installation rows registered
   * for its account that have no stored token — the rows the former server-wide token mode created.
   * Organizations connect their own tokens in Settings › Підключення (ADR-0034).
   */
  accessToken?: string;
  /** Overrides `https://api.github.com` for access-token clients (GitHub Enterprise Server). */
  apiBaseUrl?: string;
  /** Test seam for the access-token clients' Octokit transport. */
  fetchImpl?: typeof fetch;
}

/** Settings that do not depend on how the integration authenticates. */
export type GithubIntegrationSharedConfig = Pick<GithubIntegrationConfig, 'rules' | 'webhookSecret' | 'authorizedBots'>;

/** Polling replaces webhooks for token connections, so sweeps run far more often than the hourly App default. */
export const GITHUB_TOKEN_RECONCILE_INTERVAL_MS = 2 * 60_000;

/** Raised when an installation can neither use a token nor the App (no App on this server). */
export class GithubInstallationUnavailableError extends Error {
  readonly status = 409;
  constructor(installationId: number) {
    super(
      `GitHub connection ${installationId} has no usable credentials: it is not a token connection and this server ` +
        'has no GitHub App configured. Reconnect it in Settings › Підключення › GitHub.',
    );
    this.name = 'GithubInstallationUnavailableError';
  }
}

const STATUS_DESCRIPTION_LIMIT = 140;
const STATUS_STATE: Record<CommitCheck['status'], 'pending' | 'success' | 'failure' | 'error'> = {
  'in-progress': 'pending',
  success: 'success',
  failure: 'failure',
  neutral: 'success',
  skipped: 'success',
  cancelled: 'error',
};

/** Human-readable names of the required config fields, for construction errors. */
const REQUIRED_FIELDS = ['appId', 'privateKey', 'clientId', 'clientSecret', 'slug'] as const;

export class GithubIntegration implements FactoryIntegration {
  /** Stable integration identifier (see `../factory-integration.ts`). */
  readonly id = 'github';
  readonly #rules: GithubEventRules;

  get rules(): GithubEventRules {
    return this.#rules;
  }
  readonly intake: Intake = {
    resolveIntakeDispatch: input => this.#resolveIntakeDispatch(input),
    listSources: async ({ orgId }) => {
      const installations = await this.sourceControlStorage.installations.list({ orgId });
      const repositories = await Promise.all(
        installations.map(installation =>
          this.sourceControlStorage.repositories.list({ orgId, installationId: installation.id }),
        ),
      );
      return repositories.flat().map(repository => ({
        id: repository.id,
        name: repository.slug,
        type: 'repository',
        metadata: { defaultBranch: repository.defaultBranch },
      }));
    },
    listItems: async ({ orgId, sourceIds, cursor }) => {
      const page = cursor ? Number.parseInt(cursor, 10) : 1;
      const requestedPage = Number.isSafeInteger(page) && page > 0 ? page : 1;
      const pages = await Promise.all(
        sourceIds.map(async sourceId => {
          const repository = await this.sourceControlStorage.repositories.get({ orgId, id: sourceId });
          if (!repository) return { items: [], hasNextPage: false };
          const installation = await this.sourceControlStorage.installations.get({
            orgId,
            id: repository.installationId,
          });
          if (!installation) return { items: [], hasNextPage: false };
          const installationId = Number.parseInt(installation.externalId, 10);
          if (!Number.isSafeInteger(installationId)) return { items: [], hasNextPage: false };
          const [issues, pullRequests] = await Promise.all([
            this.listRepoOpenIssues(installationId, repository.slug, requestedPage),
            this.versionControl.listPullRequests({
              connection: { type: 'app-installation', installationId },
              sourceId: repository.slug,
              includeDrafts: false,
              cursor: String(requestedPage),
            }),
          ]);
          return {
            items: [
              ...issues.issues.map(issue => ({
                source: { type: 'issue', externalId: `${repository.externalId}:${issue.number}`, url: issue.url },
                sourceId: repository.id,
                title: issue.title,
                status: 'open',
                labels: issue.labels,
                createdAt: issue.createdAt,
                updatedAt: issue.updatedAt,
                metadata: { repository: repository.slug, number: issue.number, author: issue.author },
              })),
              ...pullRequests.pullRequests.map(pullRequest => ({
                source: {
                  type: 'pull-request',
                  externalId: `${repository.externalId}:${pullRequest.id}`,
                  url: pullRequest.url,
                },
                sourceId: repository.id,
                title: pullRequest.title,
                status: 'open',
                createdAt: pullRequest.createdAt,
                updatedAt: pullRequest.updatedAt,
                metadata: {
                  repository: repository.slug,
                  number: Number(pullRequest.id),
                  author: pullRequest.author,
                  baseBranch: pullRequest.baseBranch,
                  headBranch: pullRequest.headBranch,
                },
              })),
            ],
            hasNextPage: issues.nextPage !== null || pullRequests.nextCursor !== null,
          };
        }),
      );
      return {
        items: pages.flatMap(result => result.items),
        nextCursor: pages.some(result => result.hasNextPage) ? String(requestedPage + 1) : null,
      };
    },
    listIssues: input => this.#listIntakeIssues(input),
    getIssue: input => this.#getIntakeIssue(input),
    createComment: input => this.#createIntakeComment(input),
    updateIssue: input => this.#updateIntakeIssue(input),
  };
  readonly versionControl: VersionControl = {
    initialize: ({ storage }) => {
      this.#sourceControlStorage = storage;
    },
    registerInstallation: ({ orgId, userId, installation }) =>
      this.sourceControlStorage.installations.upsert({
        orgId,
        connectedByUserId: userId,
        externalId: installation.externalId,
        accountName: installation.accountName,
        accountType: installation.accountType,
        providerMetadata: installation.metadata,
      }),
    registerRepositories: ({ orgId, installationId, repositories }) =>
      Promise.all(
        repositories.map(repository =>
          this.sourceControlStorage.repositories.upsert({
            orgId,
            input: {
              installationId,
              externalId: repository.externalId,
              slug: repository.slug,
              defaultBranch: repository.defaultBranch,
              providerMetadata: repository.metadata,
            },
          }),
        ),
      ),
    getRepositoryTarget: async ({ orgId, repositoryId }) => {
      const repository = await this.sourceControlStorage.repositories.get({ orgId, id: repositoryId });
      if (!repository) throw new Error('Version-control repository not found.');
      const installation = await this.sourceControlStorage.installations.get({
        orgId,
        id: repository.installationId,
      });
      if (!installation) throw new Error('Version-control installation not found.');
      const installationId = Number.parseInt(installation.externalId, 10);
      if (!Number.isSafeInteger(installationId)) throw new Error('GitHub installation id is invalid.');
      return {
        connection: { type: 'app-installation', installationId },
        sourceId: repository.slug,
      };
    },
    getRepositoryAccess: async ({ orgId, repositoryId }) => {
      const repository = await this.sourceControlStorage.repositories.get({ orgId, id: repositoryId });
      if (!repository) throw new Error('Version-control repository not found.');
      const installation = await this.sourceControlStorage.installations.get({
        orgId,
        id: repository.installationId,
      });
      if (!installation) throw new Error('Version-control installation not found.');
      const installationId = Number.parseInt(installation.externalId, 10);
      if (!Number.isSafeInteger(installationId)) throw new Error('GitHub installation id is invalid.');
      return {
        cloneUrl: `https://github.com/${repository.slug}.git`,
        authorization: { scheme: 'bearer', token: await this.mintInstallationToken(installationId) },
      };
    },
    listPullRequests: input => this.#listPullRequests(input),
    getPullRequest: input => this.#getPullRequest(input),
    createPullRequest: input => this.#createPullRequest(input),
    updatePullRequest: input => this.#updatePullRequest(input),
    closePullRequest: input => this.#closePullRequest(input),
    mergePullRequest: input => this.#mergePullRequest(input),
    listComments: input => this.#listComments(input),
    createComment: input => this.#createComment(input),
    updateComment: input => this.#updateComment(input),
    deleteComment: input => this.#deleteComment(input),
    listReviews: input => this.#listReviews(input),
    getReview: input => this.#getReview(input),
    createReview: input => this.#createReview(input),
    updateReview: input => this.#updateReview(input),
    submitReview: input => this.#submitReview(input),
    dismissReview: input => this.#dismissReview(input),
    deletePendingReview: input => this.#deletePendingReview(input),
    listReviewComments: input => this.#listReviewComments(input),
    createReviewComment: input => this.#createReviewComment(input),
    updateReviewComment: input => this.#updateReviewComment(input),
    deleteReviewComment: input => this.#deleteReviewComment(input),
    listRequestedReviewers: input => this.#listRequestedReviewers(input),
    requestReviewers: input => this.#requestReviewers(input),
    removeRequestedReviewers: input => this.#removeReviewers(input),
    publishCommitCheck: input => this.publishCommitCheck(input),
    readApi: input => this.#readApi(input),
    editIssue: input => this.#editIssue(input),
  };
  /**
   * The OAuth/install flow round-trips a signed `state` through GitHub, so a
   * multi-replica deploy needs a deployment-stable state secret. Only the App
   * has that flow.
   */
  get requiresStableStateSigner(): boolean {
    return this.appConfigured;
  }

  /** Per-installation credentials: stored tokens, the env fallback token, else the App. */
  readonly tokens: GithubTokenConnections;
  readonly #appConfigured: boolean;
  readonly #apiBaseUrl: string | undefined;
  readonly #fetchImpl: typeof fetch | undefined;

  readonly #appId: string;
  readonly #privateKey: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #slug: string;
  readonly #webhookSecret: string | undefined;
  readonly #authorizedBots: readonly string[];
  #storage: IntegrationContext['storage'] | undefined;
  #ingestFactoryEvent: ReturnType<typeof attachGithubRules>;
  #sourceControlStorage: IntegrationContext['storage']['sourceControl'] | undefined;
  /** `installationId:owner/repo:login` → cached collaborator permission (TTL-bounded). */
  readonly #collaboratorPermissionCache = new Map<
    string,
    { permission: GithubRepositoryPermission; expiresAt: number }
  >();
  /** Same key → lookup already in flight, so overlapping callers share one request. */
  readonly #collaboratorPermissionInFlight = new Map<string, Promise<GithubRepositoryPermission | undefined>>();
  /**
   * One Octokit per installation, so its auth instance keeps the installation
   * token cached (auth-app refreshes it before expiry) instead of minting a new
   * token on every call.
   */
  readonly #installationOctokits = new Map<number, Octokit>();

  constructor(config: GithubIntegrationConfig = {}) {
    this.#rules = resolveGithubRules(config.rules);
    const app = config;
    const anyAppField = REQUIRED_FIELDS.some(field => app[field] !== undefined);
    const missing = anyAppField ? REQUIRED_FIELDS.filter(field => !app[field]) : [];
    if (missing.length > 0) {
      throw new Error(
        `GithubIntegration: missing required config field(s): ${missing.join(', ')}. ` +
          `Provide the full GitHub App credentials (appId, privateKey, clientId, clientSecret, slug) ` +
          `or omit the integration to disable GitHub-backed repositories.`,
      );
    }
    this.#appId = app.appId ?? '';
    this.#privateKey = app.privateKey ? normalizePrivateKey(app.privateKey) : '';
    this.#clientId = app.clientId ?? '';
    this.#clientSecret = app.clientSecret ?? '';
    this.#slug = app.slug ?? '';
    this.#webhookSecret = config.webhookSecret || undefined;
    this.#authorizedBots = (config.authorizedBots ?? []).map(bot => bot.trim()).filter(Boolean);
    this.#appConfigured = anyAppField;
    this.#apiBaseUrl = config.apiBaseUrl?.replace(/\/+$/, '') || undefined;
    this.#fetchImpl = config.fetchImpl;
    this.tokens = new GithubTokenConnections({
      storage: () => this.integrationStorage,
      envToken: config.accessToken,
      client: {
        ...(config.apiBaseUrl ? { baseUrl: config.apiBaseUrl } : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      },
    });
  }

  /** Whether this server has a GitHub App, so organizations may connect through its install flow. */
  get appConfigured(): boolean {
    return this.#appConfigured;
  }

  /**
   * App slug — the URL name used to build the install URL. Empty without an App: Factory then never
   * claims a login as itself (a token may be a person's own; see ADR-0034).
   */
  get slug(): string {
    return this.#slug;
  }

  /**
   * Process-wide commit authorship: the App bot, else the env token's account once known. A session
   * uses {@link gitIdentityForInstallation}, which knows its connection.
   */
  get gitIdentity(): GitIdentity | undefined {
    if (this.#appConfigured) return { login: `${this.#slug}[bot]` };
    const login = this.tokens.envToken?.login;
    return login ? { login } : undefined;
  }

  /** Commit authorship for a repository of `installationExternalId`: the token's account, or the App bot. */
  async gitIdentityForInstallation(installationExternalId: string | number): Promise<GitIdentity | undefined> {
    const installationId = Number(installationExternalId);
    if (!Number.isSafeInteger(installationId)) return this.gitIdentity;
    const auth = await this.tokens.resolve(installationId).catch(() => undefined);
    if (auth?.kind === 'token') {
      const login = await auth.account.account().then(
        info => info.login,
        () => undefined,
      );
      return login ? { login } : undefined;
    }
    return this.#appConfigured ? { login: `${this.#slug}[bot]` } : undefined;
  }

  /**
   * Whether a GitHub login is Factory's own: the App bot, or the account of a connected token. Only
   * used together with Factory's markers (triage comment, review status), since a token may be a
   * person's own account.
   */
  isFactoryCommentAuthor(login: string | null | undefined): boolean {
    if (typeof login !== 'string') return false;
    const lower = login.toLowerCase();
    if (this.#appConfigured && lower === `${this.#slug}[bot]`.toLowerCase()) return true;
    return this.tokens.knownLogins.has(lower);
  }

  /** Extra bot logins authorized to trigger author-gated PR notifications. */
  get authorizedBots(): readonly string[] {
    return this.#authorizedBots;
  }

  get genericStorage(): IntegrationContext['storage']['generic'] {
    if (!this.#storage) throw new Error('GithubIntegration storage has not been initialized.');
    return this.#storage.generic;
  }

  get sourceControlStorage(): IntegrationContext['storage']['sourceControl'] {
    const storage = this.#sourceControlStorage ?? this.#storage?.sourceControl;
    if (!storage) throw new Error('GithubIntegration source-control storage has not been initialized.');
    return storage;
  }

  get integrationStorage(): GithubSubscriptionStorage {
    if (!this.#storage) throw new Error('GithubIntegration storage has not been initialized.');
    return this.#storage.generic as unknown as GithubSubscriptionStorage;
  }

  /** Resolve a stored GitHub locator without scanning installations or repositories. */
  async #resolveIntakeDispatch({
    orgId,
    externalSource,
  }: {
    orgId: string;
    externalSource: { type: string; externalId: string };
  }): Promise<{ connection: IntegrationConnection; sourceId: string; issueId: string } | null> {
    const target = parseGithubExternalTarget(externalSource.externalId);
    if (!target) return null;
    const repository = await this.sourceControlStorage.repositories.findByExternalId({
      orgId,
      externalId: target.repositoryId,
    });
    if (!repository) return null;
    const installation = await this.sourceControlStorage.installations.get({ orgId, id: repository.installationId });
    if (!installation) return null;
    const installationId = Number.parseInt(installation.externalId, 10);
    if (!Number.isSafeInteger(installationId)) return null;
    return {
      connection: { type: 'app-installation', installationId },
      sourceId: repository.slug,
      issueId: target.issueId,
    };
  }

  /** Secret GitHub uses to sign webhook deliveries, when configured. */
  get webhookSecret(): string | undefined {
    return this.#webhookSecret;
  }

  #appAuth() {
    return {
      appId: this.#appId,
      privateKey: this.#privateKey,
      clientId: this.#clientId,
      clientSecret: this.#clientSecret,
    };
  }

  /**
   * Octokit authenticated as the GitHub App itself (app JWT). Used for
   * app-level operations and to mint installation tokens.
   */
  getAppOctokit(): Octokit {
    if (!this.#appConfigured) throw new Error('This server has no GitHub App configured.');
    return new Octokit({ authStrategy: createAppAuth, auth: this.#appAuth() });
  }

  /**
   * Octokit authenticated as a specific installation (installation access
   * token). Used to list repos and to operate on a repo on the user's behalf.
   */
  getInstallationOctokit(installationId: number): Octokit {
    let octokit = this.#installationOctokits.get(installationId);
    if (octokit) {
      // Re-insert so Map order tracks recency for LRU eviction.
      this.#installationOctokits.delete(installationId);
    } else {
      const created = new Octokit({
        ...(this.#apiBaseUrl ? { baseUrl: this.#apiBaseUrl } : {}),
        ...(this.#fetchImpl ? { request: { fetch: this.#fetchImpl } } : {}),
        authStrategy: perInstallationAuth,
        auth: {
          resolve: () => this.installationAuth(installationId),
          app: this.#appConfigured ? { ...this.#appAuth(), installationId } : undefined,
        } satisfies PerInstallationAuthOptions,
      });
      // auth-app keeps serving a cached token GitHub has revoked (it only retries
      // 401s within 5 s of minting), so drop this client and mint fresh next call.
      // Not on 403: GitHub also uses it for rate limits.
      created.hook.error('request', error => {
        if ('status' in error && error.status === 401 && this.#installationOctokits.get(installationId) === created) {
          this.#installationOctokits.delete(installationId);
        }
        throw error;
      });
      octokit = created;
      if (this.#installationOctokits.size >= INSTALLATION_OCTOKIT_CACHE_MAX_ENTRIES) {
        const oldest = this.#installationOctokits.keys().next().value;
        if (oldest !== undefined) this.#installationOctokits.delete(oldest);
      }
    }
    this.#installationOctokits.set(installationId, octokit);
    return octokit;
  }

  /**
   * How an installation authenticates: a token connection (stored token, or the env fallback for
   * rows the former token mode registered), else the App. Throws
   * {@link GithubInstallationUnavailableError} when it would need the App and there is none.
   */
  async installationAuth(installationId: number): Promise<GithubInstallationAuth> {
    const resolved = await this.tokens.resolve(installationId);
    if (resolved.kind === 'app' && !this.#appConfigured) throw new GithubInstallationUnavailableError(installationId);
    return resolved;
  }

  /** Whether an installation is a token connection; false when it cannot be resolved. */
  async isTokenInstallation(installationId: number): Promise<boolean> {
    return (await this.tokens.resolve(installationId).catch(() => undefined))?.kind === 'token';
  }

  /** Octokit authenticated as a user via their OAuth token (the identify step). */
  getUserOctokit(userToken: string): Octokit {
    return new Octokit({ auth: userToken });
  }

  /**
   * Mint a short-lived installation access token. Returned token is used only
   * server-side / inside the sandbox clone URL and never sent to the browser.
   */
  async mintInstallationToken(installationId: number): Promise<string> {
    const resolved = await this.installationAuth(installationId);
    if (resolved.kind === 'token') return resolved.account.token;
    const auth = createAppAuth(this.#appAuth());
    const installationAuth = await auth({ type: 'installation', installationId });
    return installationAuth.token;
  }

  /**
   * List the installations the authenticated user can access, via their OAuth
   * token (`GET /user/installations`).
   */
  async listUserInstallations(userToken: string): Promise<UserInstallation[]> {
    const octokit = this.getUserOctokit(userToken);
    const installations = await octokit.paginate(octokit.apps.listInstallationsForAuthenticatedUser, {
      per_page: 100,
    });
    return installations.map(inst => ({
      installationId: inst.id,
      accountLogin: inst.account && 'login' in inst.account ? inst.account.login : null,
      accountType: inst.account && 'type' in inst.account ? inst.account.type : null,
    }));
  }

  /**
   * List repos accessible to an installation (paginated). Always reads
   * GitHub directly, so `fresh` has nothing to bypass here.
   */
  async listInstallationRepos(installationId: number, _options?: { fresh?: boolean }): Promise<RepoSummary[]> {
    const resolved = await this.installationAuth(installationId);
    // A token reaches the repositories its account can push to.
    if (resolved.kind === 'token') return resolved.account.listRepos(installationId);
    const octokit = this.getInstallationOctokit(installationId);
    const repos = await octokit.paginate(octokit.apps.listReposAccessibleToInstallation, {
      per_page: 100,
    });
    return repos.map(repo => ({
      id: repo.id,
      fullName: repo.full_name,
      name: repo.name,
      owner: repo.owner.login,
      defaultBranch: repo.default_branch,
      private: repo.private,
      installationId,
    }));
  }

  /**
   * The authenticated user's permission level on a repo, through the
   * installation. `undefined` when the repo/user is not accessible.
   */
  async getRepositoryCollaboratorPermission(
    installationId: number,
    repoFullName: string,
    username: string,
    signal?: AbortSignal,
  ): Promise<GithubRepositoryPermission | undefined> {
    const parts = splitRepoFullName(repoFullName);
    if (!parts) return undefined;
    const cacheKey = `${installationId}:${parts.owner}/${parts.repo}:${username.toLowerCase()}`;
    const cached = this.#collaboratorPermissionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.permission;
    this.#collaboratorPermissionCache.delete(cacheKey);
    const inFlight = this.#collaboratorPermissionInFlight.get(cacheKey);
    if (inFlight) return settleOrAbort(inFlight, signal, undefined);
    const lookup = (async () => {
      try {
        const { data } = await this.getInstallationOctokit(installationId).repos.getCollaboratorPermissionLevel({
          ...parts,
          username,
          request: { signal: AbortSignal.timeout(COLLABORATOR_PERMISSION_LOOKUP_TIMEOUT_MS) },
        });
        const permission = data.permission as GithubRepositoryPermission;
        // Failures are not cached: a rate-limited or aborted lookup must retry
        // on the next call rather than pin the login as unknown.
        this.#collaboratorPermissionCache.set(cacheKey, {
          permission,
          expiresAt: Date.now() + COLLABORATOR_PERMISSION_CACHE_TTL_MS,
        });
        if (this.#collaboratorPermissionCache.size > COLLABORATOR_PERMISSION_CACHE_MAX_ENTRIES) {
          const oldest = this.#collaboratorPermissionCache.keys().next().value;
          if (oldest !== undefined) this.#collaboratorPermissionCache.delete(oldest);
        }
        return permission;
      } catch {
        return undefined;
      } finally {
        this.#collaboratorPermissionInFlight.delete(cacheKey);
      }
    })();
    this.#collaboratorPermissionInFlight.set(cacheKey, lookup);
    return settleOrAbort(lookup, signal, undefined);
  }

  /**
   * Fetch a single repo's metadata through an installation token and confirm
   * the installation actually has access to it. Returns `null` when the repo
   * is not accessible to the installation (so a client can't create a project
   * for an arbitrary repo under an installation id it merely owns).
   */
  async getInstallationRepo(installationId: number, repoFullName: string): Promise<RepoSummary | null> {
    const parts = splitRepoFullName(repoFullName);
    if (!parts) return null;
    const octokit = this.getInstallationOctokit(installationId);
    try {
      const { data } = await octokit.repos.get(parts);
      return {
        id: data.id,
        fullName: data.full_name,
        name: data.name,
        owner: data.owner.login,
        defaultBranch: data.default_branch,
        private: data.private,
        installationId,
      };
    } catch {
      return null;
    }
  }

  async #listIntakeIssues(input: ListIntakeIssuesInput): Promise<{ issues: IntakeIssue[]; nextCursor: string | null }> {
    const installationId = getGithubInstallationId(input.connection);
    const repoFullName = getSingleSourceId(input.sourceIds, 'GitHub Intake requires exactly one repository source.');
    const page = parsePositiveCursor(input.cursor);
    const labels = normalizeLabels(input.labels);
    const result = await this.listRepoOpenIssues(installationId, repoFullName, page, {
      label: labels.length > 0 ? labels.join(',') : undefined,
    });
    return {
      issues: result.issues.map(issue => ({
        id: String(issue.number),
        identifier: `#${issue.number}`,
        title: issue.title,
        url: issue.url,
        author: issue.author,
        state: 'open',
        stateType: 'open',
        priority: null,
        assignee: issue.assignees[0] ?? null,
        assignees: issue.assignees,
        source: repoFullName,
        labels: issue.labels,
        commentCount: issue.comments,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      })),
      nextCursor: result.nextPage === null ? null : String(result.nextPage),
    };
  }

  async #getIntakeIssue(input: GetIntakeIssueInput): Promise<IntakeIssueDetail | null> {
    const installationId = getGithubInstallationId(input.connection);
    const repoFullName = requireSourceId(input.sourceId, 'GitHub Intake requires a repository source.');
    const parts = splitRepoFullName(repoFullName);
    const issueNumber = parsePositiveInteger(input.issueId);
    if (!parts || issueNumber === null) return null;
    const octokit = this.getInstallationOctokit(installationId);
    try {
      const [{ data: issue }, comments] = await Promise.all([
        octokit.issues.get({ owner: parts.owner, repo: parts.repo, issue_number: issueNumber }),
        octokit.paginate(octokit.issues.listComments, {
          owner: parts.owner,
          repo: parts.repo,
          issue_number: issueNumber,
          per_page: 100,
        }),
      ]);
      if (issue.pull_request) return null;
      return {
        id: String(issue.number),
        identifier: `#${issue.number}`,
        title: issue.title,
        url: issue.html_url,
        author: issue.user?.login ?? null,
        state: issue.state,
        stateType: issue.state,
        priority: null,
        assignee: issue.assignee?.login ?? null,
        assignees: (issue.assignees ?? []).map(user => user.login).filter((login): login is string => Boolean(login)),
        source: repoFullName,
        labels: issue.labels.map(label => (typeof label === 'string' ? label : (label.name ?? ''))).filter(Boolean),
        commentCount: issue.comments,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        description: issue.body?.trim() ? issue.body : null,
        comments: comments.map(comment => ({
          author: comment.user?.login ?? null,
          body: comment.body ?? '',
          createdAt: comment.created_at,
        })),
      };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async #updateIntakeIssue(input: UpdateIntakeIssueInput): Promise<IntakeIssue | null> {
    const installationId = getGithubInstallationId(input.connection);
    const repoFullName = requireSourceId(input.sourceId, 'GitHub Intake requires a repository source.');
    const parts = splitRepoFullName(repoFullName);
    const issueNumber = parsePositiveInteger(input.issueId);
    if (!parts || issueNumber === null) return null;
    // GitHub has no custom workflow states; only open/closed. `byName` is a
    // no-op with a warn log.
    if (input.state.kind === 'byName') {
      console.warn(`GitHub integration: updateIssue byName is not supported (name=${input.state.name}); ignoring.`);
      return null;
    }
    const targetState: 'open' | 'closed' =
      input.state.stateType === 'unstarted' || input.state.stateType === 'started' ? 'open' : 'closed';
    const stateReason: 'completed' | 'not_planned' | null =
      targetState === 'closed' ? (input.state.stateType === 'canceled' ? 'not_planned' : 'completed') : null;
    const octokit = this.getInstallationOctokit(installationId);
    try {
      // Pre-flight: Factory does not close pull requests via `updateIssue`.
      // PR merges/closes belong to the version-control pipeline.
      const { data: current } = await octokit.issues.get({
        owner: parts.owner,
        repo: parts.repo,
        issue_number: issueNumber,
      });
      if (current.pull_request) {
        console.warn(
          `GitHub integration: updateIssue rejected — target ${repoFullName}#${issueNumber} is a pull request.`,
        );
        return null;
      }
      const { data: issue } = await octokit.issues.update({
        owner: parts.owner,
        repo: parts.repo,
        issue_number: issueNumber,
        state: targetState,
        ...(stateReason ? { state_reason: stateReason } : {}),
      });
      return {
        id: String(issue.number),
        identifier: `#${issue.number}`,
        title: issue.title,
        url: issue.html_url,
        author: issue.user?.login ?? null,
        state: issue.state,
        stateType: issue.state,
        priority: null,
        assignee: issue.assignee?.login ?? null,
        assignees: (issue.assignees ?? []).map(user => user.login).filter((login): login is string => Boolean(login)),
        source: repoFullName,
        labels: issue.labels.map(label => (typeof label === 'string' ? label : (label.name ?? ''))).filter(Boolean),
        commentCount: issue.comments,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async #createIntakeComment(input: CreateIntakeCommentInput): Promise<{ id: string; url: string } | null> {
    const installationId = getGithubInstallationId(input.connection);
    const repoFullName = requireSourceId(input.sourceId, 'GitHub Intake requires a repository source.');
    const parts = splitRepoFullName(repoFullName);
    const issueNumber = parsePositiveInteger(input.issueId);
    if (!parts || issueNumber === null) return null;
    const octokit = this.getInstallationOctokit(installationId);
    try {
      const { data } = await octokit.issues.createComment({
        owner: parts.owner,
        repo: parts.repo,
        issue_number: issueNumber,
        body: input.body,
      });
      return { id: String(data.id), url: data.html_url };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  protected repositoryClient(
    connection: IntegrationConnection,
    sourceId: string,
  ): { octokit: Octokit; parts: { owner: string; repo: string } } {
    const installationId = getGithubInstallationId(connection);
    const parts = splitRepoFullName(sourceId);
    if (!parts) throw new Error('GitHub pull requests require an owner/repository source.');
    return { octokit: this.getInstallationOctokit(installationId), parts };
  }

  async #listPullRequests(input: InputOf<'listPullRequests'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const page = parsePositiveCursor(input.cursor);
    const response = await octokit.pulls.list({
      ...parts,
      state: input.state ?? 'open',
      per_page: LIST_PAGE_SIZE,
      page,
    });
    const pullRequests = response.data
      .filter(pr => input.includeDrafts !== false || !pr.draft)
      .map(pr => parsePullRequest(pr));
    return {
      pullRequests,
      nextCursor: response.data.length === LIST_PAGE_SIZE ? String(page + 1) : null,
    };
  }

  async #getPullRequest(input: InputOf<'getPullRequest'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const pullNumber = requirePullRequestNumber(input.pullRequestId);
    try {
      const { data } = await octokit.pulls.get({ ...parts, pull_number: pullNumber });
      return parsePullRequest(data);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async #createPullRequest(input: InputOf<'createPullRequest'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.pulls.create({
      ...parts,
      title: input.title,
      body: input.body,
      base: input.baseBranch,
      head: input.headBranch,
      draft: input.draft,
    });
    return parsePullRequest(data);
  }

  async #updatePullRequest(input: InputOf<'updatePullRequest'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.pulls.update({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
      title: input.title,
      body: input.body === null ? '' : input.body,
      base: input.baseBranch,
      state: input.state,
    });
    return parsePullRequest(data);
  }

  async #closePullRequest(input: InputOf<'closePullRequest'>) {
    return this.#updatePullRequest({ ...input, state: 'closed' });
  }

  async #mergePullRequest(input: InputOf<'mergePullRequest'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.pulls.merge({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
      commit_title: input.commitTitle,
      commit_message: input.commitMessage,
      merge_method: input.method,
    });
    return { merged: data.merged, message: data.message, sha: data.sha ?? null };
  }

  async #listComments(input: InputOf<'listComments'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const page = parsePositiveCursor(input.cursor);
    const response = await octokit.issues.listComments({
      ...parts,
      issue_number: requirePullRequestNumber(input.pullRequestId),
      per_page: LIST_PAGE_SIZE,
      page,
    });
    return {
      comments: response.data.map(comment => parsePullRequestComment(comment)),
      nextCursor: response.data.length === LIST_PAGE_SIZE ? String(page + 1) : null,
    };
  }

  async #createComment(input: InputOf<'createComment'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.issues.createComment({
      ...parts,
      issue_number: requirePullRequestNumber(input.pullRequestId),
      body: input.body,
    });
    return parsePullRequestComment(data);
  }

  async #updateComment(input: InputOf<'updateComment'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.issues.updateComment({
      ...parts,
      comment_id: requirePositiveId(input.commentId, 'comment'),
      body: input.body,
    });
    return parsePullRequestComment(data);
  }

  async #deleteComment(input: InputOf<'deleteComment'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    await octokit.issues.deleteComment({ ...parts, comment_id: requirePositiveId(input.commentId, 'comment') });
  }

  async #readApi(input: ReadApiInput): Promise<unknown> {
    const octokit = this.getInstallationOctokit(getGithubInstallationId(input.connection));
    if (input.graphql) return octokit.graphql(input.graphql.query, input.graphql.variables ?? {});
    if (!input.path) throw new Error('A GitHub API read needs a path or a GraphQL query.');
    const { data } = await octokit.request(`GET /${input.path}`, {
      ...input.query,
      ...(input.accept === 'diff' ? { headers: { accept: 'application/vnd.github.diff' } } : {}),
    });
    return data;
  }

  async #editIssue(input: EditIssueInput) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const issue_number = requirePositiveId(input.issueId, 'issue');
    for (const label of input.createLabels ?? []) {
      try {
        await octokit.issues.createLabel({
          ...parts,
          name: label.name,
          ...(label.color ? { color: label.color.replace(/^#/, '') } : {}),
          ...(label.description ? { description: label.description } : {}),
        });
      } catch (err) {
        // 422: the repository already has it, which is what the caller wants.
        if (!(typeof err === 'object' && err !== null && 'status' in err && err.status === 422)) throw err;
      }
    }
    if (input.addLabels?.length) await octokit.issues.addLabels({ ...parts, issue_number, labels: input.addLabels });
    for (const name of input.removeLabels ?? []) {
      try {
        await octokit.issues.removeLabel({ ...parts, issue_number, name });
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }
    const { data } = input.state
      ? await octokit.issues.update({ ...parts, issue_number, state: input.state })
      : await octokit.issues.get({ ...parts, issue_number });
    const comment = input.comment
      ? (await octokit.issues.createComment({ ...parts, issue_number, body: input.comment })).data
      : undefined;
    return {
      labels: data.labels.map(label => (typeof label === 'string' ? label : (label.name ?? ''))).filter(Boolean),
      state: data.state,
      ...(comment ? { commentUrl: comment.html_url } : {}),
    };
  }

  async #listReviews(input: InputOf<'listReviews'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const page = parsePositiveCursor(input.cursor);
    const response = await octokit.pulls.listReviews({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
      per_page: LIST_PAGE_SIZE,
      page,
    });
    return {
      reviews: response.data.map(review => parseReview(review)),
      nextCursor: response.data.length === LIST_PAGE_SIZE ? String(page + 1) : null,
    };
  }

  async #getReview(input: InputOf<'getReview'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    try {
      const { data } = await octokit.pulls.getReview({
        ...parts,
        pull_number: requirePullRequestNumber(input.pullRequestId),
        review_id: requirePositiveId(input.reviewId, 'review'),
      });
      return parseReview(data);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async #createReview(input: InputOf<'createReview'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.pulls.createReview({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
      body: input.body,
      commit_id: input.commitId,
      event: input.event ? reviewEventToGithub(input.event) : undefined,
    });
    return parseReview(data);
  }

  async #updateReview(input: InputOf<'updateReview'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.pulls.updateReview({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
      review_id: requirePositiveId(input.reviewId, 'review'),
      body: input.body,
    });
    return parseReview(data);
  }

  async #submitReview(input: InputOf<'submitReview'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.pulls.submitReview({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
      review_id: requirePositiveId(input.reviewId, 'review'),
      body: input.body,
      event: reviewEventToGithub(input.event),
    });
    return parseReview(data);
  }

  async #dismissReview(input: InputOf<'dismissReview'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.pulls.dismissReview({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
      review_id: requirePositiveId(input.reviewId, 'review'),
      message: input.message,
    });
    return parseReview(data);
  }

  async #deletePendingReview(input: InputOf<'deletePendingReview'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    await octokit.pulls.deletePendingReview({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
      review_id: requirePositiveId(input.reviewId, 'review'),
    });
  }

  async #listReviewComments(input: InputOf<'listReviewComments'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const page = parsePositiveCursor(input.cursor);
    const response = await octokit.pulls.listReviewComments({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
      per_page: LIST_PAGE_SIZE,
      page,
    });
    return {
      comments: response.data.map(comment => parseReviewComment(comment)),
      nextCursor: response.data.length === LIST_PAGE_SIZE ? String(page + 1) : null,
    };
  }

  async #createReviewComment(input: InputOf<'createReviewComment'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const pullNumber = requirePullRequestNumber(input.pullRequestId);
    if (input.replyToId) {
      const { data } = await octokit.pulls.createReplyForReviewComment({
        ...parts,
        pull_number: pullNumber,
        comment_id: requirePositiveId(input.replyToId, 'review comment'),
        body: input.body,
      });
      return parseReviewComment(data);
    }
    if (!input.commitId || !input.path || input.line === undefined || !input.side) {
      throw new Error('A review comment requires commitId, path, line, and side unless it is a reply.');
    }
    if ((input.startLine === undefined) !== (input.startSide === undefined)) {
      throw new Error('A multi-line review comment requires both startLine and startSide.');
    }
    const { data } = await octokit.pulls.createReviewComment({
      ...parts,
      pull_number: pullNumber,
      body: input.body,
      commit_id: input.commitId,
      path: input.path,
      line: input.line,
      side: input.side.toUpperCase() as 'LEFT' | 'RIGHT',
      start_line: input.startLine,
      start_side: input.startSide?.toUpperCase() as 'LEFT' | 'RIGHT' | undefined,
    });
    return parseReviewComment(data);
  }

  async #updateReviewComment(input: InputOf<'updateReviewComment'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.pulls.updateReviewComment({
      ...parts,
      comment_id: requirePositiveId(input.commentId, 'review comment'),
      body: input.body,
    });
    return parseReviewComment(data);
  }

  async #deleteReviewComment(input: InputOf<'deleteReviewComment'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    await octokit.pulls.deleteReviewComment({
      ...parts,
      comment_id: requirePositiveId(input.commentId, 'review comment'),
    });
  }

  async #listRequestedReviewers(input: InputOf<'listRequestedReviewers'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.pulls.listRequestedReviewers({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
    });
    return parseRequestedReviewers(data);
  }

  async #requestReviewers(input: InputOf<'requestReviewers'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.pulls.requestReviewers({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
      reviewers: input.users ?? [],
      team_reviewers: input.teams ?? [],
    });
    return parseRequestedReviewers(data);
  }

  async #removeReviewers(input: InputOf<'removeRequestedReviewers'>) {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.pulls.removeRequestedReviewers({
      ...parts,
      pull_number: requirePullRequestNumber(input.pullRequestId),
      reviewers: input.users ?? [],
      team_reviewers: input.teams ?? [],
    });
    return parseRequestedReviewers(data);
  }

  /**
   * Always creates a new check run: GitHub shows the latest run per app and
   * name on a commit, so a completed run supersedes an earlier in-progress one.
   */
  async publishCommitCheck(input: InputOf<'publishCommitCheck'>): Promise<CommitCheck> {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    // Check runs are App-only on GitHub; a token connection publishes a commit status per name
    // (GitHub keeps the latest status per context on a commit).
    if ((await this.installationAuth(getGithubInstallationId(input.connection))).kind === 'token') {
      const { data } = await octokit.repos.createCommitStatus({
        ...parts,
        sha: input.headSha,
        state: STATUS_STATE[input.status],
        context: input.name,
        description: input.title.slice(0, STATUS_DESCRIPTION_LIMIT),
      });
      return { id: String(data.id), name: data.context, headSha: input.headSha, status: input.status, url: data.target_url ?? null };
    }
    const { status } = input;
    const { data } = await octokit.checks
      .create({
        ...parts,
        name: input.name,
        head_sha: input.headSha,
        ...(status === 'in-progress'
          ? { status: 'in_progress' as const }
          : { status: 'completed' as const, conclusion: status, completed_at: new Date().toISOString() }),
        output: {
          title: input.title.slice(0, GITHUB_CHECK_TITLE_LIMIT),
          summary: input.summary.slice(0, GITHUB_CHECK_TEXT_LIMIT),
          ...(input.details ? { text: input.details.slice(0, GITHUB_CHECK_TEXT_LIMIT) } : {}),
        },
      })
      .catch((error: unknown) => {
        if ((error as { status?: number } | null)?.status === 403) {
          throw new Error(
            'github cannot publish commit checks: the GitHub App lacks the "checks: write" permission; nothing was published.',
          );
        }
        throw error;
      });
    return { id: String(data.id), name: data.name, headSha: data.head_sha, status: input.status, url: data.html_url };
  }

  /** Add labels to an issue (deduplicated; no-op on empty/malformed input). */
  async addIssueLabels(
    installationId: number,
    repoFullName: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void> {
    const parts = splitRepoFullName(repoFullName);
    if (!parts) return;
    const uniqueLabels = [...new Set(labels.map(label => label.trim()).filter(Boolean))];
    if (uniqueLabels.length === 0) return;
    const octokit = this.getInstallationOctokit(installationId);
    await octokit.issues.addLabels({
      owner: parts.owner,
      repo: parts.repo,
      issue_number: issueNumber,
      labels: uniqueLabels,
    });
  }

  /** Remove one label from an issue. */
  async removeIssueLabel(
    installationId: number,
    repoFullName: string,
    issueNumber: number,
    label: string,
  ): Promise<void> {
    const parts = splitRepoFullName(repoFullName);
    const labelName = label.trim();
    if (!parts || !labelName) return;
    const octokit = this.getInstallationOctokit(installationId);
    await octokit.issues.removeLabel({
      owner: parts.owner,
      repo: parts.repo,
      issue_number: issueNumber,
      name: labelName,
    });
  }

  /**
   * List one page of a repo's open issues through an installation token. The
   * issues API also returns pull requests, so those are filtered out (the
   * filter can make a non-final page shorter than the page size — `nextPage`
   * is derived from the raw response length, not the filtered one).
   */
  async listRepoOpenIssues(
    installationId: number,
    repoFullName: string,
    page: number,
    options: ListRepoOpenIssuesOptions = {},
  ): Promise<IssuePage> {
    const parts = splitRepoFullName(repoFullName);
    if (!parts) return { issues: [], nextPage: null };
    const octokit = this.getInstallationOctokit(installationId);
    const response = await octokit.issues.listForRepo({
      owner: parts.owner,
      repo: parts.repo,
      state: 'open',
      labels: options.label,
      per_page: LIST_PAGE_SIZE,
      page,
    });
    const issues = response.data
      .filter(issue => !issue.pull_request)
      .map(issue => ({
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        author: issue.user?.login ?? null,
        assignees: issue.assignees?.flatMap(assignee => (assignee.login ? [assignee.login] : [])) ?? [],
        labels: issue.labels.map(label => (typeof label === 'string' ? label : (label.name ?? ''))).filter(Boolean),
        comments: issue.comments,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      }));
    return { issues, nextPage: response.data.length === LIST_PAGE_SIZE ? page + 1 : null };
  }

  /**
   * Build the GitHub App install URL. `state` is carried through the install
   * flow and validated on callback.
   */
  buildInstallUrl(state: string): string {
    if (!this.#appConfigured) throw new Error('This server has no GitHub App to install.');
    const url = new URL(`https://github.com/apps/${this.#slug}/installations/new`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /**
   * Build the OAuth identify URL (authorize) used to confirm the user's
   * identity and obtain a user token for listing their installations.
   */
  buildOAuthIdentifyUrl(state: string, redirectUri: string): string {
    if (!this.#appConfigured) throw new Error('This server has no GitHub App to authorize.');
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.#clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** Exchange an OAuth `code` for a user access token. */
  async exchangeOAuthCode(code: string, redirectUri: string): Promise<string> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      signal: AbortSignal.timeout(GITHUB_OAUTH_TOKEN_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) {
      throw new Error(`GitHub OAuth token exchange failed: ${res.status}`);
    }
    const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!data.access_token) {
      throw new Error(
        `GitHub OAuth token exchange returned no token: ${data.error_description ?? data.error ?? 'unknown'}`,
      );
    }
    return data.access_token;
  }

  /**
   * The integration's HTTP surface: the `/web/github/*` + `/auth/github/*`
   * Mastra `apiRoutes` (webhook handler, install/OAuth flow, project +
   * worktree + session operations). The factory folds these into the server's
   * `apiRoutes` when the feature is ready. Handlers operate on this instance.
   */
  routes(ctx: IntegrationContext): ApiRoute[] {
    this.#storage = ctx.storage;
    // The fallback token's account is read at boot, so legacy token connections and their commit
    // identity are known early, and a bad token is reported once.
    void this.tokens.envToken?.account().catch((error: unknown) => {
      console.warn('[GitHub] The fallback GITHUB_ACCESS_TOKEN could not be verified.', error);
    });
    const ingestFactoryEvent = attachGithubRules(this, ctx);
    this.#ingestFactoryEvent = ingestFactoryEvent;
    return buildGithubRoutes({
      github: this,
      auth: ctx.auth,
      sandbox: ctx.sandbox,
      ...(ctx.users ? { users: ctx.users } : {}),
      storage: ctx.factoryStorage,
      stateSigner: ctx.stateSigner,
      baseUrl: ctx.baseUrl,
      controller: ctx.controller,
      memorySettings: ctx.storage.memorySettings,
      emitAudit: ctx.hooks?.emitAudit,
      projects: ctx.storage.projects,
      ingestFactoryEvent,
      sessionRetirement: ctx.sessionRetirement,
      ...(ctx.workItems ? { workItems: ctx.workItems } : {}),
    });
  }

  /** The organization's GitHub connections for Settings › Підключення (ADR-0035). */
  connections(ctx: IntegrationContext): IntegrationConnections {
    return new GithubConnections({
      github: this,
      projects: ctx.storage.projects,
      ...(ctx.sessionRetirement ? { sessionRetirement: ctx.sessionRetirement } : {}),
      ...(ctx.workItems ? { workItems: ctx.workItems } : {}),
    });
  }

  /**
   * Import a newly linked repository's open issues and pull requests onto
   * the board. No-op until routes are mounted with rules configured.
   */
  async ingestLinkedRepositoryBacklog(args: { orgId: string; projectRepositoryId: string }): Promise<void> {
    await ingestLinkedRepositoryBacklog({ github: this, ...args, ingestFactoryEvent: this.#ingestFactoryEvent });
  }

  /**
   * The repositories whose issues the issue sweep reads. An App connection: all of them, since
   * webhooks deliver every linked repository's issues to the rules anyway. A token connection: only
   * the repositories a project's intake routes name (`source.repository`, GitHub routes), while
   * GitHub intake is switched on. Its sweep files every open issue it finds without a card, so
   * reading every repository the environment links would turn a repository's whole issue list into
   * cards for a project that takes its work from elsewhere. Without the routes domain nothing of a
   * token connection is read.
   */
  protected async issueSweepRepositories(
    ctx: IntegrationContext,
    repositories: ReconcileRepository[],
  ): Promise<ReconcileRepository[]> {
    const selected: ReconcileRepository[] = [];
    const routes = ctx.runtime?.intakeRoutes;
    for (const repository of repositories) {
      if (!(await this.isTokenInstallation(repository.installationId))) {
        selected.push(repository);
        continue;
      }
      if (!routes) continue;
      const projects = await ctx.storage.sourceControl.projectRepositories.listByExternalRepository({
        installationExternalId: String(repository.installationId),
        repositoryExternalId: String(repository.id),
      });
      for (const project of projects) {
        const selection = (await ctx.storage.intake.getConfig({ orgId: project.orgId, integrationIds: [this.id] }))[
          this.id
        ];
        if (!selection?.enabled) continue;
        const named = routedSourceScopes(
          await routes.listIntakeRoutes({ orgId: project.orgId, factoryProjectId: project.factoryProjectId }),
          'source.repository',
          this.id,
        );
        if (named.some(slug => slug.toLowerCase() === repository.fullName.toLowerCase())) {
          selected.push(repository);
          break;
        }
      }
    }
    return selected;
  }

  /**
   * A sweep that reads, for token connections, the pull-request activity webhooks would otherwise
   * deliver. App connections receive webhooks and are skipped.
   */
  protected pullRequestActivitySweep(ctx: IntegrationContext): GithubPullRequestReconciler | undefined {
    const options = githubRulesOptions(this, ctx);
    if (!options) return undefined;
    const sweep = createGithubPullRequestActivitySweep({
      source: octokitPullRequestActivitySource(installationId => this.getInstallationOctokit(installationId)),
      sourceControl: options.sourceControl,
      integrationStorage: options.integrationStorage,
      storage: options.storage,
      selfLogin: async installationId => {
        const resolved = await this.tokens.resolve(installationId);
        return resolved.kind === 'token' ? (await resolved.account.account()).login : undefined;
      },
      deliver: event => this.deliverPolledEvent(ctx, event),
    });
    return async repositories => {
      const tokenRepositories: ReconcileRepository[] = [];
      for (const repository of repositories) {
        if (await this.isTokenInstallation(repository.installationId)) tokenRepositories.push(repository);
      }
      return sweep(tokenRepositories);
    };
  }

  /**
   * Runs a delivery read by polling through the webhook pipeline: the rules
   * ingress, then the sessions subscribed to its pull request.
   */
  protected async deliverPolledEvent(ctx: IntegrationContext, event: ParsedGithubWebhook): Promise<void> {
    await deliverGithubEvent(event, {
      github: this,
      ...(this.#ingestFactoryEvent ? { ingestFactoryEvent: this.#ingestFactoryEvent } : {}),
      ...(ctx.controller ? { controller: ctx.controller } : {}),
    });
  }

  /**
   * Keeps an App connection's repositories to their own pace inside sweeps that run at the token
   * pace: a token connection's repositories pass on every sweep, an App connection's once
   * `intervalMs` has passed since they last did.
   */
  #paceAppRepositories<T>(
    sweep: ((repositories: ReconcileRepository[]) => Promise<T>) | undefined,
    intervalMs: number,
  ): ((repositories: ReconcileRepository[]) => Promise<T>) | undefined {
    if (!sweep) return undefined;
    let nextAppSweepAt = 0;
    return async repositories => {
      const now = Date.now();
      const appDue = now >= nextAppSweepAt;
      if (appDue) nextAppSweepAt = now + intervalMs;
      const selected: ReconcileRepository[] = [];
      for (const repository of repositories) {
        if (appDue || (await this.isTokenInstallation(repository.installationId))) selected.push(repository);
      }
      return sweep(selected);
    };
  }

  /**
   * Pull-request and issue sweeps share a worker and lease, but can be enabled
   * and paced independently. The legacy combined controls remain the fallback.
   *
   * Token connections get no webhooks, so the worker ticks at the token pace (two minutes); App
   * connections' repositories keep the hourly drift sweep (five minutes for discovery) unless an
   * interval is configured, which then paces both.
   */
  workers(ctx: IntegrationContext): MastraWorker[] {
    const pullRequestEnabled = reconciliationEnabled(
      process.env.MASTRACODE_GITHUB_PR_RECONCILE_ENABLED,
      process.env.MASTRACODE_GITHUB_RECONCILE_ENABLED,
    );
    const issueEnabled = reconciliationEnabled(
      process.env.MASTRACODE_GITHUB_ISSUE_RECONCILE_ENABLED,
      process.env.MASTRACODE_GITHUB_RECONCILE_ENABLED,
    );
    if (!pullRequestEnabled && !issueEnabled) return [];

    const legacyInterval = reconcileInterval(process.env.MASTRACODE_GITHUB_RECONCILE_INTERVAL_MS);
    const configuredPullRequestInterval =
      reconcileInterval(process.env.MASTRACODE_GITHUB_PR_RECONCILE_INTERVAL_MS) ?? legacyInterval;
    const configuredIssueInterval =
      reconcileInterval(process.env.MASTRACODE_GITHUB_ISSUE_RECONCILE_INTERVAL_MS) ?? legacyInterval;
    const configuredDiscoveryInterval = reconcileInterval(process.env.MASTRACODE_GITHUB_PR_DISCOVERY_INTERVAL_MS);

    const merges = pullRequestEnabled
      ? attachGithubReconciler(this, ctx, input => this.fetchPullRequestState(input))
      : undefined;
    const activity = pullRequestEnabled ? this.pullRequestActivitySweep(ctx) : undefined;
    const pacedMerges = this.#paceAppRepositories(
      merges,
      configuredPullRequestInterval ?? DEFAULT_GITHUB_RECONCILE_INTERVAL_MS,
    );
    const reconcile: GithubPullRequestReconciler | undefined =
      pacedMerges && activity
        ? async repositories => {
            // Activity first: it records the pull requests Factory opened, which
            // the merge reconcile then finds on their cards.
            const polled = await activity(repositories);
            const reconciled = await pacedMerges(repositories);
            return {
              repositories: reconciled.repositories,
              checked: polled.checked + reconciled.checked,
              merged: polled.merged + reconciled.merged,
              closed: polled.closed + reconciled.closed,
              failed: polled.failed + reconciled.failed,
              errors: [...polled.errors, ...reconciled.errors].slice(0, RECONCILE_ERROR_SAMPLE_LIMIT),
            };
          }
        : (pacedMerges ?? activity);
    const discover = this.#paceAppRepositories(
      pullRequestEnabled
        ? attachGithubPullRequestDiscovery(this, ctx, openPullRequestLister(this.versionControl))
        : undefined,
      configuredDiscoveryInterval ?? DEFAULT_GITHUB_PR_DISCOVERY_INTERVAL_MS,
    );
    const issueSweep = issueEnabled
      ? attachGithubIssueReconciler(
          this,
          ctx,
          input => this.fetchIssueState(input),
          input => this.listOpenIssueStates(input),
        )
      : undefined;
    const issues: GithubIssueReconciler | undefined = this.#paceAppRepositories(
      issueSweep ? async (repositories: ReconcileRepository[]) => issueSweep(await this.issueSweepRepositories(ctx, repositories)) : undefined,
      configuredIssueInterval ?? DEFAULT_GITHUB_RECONCILE_INTERVAL_MS,
    );
    if (!reconcile && !issues && !discover) return [];

    const intervalMs = configuredPullRequestInterval ?? GITHUB_TOKEN_RECONCILE_INTERVAL_MS;
    const issueIntervalMs = configuredIssueInterval ?? GITHUB_TOKEN_RECONCILE_INTERVAL_MS;
    const discoveryIntervalMs = configuredDiscoveryInterval ?? Math.min(intervalMs, DEFAULT_GITHUB_PR_DISCOVERY_INTERVAL_MS);
    return [
      new GithubReconcileWorker({
        ...(reconcile ? { reconcile } : {}),
        ...(issues ? { reconcileIssues: issues } : {}),
        ...(discover ? { discover } : {}),
        sourceControl: ctx.storage.sourceControl,
        intervalMs,
        issueIntervalMs,
        discoveryIntervalMs,
      }),
    ];
  }

  /**
   * Reads live PR state for the merge reconciler. Returns undefined when the PR
   * cannot be resolved so a sweep never fabricates a merge.
   */
  async fetchPullRequestState(input: {
    installationId: number;
    repository: string;
    number: number;
  }): Promise<ReconcilePullRequestState | undefined> {
    try {
      const pullRequest = await this.#getPullRequest({
        connection: { type: 'app-installation', installationId: input.installationId },
        sourceId: input.repository,
        pullRequestId: String(input.number),
      });
      if (!pullRequest) return undefined;
      return {
        title: pullRequest.title,
        url: pullRequest.url,
        state: pullRequest.state === 'closed' ? 'closed' : 'open',
        draft: pullRequest.draft,
        merged: pullRequest.merged,
        assignees: pullRequest.assignees ?? [],
        requestedReviewers: pullRequest.requestedReviewers ?? [],
        labels: pullRequest.labels ?? [],
        headBranch: pullRequest.headBranch,
        baseBranch: pullRequest.baseBranch,
        ...(pullRequest.author ? { author: pullRequest.author } : {}),
        ...(pullRequest.createdAt ? { createdAt: pullRequest.createdAt } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Reads live issue state for the reconciler. Returns undefined when the
   * issue cannot be resolved (missing, is actually a PR, API error) so a
   * sweep never fabricates a close.
   */
  async fetchIssueState(input: {
    installationId: number;
    repository: string;
    number: number;
  }): Promise<ReconcileIssueState | undefined> {
    const parts = splitRepoFullName(input.repository);
    if (!parts) return undefined;
    try {
      const octokit = this.getInstallationOctokit(input.installationId);
      const { data: issue } = await octokit.issues.get({
        owner: parts.owner,
        repo: parts.repo,
        issue_number: input.number,
      });
      if (issue.pull_request) return undefined;
      return {
        title: issue.title,
        url: issue.html_url,
        state: issue.state === 'closed' ? 'closed' : 'open',
        ...(issue.state_reason ? { stateReason: issue.state_reason } : {}),
        assignees: (issue.assignees ?? []).map(user => user.login).filter((login): login is string => Boolean(login)),
        labels: (issue.labels ?? [])
          .map(label => (typeof label === 'string' ? label : label.name))
          .filter((name): name is string => Boolean(name)),
        ...(issue.user?.login ? { author: issue.user.login } : {}),
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Lists a repository's open issues (pull requests excluded) so the issue
   * sweep can mint cards for issues whose webhook never arrived.
   */
  async listOpenIssueStates(input: {
    installationId: number;
    repository: string;
  }): Promise<Array<ReconcileIssueState & { number: number }>> {
    const parts = splitRepoFullName(input.repository);
    if (!parts) return [];
    const octokit = this.getInstallationOctokit(input.installationId);
    const issues: Array<ReconcileIssueState & { number: number }> = [];
    for (let page = 1; page <= OPEN_ISSUE_DISCOVERY_MAX_PAGES; page += 1) {
      const { data } = await octokit.issues.listForRepo({
        owner: parts.owner,
        repo: parts.repo,
        state: 'open',
        per_page: OPEN_ISSUE_DISCOVERY_PAGE_SIZE,
        page,
      });
      for (const issue of data) {
        if (issue.pull_request) continue;
        issues.push({
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          state: 'open',
          assignees: (issue.assignees ?? []).map(user => user.login).filter((login): login is string => Boolean(login)),
          labels: (issue.labels ?? [])
            .map(label => (typeof label === 'string' ? label : label.name))
            .filter((name): name is string => Boolean(name)),
          ...(issue.user?.login ? { author: issue.user.login } : {}),
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
        });
      }
      if (data.length < OPEN_ISSUE_DISCOVERY_PAGE_SIZE) break;
    }
    return issues;
  }

  /**
   * Session-scoped agent tools for token refresh and PR subscriptions in
   * sessions bound to a GitHub-backed project. Empty elsewhere.
   */
  async upsertFactoryTriageComment(input: GithubTriageCommentUpsertInput): Promise<GithubTriageCommentUpsertResult> {
    const parts = splitRepoFullName(input.repository);
    if (!parts) throw new Error('GitHub triage comments require an owner/repository source.');
    const octokit = this.getInstallationOctokit(input.installationId);
    const comments = [] as Array<{
      id: number;
      body?: string | null;
      user?: { login?: string } | null;
      html_url: string;
    }>;
    for (let page = 1; ; page += 1) {
      const response = await octokit.issues.listComments({
        ...parts,
        issue_number: input.issueNumber,
        per_page: 100,
        page,
      });
      comments.push(...response.data);
      if (response.data.length < 100) break;
    }
    const existing = comments
      .filter(
        comment =>
          comment.body?.includes('<!-- mastra-factory-triage -->') && this.isFactoryCommentAuthor(comment.user?.login),
      )
      .sort((left, right) => left.id - right.id)[0];
    if (existing) {
      const { data } = await octokit.issues.updateComment({ ...parts, comment_id: existing.id, body: input.body });
      return { action: 'updated', commentId: String(data.id), url: data.html_url };
    }
    const { data } = await octokit.issues.createComment({
      ...parts,
      issue_number: input.issueNumber,
      body: input.body,
    });
    return { action: 'created', commentId: String(data.id), url: data.html_url };
  }

  sessionTools({ requestContext }: { requestContext: RequestContext }): IntegrationTools {
    return createGithubSubscriptionTools(requestContext, this);
  }

  async postToolObserver({
    toolContext,
    requestContext,
  }: Parameters<NonNullable<FactoryIntegration['postToolObserver']>>[0]): Promise<void> {
    const pullRequestUrl = parseCreatedPullRequest(toolContext);
    if (!pullRequestUrl || !requestContext) return;
    await subscribeCurrentSessionToPullRequest(requestContext, pullRequestUrl, 'auto-gh-pr-create', this);
  }

  /** Non-secret config snapshot for system diagnostics/startup logs. */
  diagnostics(): Record<string, unknown> {
    const envToken = this.tokens.envToken;
    return {
      appConfigured: this.#appConfigured,
      slug: this.#slug,
      webhookSecretConfigured: this.#webhookSecret !== undefined,
      fallbackTokenConfigured: envToken !== undefined,
      fallbackTokenAccount: envToken?.login ?? null,
      fallbackTokenRejected: envToken?.rejected ?? false,
    };
  }
}

interface GithubPullRequestData {
  number: number;
  title: string;
  html_url: string;
  user: { login?: string } | null;
  assignees?: Array<{ login?: string }> | null;
  requested_reviewers?: Array<{ login?: string }> | null;
  labels?: Array<{ name?: string } | string> | null;
  body?: string | null;
  state: string;
  draft?: boolean | null;
  merged?: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  base: { ref: string };
  head: { ref: string; sha: string };
  created_at: string;
  updated_at: string;
}

interface GithubCommentData {
  id: number;
  html_url: string;
  user: { login?: string } | null;
  body?: string | null;
  created_at: string;
  updated_at: string;
}

interface GithubReviewData {
  id: number;
  html_url?: string;
  user: { login?: string } | null;
  body?: string | null;
  state: string;
  commit_id?: string | null;
  submitted_at?: string | null;
}

interface GithubReviewCommentData extends GithubCommentData {
  path: string;
  line?: number | null;
  side?: string | null;
  commit_id: string;
  in_reply_to_id?: number | null;
}

function parsePullRequest(pr: GithubPullRequestData): PullRequest {
  return {
    id: String(pr.number),
    title: pr.title,
    url: pr.html_url,
    author: pr.user?.login ?? null,
    assignees: (pr.assignees ?? []).flatMap(assignee => (assignee.login ? [assignee.login] : [])),
    requestedReviewers: (pr.requested_reviewers ?? []).flatMap(reviewer => (reviewer.login ? [reviewer.login] : [])),
    labels: (pr.labels ?? []).flatMap(label => (typeof label === 'string' ? [label] : label.name ? [label.name] : [])),
    body: pr.body?.trim() ? pr.body : null,
    state: pr.state === 'closed' ? 'closed' : 'open',
    draft: pr.draft ?? false,
    merged: pr.merged ?? Boolean(pr.merged_at),
    mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    headSha: pr.head.sha,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
  };
}

function parsePullRequestComment(comment: GithubCommentData): PullRequestComment {
  return {
    id: String(comment.id),
    url: comment.html_url,
    author: comment.user?.login ?? null,
    body: comment.body ?? '',
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
}

function parseReview(review: GithubReviewData): Review {
  return {
    id: String(review.id),
    url: review.html_url ?? null,
    author: review.user?.login ?? null,
    body: review.body?.trim() ? review.body : null,
    state: parseReviewState(review.state),
    commitId: review.commit_id ?? null,
    submittedAt: review.submitted_at ?? null,
  };
}

function parseReviewComment(comment: GithubReviewCommentData): ReviewComment {
  const parsed = parsePullRequestComment(comment);
  const side = comment.side?.toLowerCase();
  return {
    ...parsed,
    path: comment.path,
    line: comment.line ?? null,
    side: side === 'left' || side === 'right' ? side : null,
    commitId: comment.commit_id,
    replyToId: comment.in_reply_to_id ? String(comment.in_reply_to_id) : null,
  };
}

function parseRequestedReviewers(data: {
  users?: Array<{ login?: string }> | null;
  teams?: Array<{ slug?: string }> | null;
  requested_reviewers?: Array<{ login?: string }> | null;
  requested_teams?: Array<{ slug?: string }> | null;
}) {
  return {
    users: (data.users ?? data.requested_reviewers ?? []).flatMap(user => (user.login ? [user.login] : [])),
    teams: (data.teams ?? data.requested_teams ?? []).flatMap(team => (team.slug ? [team.slug] : [])),
  };
}

function parseReviewState(state: string): Review['state'] {
  if (state === 'PENDING') return 'pending';
  if (state === 'COMMENTED') return 'commented';
  if (state === 'APPROVED') return 'approved';
  if (state === 'CHANGES_REQUESTED') return 'changes-requested';
  if (state === 'DISMISSED') return 'dismissed';
  throw new Error(`Unsupported GitHub review state: ${state}`);
}

function reviewEventToGithub(event: Exclude<InputOf<'createReview'>['event'], undefined>) {
  if (event === 'approve') return 'APPROVE' as const;
  if (event === 'request-changes') return 'REQUEST_CHANGES' as const;
  return 'COMMENT' as const;
}

function requirePullRequestNumber(value: string): number {
  return requirePositiveId(value, 'pull request');
}

function requirePositiveId(value: string, resource: string): number {
  const parsed = parsePositiveInteger(value);
  if (parsed === null) throw new Error(`GitHub ${resource} id must be a positive integer.`);
  return parsed;
}

function getGithubInstallationId(connection: IntegrationConnection): number {
  if (connection.type !== 'app-installation') {
    throw new Error('GitHub capabilities require an app-installation connection.');
  }
  return connection.installationId;
}

function getSingleSourceId(sourceIds: string[], message: string): string {
  if (sourceIds.length !== 1) throw new Error(message);
  return sourceIds[0]!;
}

function normalizeLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map(label => label.trim()).filter(Boolean))];
}

function requireSourceId(sourceId: string | undefined, message: string): string {
  if (!sourceId) throw new Error(message);
  return sourceId;
}

function parsePositiveCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  const page = parsePositiveInteger(cursor);
  if (page === null) throw new Error('GitHub cursor must be a positive page number.');
  return page;
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}

/** Split an `owner/name` full name into its parts, or `null` when malformed. */
function splitRepoFullName(repoFullName: string): { owner: string; repo: string } | null {
  const slash = repoFullName.indexOf('/');
  if (slash <= 0 || slash === repoFullName.length - 1) return null;
  return { owner: repoFullName.slice(0, slash), repo: repoFullName.slice(slash + 1) };
}

function parseGithubExternalTarget(externalId: string): { repositoryId: string; issueId: string } | null {
  const match = externalId.match(/^github:(\d+):(?:issue|pull-request):(\d+)$/) ?? externalId.match(/^(\d+):(\d+)$/);
  if (!match?.[1] || !match[2]) return null;
  const repositoryId = parsePositiveInteger(match[1]);
  const issueId = parsePositiveInteger(match[2]);
  return repositoryId && issueId ? { repositoryId: String(repositoryId), issueId: String(issueId) } : null;
}

/** Options of {@link perInstallationAuth}: how to resolve the installation, and its App credentials. */
interface PerInstallationAuthOptions {
  resolve: () => Promise<GithubInstallationAuth>;
  app: (Parameters<typeof createAppAuth>[0] & { installationId: number }) | undefined;
}

type OctokitRequestHook = (
  request: ((options: Record<string, unknown>) => Promise<unknown>) & {
    endpoint: { merge: (route: unknown, parameters?: unknown) => Record<string, unknown> & { headers: Record<string, string> } };
  },
  route: unknown,
  parameters?: unknown,
) => Promise<unknown>;

/**
 * Octokit auth strategy that decides per request how its installation authenticates (ADR-0034):
 * a token connection sends its token, anything else goes through the App's installation auth. The
 * decision is made per request, so a token connected, replaced or removed later takes effect
 * without rebuilding cached clients.
 */
function perInstallationAuth(options: PerInstallationAuthOptions & Record<string, unknown>) {
  const { resolve, app, ...octokitOptions } = options;
  const appAuth = app ? createAppAuth({ ...octokitOptions, ...app } as Parameters<typeof createAppAuth>[0]) : undefined;
  const auth = async (parameters?: Record<string, unknown>) => {
    const resolved = await resolve();
    if (resolved.kind === 'token') return { type: 'token', tokenType: 'oauth', token: resolved.account.token };
    if (!appAuth) throw new Error('This server has no GitHub App configured.');
    return appAuth((parameters ?? { type: 'installation' }) as Parameters<typeof appAuth>[0]);
  };
  const hook: OctokitRequestHook = async (request, route, parameters) => {
    const resolved = await resolve();
    if (resolved.kind === 'token') {
      const endpoint = request.endpoint.merge(route, parameters);
      endpoint.headers.authorization = `token ${resolved.account.token}`;
      try {
        const response = await request(endpoint);
        resolved.account.markAccepted();
        return response;
      } catch (error) {
        if ((error as { status?: number }).status === 401) resolved.account.markRejected();
        throw error;
      }
    }
    if (!appAuth) throw new Error('This server has no GitHub App configured.');
    return (appAuth.hook as unknown as OctokitRequestHook)(request, route, parameters);
  };
  return Object.assign(auth, { hook });
}
