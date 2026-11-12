import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStateSigner } from '@factory/auth';
import { fakeRouteAuth } from '@factory/http/testing';
import { createFactoryStorageForTests } from '@factory/testing';

import { isFactoryGithubLogin } from './rules.ts';
import { GITHUB_TOKEN_RECONCILE_INTERVAL_MS, GithubInstallationUnavailableError, GithubIntegration } from './integration.ts';
import type { GithubIntegrationConfig } from './integration.ts';

const TOKEN = 'ghp_test_token';
const connection = { type: 'app-installation' as const, installationId: 4242 };

type Call = { method: string; url: URL; authorization: string | null; body: unknown };

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Answer = unknown;
const isAnswer = (value: unknown): value is Reply =>
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
    const reply: Reply = isAnswer(answer) ? answer : { status: 200, body: answer };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const account = { id: 4242, login: 'Yura', type: 'User' };

/** An integration wired to real in-memory storage, as the factory mounts it. */
async function mounted(
  config: GithubIntegrationConfig,
  storage?: Awaited<ReturnType<typeof createFactoryStorageForTests>>,
  auth = fakeRouteAuth(),
) {
  const seeded = storage ?? (await createFactoryStorageForTests());
  const integration = new GithubIntegration(config);
  const routes = integration.routes({
    auth,
    sandbox: (() => ({})) as never,
    stateSigner: createStateSigner('secret'),
    storage: {
      generic: seeded.integrations.forIntegration(integration.id),
      sourceControl: seeded.sourceControl.forIntegration(integration.id),
      projects: seeded.projects,
      intake: seeded.intake,
    } as never,
  });
  integration.versionControl.initialize({ storage: seeded.sourceControl.forIntegration(integration.id) });
  return { integration, routes, storage: seeded };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});


const APP = { appId: '1', privateKey: 'not-a-real-key', clientId: 'client', clientSecret: 'secret', slug: 'factory-crew' };

const repo = (id: number, fullName = `yura/repo-${id}`, permissions = { admin: false, push: true, pull: true }) => ({
  id,
  full_name: fullName,
  name: fullName.split('/')[1],
  owner: { login: fullName.split('/')[0] },
  default_branch: 'main',
  private: true,
  permissions,
});

describe('GithubIntegration: how each installation authenticates', () => {
  it('serves a legacy token row (its id is the fallback token account) with GITHUB_ACCESS_TOKEN', async () => {
    const github = fakeGithub({
      'GET /user': account,
      'GET /repos/yura/app': repo(1, 'yura/app'),
    });
    const integration = new GithubIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    await expect(integration.installationAuth(4242)).resolves.toMatchObject({ kind: 'token', source: 'env' });
    expect(await integration.mintInstallationToken(4242)).toBe(TOKEN);
    expect(await integration.getInstallationRepo(4242, 'yura/app')).toMatchObject({ fullName: 'yura/app' });
    expect(github.calls.at(-1)!.authorization).toBe(`token ${TOKEN}`);
    expect(await integration.gitIdentityForInstallation('4242')).toEqual({ login: 'Yura' });
    expect(integration.gitIdentity).toEqual({ login: 'Yura' });
    // Without an App, any other installation has no credentials at all.
    await expect(integration.installationAuth(7)).rejects.toBeInstanceOf(GithubInstallationUnavailableError);
    await expect(integration.mintInstallationToken(7)).rejects.toThrow('no usable credentials');
  });

  it('keeps App installations on the App and token installations on their token, side by side', async () => {
    const github = fakeGithub({ 'GET /user': account });
    const { integration } = await mounted({ ...APP, accessToken: TOKEN, fetchImpl: github.fetchImpl });

    expect(integration.appConfigured).toBe(true);
    expect(integration.requiresStableStateSigner).toBe(true);
    // An App installation id.
    await expect(integration.installationAuth(55)).resolves.toEqual({ kind: 'app' });
    expect(await integration.gitIdentityForInstallation(55)).toEqual({ login: 'factory-crew[bot]' });
    // The legacy row of the fallback token.
    await expect(integration.installationAuth(4242)).resolves.toMatchObject({ kind: 'token', source: 'env' });
    // A token the org stored wins over the fallback, and only for its own account id.
    await integration.tokens.save('org-1', 7001, 'ghp_stored', 'client-bot');
    await expect(integration.installationAuth(7001)).resolves.toMatchObject({ kind: 'token', source: 'stored' });
    expect(await integration.mintInstallationToken(7001)).toBe('ghp_stored');
    await expect(integration.installationAuth(55)).resolves.toEqual({ kind: 'app' });
    expect(integration.isFactoryCommentAuthor('factory-crew[bot]')).toBe(true);
    expect(integration.isFactoryCommentAuthor('CLIENT-BOT')).toBe(true);
    expect(integration.isFactoryCommentAuthor('someone')).toBe(false);
  });

  it('runs with neither an App nor a fallback token: only stored tokens connect', async () => {
    const github = fakeGithub({ 'GET /user/repos': [repo(1)] });
    const { integration } = await mounted({ fetchImpl: github.fetchImpl });
    expect(integration.appConfigured).toBe(false);
    expect(integration.requiresStableStateSigner).toBe(false);
    expect(integration.gitIdentity).toBeUndefined();
    expect(() => integration.getAppOctokit()).toThrow('no GitHub App');
    expect(() => integration.buildInstallUrl('state')).toThrow('no GitHub App');
    expect(integration.diagnostics()).toMatchObject({ appConfigured: false, fallbackTokenConfigured: false });

    await integration.tokens.save('org-1', 4242, 'ghp_stored', 'Yura');
    expect(await integration.listInstallationRepos(4242)).toEqual([expect.objectContaining({ fullName: 'yura/repo-1', installationId: 4242 })]);
    expect(github.calls[0]!.authorization).toBe('token ghp_stored');
  });

  it('rejects a partial App configuration', () => {
    expect(() => new GithubIntegration({ appId: '1', slug: 'x' })).toThrow(/privateKey, clientId, clientSecret/);
  });

  it('lists only the repositories a token account can push to, past the first hundred', async () => {
    const github = fakeGithub({
      'GET /user': account,
      'GET /user/repos': (call: Call) =>
        call.url.searchParams.get('page') === '2'
          ? [repo(101), repo(102, 'acme/docs', { admin: false, push: false, pull: true })]
          : {
              status: 200,
              body: Array.from({ length: 100 }, (_, index) => repo(index + 1)),
              headers: { link: '<https://api.github.com/user/repos?page=2&per_page=100>; rel="next"' },
            },
    });
    const integration = new GithubIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    const repos = await integration.listInstallationRepos(4242);
    expect(repos).toHaveLength(101);
    expect(repos.at(-1)).toMatchObject({ fullName: 'yura/repo-101', installationId: 4242 });
    expect(github.calls.find(call => call.url.pathname === '/user/repos')!.url.searchParams.get('affiliation')).toBe(
      'owner,collaborator,organization_member',
    );
  });

  it('publishes commit checks of a token connection as commit statuses', async () => {
    const github = fakeGithub({
      'GET /user': account,
      'POST /repos/yura/app/statuses/abc123': {
        id: 77,
        context: 'factory/gates',
        target_url: null,
      },
    });
    const integration = new GithubIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

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
    expect(github.calls.at(-1)!.body).toEqual({ state: 'error', context: 'factory/gates', description: 'x'.repeat(140) });
  });

  it('clones a repository of a token connection with its token', async () => {
    const { integration } = await mounted({ accessToken: TOKEN, fetchImpl: fakeGithub({ 'GET /user': account }).fetchImpl });
    const installation = await integration.versionControl.registerInstallation({
      orgId: 'org-1',
      userId: 'user-1',
      installation: { externalId: '4242', accountName: 'Yura', accountType: 'User' },
    });
    const [repository] = await integration.versionControl.registerRepositories({
      orgId: 'org-1',
      installationId: installation.id,
      repositories: [{ externalId: '1', slug: 'yura/app', defaultBranch: 'main' }],
    });
    await expect(
      integration.versionControl.getRepositoryAccess({ orgId: 'org-1', repositoryId: repository!.id }),
    ).resolves.toEqual({ cloneUrl: 'https://github.com/yura/app.git', authorization: { scheme: 'bearer', token: TOKEN } });
  });

  it('reports a revoked fallback token once, and clears it when GitHub accepts again', async () => {
    let revoked = true;
    const github = fakeGithub({
      'GET /user': account,
      'GET /repos/yura/app': () => (revoked ? { status: 401, body: { message: 'Bad credentials' } } : repo(1, 'yura/app')),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const integration = new GithubIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });

    for (let sweep = 0; sweep < 3; sweep += 1) {
      expect(await integration.getInstallationRepo(4242, 'yura/app')).toBeNull();
    }
    expect(integration.diagnostics()).toMatchObject({ fallbackTokenRejected: true });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('rejected GITHUB_ACCESS_TOKEN (401)');
    expect(String(error.mock.calls[0]![0])).not.toContain(TOKEN);

    revoked = false;
    expect(await integration.getInstallationRepo(4242, 'yura/app')).toMatchObject({ fullName: 'yura/app' });
    expect(integration.diagnostics()).toMatchObject({ fallbackTokenRejected: false });
    expect(info).toHaveBeenCalledWith('[GitHub] GITHUB_ACCESS_TOKEN is accepted again.');
  });

  it('warns at mount when GitHub cannot confirm the fallback token, and still serves its routes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const github = fakeGithub({ 'GET /user': { status: 401, body: { message: 'Bad credentials' } } });
    const { routes } = await mounted({ accessToken: TOKEN, fetchImpl: github.fetchImpl });
    expect(routes.length).toBeGreaterThan(0);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[GitHub] The fallback GITHUB_ACCESS_TOKEN could not be verified.', expect.anything()),
    );
  });
});

describe('GithubIntegration: polling for token connections', () => {
  it('reads issues of a token connection only from repositories routes name; an App connection reads all', async () => {
    const seeded = await createFactoryStorageForTests();
    const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Factory' } });
    const sourceControl = seeded.sourceControl.forIntegration('github');
    const integration = new GithubIntegration({ ...APP, accessToken: TOKEN, fetchImpl: fakeGithub({ 'GET /user': account }).fetchImpl });
    const installation = await sourceControl.installations.upsert({ orgId: 'org-1', connectedByUserId: 'user-1', externalId: '4242' });
    const projectConnection = await sourceControl.connections.create({
      orgId: 'org-1',
      factoryProjectId: project.id,
      installationId: installation.id,
      createdByUserId: 'user-1',
    });
    for (const [externalId, slug] of [
      ['10', 'acme/app'],
      ['11', 'acme/api'],
    ] as const) {
      const stored = await sourceControl.repositories.upsert({
        orgId: 'org-1',
        input: { installationId: installation.id, externalId, slug, defaultBranch: 'main' },
      });
      await sourceControl.projectRepositories.link({
        orgId: 'org-1',
        connectionId: projectConnection.id,
        repositoryId: stored.id,
        createdByUserId: 'user-1',
        sandboxProvider: 'local',
        sandboxWorkdir: '/workspace',
      });
    }
    const context = { storage: { sourceControl, intake: seeded.intake }, runtime: { intakeRoutes: seeded.storedBoards } } as never;
    const scope = (repositories: Array<{ id: number; fullName: string; installationId: number }>) =>
      (
        integration as unknown as { issueSweepRepositories(ctx: unknown, repositories: unknown[]): Promise<unknown[]> }
      ).issueSweepRepositories(context, repositories);
    const app = { id: 10, fullName: 'acme/app', installationId: 4242 };
    const api = { id: 11, fullName: 'acme/api', installationId: 4242 };
    const viaApp = { id: 12, fullName: 'acme/web', installationId: 55 };

    await seeded.intake.saveConfig({ orgId: 'org-1', config: { github: { enabled: true, sourceIds: null } } });
    await expect(scope([app, api, viaApp])).resolves.toEqual([viaApp]);
    await seeded.storedBoards.createIntakeRoute(
      { orgId: 'org-1', factoryProjectId: project.id },
      {
        name: 'github acme/api',
        when: {
          operator: 'AND',
          conditions: [
            { field: 'source.integration', operator: 'equals', value: 'github' },
            { field: 'source.repository', operator: 'equals', value: 'acme/api' },
          ],
        },
        target: { boardKey: 'work', phaseKey: 'intake' },
      },
      'user-1',
    );
    await expect(scope([app, api, viaApp])).resolves.toEqual([api, viaApp]);
  });

  it('reads pull-request activity only for token connections', async () => {
    const github = fakeGithub({ 'GET /user': account, 'GET /repos/acme/app/pulls': [] });
    const integration = new GithubIntegration({ ...APP, accessToken: TOKEN, fetchImpl: github.fetchImpl });
    const context = {
      controller: {},
      storage: {
        generic: { subscriptions: { listByTarget: async () => [] }, settings: { get: async () => null } },
        sourceControl: {
          projectRepositories: { listByExternalRepository: async () => [{ orgId: 'org-1', factoryProjectId: 'project-1' }] },
        },
        projects: {},
        intake: {},
      },
      runtime: { configVersion: 'test-v1', workItems: { list: async () => [] }, boards: {} },
    } as never;
    // The integration's own settings storage is read when resolving installations.
    integration.routes({ ...(context as object), auth: fakeRouteAuth(), storage: { ...(context as { storage: object }).storage, memorySettings: {} } } as never);
    const sweep = (
      integration as unknown as { pullRequestActivitySweep(ctx: unknown): ((repositories: unknown[]) => Promise<unknown>) | undefined }
    ).pullRequestActivitySweep(context);

    await expect(
      sweep?.([
        { id: 10, fullName: 'acme/app', installationId: 4242 },
        { id: 12, fullName: 'acme/web', installationId: 55 },
      ]),
    ).resolves.toMatchObject({ repositories: 1, failed: 0 });
    expect(github.calls.map(call => `${call.method} ${call.url.pathname}`)).toContain('GET /repos/acme/app/pulls');
    expect(github.calls.map(call => call.url.pathname)).not.toContain('/repos/acme/web/pulls');
  });

  it('runs the sweeps at the token pace', () => {
    const integration = new GithubIntegration({ accessToken: TOKEN });
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
    expect(GITHUB_TOKEN_RECONCILE_INTERVAL_MS).toBe(120_000);
  });
});

describe('GithubIntegration: token connections through the routes', () => {
  async function app(options: { config?: GithubIntegrationConfig; routes: Record<string, unknown>; admin?: boolean }) {
    const { Hono } = await import('hono');
    const { mountApiRoutes } = await import('@factory/http/testing');
    const github = fakeGithub(options.routes);
    const audits: Array<{ action: string; metadata: unknown }> = [];
    const seeded = await createFactoryStorageForTests();
    const integration = new GithubIntegration({ ...options.config, fetchImpl: github.fetchImpl });
    const routes = integration.routes({
      auth: fakeRouteAuth({ isOrganizationAdmin: async () => options.admin ?? true }),
      sandbox: (() => ({})) as never,
      stateSigner: createStateSigner('secret'),
      hooks: { emitAudit: async ({ input }: { input: { action: string; metadata: unknown } }) => void audits.push(input) },
      storage: {
        generic: seeded.integrations.forIntegration('github'),
        sourceControl: seeded.sourceControl.forIntegration('github'),
        projects: seeded.projects,
        intake: seeded.intake,
        memorySettings: { get: async () => null },
      },
    } as never);
    integration.versionControl.initialize({ storage: seeded.sourceControl.forIntegration('github') });
    const request = (path: string, init?: RequestInit, orgId = 'org-1') => {
      const hono = new Hono();
      hono.use('*', async (c, next) => {
        c.set('factoryAuthUser' as never, { id: `user-${orgId}`, organizationId: orgId } as never);
        await next();
      });
      mountApiRoutes(hono as never, routes);
      return hono.request(path, init);
    };
    const json = (method: string, body: unknown) => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { integration, request, json, audits, github, projects: seeded.projects, storage: seeded.sourceControl.forIntegration('github'), settings: seeded.integrations.forIntegration('github') };
  }

  it('connects a token: checks it, stores it encrypted for the org, never returns it', async () => {
    const t = await app({ routes: { 'GET /user': account, 'GET /user/repos': [repo(1), repo(2)] } });

    const res = await t.request('/web/github/token-connections', t.json('POST', { token: ` ${TOKEN} ` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      connection: expect.objectContaining({ kind: 'token', tokenSource: 'stored', installationId: 4242, accountLogin: 'Yura', repositoryCount: 2 }),
      replaced: false,
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(t.github.calls.every(call => call.authorization === `token ${TOKEN}`)).toBe(true);
    expect(await t.storage.installations.list({ orgId: 'org-1' })).toEqual([
      expect.objectContaining({ externalId: '4242', accountName: 'Yura', providerMetadata: expect.objectContaining({ auth: 'token' }) }),
    ]);
    expect(await t.integration.mintInstallationToken(4242)).toBe(TOKEN);
    expect(t.audits).toEqual([expect.objectContaining({ action: 'factory.integration.token_connected', metadata: { replaced: false, account: 'Yura' } })]);

    const status = await (await t.request('/web/github/status')).json();
    expect(status).toMatchObject({ appConfigured: false, connected: true, installations: [expect.objectContaining({ kind: 'token', tokenSource: 'stored' })] });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    const listed = await (await t.request('/web/github/connections')).json();
    expect(listed).toEqual({
      appConfigured: false,
      canManage: true,
      connections: [expect.objectContaining({ kind: 'token', repositoryCount: 2, status: 'ok' })],
    });
    // Another org does not see it.
    expect((await (await t.request('/web/github/status', undefined, 'org-2')).json()) as any).toMatchObject({ connected: false });
  });

  it('explains a token GitHub refuses, and stores nothing', async () => {
    const t = await app({ routes: { 'GET /user': { status: 401, body: { message: 'Bad credentials' } } } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await t.request('/web/github/token-connections', t.json('POST', { token: 'ghp_bad' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
    expect(await t.storage.installations.list({ orgId: 'org-1' })).toEqual([]);
    expect((await t.request('/web/github/token-connections', t.json('POST', {}))).status).toBe(422);
  });

  it('lets only organization admins connect, replace or disconnect', async () => {
    const t = await app({ routes: { 'GET /user': account }, admin: false });
    expect((await t.request('/web/github/token-connections', t.json('POST', { token: TOKEN }))).status).toBe(403);
    expect((await t.request('/web/github/token-connections/x', t.json('PUT', { token: TOKEN }))).status).toBe(403);
    expect((await t.request('/web/github/connections/x', { method: 'DELETE' })).status).toBe(403);
    expect((await (await t.request('/web/github/status')).json()) as any).toMatchObject({ canManage: false });
  });

  it('replaces the token of the same account, refuses another account, and moves a legacy row to a stored token', async () => {
    let user = account;
    const t = await app({
      config: { accessToken: 'ghp_env' },
      routes: { 'GET /user': () => user, 'GET /user/repos': [repo(1)] },
    });
    // The legacy row the former token mode registered: no metadata, the env account's id.
    const legacy = await t.storage.installations.upsert({ orgId: 'org-1', connectedByUserId: 'u', externalId: '4242', accountName: 'Yura' });
    expect(((await (await t.request('/web/github/status')).json()) as any).installations).toEqual([
      expect.objectContaining({ id: legacy.id, kind: 'token', tokenSource: 'env' }),
    ]);

    const replaced = await t.request(`/web/github/token-connections/${legacy.id}`, t.json('PUT', { token: 'ghp_new' }));
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ connection: { id: legacy.id, tokenSource: 'stored' }, replaced: true });
    expect(await t.integration.mintInstallationToken(4242)).toBe('ghp_new');

    user = { id: 9, login: 'someone-else', type: 'User' };
    const mismatch = await t.request(`/web/github/token-connections/${legacy.id}`, t.json('PUT', { token: 'ghp_other' }));
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({ error: 'account_mismatch' });
    expect(await t.integration.mintInstallationToken(4242)).toBe('ghp_new');
    expect((await t.request('/web/github/token-connections/missing', t.json('PUT', { token: 'ghp_x' }))).status).toBe(404);
  });

  it('disconnects an unused token connection straight away', async () => {
    const t = await app({ routes: { 'GET /user': account, 'GET /user/repos': [repo(1)] } });
    const { connection } = (await (await t.request('/web/github/token-connections', t.json('POST', { token: TOKEN }))).json()) as any;
    const removed = await t.request(`/web/github/connections/${connection.id}`, { method: 'DELETE' });
    expect(await removed.json()).toEqual({ removed: true, moved: [], unlinked: [] });
    expect(await t.storage.installations.list({ orgId: 'org-1' })).toEqual([]);
    expect(await t.integration.tokens.hasStoredToken('org-1', 4242)).toBe(false);
    expect(t.audits.at(-1)).toMatchObject({ action: 'factory.integration.connection_removed', metadata: { account: 'Yura', kind: 'token' } });
  });

  describe('deleting a connection Factories still use', () => {
    const CLIENT = { id: 7001, login: 'client-bot', type: 'User' };
    async function used() {
      // ghp_yura reaches acme/app (1) and client/site (2); ghp_client reaches only acme/app.
      const t = await app({
        routes: {
          'GET /user': (call: Call) => (call.authorization === 'token ghp_client' ? CLIENT : account),
          'GET /user/repos': (call: Call) =>
            call.authorization === 'token ghp_client' ? [repo(1, 'acme/app')] : [repo(1, 'acme/app'), repo(2, 'client/site')],
        },
      });
      const yura = ((await (await t.request('/web/github/token-connections', t.json('POST', { token: 'ghp_yura' }))).json()) as any).connection;
      const client = ((await (await t.request('/web/github/token-connections', t.json('POST', { token: 'ghp_client' }))).json()) as any).connection;
      const project = await t.projects.create({ orgId: 'org-1', userId: 'u', input: { name: 'post-airborne' } });
      const projectConnection = await t.storage.connections.create({
        orgId: 'org-1',
        factoryProjectId: project.id,
        installationId: yura.id,
        createdByUserId: 'u',
      });
      const links: Record<string, string> = {};
      for (const [externalId, slug] of [
        ['1', 'acme/app'],
        ['2', 'client/site'],
      ] as const) {
        const repository = await t.storage.repositories.upsert({
          orgId: 'org-1',
          input: { installationId: yura.id, externalId, slug, defaultBranch: 'main' },
        });
        links[slug] = (
          await t.storage.projectRepositories.link({
            orgId: 'org-1',
            connectionId: projectConnection.id,
            repositoryId: repository.id,
            createdByUserId: 'u',
            sandboxProvider: 'local',
            sandboxWorkdir: '/workspace',
          })
        ).id;
      }
      return { t, yura, client, project, links };
    }

    it('previews which Factories and repositories move to another connection or get unlinked', async () => {
      const { t, yura, client, project } = await used();
      const res = await t.request(`/web/github/connections/${yura.id}/usage`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        connection: expect.objectContaining({ id: yura.id, kind: 'token', accountLogin: 'Yura' }),
        factories: [{ id: project.id, name: 'post-airborne' }],
        repositories: [
          expect.objectContaining({ slug: 'acme/app', factories: ['post-airborne'], target: { id: client.id, kind: 'token', accountLogin: 'client-bot' } }),
          expect.objectContaining({ slug: 'client/site', factories: ['post-airborne'], target: null }),
        ],
      });
    });

    it('refuses without confirmation, returning the same usage', async () => {
      const { t, yura } = await used();
      const refused = await t.request(`/web/github/connections/${yura.id}`, { method: 'DELETE' });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        error: 'connection_in_use',
        projectConnections: 1,
        usage: { repositories: [expect.objectContaining({ slug: 'acme/app' }), expect.objectContaining({ slug: 'client/site', target: null })] },
      });
      expect(await t.storage.installations.get({ orgId: 'org-1', id: yura.id })).not.toBeNull();
    });

    it('on confirmation moves what another connection reaches, unlinks the rest, and deletes the connection and its token', async () => {
      const { t, yura, client, project, links } = await used();
      const res = await t.request(`/web/github/connections/${yura.id}?confirm=1`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        removed: true,
        moved: [{ slug: 'acme/app', to: { id: client.id, kind: 'token', accountLogin: 'client-bot' } }],
        unlinked: ['client/site'],
      });
      expect(await t.storage.installations.get({ orgId: 'org-1', id: yura.id })).toBeNull();
      expect(await t.integration.tokens.hasStoredToken('org-1', 4242)).toBe(false);
      const moved = await t.storage.projectRepositories.get({ orgId: 'org-1', id: links['acme/app']! });
      expect(await t.storage.connections.get({ orgId: 'org-1', id: moved!.connectionId })).toMatchObject({
        factoryProjectId: project.id,
        installationId: client.id,
      });
      expect(await t.storage.projectRepositories.get({ orgId: 'org-1', id: links['client/site']! })).toBeNull();
      expect(t.audits.at(-1)).toMatchObject({
        action: 'factory.integration.connection_removed',
        metadata: { account: 'Yura', factories: ['post-airborne'], moved: [{ slug: 'acme/app', to: 'client-bot' }], unlinked: ['client/site'] },
      });
    });

    it('lets only organization admins delete', async () => {
      const { t, yura } = await used();
      void t;
      const member = await app({ routes: { 'GET /user': account }, admin: false });
      expect((await member.request(`/web/github/connections/${yura.id}?confirm=1`, { method: 'DELETE' })).status).toBe(403);
    });
  });

  it('keeps two organizations with tokens of one account apart in storage', async () => {
    const t = await app({ routes: { 'GET /user': account, 'GET /user/repos': [repo(1)] } });
    await t.request('/web/github/token-connections', t.json('POST', { token: 'ghp_org1' }));
    await t.request('/web/github/token-connections', t.json('POST', { token: 'ghp_org2' }), 'org-2');
    const org2 = (await t.storage.installations.list({ orgId: 'org-2' }))[0]!;
    await t.request(`/web/github/connections/${org2.id}`, { method: 'DELETE' }, 'org-2');
    // Org 1's connection still works with its own token.
    expect(await t.integration.tokens.hasStoredToken('org-1', 4242)).toBe(true);
    expect(await t.integration.mintInstallationToken(4242)).toBe('ghp_org1');
  });

  it('has no App install flow without an App', async () => {
    const t = await app({ routes: {} });
    const res = await t.request('/auth/github/connect');
    expect(res.headers.get('location')).toBe('/?github=no_app');
  });
});
