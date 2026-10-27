import { describe, expect, it, vi } from 'vitest';

import { createMastraHarness, FactoryStartCoordinator } from '@factory/harness-mastra';
import { GithubRules, resolveGithubRules } from '@factory/integration-github';
import type { GithubIntegration } from '@factory/integration-github';
import { bugBoard } from '@factory/pipelines';
import { createBoardRegistry, createFactoryStorageForTests, FactoryDecisionDispatcher, FactoryTransitionService } from '@factory/testing';

/**
 * The Bug board end to end through the runtime: a `bug`-labelled issue routes to the board, a
 * person starts triage, the agents classify and plan, the plan gate holds the reproduction test
 * for a person, the tester's recorded test opens the fix, and the stock GitHub rules carry the
 * card through its pull request to Done.
 */
async function setup() {
  const seeded = await createFactoryStorageForTests();
  const workItems = seeded.workItems;
  const sourceControl = seeded.sourceControl.forIntegration('github');
  const integrationStorage = seeded.integrations.forIntegration<
    Record<string, unknown>,
    Record<string, unknown>,
    { kind: 'factory-pr-provenance'; factoryProjectId: string; workItemId: string }
  >('github');
  const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Bugs' } });
  const installation = await sourceControl.installations.upsert({
    orgId: 'org-1',
    connectedByUserId: 'user-1',
    externalId: '7',
  });
  const repository = await sourceControl.repositories.upsert({
    orgId: 'org-1',
    input: { installationId: installation.id, externalId: '10', slug: 'acme/repo', defaultBranch: 'main' },
  });
  const connection = await sourceControl.connections.create({
    orgId: 'org-1',
    factoryProjectId: project.id,
    installationId: installation.id,
    createdByUserId: 'user-1',
  });
  const projectRepository = await sourceControl.projectRepositories.link({
    orgId: 'org-1',
    connectionId: connection.id,
    repositoryId: repository.id,
    createdByUserId: 'user-1',
    sandboxProvider: 'local',
    sandboxWorkdir: '/workspace',
  });
  // Settings › Intake: issues labelled `bug` go to the Bug board.
  await seeded.intake.setLabelRoute({
    orgId: 'org-1',
    factoryProjectId: project.id,
    integrationId: 'github',
    label: 'bug',
    board: 'bug',
    userId: 'user-1',
  });
  const github = {
    rules: resolveGithubRules(),
    slug: 'factory-app',
    getRepositoryCollaboratorPermission: vi.fn().mockResolvedValue('write'),
  } as unknown as GithubIntegration;
  const boards = createBoardRegistry({ boards: [bugBoard] });
  const configVersion = 'bug-runtime-v1';
  const transitionService = new FactoryTransitionService({ storage: workItems, boards, configVersion });
  const rules = new GithubRules({
    github,
    sourceControl,
    integrationStorage,
    projects: seeded.projects,
    storage: workItems,
    boards,
    configVersion,
    intake: seeded.intake,
  });
  return { workItems, sourceControl, integrationStorage, project, projectRepository, boards, transitionService, rules };
}

function issueOpened() {
  return {
    event: 'issues',
    deliveryId: 'bug-issue-opened',
    payload: {
      action: 'opened',
      installation: { id: 7 },
      repository: { id: 10, full_name: 'acme/repo' },
      sender: { login: 'maintainer' },
      issue: {
        number: 42,
        title: 'Saving a profile drops the phone number',
        html_url: 'https://github.com/acme/repo/issues/42',
        created_at: '2030-01-01T00:00:00Z',
        labels: [{ name: 'Bug' }],
      },
    },
  };
}

function pullRequest(action: 'opened' | 'closed', deliveryId: string, merged = false) {
  return {
    event: 'pull_request',
    deliveryId,
    payload: {
      action,
      installation: { id: 7 },
      repository: { id: 10, full_name: 'acme/repo' },
      sender: { login: 'maintainer' },
      pull_request: {
        number: 17,
        title: 'Keep the phone number when saving a profile',
        html_url: 'https://github.com/acme/repo/pull/17',
        created_at: '2030-01-02T00:00:00Z',
        state: merged ? 'closed' : 'open',
        merged,
        head: { ref: 'factory/issue-42', sha: 'a'.repeat(40) },
        base: { ref: 'main' },
      },
    },
  };
}

describe('Bug board runtime', () => {
  it('carries a bug-labelled issue through triage, the plan gate, the reproduction test, the fix, its pull request, and the merge', async () => {
    const { workItems, sourceControl, integrationStorage, project, projectRepository, boards, transitionService, rules } =
      await setup();
    const delivered: string[] = [];
    let threadId: string | undefined;
    const agentEndListeners = new Set<(event: { type: string }) => void>();
    const makeSession = (key: string) => ({
      thread: {
        list: vi.fn(async () => []),
        create: vi.fn(async () => {
          threadId = 'thread-issue-42';
          return { id: threadId };
        }),
        switch: vi.fn(async ({ threadId: next }: { threadId: string }) => {
          threadId = next;
        }),
        getSetting: vi.fn(async () => undefined),
        setSetting: vi.fn(async () => {}),
        rename: vi.fn(async () => {}),
        requireId: vi.fn(() => {
          if (!threadId) throw new Error('Thread was not persisted before binding creation.');
          return threadId;
        }),
        listActiveMessages: vi.fn(async () => delivered.map((_, index) => ({ id: `signal-${index}` }))),
      },
      getWorkspace: () => ({
        skills: {
          maybeRefresh: vi.fn(async () => {}),
          get: vi.fn(async (name: string) => ({ name, instructions: `Run ${name}.` })),
        },
      }),
      sendSignal: vi.fn((input: { contents: string }) => {
        delivered.push(input.contents);
        for (const listener of agentEndListeners) listener({ type: 'agent_end' });
        return { accepted: Promise.resolve({ accepted: true, action: 'wake' }) };
      }),
      subscribe: vi.fn((listener: (event: { type: string }) => void) => {
        agentEndListeners.add(listener);
        return () => agentEndListeners.delete(listener);
      }),
      state: { get: vi.fn(() => ({ factoryProjectId: project.id })), set: vi.fn(async () => {}) },
      mode: { get: vi.fn(() => 'build'), resolve: vi.fn(() => ({})) },
      model: { get: vi.fn(() => 'openai/gpt-5.6-sol') },
      identity: { getId: vi.fn(() => key), getOwnerId: vi.fn(() => 'user-1') },
      permissions: { setForTool: vi.fn(async () => {}) },
      sendMessage: vi.fn(async () => {}),
      sendNotificationSignal: vi.fn(async () => ({ persisted: Promise.resolve(), accepted: Promise.resolve() })),
    });
    const sessions = new Map<string, ReturnType<typeof makeSession>>();
    const controller = {
      queryThreadById: vi.fn(async () => null),
      createSession: vi.fn(async ({ id, threadId: initial }: { id: string; threadId?: string }) => {
        threadId ??= initial;
        const session = makeSession(id);
        sessions.set(id, session);
        return session;
      }),
      getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId)),
    };
    await sourceControl.sessions.create({
      sessionId: 'session-issue-42',
      projectRepositoryId: projectRepository.id,
      orgId: 'org-1',
      userId: 'user-1',
      branch: 'factory/issue-42',
      baseBranch: 'main',
    });
    const coordinator = new FactoryStartCoordinator(controller as never, workItems, transitionService, sourceControl);
    const dispatcher = new FactoryDecisionDispatcher({
      harness: createMastraHarness(controller as never),
      transitionService,
      storage: workItems,
      boards,
      isAutoRunEnabled: async () => true,
      ownerId: 'worker-1',
      primeCredentials: async () => {},
      prepareBinding: async ({ record, item, role }) => {
        await coordinator.prepare({
          orgId: record.orgId,
          userId: 'user-1',
          factoryProjectId: record.factoryProjectId,
          sessionId: 'session-issue-42',
          threadTitle: `Issue: ${item.title}`,
          kickoffKey: record.idempotencyKey,
          workItem: { id: item.id, role, input: item },
        });
      },
    });
    let tick = 0;
    const drain = async () => {
      for (let round = 0; round < 3; round += 1) {
        await dispatcher.runOnce(new Date(Date.UTC(2030, 0, 1, 0, 0, tick++)));
      }
    };
    const card = async () => {
      const [found] = (await workItems.list({ orgId: 'org-1', factoryProjectId: project.id })).filter(
        item => item.board === 'bug',
      );
      if (!found) throw new Error('Missing Bug card.');
      return found;
    };
    let moves = 0;
    const move = async (
      stage: string,
      actor: { type: 'human'; id: string } | { type: 'agent'; bindingId: string; role: string },
      options: { triageType?: 'bug' | 'feature request' } = {},
    ) => {
      const current = await card();
      moves += 1;
      return transitionService.transition({
        orgId: 'org-1',
        factoryProjectId: project.id,
        workItemId: current.id,
        board: 'bug',
        stage,
        expectedRevision: current.revision,
        actor,
        ingress:
          actor.type === 'human'
            ? { type: 'human', identity: `human-${stage}-${moves}` }
            : { type: 'agent', identity: `${actor.bindingId}:${stage}-${moves}` },
        cause: `move to ${stage}`,
        ...options,
      });
    };

    // A `bug`-labelled issue lands on Bug › Intake (labels match case-insensitively) and starts nothing.
    await expect(rules.ingest(issueOpened())).resolves.toEqual({ status: 'committed' });
    await drain();
    expect(await card()).toMatchObject({ board: 'bug', stages: ['intake'], triageType: null });
    expect(delivered).toEqual([]);

    // A person starts triage: the triage seat runs bug-triage.
    await expect(move('triage', { type: 'human', id: 'user-1' })).resolves.toMatchObject({ status: 'accepted' });
    await drain();
    expect(delivered.at(-1)).toContain('<skill name="bug-triage">');

    // Triage must classify; a non-bug cannot be carried on to Planning on this board.
    const triage = { type: 'agent' as const, bindingId: 'binding-triage', role: 'triage' };
    await expect(move('planning', triage)).resolves.toMatchObject({ status: 'rejected', code: 'invalid_transition' });
    await expect(move('planning', triage, { triageType: 'feature request' })).resolves.toMatchObject({
      status: 'rejected',
      code: 'invalid_transition',
      reason: expect.stringContaining('Cards cannot change boards'),
    });
    await expect(move('planning', triage, { triageType: 'bug' })).resolves.toMatchObject({ status: 'accepted' });
    await drain();
    expect(await card()).toMatchObject({ stages: ['planning'], triageType: 'bug' });
    expect(delivered.at(-1)).toContain('<skill name="bug-plan">');

    // The plan gate: without auto-approved plans the planner cannot start the reproduction test
    // itself, nor skip it straight to the fix.
    const plan = { type: 'agent' as const, bindingId: 'binding-plan', role: 'plan' };
    await expect(move('tests', plan)).resolves.toMatchObject({ status: 'rejected', code: 'approval_required' });
    await expect(move('execute', plan)).resolves.toMatchObject({ status: 'rejected', code: 'invalid_transition' });
    expect(await card()).toMatchObject({ stages: ['planning'] });
    await expect(move('tests', { type: 'human', id: 'user-1' })).resolves.toMatchObject({ status: 'accepted' });
    await drain();
    expect(await card()).toMatchObject({ stages: ['tests'] });
    expect(delivered.at(-1)).toContain('<skill name="bug-test">');

    // The tester's seat cannot hand over to the fix until the failing test is recorded on the card
    // (factory_record_reproduction_test writes these keys after checking the commit in the checkout).
    const tester = { type: 'agent' as const, bindingId: 'binding-tester', role: 'tester' };
    await expect(move('execute', tester)).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('No reproduction test is recorded'),
    });
    const testing = await card();
    await workItems.update({
      orgId: 'org-1',
      id: testing.id,
      userId: 'agent:binding-tester',
      expectedRevision: testing.revision,
      patch: {
        metadata: {
          ...(testing.metadata ?? {}),
          bugReproTestSha: 'c'.repeat(40),
          bugReproTestPaths: ['apps/mobile/test/profile_save_test.dart'],
        },
      },
    });
    await expect(move('execute', tester)).resolves.toMatchObject({ status: 'accepted' });
    await drain();
    const building = await card();
    expect(building).toMatchObject({ stages: ['execute'] });
    expect(delivered.at(-1)).toContain('<skill name="bug-build">');
    expect(delivered.at(-1)).toContain('"apps/mobile/test/profile_save_test.dart"');

    // The fix seat leaves through Review (where its tool checks the test files), then opens the
    // pull request. Provenance binds it to the Bug card, and it gets its own Review card.
    const work = { type: 'agent' as const, bindingId: 'binding-work', role: 'work' };
    await expect(move('review', work)).resolves.toMatchObject({ status: 'accepted' });
    await drain();
    await integrationStorage.subscriptions.create({
      orgId: 'org-1',
      targetKey: 'factory-pr-provenance:10:17',
      threadId: 'thread-issue-42',
      status: 'active',
      data: { kind: 'factory-pr-provenance', factoryProjectId: project.id, workItemId: building.id },
    });
    await rules.ingest(pullRequest('opened', 'bug-pr-opened'));
    await drain();
    expect(await card()).toMatchObject({ stages: ['review'], metadata: expect.objectContaining({ openPullRequestNumber: 17 }) });
    const reviewCard = (await workItems.list({ orgId: 'org-1', factoryProjectId: project.id })).find(
      item => item.board === 'review',
    );
    expect(reviewCard).toMatchObject({ parentWorkItemId: building.id, stages: ['intake'] });

    // With the pull request open, an agent cannot close the bug; the merge does.
    await expect(move('done', work)).resolves.toMatchObject({ status: 'rejected', code: 'invalid_transition' });
    await rules.ingest(pullRequest('closed', 'bug-pr-merged', true));
    await drain();
    expect(await card()).toMatchObject({ board: 'bug', stages: ['done'] });
    expect(await workItems.get({ orgId: 'org-1', id: reviewCard!.id })).toMatchObject({
      board: 'review',
      stages: ['done'],
    });
    expect(
      (await workItems.listDeferredDecisions('org-1', project.id))
        .filter(record => record.workItemId === building.id && record.decision.type === 'transition')
        .map(record => record.decision),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ board: 'bug', stage: 'done' })]));
  }, 60_000);
});
