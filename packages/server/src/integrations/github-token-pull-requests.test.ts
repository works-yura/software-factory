import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStateSigner } from '@factory/auth';
import { fakeRouteAuth } from '@factory/http/testing';
import type { IntegrationContext } from '@factory/integrations';
import { createBoardRegistry, createFactoryStorageForTests } from '@factory/testing';
import {
  createGithubPullRequestActivitySweep,
  GithubRules,
  GithubTokenIntegration,
  octokitPullRequestActivitySource,
} from '@factory/integration-github';
import type { GithubPullRequestReconciler } from '@factory/integration-github';

/**
 * GitHub without an App gets no webhooks, so the life of the pull request
 * Factory opened is read by polling. This drives the activity sweep through a
 * real `GithubTokenIntegration` against a fake GitHub API and into the real
 * rules: the Work card records the pull request, a reviewer's comment and
 * review reach the authoring agent, the agent's own comments do not, and the
 * merge settles the card.
 */

const TOKEN = 'github_pat_activity_token';
const repository = { id: 10, fullName: 'acme/repo', installationId: 4242 };
const created = '2030-01-01T00:00:00Z';

const pullRequest = (extra: Record<string, unknown> = {}) => ({
  number: 17,
  title: 'PR 17',
  html_url: 'https://github.com/acme/repo/pull/17',
  url: 'https://api.github.com/repos/acme/repo/pulls/17',
  state: 'open',
  user: { login: 'yura' },
  created_at: created,
  updated_at: created,
  head: { ref: 'factory/work', sha: 'aaa' },
  base: { ref: 'main' },
  ...extra,
});

function fakeGithub(routes: Record<string, unknown>) {
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    requests.push({ path: url.pathname, authorization: new Headers(init?.headers).get('authorization') });
    const body = routes[`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`];
    return body === undefined
      ? new Response('{"message":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { requests, fetchImpl: fetchImpl as unknown as typeof fetch };
}

async function setup() {
  const seeded = await createFactoryStorageForTests();
  const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Factory' } });
  const sourceControl = seeded.sourceControl.forIntegration('github');
  const installation = await sourceControl.installations.upsert({
    orgId: 'org-1',
    connectedByUserId: 'user-1',
    externalId: String(repository.installationId),
    accountName: 'yura',
    accountType: 'User',
  });
  const stored = await sourceControl.repositories.upsert({
    orgId: 'org-1',
    input: { installationId: installation.id, externalId: '10', slug: repository.fullName, defaultBranch: 'main' },
  });
  const connection = await sourceControl.connections.create({
    orgId: 'org-1',
    factoryProjectId: project.id,
    installationId: installation.id,
    createdByUserId: 'user-1',
  });
  await sourceControl.projectRepositories.link({
    orgId: 'org-1',
    connectionId: connection.id,
    repositoryId: stored.id,
    createdByUserId: 'user-1',
    sandboxProvider: 'local',
    sandboxWorkdir: '/workspace',
  });
  // A card from another intake source (ClickUp): it names no repository.
  const work = (
    await seeded.workItems.upsert({
      orgId: 'org-1',
      userId: 'user-1',
      factoryProjectId: project.id,
      input: { title: 'Add the export', stages: ['execute'], sessions: {}, metadata: {} },
    })
  ).item;
  const integrationStorage = seeded.integrations.forIntegration('github');
  // What the run records when its `gh pr create` succeeds.
  await integrationStorage.subscriptions.create({
    orgId: 'org-1',
    targetKey: 'factory-pr-provenance:10:17',
    threadId: 'thread-1',
    status: 'active',
    data: { kind: 'factory-pr-provenance', factoryProjectId: project.id, workItemId: work.id },
  });

  const routes: Record<string, unknown> = {
    'GET /user': { id: 4242, login: 'yura', type: 'User' },
    'GET /repos/acme/repo/pulls': [pullRequest()],
    'GET /repos/acme/repo/issues/17/comments': [],
    'GET /repos/acme/repo/pulls/17/comments': [],
    'GET /repos/acme/repo/pulls/17/reviews': [],
    'GET /repos/acme/repo/collaborators/alice/permission': { permission: 'write', user: { login: 'alice' } },
    'GET /repos/acme/repo/collaborators/yura/permission': { permission: 'admin', user: { login: 'yura' } },
  };
  const github = fakeGithub(routes);
  const integration = new GithubTokenIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });
  const rules = new GithubRules({
    github: integration,
    sourceControl,
    integrationStorage,
    projects: seeded.projects,
    storage: seeded.workItems,
    configVersion: 'factory-config-v1',
    boards: createBoardRegistry(),
  });
  const sweep = createGithubPullRequestActivitySweep({
    source: octokitPullRequestActivitySource(id => integration.getInstallationOctokit(id)),
    sourceControl,
    integrationStorage,
    storage: seeded.workItems,
    selfLogin: async () => (await integration.account()).login,
    deliver: async event => {
      await rules.ingest(event);
    },
  });
  const card = async () => (await seeded.workItems.get({ orgId: 'org-1', id: work.id }))!;
  const decisions = async () =>
    (await seeded.workItems.listDeferredDecisions('org-1', project.id)).filter(entry => entry.workItemId === work.id);
  return { ...seeded, project, work, routes, github, integration, sweep, card, decisions };
}

/**
 * The sweep exactly as the server wires it: mounting the routes attaches the
 * rules ingress, and the integration's own sweep delivers through it and on
 * to the sessions the controller holds.
 */
async function productionSweep(run: Awaited<ReturnType<typeof setup>>, controller: Record<string, unknown>) {
  const context = {
    auth: fakeRouteAuth(),
    sandbox: (() => ({})) as never,
    stateSigner: createStateSigner('secret'),
    controller: controller as never,
    storage: {
      generic: run.integrations.forIntegration('github'),
      sourceControl: run.sourceControl.forIntegration('github'),
      sourceControls: [],
      projects: run.projects,
      intake: run.intake,
    },
    runtime: { configVersion: 'factory-config-v1', workItems: run.workItems, boards: createBoardRegistry() },
  } as unknown as IntegrationContext;
  run.integration.routes(context);
  const sweep = (
    run.integration as unknown as {
      pullRequestActivitySweep(ctx: IntegrationContext): GithubPullRequestReconciler | undefined;
    }
  ).pullRequestActivitySweep(context);
  if (!sweep) throw new Error('The access-token integration has no pull-request activity sweep.');
  return sweep;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GitHub without an App: the pull request Factory opened, by polling', () => {
  it('records the pull request, hands review feedback to the agent, and settles the card on merge', async () => {
    const run = await setup();

    // The opening: the card records the pull request it has out.
    await expect(run.sweep([repository])).resolves.toMatchObject({ checked: 1, failed: 0 });
    expect((await run.card()).metadata).toMatchObject({
      openChangeRequests: [{ repository: 'acme/repo', number: 17, provider: 'github' }],
      openPullRequestNumber: 17,
      pullRequestHeadSha: 'aaa',
    });
    expect(await run.decisions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ decision: expect.objectContaining({ type: 'transition', stage: 'pr-review' }) }),
      ]),
    );

    // A reviewer's comment and review reach the authoring agent; the agent's
    // own progress comment (the token's account) does not wake it.
    const before = (await run.decisions()).length;
    run.routes['GET /repos/acme/repo/issues/17/comments'] = [
      {
        id: 501,
        body: 'This needs a null check.',
        html_url: 'https://github.com/acme/repo/pull/17#issuecomment-501',
        user: { login: 'alice', type: 'User' },
        created_at: '2030-01-01T00:05:00Z',
        updated_at: '2030-01-01T00:05:00Z',
      },
      {
        id: 502,
        body: 'Pushed the fix.',
        user: { login: 'yura', type: 'User' },
        created_at: '2030-01-01T00:06:00Z',
        updated_at: '2030-01-01T00:06:00Z',
      },
    ];
    run.routes['GET /repos/acme/repo/pulls/17/reviews'] = [
      {
        id: 601,
        state: 'CHANGES_REQUESTED',
        body: 'Please handle the empty export.',
        html_url: 'https://github.com/acme/repo/pull/17#pullrequestreview-601',
        user: { login: 'alice', type: 'User' },
        submitted_at: '2030-01-01T00:07:00Z',
      },
    ];
    await run.sweep([repository]);
    const feedback = (await run.decisions()).slice(before).map(entry => entry.decision);
    expect(feedback).toEqual([
      expect.objectContaining({
        type: 'sendMessage',
        role: 'work',
        message: expect.stringContaining('alice commented on pull request #17'),
      }),
      expect.objectContaining({
        type: 'sendMessage',
        role: 'work',
        message: expect.stringContaining('Changes were requested on pull request #17'),
      }),
    ]);

    // Nothing new: the next sweep delivers nothing again.
    await run.sweep([repository]);
    expect(await run.decisions()).toHaveLength(before + 2);

    // The merge: the pull request leaves the open list and reads merged.
    run.routes['GET /repos/acme/repo/pulls'] = [];
    run.routes['GET /repos/acme/repo/pulls/17'] = pullRequest({
      state: 'closed',
      merged: true,
      merged_by: { login: 'alice' },
    });
    await expect(run.sweep([repository])).resolves.toMatchObject({ merged: 1, failed: 0 });
    expect((await run.card()).metadata).toMatchObject({ openChangeRequests: [], openPullRequestNumber: null });
    expect((await run.decisions()).map(entry => entry.decision)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'transition', board: 'work', stage: 'done' })]),
    );

    // Every call went out with the token.
    expect(run.github.requests.every(request => request.authorization === `token ${TOKEN}`)).toBe(true);
  });

  it("tells the agent's session about every step, as the webhooks would, and retires its subscription at the merge", async () => {
    const run = await setup();
    const signals: Array<{ kind: string; summary: string }> = [];
    const sendNotificationSignal = vi.fn(async (signal: { kind: string; summary: string }) => {
      signals.push({ kind: signal.kind, summary: signal.summary });
      return { persisted: Promise.resolve(), accepted: Promise.resolve() };
    });
    const sweep = await productionSweep(run, {
      queryThreadById: async ({ threadId }: { threadId: string }) => ({ id: threadId, resourceId: run.project.id }),
      getSession: async () => ({ thread: { getId: () => 'thread-1', switch: vi.fn() }, sendNotificationSignal }),
      createSession: vi.fn(),
    });
    const subscriptions = run.integrations.forIntegration('github').subscriptions;
    // What the run records when it opens the pull request.
    const subscription = await subscriptions.create({
      orgId: 'org-1',
      targetKey: 'change-request:4242:10:17',
      sessionId: 'session-1',
      resourceId: run.project.id,
      threadId: 'thread-1',
      status: 'open',
      data: {
        installationExternalId: '4242',
        repositoryExternalId: '10',
        repositorySlug: 'acme/repo',
        changeRequestId: '17',
        projectRepositoryId: 'project-repository-1',
        source: 'auto-gh-pr-create',
        subscribedByUserId: 'user-1',
      },
    });

    await sweep([repository]);
    // The opening is not news to the session that opened it.
    expect(signals).toEqual([]);
    expect((await run.card()).metadata).toMatchObject({ openChangeRequests: [{ number: 17 }] });

    run.routes['GET /repos/acme/repo/issues/17/comments'] = [
      {
        id: 501,
        body: 'This needs a null check.',
        html_url: 'https://github.com/acme/repo/pull/17#issuecomment-501',
        user: { login: 'alice', type: 'User' },
        created_at: '2030-01-01T00:05:00Z',
        updated_at: '2030-01-01T00:05:00Z',
      },
      {
        id: 502,
        body: 'Pushed the fix.',
        user: { login: 'yura', type: 'User' },
        created_at: '2030-01-01T00:06:00Z',
        updated_at: '2030-01-01T00:06:00Z',
      },
    ];
    run.routes['GET /repos/acme/repo/pulls/17/comments'] = [
      {
        id: 701,
        body: 'Rename this.',
        html_url: 'https://github.com/acme/repo/pull/17#discussion_r701',
        user: { login: 'alice', type: 'User' },
        created_at: '2030-01-01T00:07:00Z',
        updated_at: '2030-01-01T00:07:00Z',
      },
    ];
    run.routes['GET /repos/acme/repo/pulls/17/reviews'] = [
      {
        id: 601,
        state: 'CHANGES_REQUESTED',
        body: 'Please handle the empty export.',
        html_url: 'https://github.com/acme/repo/pull/17#pullrequestreview-601',
        user: { login: 'alice', type: 'User' },
        submitted_at: '2030-01-01T00:08:00Z',
      },
    ];
    run.routes['GET /repos/acme/repo/pulls'] = [
      pullRequest({ head: { ref: 'factory/work', sha: 'bbb' }, updated_at: '2030-01-01T00:09:00Z' }),
    ];
    await sweep([repository]);
    expect(signals).toEqual([
      { kind: 'pull-request-synchronize', summary: 'yura synchronize on acme/repo#17' },
      { kind: 'issue-comment-created', summary: 'alice commented on acme/repo#17' },
      { kind: 'review-comment-created', summary: 'alice left a review comment on acme/repo#17' },
      { kind: 'review-changes-requested', summary: 'alice requested changes on acme/repo#17' },
    ]);

    // Nothing new reaches the session twice.
    await sweep([repository]);
    expect(signals).toHaveLength(4);

    run.routes['GET /repos/acme/repo/pulls'] = [];
    run.routes['GET /repos/acme/repo/pulls/17'] = pullRequest({
      state: 'closed',
      merged: true,
      merged_by: { login: 'alice' },
    });
    await sweep([repository]);
    expect(signals.at(-1)).toEqual({ kind: 'pull-request-merged', summary: 'alice merged the pull request on acme/repo#17' });
    expect((await subscriptions.listByTarget('change-request:4242:10:17'))[0]).toMatchObject({
      id: subscription.id,
      status: 'merged',
    });
    expect((await run.card()).metadata).toMatchObject({ openChangeRequests: [] });
    expect((await run.decisions()).map(entry => entry.decision)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'transition', board: 'work', stage: 'done' })]),
    );
  });

  it('keeps the subscription open when the session cannot take the merge, so it is not lost', async () => {
    const run = await setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sweep = await productionSweep(run, {
      queryThreadById: async ({ threadId }: { threadId: string }) => ({ id: threadId, resourceId: run.project.id }),
      getSession: async () => ({
        thread: { getId: () => 'thread-1', switch: vi.fn() },
        sendNotificationSignal: vi.fn(async () => {
          throw new Error('session is shutting down');
        }),
      }),
      createSession: vi.fn(),
    });
    const subscriptions = run.integrations.forIntegration('github').subscriptions;
    await subscriptions.create({
      orgId: 'org-1',
      targetKey: 'change-request:4242:10:17',
      sessionId: 'session-1',
      resourceId: run.project.id,
      threadId: 'thread-1',
      status: 'open',
      data: {
        installationExternalId: '4242',
        repositoryExternalId: '10',
        repositorySlug: 'acme/repo',
        changeRequestId: '17',
        source: 'auto-gh-pr-create',
        subscribedByUserId: 'user-1',
      },
    });
    await sweep([repository]);

    run.routes['GET /repos/acme/repo/pulls'] = [];
    run.routes['GET /repos/acme/repo/pulls/17'] = pullRequest({ state: 'closed', merged: true, merged_by: { login: 'alice' } });
    await sweep([repository]);

    // The card still settles; the session failure is reported, not swallowed.
    expect((await run.card()).metadata).toMatchObject({ openChangeRequests: [] });
    expect((await subscriptions.listByTarget('change-request:4242:10:17'))[0]?.status).toBe('open');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('1 subscribed target(s) failed'));
  });

  it('records a push to the pull request as its new head', async () => {
    const run = await setup();
    await run.sweep([repository]);
    // The pull request's own card, as the dispatcher files it from the opening.
    const review = await run.workItems.upsert({
      orgId: 'org-1',
      userId: 'factory-rule-dispatcher',
      factoryProjectId: run.project.id,
      input: {
        externalSource: {
          integrationId: 'github',
          type: 'pull-request',
          externalId: 'github-pr:17',
          url: 'https://github.com/acme/repo/pull/17',
        },
        parentWorkItemId: run.work.id,
        title: 'PR 17',
        stages: ['review'],
        sessions: {},
        metadata: {},
      },
    });

    run.routes['GET /repos/acme/repo/pulls'] = [
      pullRequest({ head: { ref: 'factory/work', sha: 'bbb' }, updated_at: '2030-01-01T01:00:00Z' }),
    ];
    await run.sweep([repository]);

    expect((await run.card()).metadata).toMatchObject({ pullRequestHeadSha: 'bbb' });
    expect((await run.workItems.get({ orgId: 'org-1', id: review.item.id }))?.metadata).toMatchObject({
      pullRequestHeadSha: 'bbb',
    });
  });
});
