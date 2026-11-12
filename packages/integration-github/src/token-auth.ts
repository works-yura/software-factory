/**
 * GitHub access tokens as connections (ADR-0034).
 *
 * An organization connects GitHub either through the deployment's GitHub App or with an access
 * token (a classic or fine-grained personal access token) an admin pastes in Settings ›
 * Підключення. A token connection is an ordinary `source_control_installations` row whose
 * `external_id` is the token account's numeric id and whose `provider_metadata.auth` is `'token'`;
 * the token itself is stored per installation in the integration's settings, which the storage
 * encrypts.
 *
 * Every GitHub call is addressed by installation id only (`getInstallationOctokit(id)`,
 * `mintInstallationToken(id)`), so the token is found by that id: one settings row per token
 * account, outside any real org, holding each connecting org's token. When two organizations
 * connect tokens of the same GitHub account, calls for that account use the token connected first
 * that is still there; both tokens act as the same GitHub account.
 *
 * `GITHUB_ACCESS_TOKEN` stays an optional fallback: an installation row whose id is that token's
 * account id and that has no stored token (the rows the old token mode registered) is served by the
 * env token.
 */

import { Octokit } from '@octokit/rest';

import type { RepoSummary } from './integration.ts';
import type { GithubSubscriptionStorage } from './subscriptions.ts';

/** The token's account, as `GET /user` reports it. */
export interface GithubTokenAccountInfo {
  id: number;
  login: string;
  type: string;
}

export interface GithubTokenClientOptions {
  /** Overrides `https://api.github.com` (GitHub Enterprise Server: `https://<host>/api/v3`). */
  baseUrl?: string;
  /** Test seam for the Octokit transport. */
  fetchImpl?: typeof fetch;
}

/**
 * One access token: its Octokit, its account and the repositories it can push to. A 401 marks the
 * token rejected (reported once) until a request succeeds again.
 */
export class GithubTokenAccount {
  readonly token: string;
  readonly octokit: Octokit;
  readonly #label: string;
  #rejected = false;
  #account: Promise<GithubTokenAccountInfo> | undefined;
  #login: string | undefined;

  constructor(token: string, options: GithubTokenClientOptions & { label?: string } = {}) {
    this.token = token.trim();
    this.#label = options.label ?? 'a GitHub access token';
    this.octokit = new Octokit({
      auth: this.token,
      ...(options.baseUrl ? { baseUrl: options.baseUrl.replace(/\/+$/, '') } : {}),
      request: { timeout: 15_000, ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}) },
    });
    this.octokit.hook.after('request', () => this.markAccepted());
    this.octokit.hook.error('request', error => {
      if ((error as { status?: number }).status === 401) this.markRejected();
      throw error;
    });
  }

  /** True after GitHub rejected the token, until a request succeeds again. */
  get rejected(): boolean {
    return this.#rejected;
  }

  /** The account's login once read. */
  get login(): string | undefined {
    return this.#login;
  }

  markRejected(): void {
    if (this.#rejected) return;
    this.#rejected = true;
    console.error(
      `[GitHub] GitHub rejected ${this.#label} (401): it is revoked, expired or mistyped. ` +
        'Polling and agent work through it fail until it is replaced.',
    );
  }

  markAccepted(): void {
    if (!this.#rejected) return;
    this.#rejected = false;
    console.info(`[GitHub] ${this.#label} is accepted again.`);
  }

  /** The token's account, read once; a failed read is retried on the next call. */
  account(): Promise<GithubTokenAccountInfo> {
    this.#account ??= this.octokit.users.getAuthenticated().then(
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

  /** Repositories the token's account can push to, reported under `installationId`. */
  async listRepos(installationId: number): Promise<RepoSummary[]> {
    const repos = await this.octokit.paginate(this.octokit.repos.listForAuthenticatedUser, {
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
}

/** How one installation authenticates. */
export type GithubInstallationAuth =
  | { kind: 'token'; source: 'stored' | 'env'; account: GithubTokenAccount }
  | { kind: 'app' };

/** Settings rows holding the tokens, keyed by token account id, outside any real org. */
const TOKEN_ORG_ID = '__github_token_installations__';
/** The token stays cached this long, so a token replaced on another replica is picked up. */
const RESOLVE_TTL_MS = 60_000;

interface StoredTokens {
  login?: string;
  /** orgId → token, in connection order. */
  tokens: Record<string, string>;
}

function storedTokensOf(value: unknown): StoredTokens {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const tokens: Record<string, string> = {};
  if (raw.tokens && typeof raw.tokens === 'object') {
    for (const [orgId, token] of Object.entries(raw.tokens as Record<string, unknown>)) {
      if (typeof token === 'string' && token.trim()) tokens[orgId] = token;
    }
  }
  return { ...(typeof raw.login === 'string' ? { login: raw.login } : {}), tokens };
}

/**
 * Resolves each installation's credentials: a stored token, the env fallback token, or the App.
 * Token clients are kept per token, so a replaced token takes effect on the next call.
 */
export class GithubTokenConnections {
  readonly #storage: () => GithubSubscriptionStorage;
  readonly #options: GithubTokenClientOptions;
  readonly #envToken: GithubTokenAccount | undefined;
  readonly #byToken = new Map<string, GithubTokenAccount>();
  readonly #resolved = new Map<number, { at: number; value: Promise<GithubInstallationAuth> }>();
  /** Logins of every token account seen, so their triage comments are recognised as Factory's. */
  readonly #logins = new Set<string>();

  constructor(options: {
    storage: () => GithubSubscriptionStorage;
    envToken?: string;
    client?: GithubTokenClientOptions;
  }) {
    this.#storage = options.storage;
    this.#options = options.client ?? {};
    const envToken = options.envToken?.trim();
    this.#envToken = envToken
      ? new GithubTokenAccount(envToken, { ...this.#options, label: 'GITHUB_ACCESS_TOKEN' })
      : undefined;
  }

  /** The env fallback token's client, when `GITHUB_ACCESS_TOKEN` is set. */
  get envToken(): GithubTokenAccount | undefined {
    return this.#envToken;
  }

  /** Token account logins seen so far, lowercased. */
  get knownLogins(): ReadonlySet<string> {
    return this.#logins;
  }

  /** A client for a token the caller holds (a token being checked, a stored one). */
  forToken(token: string): GithubTokenAccount {
    const key = token.trim();
    let account = this.#byToken.get(key);
    if (!account) {
      account = new GithubTokenAccount(key, this.#options);
      this.#byToken.set(key, account);
    }
    return account;
  }

  /** Reads `GET /user` with the token and remembers its login. */
  async checkToken(token: string): Promise<GithubTokenAccountInfo> {
    const client = this.forToken(token);
    try {
      const info = await client.account();
      this.#logins.add(info.login.toLowerCase());
      return info;
    } catch (error) {
      this.#byToken.delete(token.trim());
      throw error;
    }
  }

  /** How `installationId` authenticates. Cached briefly; {@link forget} drops the cache. */
  resolve(installationId: number): Promise<GithubInstallationAuth> {
    const cached = this.#resolved.get(installationId);
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.value;
    const value = this.#lookup(installationId).catch((error: unknown) => {
      this.#resolved.delete(installationId);
      throw error;
    });
    this.#resolved.set(installationId, { at: Date.now(), value });
    return value;
  }

  async #lookup(installationId: number): Promise<GithubInstallationAuth> {
    const stored = await this.#read(installationId);
    const token = Object.values(stored.tokens)[0];
    if (token) {
      const account = this.forToken(token);
      if (stored.login) this.#logins.add(stored.login.toLowerCase());
      return { kind: 'token', source: 'stored', account };
    }
    if (this.#envToken) {
      // The env account is read once; when GitHub cannot be reached the row is served as the App's
      // would be, and the next lookup tries again.
      const info = await this.#envToken.account().catch(() => undefined);
      if (info) this.#logins.add(info.login.toLowerCase());
      if (info?.id === installationId) return { kind: 'token', source: 'env', account: this.#envToken };
      if (!info) this.#resolved.delete(installationId);
    }
    return { kind: 'app' };
  }

  async #read(installationId: number): Promise<StoredTokens> {
    try {
      return storedTokensOf(await this.#storage().settings.get(TOKEN_ORG_ID, String(installationId)));
    } catch {
      // Storage not initialized (partial test harness): nothing stored.
      return { tokens: {} };
    }
  }

  /** Whether `orgId` stored a token for `installationId`. */
  async hasStoredToken(orgId: string, installationId: number): Promise<boolean> {
    return Boolean((await this.#read(installationId)).tokens[orgId]);
  }

  /** Stores (or replaces) `orgId`'s token for the token account `installationId`. */
  async save(orgId: string, installationId: number, token: string, login: string): Promise<void> {
    const stored = await this.#read(installationId);
    const previous = stored.tokens[orgId];
    await this.#storage().settings.save(TOKEN_ORG_ID, String(installationId), {
      login,
      tokens: { ...stored.tokens, [orgId]: token.trim() },
    });
    if (previous && previous !== token.trim()) this.#byToken.delete(previous);
    this.#logins.add(login.toLowerCase());
    this.forget(installationId);
  }

  /** Removes `orgId`'s token for `installationId`. */
  async remove(orgId: string, installationId: number): Promise<void> {
    const stored = await this.#read(installationId);
    const previous = stored.tokens[orgId];
    if (!previous) return;
    const { [orgId]: _removed, ...rest } = stored.tokens;
    await this.#storage().settings.save(TOKEN_ORG_ID, String(installationId), { ...stored, tokens: rest });
    if (!Object.values(rest).includes(previous)) this.#byToken.delete(previous);
    this.forget(installationId);
  }

  /** Drops the cached resolution of `installationId`. */
  forget(installationId: number): void {
    this.#resolved.delete(installationId);
  }
}
