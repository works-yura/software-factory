import { describe, expect, it, vi } from 'vitest';

import { createFactoryStorageForTests } from '@factory/testing';

import { createGithubPullRequestActivitySweep } from './pull-request-activity.ts';
import type { GithubRestObject, PullRequestActivitySource } from './pull-request-activity.ts';
import type { ReconcileRepository } from './rules.ts';
import type { ParsedGithubWebhook } from './webhook.ts';

const app: ReconcileRepository = { id: 10, fullName: 'acme/app', installationId: 4242 };
const api: ReconcileRepository = { id: 11, fullName: 'acme/api', installationId: 4242 };

function pull(number: number, extra: GithubRestObject = {}): GithubRestObject {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/acme/app/pull/${number}`,
    url: `https://api.github.com/repos/acme/app/pulls/${number}`,
    state: 'open',
    user: { login: 'yura' },
    created_at: '2030-01-01T00:00:00Z',
    updated_at: '2030-01-01T00:00:00Z',
    head: { ref: 'factory/work', sha: 'aaa' },
    base: { ref: 'main' },
    ...extra,
  };
}

function comment(id: number, at: string, login: string, body = `comment ${id}`, updatedAt = at): GithubRestObject {
  return { id, body, user: { login, type: 'User' }, created_at: at, updated_at: updatedAt, html_url: `#c${id}` };
}

/** GitHub as the sweep reads it, per repository; tests edit it between sweeps. */
function fakeSource() {
  const state = {
    open: new Map<string, GithubRestObject[]>(),
    pulls: new Map<string, GithubRestObject>(),
    issueComments: new Map<number, GithubRestObject[]>(),
    reviewComments: new Map<number, GithubRestObject[]>(),
    reviews: new Map<number, GithubRestObject[]>(),
    failOpen: new Set<string>(),
  };
  const source: PullRequestActivitySource = {
    listOpenPullRequests: async ({ repository }) => {
      if (state.failOpen.has(repository)) throw new Error(`${repository} is unreachable`);
      return state.open.get(repository) ?? [];
    },
    getPullRequest: async ({ repository, number }) => {
      const found = state.pulls.get(`${repository}#${number}`);
      if (!found) throw new Error('Not Found');
      return found;
    },
    listIssueComments: async ({ number }) => state.issueComments.get(number) ?? [],
    listReviewComments: async ({ number }) => state.reviewComments.get(number) ?? [],
    listReviews: async ({ number }) => state.reviews.get(number) ?? [],
  };
  return { state, source };
}

async function setup() {
  const seeded = await createFactoryStorageForTests();
  const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Factory' } });
  const sourceControl = seeded.sourceControl.forIntegration('github');
  const installation = await sourceControl.installations.upsert({
    orgId: 'org-1',
    connectedByUserId: 'user-1',
    externalId: String(app.installationId),
  });
  const connection = await sourceControl.connections.create({
    orgId: 'org-1',
    factoryProjectId: project.id,
    installationId: installation.id,
    createdByUserId: 'user-1',
  });
  for (const repository of [app, api]) {
    const stored = await sourceControl.repositories.upsert({
      orgId: 'org-1',
      input: {
        installationId: installation.id,
        externalId: String(repository.id),
        slug: repository.fullName,
        defaultBranch: 'main',
      },
    });
    await sourceControl.projectRepositories.link({
      orgId: 'org-1',
      connectionId: connection.id,
      repositoryId: stored.id,
      createdByUserId: 'user-1',
      sandboxProvider: 'local',
      sandboxWorkdir: '/workspace',
    });
  }
  const integrationStorage = seeded.integrations.forIntegration('github');
  const work = (
    await seeded.workItems.upsert({
      orgId: 'org-1',
      userId: 'user-1',
      factoryProjectId: project.id,
      input: { title: 'Work', stages: ['execute'], sessions: {}, metadata: {} },
    })
  ).item;
  const authored = (repository: ReconcileRepository, number: number) =>
    integrationStorage.subscriptions.create({
      orgId: 'org-1',
      targetKey: `factory-pr-provenance:${repository.id}:${number}`,
      threadId: 'thread-1',
      status: 'active',
      data: { kind: 'factory-pr-provenance', factoryProjectId: project.id, workItemId: work.id },
    });
  const { state, source } = fakeSource();
  const delivered: ParsedGithubWebhook[] = [];
  const deliver = vi.fn(async (event: ParsedGithubWebhook) => {
    delivered.push(event);
  });
  const sweep = createGithubPullRequestActivitySweep({
    source,
    sourceControl,
    integrationStorage,
    storage: seeded.workItems,
    selfLogin: async () => 'Yura',
    deliver,
  });
  const ids = () => delivered.map(event => event.deliveryId);
  return { ...seeded, project, work, authored, state, deliver, delivered, ids, sweep };
}

describe('pull-request activity read by polling', () => {
  it('delivers the opening of a pull request Factory authored, once, and leaves the others alone', async () => {
    const run = await setup();
    await run.authored(app, 5);
    run.state.open.set('acme/app', [pull(5), pull(6, { user: { login: 'stranger' } })]);

    await expect(run.sweep([app])).resolves.toMatchObject({ repositories: 1, checked: 1, failed: 0 });
    expect(run.delivered).toEqual([
      {
        event: 'pull_request',
        deliveryId: 'poll:10:pull-request:5:2030-01-01T00:00:00Z',
        payload: expect.objectContaining({
          action: 'opened',
          installation: { id: 4242 },
          repository: { id: 10, full_name: 'acme/app' },
          sender: { login: 'yura' },
          pull_request: expect.objectContaining({ number: 5 }),
        }),
      },
    ]);

    await run.sweep([app]);
    expect(run.delivered).toHaveLength(1);
  });

  it('follows a pull request a card has out even without provenance', async () => {
    const run = await setup();
    await run.workItems.update({
      orgId: 'org-1',
      id: run.work.id,
      userId: 'user-1',
      patch: { metadata: { openChangeRequests: [{ repository: 'ACME/app', number: 7 }], openPullRequestNumber: 7 } },
    });
    run.state.open.set('acme/app', [pull(7)]);

    await run.sweep([app]);
    expect(run.ids()).toEqual(['poll:10:pull-request:7:2030-01-01T00:00:00Z']);
  });

  it('replays a push as one synchronize per new head', async () => {
    const run = await setup();
    await run.authored(app, 5);
    run.state.open.set('acme/app', [pull(5)]);
    await run.sweep([app]);

    run.state.open.set('acme/app', [pull(5, { head: { ref: 'factory/work', sha: 'bbb' } })]);
    await run.sweep([app]);
    await run.sweep([app]);

    expect(run.ids()).toEqual([
      'poll:10:pull-request:5:2030-01-01T00:00:00Z',
      'poll:10:pull-request:5:synchronize:bbb',
    ]);
    expect(run.delivered[1]?.payload).toMatchObject({ action: 'synchronize', pull_request: { head: { sha: 'bbb' } } });
  });

  it('delivers comments, review comments and reviews after the opening, oldest first, each once', async () => {
    const run = await setup();
    await run.authored(app, 5);
    run.state.open.set('acme/app', [pull(5)]);
    run.state.issueComments.set(5, [comment(1, '2030-01-01T00:03:00Z', 'alice', 'Needs a null check.')]);
    run.state.reviewComments.set(5, [comment(2, '2030-01-01T00:01:00Z', 'bob', 'Rename this.')]);
    run.state.reviews.set(5, [
      { id: 3, state: 'CHANGES_REQUESTED', body: 'Please fix.', user: { login: 'alice' }, submitted_at: '2030-01-01T00:02:00Z' },
      { id: 4, state: 'PENDING', body: 'draft', user: { login: 'alice' } },
    ]);

    await run.sweep([app]);
    expect(run.ids()).toEqual([
      'poll:10:pull-request:5:2030-01-01T00:00:00Z',
      'poll:10:review-comment:2',
      'poll:10:review:3',
      'poll:10:comment:1',
    ]);
    const [, reviewComment, review, issueComment] = run.delivered;
    expect(reviewComment).toMatchObject({
      event: 'pull_request_review_comment',
      payload: { action: 'created', sender: { login: 'bob' }, pull_request: { number: 5 }, comment: { id: 2 } },
    });
    // Webhooks spell a review's state in lower case.
    expect(review).toMatchObject({
      event: 'pull_request_review',
      payload: { action: 'submitted', review: { id: 3, state: 'changes_requested' } },
    });
    // A comment on a pull request arrives as `issue_comment` on the issue view of it.
    expect(issueComment).toMatchObject({
      event: 'issue_comment',
      payload: {
        action: 'created',
        sender: { login: 'alice' },
        issue: { number: 5, state: 'open', pull_request: { html_url: 'https://github.com/acme/app/pull/5' } },
        comment: { id: 1, body: 'Needs a null check.' },
      },
    });

    await run.sweep([app]);
    expect(run.delivered).toHaveLength(4);
  });

  it("skips the token account's own posts but delivers its request-changes verdict and the verdict's edit", async () => {
    const run = await setup();
    await run.authored(app, 5);
    run.state.open.set('acme/app', [pull(5)]);
    run.state.issueComments.set(5, [
      comment(1, '2030-01-01T00:01:00Z', 'yura', 'Pushed the fix.'),
      comment(2, '2030-01-01T00:02:00Z', 'yura', 'Verdict: request changes\nReviewed head: aaa'),
    ]);
    run.state.reviews.set(5, [
      { id: 3, state: 'COMMENTED', body: 'Looks fine.', user: { login: 'YURA' }, submitted_at: '2030-01-01T00:03:00Z' },
    ]);

    await run.sweep([app]);
    expect(run.ids()).toEqual(['poll:10:pull-request:5:2030-01-01T00:00:00Z', 'poll:10:comment:2']);

    // The review skill rewrites its verdict in place on the next pass.
    run.state.issueComments.set(5, [
      comment(2, '2030-01-01T00:02:00Z', 'yura', 'Verdict: request changes\nReviewed head: bbb', '2030-01-01T00:10:00Z'),
    ]);
    await run.sweep([app]);
    expect(run.ids().at(-1)).toBe('poll:10:comment:2:edited:2030-01-01T00:10:00Z');
    expect(run.delivered.at(-1)?.payload).toMatchObject({ action: 'edited', changes: { body: { from: '' } } });
  });

  it('reads a comment landing in the same second as the last one it delivered', async () => {
    const run = await setup();
    await run.authored(app, 5);
    run.state.open.set('acme/app', [pull(5)]);
    run.state.issueComments.set(5, [comment(1, '2030-01-01T00:01:00Z', 'alice')]);
    await run.sweep([app]);

    run.state.issueComments.set(5, [comment(1, '2030-01-01T00:01:00Z', 'alice'), comment(2, '2030-01-01T00:01:00Z', 'bob')]);
    await run.sweep([app]);
    await run.sweep([app]);

    expect(run.ids().slice(1)).toEqual(['poll:10:comment:1', 'poll:10:comment:2']);
  });

  it('replays the merge of a pull request a card has out, in its own repository only', async () => {
    const run = await setup();
    await run.workItems.update({
      orgId: 'org-1',
      id: run.work.id,
      userId: 'user-1',
      patch: {
        metadata: {
          openChangeRequests: [
            { repository: 'acme/app', number: 5 },
            { repository: 'acme/api', number: 5 },
          ],
          openPullRequestNumber: 5,
        },
      },
    });
    // Merged in acme/app; the same number is still open in acme/api.
    run.state.pulls.set(
      'acme/app#5',
      pull(5, { state: 'closed', merged: true, merged_by: { login: 'alice' } }),
    );
    run.state.open.set('acme/api', [pull(5, { html_url: 'https://github.com/acme/api/pull/5' })]);

    await expect(run.sweep([app, api])).resolves.toMatchObject({ merged: 1, closed: 0, failed: 0 });
    const closed = run.delivered.filter(event => event.payload.action === 'closed');
    expect(closed).toEqual([
      {
        event: 'pull_request',
        // The merge reconciler's id for the same outcome, so the two dedupe.
        deliveryId: 'reconcile:10:pull-request:5:merged',
        payload: expect.objectContaining({
          sender: { login: 'alice' },
          repository: { id: 10, full_name: 'acme/app' },
          pull_request: expect.objectContaining({ number: 5, merged: true }),
        }),
      },
    ]);
  });

  it('replays a close without merge, and stops following the pull request once it is closed', async () => {
    const run = await setup();
    await run.authored(app, 5);
    run.state.open.set('acme/app', [pull(5)]);
    await run.sweep([app]);
    await run.workItems.update({
      orgId: 'org-1',
      id: run.work.id,
      userId: 'user-1',
      patch: { metadata: { openChangeRequests: [{ repository: 'acme/app', number: 5 }], openPullRequestNumber: 5 } },
    });

    run.state.open.set('acme/app', []);
    run.state.pulls.set('acme/app#5', pull(5, { state: 'closed', merged: false }));
    await expect(run.sweep([app])).resolves.toMatchObject({ merged: 0, closed: 1, failed: 0 });
    expect(run.delivered.at(-1)).toMatchObject({
      deliveryId: 'reconcile:10:pull-request:5:closed',
      payload: { action: 'closed', sender: { login: 'yura' }, pull_request: { merged: false } },
    });
    expect(await run.integrations.forIntegration('github').settings.get('__github_pull_request_activity__', '10:5')).toMatchObject(
      { closed: true },
    );

    // Still closed on the next sweep: replayed with the same id, so the ingress dedupes it.
    await run.sweep([app]);
    expect(run.ids().slice(-2)).toEqual(['reconcile:10:pull-request:5:closed', 'reconcile:10:pull-request:5:closed']);
  });

  it('leaves a pull request a card has out alone while it is still open elsewhere in the list or unreadable', async () => {
    const run = await setup();
    await run.workItems.update({
      orgId: 'org-1',
      id: run.work.id,
      userId: 'user-1',
      patch: {
        metadata: {
          openChangeRequests: [
            { repository: 'acme/app', number: 5 },
            { repository: 'acme/app', number: 6 },
          ],
          openPullRequestNumber: 6,
        },
      },
    });
    // #5 is gone from the open list but GitHub cannot read it; #6 reads as reopened.
    run.state.pulls.set('acme/app#6', pull(6, { state: 'open' }));

    await expect(run.sweep([app])).resolves.toMatchObject({
      checked: 1,
      merged: 0,
      closed: 0,
      failed: 1,
      errors: [{ repository: 'acme/app', pullRequestNumber: 5, error: 'Not Found' }],
    });
    expect(run.delivered).toEqual([]);
  });

  it('keeps its place when a delivery fails, so the next sweep retries it', async () => {
    const run = await setup();
    await run.authored(app, 5);
    run.state.open.set('acme/app', [pull(5)]);
    run.state.issueComments.set(5, [comment(1, '2030-01-01T00:01:00Z', 'alice'), comment(2, '2030-01-01T00:02:00Z', 'bob')]);
    run.deliver.mockImplementationOnce(async event => {
      run.delivered.push(event);
    });
    run.deliver.mockImplementationOnce(async () => {
      throw new Error('rules ingress unavailable');
    });

    await expect(run.sweep([app])).resolves.toMatchObject({
      failed: 1,
      errors: [{ repository: 'acme/app', pullRequestNumber: 5, error: 'rules ingress unavailable' }],
    });
    expect(run.ids()).toEqual(['poll:10:pull-request:5:2030-01-01T00:00:00Z']);

    await run.sweep([app]);
    expect(run.ids().slice(1)).toEqual(['poll:10:comment:1', 'poll:10:comment:2']);
  });

  it('sweeps the other repositories when one cannot be read', async () => {
    const run = await setup();
    await run.authored(api, 8);
    run.state.failOpen.add('acme/app');
    run.state.open.set('acme/api', [pull(8)]);

    await expect(run.sweep([app, api])).resolves.toMatchObject({
      repositories: 2,
      failed: 1,
      errors: [{ repository: 'acme/app', error: 'acme/app is unreachable' }],
    });
    expect(run.ids()).toEqual(['poll:11:pull-request:8:2030-01-01T00:00:00Z']);
  });

  it('ignores provenance another project recorded for the same pull request', async () => {
    const run = await setup();
    const other = await run.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Other' } });
    await run.integrations.forIntegration('github').subscriptions.create({
      orgId: 'org-1',
      targetKey: 'factory-pr-provenance:10:5',
      threadId: 'thread-2',
      status: 'active',
      data: { kind: 'factory-pr-provenance', factoryProjectId: other.id, workItemId: 'elsewhere' },
    });
    run.state.open.set('acme/app', [pull(5)]);

    await run.sweep([app]);
    expect(run.delivered).toEqual([]);
  });
});
