/**
 * `GithubTokenIntegration` — GitHub through one access token, without a GitHub App.
 *
 * Every API call, clone and push, and the sandbox `GH_TOKEN` use the token, so
 * Factory reaches exactly the repositories the token's account can push to.
 * There is no App to install: Connect registers the token's account as the
 * org's single installation, keyed by the account's numeric id.
 *
 * Nothing delivers webhooks to this mode. Factory learns about new and closed
 * issues and merged pull requests by polling (the issue and pull-request
 * reconcile sweeps), paced every two minutes unless configured otherwise.
 * Comments and review events are not polled.
 *
 * The token may be a person's own. Factory then writes as that person, so it
 * cannot tell its own comments, issues and pull requests apart from the
 * person's by author. It therefore never claims a login as itself: its pull
 * requests are still recognised by their provenance marker, and its triage
 * comment by marker plus the token's login.
 *
 * Commit checks are App-only on GitHub; this mode publishes commit statuses.
 *
 * The token belongs to the deployment, not to an org, so exactly one org may
 * connect it: the one named by `orgId` (`GITHUB_ACCESS_TOKEN_ORG_ID`), else the
 * first org to connect, which claims the token's account. Other orgs are
 * refused, so they never see the account's repositories.
 */

import { Octokit } from '@octokit/rest';

import type { ApiRoute } from '@mastra/core/server';

import type { CommitCheck, CommitCheckStatus, PublishCommitCheckInput } from '@factory/capabilities';
import type { IntegrationContext } from '@factory/integrations';
import type { GitIdentity } from '@factory/sandbox';

import { GithubIntegration } from './integration.ts';
import type { GithubIntegrationSharedConfig, RepoSummary, UserInstallation } from './integration.ts';

/** Polling replaces webhooks here, so sweeps run far more often than the hourly App default. */
export const GITHUB_TOKEN_RECONCILE_INTERVAL_MS = 2 * 60_000;

const STATUS_DESCRIPTION_LIMIT = 140;
const STATUS_STATE: Record<CommitCheckStatus, 'pending' | 'success' | 'failure' | 'error'> = {
  'in-progress': 'pending',
  success: 'success',
  failure: 'failure',
  neutral: 'success',
  skipped: 'success',
  cancelled: 'error',
};

export interface GithubTokenIntegrationConfig extends Omit<GithubIntegrationSharedConfig, 'webhookSecret'> {
  /** Personal access token (classic `repo` scope, or fine-grained with contents, issues, pull requests and commit statuses write). */
  accessToken?: string;
  /** Overrides `https://api.github.com` (GitHub Enterprise Server: `https://<host>/api/v3`). */
  baseUrl?: string;
  /** The only org that may connect the token. Unset: the first org to connect claims it. */
  orgId?: string;
  /** Test seam for the Octokit transport. */
  fetchImpl?: typeof fetch;
}

/** Deployment-wide claim row in the integration's settings, outside any real org. */
const CLAIM_ORG_ID = '__github_access_token__';
const CLAIM_USER_ID = '__claim__';

interface TokenClaim {
  orgId: string;
  accountId: number;
}

interface TokenAccount {
  id: number;
  login: string;
  type: string;
}

export class GithubTokenIntegration extends GithubIntegration {
  override readonly requiresStableStateSigner = false;
  override readonly authMode = 'token' as const;
  readonly #accessToken: string;
  readonly #octokit: Octokit;
  readonly #orgId: string | undefined;
  /** Set by a 401 until a request succeeds again, so a revoked token is reported once, not per sweep. */
  #rejected = false;
  #account: Promise<TokenAccount> | undefined;
  #login: string | undefined;

  constructor(config: GithubTokenIntegrationConfig = {}) {
    super({ rules: config.rules, authorizedBots: config.authorizedBots }, false);
    const accessToken = config.accessToken?.trim() || process.env.GITHUB_ACCESS_TOKEN?.trim();
    if (!accessToken) throw new Error('GithubTokenIntegration: missing required GITHUB_ACCESS_TOKEN.');
    this.#accessToken = accessToken;
    this.#orgId = config.orgId?.trim() || process.env.GITHUB_ACCESS_TOKEN_ORG_ID?.trim() || undefined;
    this.#octokit = new Octokit({
      auth: accessToken,
      ...(config.baseUrl ? { baseUrl: config.baseUrl.replace(/\/+$/, '') } : {}),
      request: { timeout: 15_000, ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}) },
    });
    this.#octokit.hook.after('request', () => {
      if (!this.#rejected) return;
      this.#rejected = false;
      console.info('[GitHub] GITHUB_ACCESS_TOKEN is accepted again.');
    });
    this.#octokit.hook.error('request', error => {
      if ((error as { status?: number }).status === 401 && !this.#rejected) {
        this.#rejected = true;
        console.error(
          '[GitHub] GitHub rejected GITHUB_ACCESS_TOKEN (401): it is revoked, expired or mistyped. ' +
            'Polling and agent work on GitHub fail until it is replaced.',
        );
      }
      throw error;
    });
  }

  /** True after GitHub rejected the token, until a request succeeds again. */
  get tokenRejected(): boolean {
    return this.#rejected;
  }

  /** The token's account, read once; a failed read is retried on the next call. */
  account(): Promise<TokenAccount> {
    this.#account ??= this.#octokit.users.getAuthenticated().then(
      ({ data }) => {
        this.#login = data.login;
        return { id: data.id, login: data.login, type: data.type };
      },
      (error: unknown) => {
        this.#account = undefined;
        throw error;
      },
    );
    return this.#account;
  }

  /** Resolves the token's account at boot, so commit identity and the triage comment author are known early. */
  override routes(ctx: IntegrationContext): ApiRoute[] {
    void this.account().catch((error: unknown) => {
      console.warn('[GitHub] The configured GITHUB_ACCESS_TOKEN could not be verified.', error);
    });
    return super.routes(ctx);
  }

  /** No App slug: Factory never claims a login as itself (see the module note). */
  override get slug(): string {
    return '';
  }

  /** Commits are authored as the token's account once it is known. */
  override get gitIdentity(): GitIdentity | undefined {
    return this.#login ? { login: this.#login } : undefined;
  }

  override isFactoryCommentAuthor(login: string | null | undefined): boolean {
    return typeof login === 'string' && !!this.#login && login.toLowerCase() === this.#login.toLowerCase();
  }

  protected override get defaultReconcileIntervalMs(): number {
    return GITHUB_TOKEN_RECONCILE_INTERVAL_MS;
  }

  /** The token's account, for `orgId` only: see the module note on which org may connect. */
  override async directInstallations({ orgId }: { orgId: string }): Promise<UserInstallation[]> {
    const account = await this.account();
    if (this.#orgId) {
      if (orgId !== this.#orgId) {
        throw new Error(`GITHUB_ACCESS_TOKEN is reserved for org ${this.#orgId} (GITHUB_ACCESS_TOKEN_ORG_ID).`);
      }
    } else {
      const settings = this.integrationStorage.settings;
      const claim = (await settings.get(CLAIM_ORG_ID, CLAIM_USER_ID)) as TokenClaim | null;
      if (claim && claim.accountId === account.id && claim.orgId !== orgId) {
        throw new Error(`GITHUB_ACCESS_TOKEN (@${account.login}) is already connected by another org.`);
      }
      if (!claim || claim.accountId !== account.id) {
        await settings.save(CLAIM_ORG_ID, CLAIM_USER_ID, { orgId, accountId: account.id } satisfies TokenClaim);
      }
    }
    return [{ installationId: account.id, accountLogin: account.login, accountType: account.type }];
  }

  override getAppOctokit(): Octokit {
    throw new Error('GithubTokenIntegration has no GitHub App.');
  }

  override getInstallationOctokit(_installationId: number): Octokit {
    return this.#octokit;
  }

  override async mintInstallationToken(_installationId: number): Promise<string> {
    return this.#accessToken;
  }

  override async listUserInstallations(_userToken: string): Promise<UserInstallation[]> {
    throw new Error('GithubTokenIntegration has no GitHub App to authorize.');
  }

  /** Repositories the token's account can push to. */
  override async listInstallationRepos(installationId: number): Promise<RepoSummary[]> {
    const repos = await this.#octokit.paginate(this.#octokit.repos.listForAuthenticatedUser, {
      affiliation: 'owner,collaborator,organization_member',
      per_page: 100,
    });
    return repos
      .filter(repo => repo.permissions?.push || repo.permissions?.admin)
      .map(repo => ({
        id: repo.id,
        fullName: repo.full_name,
        name: repo.name,
        owner: repo.owner.login,
        defaultBranch: repo.default_branch,
        private: repo.private,
        installationId,
      }));
  }

  override buildInstallUrl(_state: string): string {
    throw new Error('GithubTokenIntegration has no GitHub App to install.');
  }

  override buildOAuthIdentifyUrl(_state: string, _redirectUri: string): string {
    throw new Error('GithubTokenIntegration has no GitHub App to authorize.');
  }

  override async exchangeOAuthCode(_code: string, _redirectUri: string): Promise<string> {
    throw new Error('GithubTokenIntegration has no GitHub App to authorize.');
  }

  /** A commit status per name: GitHub keeps the latest status per context on a commit. */
  override async publishCommitCheck(input: PublishCommitCheckInput): Promise<CommitCheck> {
    const { octokit, parts } = this.repositoryClient(input.connection, input.sourceId);
    const { data } = await octokit.repos.createCommitStatus({
      ...parts,
      sha: input.headSha,
      state: STATUS_STATE[input.status],
      context: input.name,
      description: input.title.slice(0, STATUS_DESCRIPTION_LIMIT),
    });
    return {
      id: String(data.id),
      name: data.context,
      headSha: input.headSha,
      status: input.status,
      url: data.target_url ?? null,
    };
  }

  override diagnostics(): Record<string, unknown> {
    return {
      mode: 'token',
      accountLogin: this.#login ?? null,
      orgPinned: this.#orgId !== undefined,
      tokenRejected: this.#rejected,
      webhooks: false,
    };
  }
}
