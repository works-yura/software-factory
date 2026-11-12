import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBoardRegistry, createFactoryStorageForTests } from '@factory/testing';
import { createGithubIssueReconciler, GithubIntegration } from '@factory/integration-github';

/**
 * GitHub without an App learns about issues only by polling. This drives the
 * issue sweep through a real `GithubIntegration` (fallback access token) against a fake GitHub
 * API: the token reads the issues and the author's permission, and an issue
 * the token's own account filed becomes a card (Factory must not mistake the
 * person behind the token for itself).
 */

const TOKEN = 'ghp_polling_token';
const repository = { id: 10, fullName: 'yura/app', installationId: 4242 };

function issue(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/yura/app/issues/${number}`,
    state: 'open',
    assignees: [],
    labels: [],
    user: { login: 'yura' },
    created_at: new Date(Date.now() + 60_000).toISOString(),
    updated_at: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  };
}

function fakeGithub(routes: Record<string, unknown>, options: { rejected?: boolean } = {}) {
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    requests.push({ path: url.pathname, authorization: new Headers(init?.headers).get('authorization') });
    if (options.rejected && url.pathname !== '/user') {
      return new Response('{"message":"Bad credentials"}', { status: 401, headers: { 'content-type': 'application/json' } });
    }
    const body = routes[`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`];
    return body === undefined
      ? new Response('{"message":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { requests, fetchImpl: fetchImpl as unknown as typeof fetch };
}

async function setup(routes: Record<string, unknown>, options: { rejected?: boolean } = {}) {
  const seeded = await createFactoryStorageForTests();
  const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Factory' } });
  const sourceControl = seeded.sourceControl.forIntegration('github');
  const installation = await sourceControl.installations.upsert({
    orgId: project.orgId,
    connectedByUserId: project.createdBy,
    externalId: String(repository.installationId),
    accountName: 'yura',
    accountType: 'User',
  });
  const storedRepository = await sourceControl.repositories.upsert({
    orgId: project.orgId,
    input: {
      installationId: installation.id,
      externalId: String(repository.id),
      slug: repository.fullName,
      defaultBranch: 'main',
    },
  });
  const connection = await sourceControl.connections.create({
    orgId: project.orgId,
    factoryProjectId: project.id,
    installationId: installation.id,
    createdByUserId: project.createdBy,
  });
  await sourceControl.projectRepositories.link({
    orgId: project.orgId,
    connectionId: connection.id,
    repositoryId: storedRepository.id,
    createdByUserId: project.createdBy,
    sandboxProvider: 'local',
    sandboxWorkdir: '/workspace',
  });

  const github = fakeGithub({ 'GET /user': { id: 4242, login: 'yura', type: 'User' }, ...routes }, options);
  const integration = new GithubIntegration({ accessToken: TOKEN, fetchImpl: github.fetchImpl });
  await integration.tokens.envToken!.account();
  const reconciler = createGithubIssueReconciler(
    {
      github: integration,
      sourceControl,
      integrationStorage: seeded.integrations.forIntegration('github'),
      projects: seeded.projects,
      storage: seeded.workItems,
      configVersion: 'factory-config-v1',
      boards: createBoardRegistry(),
    },
    input => integration.fetchIssueState(input),
    input => integration.listOpenIssueStates(input),
  );
  return { ...seeded, project, github, integration, reconciler };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GitHub without an App: issues arrive by polling', () => {
  it("files an issue the token's own account opened as a card, once", async () => {
    const run = await setup({
      'GET /repos/yura/app/issues': [issue(39), issue(40, { pull_request: { url: 'x' } })],
      'GET /repos/yura/app/collaborators/yura/permission': { permission: 'admin', user: { login: 'yura' } },
    });

    await expect(run.reconciler([repository])).resolves.toMatchObject({ created: 1, failed: 0 });
    const decisions = await run.workItems.listDeferredDecisions('org-1', run.project.id);
    expect(decisions.map(entry => entry.decision)).toMatchObject([
      {
        type: 'upsertLinkedWorkItem',
        sourceKey: 'github:10:issue:39',
        metadata: { author: 'yura', authorTrusted: true },
      },
    ]);
    // The person behind the token is trusted, and not mistaken for Factory.
    expect(decisions[0]?.actor).toEqual({ type: 'github', login: 'yura', trusted: true, factoryAuthored: false });
    expect(JSON.stringify(decisions)).not.toContain('github:10:issue:40');

    // The next sweep sees the same issue and files nothing new.
    await run.reconciler([repository]);
    expect(await run.workItems.listDeferredDecisions('org-1', run.project.id)).toHaveLength(1);

    expect(run.github.requests.length).toBeGreaterThan(0);
    expect(run.github.requests.every(request => request.authorization === `token ${TOKEN}`)).toBe(true);
  });

  it('leaves an issue alone when its author cannot push to the repository', async () => {
    const run = await setup({
      'GET /repos/yura/app/issues': [issue(41, { user: { login: 'stranger' } })],
      'GET /repos/yura/app/collaborators/stranger/permission': { permission: 'read', user: { login: 'stranger' } },
    });

    await expect(run.reconciler([repository])).resolves.toMatchObject({ created: 1, failed: 0 });
    const [entry] = await run.workItems.listDeferredDecisions('org-1', run.project.id);
    // Filed for a person to look at, never started on its own.
    expect(entry?.actor).toEqual({ type: 'github', login: 'stranger', trusted: false, factoryAuthored: false });
    expect(entry?.decision).toMatchObject({
      stage: 'intake',
      metadata: { author: 'stranger', authorTrusted: false, autoStartCandidate: false },
    });
  });

  it('reports a failed sweep, files nothing, and flags the token while GitHub rejects it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = await setup({}, { rejected: true });

    await expect(run.reconciler([repository])).resolves.toMatchObject({ created: 0, failed: 1 });
    expect(await run.workItems.listDeferredDecisions('org-1', run.project.id)).toHaveLength(0);
    expect(run.integration.diagnostics()).toMatchObject({ fallbackTokenRejected: true });
  });
});
