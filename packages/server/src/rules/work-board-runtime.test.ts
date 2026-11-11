import { autoStartingBoards } from '@factory/pipelines/testing';
import { describe, expect, it, vi } from 'vitest';

import { createMastraHarness, FactoryStartCoordinator } from '@factory/harness-mastra';
import { GithubRules, resolveGithubRules } from '@factory/integration-github';
import type { GithubIntegration } from '@factory/integration-github';
import { createBoardRegistry, createFactoryStorageForTests, FactoryDecisionDispatcher, FactoryTransitionService } from '@factory/testing';

/**
 * A bug on the Work board end to end through the runtime: an issue lands in Intake, a person
 * starts triage, the agents classify and plan, the plan gate holds Building for a person, and the
 * stock GitHub rules carry the card through its pull request to Done.
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
  const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Work' } });
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
  const github = {
    rules: resolveGithubRules(),
    slug: 'factory-app',
    getRepositoryCollaboratorPermission: vi.fn().mockResolvedValue('write'),
  } as unknown as GithubIntegration;
  const boards = createBoardRegistry();
  const configVersion = 'work-runtime-v1';
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
    deliveryId: 'work-issue-opened',
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

describe('Work board runtime: a bug', () => {
  it('carries a bug issue through triage, the plan gate, the fix, its pull request, and the merge', async () => {
    const { workItems, sourceControl, integrationStorage, project, projectRepository, boards, transitionService, rules } =
      await setup();
    const delivered: string[] = [];
    const skills: Array<string | undefined> = [];
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
      sendSignal: vi.fn((input: { tagName: string; attributes?: { name: string }; contents: string }) => {
        // Factory skills start as typed skill signals, like every Factory skill kickoff.
        if (input.tagName === 'skill') skills.push(input.attributes?.name);
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
      boards: autoStartingBoards(boards),
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
      // The bug's own card: a pull request's card sits on Work too.
      const [found] = (await workItems.list({ orgId: 'org-1', factoryProjectId: project.id })).filter(
        item => item.board === 'work' && item.externalSource?.type !== 'pull-request',
      );
      if (!found) throw new Error('Missing Work card.');
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
        board: 'work',
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

    // An issue lands on Work › Intake and starts nothing.
    await expect(rules.ingest(issueOpened())).resolves.toEqual({ status: 'committed' });
    await drain();
    expect(await card()).toMatchObject({ board: 'work', stages: ['intake'], triageType: null });
    expect(delivered).toEqual([]);

    // A person starts triage: the triage seat runs factory-triage.
    await expect(move('triage', { type: 'human', id: 'user-1' })).resolves.toMatchObject({ status: 'accepted' });
    await drain();
    expect(skills.at(-1)).toBe('factory-triage');
    expect(delivered.at(-1)).toContain('Run factory-triage.');

    // Triage records no classification (upstream #29039): it moves a confirmed bug to Planning
    // itself and sends anything else back to Intake, where a person decides.
    const triage = { type: 'agent' as const, bindingId: 'binding-triage', role: 'triage' };
    await expect(move('planning', triage)).resolves.toMatchObject({ status: 'accepted' });
    await drain();
    expect(await card()).toMatchObject({ stages: ['planning'], triageType: null });
    expect(skills.at(-1)).toBe('factory-plan');
    expect(delivered.at(-1)).toContain('Run factory-plan.');

    // The plan gate: without auto-approved plans the planner cannot start Building itself.
    const plan = { type: 'agent' as const, bindingId: 'binding-plan', role: 'plan' };
    await expect(move('execute', plan)).resolves.toMatchObject({ status: 'rejected', code: 'approval_required' });
    expect(await card()).toMatchObject({ stages: ['planning'] });
    await expect(move('execute', { type: 'human', id: 'user-1' })).resolves.toMatchObject({ status: 'accepted' });
    await drain();
    const building = await card();
    expect(building).toMatchObject({ stages: ['execute'] });

    // Work has no self-review phase (upstream #29724): the builder opens the pull request from
    // Building. Provenance binds it to the Work card, the pull request joins that card as one more
    // source (upstream #29346), and its opening moves the card to Review (`pr-review`).
    await integrationStorage.subscriptions.create({
      orgId: 'org-1',
      targetKey: 'factory-pr-provenance:10:17',
      threadId: 'thread-issue-42',
      status: 'active',
      data: { kind: 'factory-pr-provenance', factoryProjectId: project.id, workItemId: building.id },
    });
    await rules.ingest(pullRequest('opened', 'work-pr-opened'));
    await drain();
    expect(await card()).toMatchObject({ stages: ['pr-review'], metadata: expect.objectContaining({ openPullRequestNumber: 17 }) });
    const cards = await workItems.list({ orgId: 'org-1', factoryProjectId: project.id });
    expect(cards.map(item => item.id)).toEqual([building.id]);
    expect((await card())!.workItem.sources.map(source => source.sourceType)).toEqual(['issue', 'pull-request']);

    // The merge closes the card (the board no longer refuses an agent's Done; the build prompt tells it when).
    await rules.ingest(pullRequest('closed', 'work-pr-merged', true));
    await drain();
    expect(await card()).toMatchObject({ board: 'work', stages: ['done'] });
    expect((await card())!.workItem.sources.find(source => source.sourceType === 'pull-request')).toMatchObject({
      state: 'merged',
    });
    expect(
      (await workItems.listDeferredDecisions('org-1', project.id))
        .filter(record => record.workItemId === building.id && record.decision.type === 'transition')
        .map(record => record.decision),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ board: 'work', stage: 'done' })]));
  }, 60_000);
});
