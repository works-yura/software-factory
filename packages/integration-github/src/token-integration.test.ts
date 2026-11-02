import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStateSigner } from '@factory/auth';
import { fakeRouteAuth } from '@factory/http/testing';
import { createFactoryStorageForTests } from '@factory/testing';

import { isFactoryGithubLogin } from './rules.ts';
import { GITHUB_TOKEN_RECONCILE_INTERVAL_MS, GithubTokenIntegration } from './token-integration.ts';

const TOKEN = 'ghp_test_token';
const connection = { type: 'app-installation' as const, installationId: 4242 };

type Call = { method: string; url: URL; authorization: string | null; body: unknown };

type Answer = unknown | { status: number; body?: unknown; headers?: Record<string, string> };
const isAnswer = (value: unknown): value is { status: number; body?: unknown; headers?: Record<string, string> } =>
  typeof value === 'object' && value !== null && 'status' in value && typeof (value as { status: unknown }).status === 'number';

/**
 * A fake api.github.com: answers by `METHOD path` (or `METHOD path?query` when
 * the query matters) and records every request. A route may be a function of
 * the call, or `{ status, body, headers }` for non-200 answers.
 */
function fakeGithub(routes: Record<string, Answer | ((call: Call) => Answer)>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url,
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const withQuery = `${method} ${url.pathname}${url.search}`;
    const key = withQuery in routes ? withQuery : `${method} ${url.pathname}`;
    if (!(key in routes)) {
      return new Response(JSON.stringify({ message: `unexpected ${key}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const route = routes[key];
    const answer = typeof route === 'function' ? route(calls.at(-1)!) : route;
    const reply = isAnswer(answer) ? answer : { status: 200, body: answer };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const account = { id: 4242, login: 'Yura', type: 'User' };

/** An integration wired to real in-memory storage, as the factory mounts it. */
async function mounted(config: ConstructorParameters<typeof GithubTokenIntegration>[0], storage?: Awaited<ReturnType<typeof createFactoryStorageForTests>>) {
  const seeded = storage ?? (await createFactoryStorageForTests());
  const integration = new GithubTokenIntegration(config);
  const routes = integration.routes({
    auth: fakeRouteAuth(),
    sandbox: (() => ({})) as never,
    stateSigner: createStateSigner('secret'),
    storage: {
      generic: seeded.integrations.forIntegration(integration.id),
      sourceControl: seeded.sourceControl.forIntegration(integration.id),
      projects: seeded.projects,
      intake: seeded.intake,
    },
  });
  integration.versionControl.initialize({ storage: seeded.sourceControl.forIntegration(integration.id) });
  return { integration, routes, storage: seeded };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GithubTokenIntegration', () => {
  it('needs a token', () => {
    vi.stubEnv('GITHUB_ACCESS_TOKEN', '');
    expect(() => new GithubTokenIntegration()).toThrow('GITHUB_ACCESS_TOKEN');
  });

  it('reads the token from the environment', async () => {
    vi.stubEnv('GITHUB_ACCESS_TOKEN', ` ${TOKEN} `);
    expect(await new GithubTokenIntegration().mintInstallationToken(1)).toBe(TOKEN);
  });

  it("registers the token's account as the only installation and authenticates with the token", async () => {
    const github = fakeGithub({ 'GET /user': account });
    const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    const { integration: connected } = await mounted({ accessToken: TOKEN, fetchImpl: github.fetchImpl });
    expect(await connected.directInstallations({ orgId: 'org-1' })).toEqual([
      { installationId: 4242, accountLogin: 'Yura', accountType: 'User' },
    ]);
    await connected.directInstallations({ orgId: 'org-1' });
    expect(github.calls).toHaveLength(1);
    expect(connected.gitIdentity).toEqual({ login: 'Yura' });

    await integration.account();
    expect(github.calls[0]!.authorization).toBe(`token ${TOKEN}`);
    expect(integration.gitIdentity).toEqual({ login: 'Yura' });
    expect(integration.diagnostics()).toEqual({
      mode: 'token',
      accountLogin: 'Yura',
      orgPinned: false,
      tokenRejected: false,
      webhooks: false,
    });
  });

  it('retries the account read after a failure', async () => {
    const failing = vi.fn(async () => new Response('{"message":"Bad credentials"}', { status: 401 }));
    const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: failing as never });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(integration.account()).rejects.toThrow('Bad credentials');
    await expect(integration.account()).rejects.toThrow('Bad credentials');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("never treats the token's account as Factory, so the person's own issues still reach the board", async () => {
    const github = fakeGithub({ 'GET /user': account });
    const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });
    await integration.account();

    expect(isFactoryGithubLogin(integration, 'yura')).toBe(false);
    expect(isFactoryGithubLogin(integration, '[bot]')).toBe(false);
    // Its own triage comment is still found again by marker and author.
    expect(integration.isFactoryCommentAuthor('YURA')).toBe(true);
    expect(integration.isFactoryCommentAuthor('someone')).toBe(false);
  });

  it('lists only the repositories the account can push to', async () => {
    const repo = (id: number, fullName: string, permissions: Record<string, boolean>) => ({
      id,
      full_name: fullName,
      name: fullName.split('/')[1],
      owner: { login: fullName.split('/')[0] },
      default_branch: 'main',
      private: true,
      permissions,
    });
    const github = fakeGithub({
      'GET /user/repos': [
        repo(1, 'yura/app', { admin: true, push: true, pull: true }),
        repo(2, 'acme/api', { admin: false, push: true, pull: true }),
        repo(3, 'acme/docs', { admin: false, push: false, pull: true }),
      ],
    });
    const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    const repos = await integration.listInstallationRepos(4242);
    expect(repos.map(r => r.fullName)).toEqual(['yura/app', 'acme/api']);
    expect(repos[0]).toEqual({
      id: 1,
      fullName: 'yura/app',
      name: 'app',
      owner: 'yura',
      defaultBranch: 'main',
      private: true,
      installationId: 4242,
    });
    expect(github.calls[0]!.url.searchParams.get('affiliation')).toBe('owner,collaborator,organization_member');
  });

  it('publishes commit checks as commit statuses', async () => {
    const github = fakeGithub({
      'POST /repos/yura/app/statuses/abc123': {
        id: 77,
        context: 'factory/gates',
        target_url: null,
        url: 'https://api.github.com/repos/yura/app/statuses/abc123',
      },
    });
    const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    const check = await integration.versionControl.publishCommitCheck!({
      connection,
      sourceId: 'yura/app',
      headSha: 'abc123',
      name: 'factory/gates',
      status: 'cancelled',
      title: 'x'.repeat(200),
      summary: 'Stopped.',
    });
    expect(check).toEqual({ id: '77', name: 'factory/gates', headSha: 'abc123', status: 'cancelled', url: null });
    expect(github.calls[0]!.body).toEqual({ state: 'error', context: 'factory/gates', description: 'x'.repeat(140) });

    for (const [status, state] of [
      ['in-progress', 'pending'],
      ['success', 'success'],
      ['failure', 'failure'],
      ['neutral', 'success'],
      ['skipped', 'success'],
    ] as const) {
      await integration.versionControl.publishCommitCheck!({
        connection,
        sourceId: 'yura/app',
        headSha: 'abc123',
        name: 'factory/gates',
        status,
        title: status,
        summary: '',
      });
      expect(github.calls.at(-1)!.body).toMatchObject({ state });
    }
  });

  it('uses the token for repository API calls and clones', async () => {
    const github = fakeGithub({
      'GET /repos/yura/app': {
        id: 1,
        full_name: 'yura/app',
        name: 'app',
        owner: { login: 'yura' },
        default_branch: 'main',
        private: true,
      },
    });
    const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    expect(await integration.getInstallationRepo(4242, 'yura/app')).toMatchObject({ fullName: 'yura/app' });
    expect(github.calls[0]!.authorization).toBe(`token ${TOKEN}`);
    expect(await integration.mintInstallationToken(4242)).toBe(TOKEN);
  });

  it('has no App flow to fall into', async () => {
    const integration = new GithubTokenIntegration({ accessToken: TOKEN });
    expect(() => integration.getAppOctokit()).toThrow('no GitHub App');
    expect(() => integration.buildInstallUrl('state')).toThrow('no GitHub App');
    expect(() => integration.buildOAuthIdentifyUrl('state', 'http://localhost')).toThrow('no GitHub App');
    await expect(integration.listUserInstallations('user-token')).rejects.toThrow('no GitHub App');
    await expect(integration.exchangeOAuthCode('code', 'http://localhost')).rejects.toThrow('no GitHub App');
    expect(integration.webhookSecret).toBeUndefined();
    expect(integration.requiresStableStateSigner).toBe(false);
    expect(integration.authMode).toBe('token');
  });

  it('warns at mount when GitHub cannot confirm the token, and still serves its routes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const github = fakeGithub({ 'GET /user': { status: 401, body: { message: 'Bad credentials' } } });
    const { routes, integration } = await mounted({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    expect(routes.length).toBeGreaterThan(0);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[GitHub] The configured GITHUB_ACCESS_TOKEN could not be verified.', expect.anything()),
    );
    expect(integration.tokenRejected).toBe(true);
  });

  it('polls every two minutes unless an interval is configured', () => {
    class Probe extends GithubTokenIntegration {
      get interval() {
        return this.defaultReconcileIntervalMs;
      }
    }
    expect(new Probe({ accessToken: TOKEN }).interval).toBe(GITHUB_TOKEN_RECONCILE_INTERVAL_MS);
    expect(GITHUB_TOKEN_RECONCILE_INTERVAL_MS).toBe(120_000);
  });
});

describe('GithubTokenIntegration: which org may connect the token', () => {
  it('lets the first org claim the token and refuses every other org, across restarts', async () => {
    const github = fakeGithub({ 'GET /user': account });
    const first = await mounted({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    await expect(first.integration.directInstallations({ orgId: 'org-1' })).resolves.toHaveLength(1);
    await expect(first.integration.directInstallations({ orgId: 'org-1' })).resolves.toHaveLength(1);
    await expect(first.integration.directInstallations({ orgId: 'org-2' })).rejects.toThrow(
      'already connected by another org',
    );

    // A restarted server reads the claim back from storage.
    const restarted = await mounted({ accessToken: TOKEN, fetchImpl: github.fetchImpl }, first.storage);
    await expect(restarted.integration.directInstallations({ orgId: 'org-2' })).rejects.toThrow(
      'already connected by another org',
    );
    await expect(restarted.integration.directInstallations({ orgId: 'org-1' })).resolves.toHaveLength(1);
  });

  it('moves the claim when the token is replaced by one for another account', async () => {
    const first = await mounted({ accessToken: TOKEN, fetchImpl: fakeGithub({ 'GET /user': account }).fetchImpl });
    await first.integration.directInstallations({ orgId: 'org-1' });

    const other = fakeGithub({ 'GET /user': { id: 7, login: 'factory-bot', type: 'User' } });
    const replaced = await mounted({ accessToken: 'ghp_other', fetchImpl: other.fetchImpl }, first.storage);
    await expect(replaced.integration.directInstallations({ orgId: 'org-2' })).resolves.toEqual([
      { installationId: 7, accountLogin: 'factory-bot', accountType: 'User' },
    ]);
    await expect(replaced.integration.directInstallations({ orgId: 'org-1' })).rejects.toThrow('another org');
  });

  it('admits only the pinned org when GITHUB_ACCESS_TOKEN_ORG_ID is set', async () => {
    vi.stubEnv('GITHUB_ACCESS_TOKEN_ORG_ID', 'org-pinned');
    const { integration } = await mounted({ accessToken: TOKEN, fetchImpl: fakeGithub({ 'GET /user': account }).fetchImpl });

    await expect(integration.directInstallations({ orgId: 'org-1' })).rejects.toThrow(
      'reserved for org org-pinned (GITHUB_ACCESS_TOKEN_ORG_ID)',
    );
    await expect(integration.directInstallations({ orgId: 'org-pinned' })).resolves.toHaveLength(1);
    expect(integration.diagnostics()).toMatchObject({ orgPinned: true });
  });
});

describe('GithubTokenIntegration: a rejected token', () => {
  it('reports a revoked token once, not on every sweep, and clears it when GitHub accepts again', async () => {
    let revoked = true;
    const github = fakeGithub({
      'GET /repos/yura/app': () =>
        revoked
          ? { status: 401, body: { message: 'Bad credentials' } }
          : { id: 1, full_name: 'yura/app', name: 'app', owner: { login: 'yura' }, default_branch: 'main', private: true },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    for (let sweep = 0; sweep < 3; sweep += 1) {
      expect(await integration.getInstallationRepo(4242, 'yura/app')).toBeNull();
    }
    expect(integration.tokenRejected).toBe(true);
    expect(integration.diagnostics()).toMatchObject({ tokenRejected: true });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('rejected GITHUB_ACCESS_TOKEN (401)');
    expect(String(error.mock.calls[0]![0])).not.toContain(TOKEN);

    revoked = false;
    expect(await integration.getInstallationRepo(4242, 'yura/app')).toMatchObject({ fullName: 'yura/app' });
    expect(integration.tokenRejected).toBe(false);
    expect(info).toHaveBeenCalledWith('[GitHub] GITHUB_ACCESS_TOKEN is accepted again.');
  });

  it('does not treat a 403 rate limit as a rejected token', async () => {
    const github = fakeGithub({ 'GET /repos/yura/app': { status: 403, body: { message: 'API rate limit exceeded' } } });
    const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });
    expect(await integration.getInstallationRepo(4242, 'yura/app')).toBeNull();
    expect(integration.tokenRejected).toBe(false);
  });
});

describe('GithubTokenIntegration: repositories and access', () => {
  const repo = (id: number) => ({
    id,
    full_name: `yura/repo-${id}`,
    name: `repo-${id}`,
    owner: { login: 'yura' },
    default_branch: 'main',
    private: true,
    permissions: { admin: false, push: true, pull: true },
  });

  it('follows pagination past the first hundred repositories', async () => {
    const github = fakeGithub({
      'GET /user/repos': call =>
        call.url.searchParams.get('page') === '2'
          ? [repo(101), repo(102)]
          : {
              status: 200,
              body: Array.from({ length: 100 }, (_, index) => repo(index + 1)),
              headers: { link: '<https://api.github.com/user/repos?page=2&per_page=100>; rel="next"' },
            },
    });
    const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    const repos = await integration.listInstallationRepos(4242);
    expect(repos).toHaveLength(102);
    expect(repos.at(-1)).toMatchObject({ fullName: 'yura/repo-102', installationId: 4242 });
    expect(github.calls).toHaveLength(2);
  });

  it('clones a connected repository with the token', async () => {
    const { integration } = await mounted({ accessToken: TOKEN, fetchImpl: fakeGithub({ 'GET /user': account }).fetchImpl });
    const [direct] = await integration.directInstallations({ orgId: 'org-1' });
    const installation = await integration.versionControl.registerInstallation({
      orgId: 'org-1',
      userId: 'user-1',
      installation: { externalId: String(direct!.installationId), accountName: 'Yura', accountType: 'User' },
    });
    const [repository] = await integration.versionControl.registerRepositories({
      orgId: 'org-1',
      installationId: installation.id,
      repositories: [{ externalId: '1', slug: 'yura/app', defaultBranch: 'main' }],
    });

    await expect(
      integration.versionControl.getRepositoryAccess({ orgId: 'org-1', repositoryId: repository!.id }),
    ).resolves.toEqual({
      cloneUrl: 'https://github.com/yura/app.git',
      authorization: { scheme: 'bearer', token: TOKEN },
    });
    await expect(
      integration.versionControl.getRepositoryTarget({ orgId: 'org-1', repositoryId: repository!.id }),
    ).resolves.toEqual({ connection: { type: 'app-installation', installationId: 4242 }, sourceId: 'yura/app' });
    await expect(
      integration.versionControl.getRepositoryAccess({ orgId: 'org-2', repositoryId: repository!.id }),
    ).rejects.toThrow('not found');
  });

  it('reads issues for the polling sweeps with the token, skipping pull requests', async () => {
    const issue = (number: number, extra: Record<string, unknown> = {}) => ({
      number,
      title: `Issue ${number}`,
      html_url: `https://github.com/yura/app/issues/${number}`,
      state: 'open',
      assignees: [],
      labels: [{ name: 'bug' }],
      user: { login: 'Yura' },
      created_at: '2026-10-29T10:00:00Z',
      updated_at: '2026-10-29T10:00:00Z',
      ...extra,
    });
    const github = fakeGithub({
      'GET /repos/yura/app/issues': [issue(3), issue(4, { pull_request: { url: 'x' } })],
      'GET /repos/yura/app/issues/3': issue(3, { state: 'closed', state_reason: 'completed' }),
    });
    const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    await expect(integration.listOpenIssueStates({ installationId: 4242, repository: 'yura/app' })).resolves.toEqual([
      expect.objectContaining({ number: 3, author: 'Yura', labels: ['bug'], state: 'open' }),
    ]);
    await expect(
      integration.fetchIssueState({ installationId: 4242, repository: 'yura/app', number: 3 }),
    ).resolves.toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(github.calls.every(call => call.authorization === `token ${TOKEN}`)).toBe(true);
  });

  it('runs the polling sweeps every two minutes, or at the configured interval', () => {
    const integration = new GithubTokenIntegration({ accessToken: TOKEN });
    const context = {
      controller: {},
      storage: {
        generic: {},
        sourceControl: {
          projectRepositories: { listConfiguredExternalKeys: async () => [], listByExternalRepository: async () => [] },
          repositories: { findByExternalId: async () => null },
        },
        projects: { listAll: async () => [] },
        intake: {},
      },
      runtime: { configVersion: 'test-v1', workItems: {} },
    } as never;
    expect(integration.workers(context).map(worker => worker.name)).toEqual(['github-pull-request-reconcile']);
  });

  it('reads issues only from repositories an org selected as a GitHub intake source', async () => {
    const seeded = await createFactoryStorageForTests();
    const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Factory' } });
    const sourceControl = seeded.sourceControl.forIntegration('github');
    const installation = await sourceControl.installations.upsert({
      orgId: 'org-1',
      connectedByUserId: 'user-1',
      externalId: '4242',
    });
    const connection = await sourceControl.connections.create({
      orgId: 'org-1',
      factoryProjectId: project.id,
      installationId: installation.id,
      createdByUserId: 'user-1',
    });
    const linked: Record<string, string> = {};
    for (const [externalId, slug] of [
      ['10', 'acme/app'],
      ['11', 'acme/api'],
    ] as const) {
      const stored = await sourceControl.repositories.upsert({
        orgId: 'org-1',
        input: { installationId: installation.id, externalId, slug, defaultBranch: 'main' },
      });
      linked[slug] = stored.id;
      await sourceControl.projectRepositories.link({
        orgId: 'org-1',
        connectionId: connection.id,
        repositoryId: stored.id,
        createdByUserId: 'user-1',
        sandboxProvider: 'local',
        sandboxWorkdir: '/workspace',
      });
    }
    const integration = new GithubTokenIntegration({ accessToken: TOKEN });
    const context = { storage: { sourceControl, intake: seeded.intake } } as never;
    const scope = (repositories: Array<{ id: number; fullName: string; installationId: number }>) =>
      (
        integration as unknown as {
          issueSweepRepositories(ctx: unknown, repositories: unknown[]): Promise<unknown[]>;
        }
      ).issueSweepRepositories(context, repositories);
    const app = { id: 10, fullName: 'acme/app', installationId: 4242 };
    const api = { id: 11, fullName: 'acme/api', installationId: 4242 };

    // Cards come from another source: no GitHub repository's issues are read.
    await expect(scope([app, api])).resolves.toEqual([]);

    await seeded.intake.saveConfig({
      orgId: 'org-1',
      config: { github: { enabled: true, sourceIds: [linked['acme/api']!] } },
    });
    await expect(scope([app, api])).resolves.toEqual([api]);

    // A switched-off selection reads nothing.
    await seeded.intake.saveConfig({
      orgId: 'org-1',
      config: { github: { enabled: false, sourceIds: [linked['acme/api']!] } },
    });
    await expect(scope([app, api])).resolves.toEqual([]);
  });

  it('reads pull-request activity on each sweep, standing in for the webhooks it never gets', async () => {
    const github = fakeGithub({ 'GET /user': account, 'GET /repos/acme/app/pulls': [] });
    const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });
    const context = {
      controller: {},
      storage: {
        generic: { subscriptions: { listByTarget: async () => [] }, settings: { get: async () => null } },
        sourceControl: {
          projectRepositories: {
            listByExternalRepository: async () => [{ orgId: 'org-1', factoryProjectId: 'project-1' }],
          },
        },
        projects: {},
        intake: {},
      },
      runtime: { configVersion: 'test-v1', workItems: { list: async () => [] }, boards: {} },
    } as never;
    const sweep = (
      integration as unknown as {
        pullRequestActivitySweep(ctx: unknown): ((repositories: unknown[]) => Promise<unknown>) | undefined;
      }
    ).pullRequestActivitySweep(context);

    await expect(sweep?.([{ id: 10, fullName: 'acme/app', installationId: 4242 }])).resolves.toMatchObject({
      repositories: 1,
      failed: 0,
    });
    expect(github.calls.map(call => `${call.method} ${call.url.pathname}`)).toContain('GET /repos/acme/app/pulls');
  });
});

describe('GithubTokenIntegration: connect through the mounted routes', () => {
  it('connects the claiming org and refuses another org without touching its installations', async () => {
    const { Hono } = await import('hono');
    const { mountApiRoutes } = await import('@factory/http/testing');
    const github = fakeGithub({ 'GET /user': account });
    const { routes, storage } = await mounted({ accessToken: TOKEN, fetchImpl: github.fetchImpl });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const app = (orgId: string) => {
      const hono = new Hono();
      hono.use('*', async (c, next) => {
        c.set('factoryAuthUser' as never, { workosId: `user-${orgId}`, organizationId: orgId } as never);
        await next();
      });
      mountApiRoutes(hono as never, routes);
      return hono;
    };
    const installations = (orgId: string) =>
      storage.sourceControl.forIntegration('github').installations.list({ orgId });

    const connected = await app('org-1').request('/auth/github/connect');
    expect(connected.headers.get('location')).toBe('/?github=connected');
    expect(await installations('org-1')).toEqual([
      expect.objectContaining({ externalId: '4242', accountName: 'Yura', accountType: 'User' }),
    ]);

    const refused = await app('org-2').request('/auth/github/connect');
    expect(refused.headers.get('location')).toBe('/?github=error');
    expect(await installations('org-2')).toEqual([]);
  });
});
