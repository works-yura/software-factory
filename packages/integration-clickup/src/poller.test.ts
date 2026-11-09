import { describe, expect, it, vi } from 'vitest';

import { createBoardRegistry, defineBoard } from '@factory/core';
import type { IntakeRoute, RuleGroup } from '@factory/core';

import type { ClickUpTask } from './api.ts';
import { createClickUpPoller } from './poller.ts';

const START = new Date('2026-10-28T10:00:00.000Z');

function task(overrides: Partial<ClickUpTask> = {}): ClickUpTask {
  return {
    id: 'abc',
    name: 'Crash on login',
    description: 'Steps: open app',
    url: 'https://app.clickup.com/t/abc',
    status: { name: 'to do', type: 'open' },
    tags: ['bug'],
    creator: 'ann',
    assignees: [],
    priority: null,
    listId: 'L1',
    createdAt: '2026-10-28T11:00:00.000Z',
    updatedAt: '2026-10-28T11:00:00.000Z',
    ...overrides,
  };
}

interface SetupOptions {
  tasks: ClickUpTask[];
  existing?: unknown;
  rules?: Record<string, { action: string; phase?: string }>;
  enabled?: boolean;
  binding?: { board: string | null } | null;
  closure?: boolean;
  /** Intake routes of the project; set, the poller applies them ahead of the List's board. */
  intakeRoutes?: IntakeRoute[];
}

/** The project's boards an intake route can name: Work and a stored Docs board. */
const projectRegistry = createBoardRegistry({
  boards: [
    defineBoard({
      id: 'work',
      title: 'Work',
      initialPhase: 'intake',
      phases: {
        intake: { title: 'Intake', kind: 'resting', outcomes: { triage: 'triage' } },
        triage: { title: 'Triage', kind: 'working', role: 'triage' },
      },
    }),
    defineBoard({
      id: 'docs',
      title: 'Docs',
      initialPhase: 'inbox',
      phases: {
        inbox: { title: 'Inbox', kind: 'resting', outcomes: { drafting: 'drafting' } },
        drafting: { title: 'Drafting', kind: 'working', role: 'writer' },
      },
    }),
  ],
});
const tagged = (tag: string): RuleGroup => ({
  operator: 'AND',
  conditions: [{ field: 'item.labels', operator: 'contains', value: tag }],
});

function setup(options: SetupOptions) {
  const listTasks = vi.fn(async (_input: unknown) => options.tasks);
  const commitRuleEvaluation = vi.fn(async (_input: unknown) => ({ status: 'committed', result: {} }));
  const update = vi.fn(async (_input: unknown) => null);
  const getByProjectSource = vi.fn(async (_input: unknown) => options.existing ?? null);
  const phases = { intake: {}, triage: {}, done: {} };
  const board = {
    title: 'Bug',
    initialPhase: 'intake',
    phases,
    isTerminal: (stage: string) => stage === 'done',
    ...(options.closure === false ? {} : { sourceClosed: { completed: 'done', canceled: 'done' } }),
  };
  const binding = options.binding === undefined ? { board: 'work' } : options.binding;
  const poll = createClickUpPoller({
    client: { listTasks } as never,
    intake: {
      getConfig: async () => ({ clickup: { enabled: options.enabled ?? true, sourceIds: ['L1'] } }),
      listBindings: async () => (binding ? [{ integrationId: 'clickup', sourceId: 'L1', factoryProjectId: 'proj', ...binding }] : []),
    } as never,
    rules: async () => ({ L1: { statuses: options.rules ?? { 'to do': { action: 'phase', phase: 'intake' } } } }) as never,
    projects: { listAll: async () => [{ id: 'proj', orgId: 'org' }] as never },
    workItems: { getByProjectSource, commitRuleEvaluation, update } as never,
    boards: { get: () => board } as never,
    ...(options.intakeRoutes
      ? {
          intakeRoutes: { listIntakeRoutes: async () => options.intakeRoutes! },
          projectBoards: { load: async () => projectRegistry },
        }
      : {}),
    configVersion: 'v',
    now: () => START,
  });
  return { poll, listTasks, commitRuleEvaluation, update, getByProjectSource };
}

const decisionOf = (mock: { mock: { calls: unknown[][] } }) => (mock.mock.calls[0]![0] as any).decisions[0];

describe('createClickUpPoller', () => {
  it("files a new task on the List's board, in the phase its status maps to", async () => {
    const { poll, commitRuleEvaluation } = setup({ tasks: [task()], binding: { board: 'bug' } });
    expect(await poll()).toMatchObject({ checked: 1, updated: 1, failed: 0 });
    const input = commitRuleEvaluation.mock.calls[0]![0] as any;
    expect(input.ingress.identity).toBe('clickup:task:abc:created');
    expect(input.workItemId).toBeNull();
    expect(input.decisions[0]).toMatchObject({
      type: 'upsertLinkedWorkItem',
      board: 'bug',
      source: 'clickup-task',
      sourceKey: 'abc',
      stage: 'intake',
    });
    expect(input.decisions[0].metadata).toMatchObject({ labels: ['bug'], description: 'Steps: open app' });
  });

  it("files a task whose status imports it in the first phase of the List's board, even a new one", async () => {
    const { poll, commitRuleEvaluation } = setup({ tasks: [task()], rules: { 'to do': { action: 'import' } } });
    await poll();
    expect(decisionOf(commitRuleEvaluation)).toMatchObject({ board: 'work', stage: 'intake' });
  });

  it('ignores a List that is not routed, disabled, or has no board', async () => {
    for (const options of [{ binding: null }, { enabled: false }, { binding: { board: null } }]) {
      const { poll, listTasks, commitRuleEvaluation } = setup({ tasks: [task()], ...options });
      await poll();
      expect(commitRuleEvaluation).not.toHaveBeenCalled();
      expect(listTasks).not.toHaveBeenCalled();
    }
  });

  it('files a task in the phase its status maps to, but only a task created after start runs ahead', async () => {
    const rules = { 'to do': { action: 'phase', phase: 'triage' } };
    const fresh = setup({ rules, tasks: [task()] });
    await fresh.poll();
    expect(decisionOf(fresh.commitRuleEvaluation).stage).toBe('triage');

    const old = setup({ rules, tasks: [task({ createdAt: '2026-10-27T00:00:00.000Z' })] });
    await old.poll();
    expect(decisionOf(old.commitRuleEvaluation).stage).toBe('intake');
  });

  it('ignores tasks whose status has no rule or is ignored', async () => {
    for (const rules of [{}, { 'to do': { action: 'ignore' } }, { backlog: { action: 'phase', phase: 'intake' } }]) {
      const { poll, commitRuleEvaluation } = setup({ rules, tasks: [task()] });
      expect(await poll()).toMatchObject({ failed: 0 });
      expect(commitRuleEvaluation).not.toHaveBeenCalled();
    }
  });

  it('matches status names without regard to case', async () => {
    const { poll, commitRuleEvaluation } = setup({
      rules: { 'dev fixed': { action: 'phase', phase: 'intake' } },
      tasks: [task({ status: { name: 'DEV FIXED', type: 'custom' } })],
    });
    await poll();
    expect(commitRuleEvaluation).toHaveBeenCalledTimes(1);
  });

  it('fails visibly when a rule names a phase the board does not have', async () => {
    const { poll, commitRuleEvaluation } = setup({
      rules: { 'to do': { action: 'phase', phase: 'nope' } },
      tasks: [task()],
    });
    const summary = await poll();
    expect(summary.failed).toBe(1);
    expect(summary.errors[0]!.error).toContain('no phase "nope"');
    expect(commitRuleEvaluation).not.toHaveBeenCalled();
  });

  it('closes the card of a task whose status is mapped to close', async () => {
    const { poll, commitRuleEvaluation } = setup({
      rules: { 'dev fixed': { action: 'close' } },
      tasks: [task({ status: { name: 'DEV FIXED', type: 'custom' } })],
      existing: { id: 'card', board: 'bug', stages: ['triage'], revision: 2, externalSource: null, metadata: {} },
    });
    expect(await poll()).toMatchObject({ closed: 1 });
    expect(decisionOf(commitRuleEvaluation)).toMatchObject({ type: 'transition', stage: 'done' });
  });

  it('moves a card into the phase of its new status while it is still where sync put it', async () => {
    const rules = { backlog: { action: 'phase', phase: 'intake' }, 'to do': { action: 'phase', phase: 'triage' } };
    const card = (stages: string[]) => ({
      id: 'card',
      board: 'bug',
      stages,
      revision: 3,
      externalSource: null,
      metadata: {},
      workItem: { metadata: { state: 'BACKLOG' } },
    });
    const moved = setup({ rules, tasks: [task()], existing: card(['intake']) });
    expect(await moved.poll()).toMatchObject({ updated: 1 });
    expect(decisionOf(moved.commitRuleEvaluation)).toMatchObject({ type: 'transition', board: 'bug', stage: 'triage' });

    const owned = setup({ rules, tasks: [task()], existing: card(['execute']) });
    await owned.poll();
    expect(owned.commitRuleEvaluation).not.toHaveBeenCalled();
  });

  it('refreshes a known card instead of creating a second one', async () => {
    const { poll, commitRuleEvaluation, update } = setup({
      tasks: [task({ tags: ['bug', 'urgent'] })],
      existing: { id: 'card', metadata: { keep: 1 }, workItem: { metadata: { labels: ['bug'] } } },
    });
    await poll();
    expect(commitRuleEvaluation).not.toHaveBeenCalled();
    expect((update.mock.calls[0]![0] as any).patch.metadata).toMatchObject({ keep: 1, labels: ['bug', 'urgent'] });
  });

  it('moves a card where the board says when its task is closed', async () => {
    const closed = task({ status: { name: 'complete', type: 'closed' } });
    const { poll, commitRuleEvaluation } = setup({
      tasks: [closed],
      existing: { id: 'card', board: 'bug', stages: ['execute'], revision: 4, externalSource: null, metadata: {} },
    });
    expect(await poll()).toMatchObject({ closed: 1, failed: 0 });
    const input = commitRuleEvaluation.mock.calls[0]![0] as any;
    expect(input.workItemId).toBe('card');
    expect(input.expectedRevision).toBe(4);
    expect(input.decisions[0]).toMatchObject({ type: 'transition', board: 'bug', stage: 'done' });
  });

  it('does not import a task that was already closed', async () => {
    const { poll, commitRuleEvaluation } = setup({ tasks: [task({ status: { name: 'done', type: 'closed' } })] });
    await poll();
    expect(commitRuleEvaluation).not.toHaveBeenCalled();
  });

  it('only asks for tasks updated since the previous sweep', async () => {
    const { poll, listTasks } = setup({ tasks: [task()] });
    await poll();
    await poll();
    const calls = listTasks.mock.calls as unknown as Array<[{ updatedAfter: Date }]>;
    expect(calls[0]![0].updatedAfter.toISOString()).toBe('2026-10-21T10:00:00.000Z');
    expect(calls[1]![0].updatedAfter.toISOString()).toBe('2026-10-28T11:00:00.000Z');
  });

  describe('intake routes', () => {
    const docsRoute: IntakeRoute = {
      id: 'route-docs',
      enabled: true,
      on: ['work_item.created'],
      when: tagged('docs'),
      target: { boardKey: 'docs', phaseKey: 'drafting' },
    };

    it("files a new task where the first matching route says, ahead of the List's board, and names the route", async () => {
      const { poll, commitRuleEvaluation } = setup({
        tasks: [task({ tags: ['docs', 'bug'] })],
        binding: { board: 'bug' },
        intakeRoutes: [docsRoute],
      });
      expect(await poll()).toMatchObject({ checked: 1, updated: 1, failed: 0 });
      expect(decisionOf(commitRuleEvaluation)).toMatchObject({
        board: 'docs',
        stage: 'drafting',
        metadata: { intakeRouteId: 'route-docs', labels: ['docs', 'bug'] },
      });
    });

    it("holds a task that existed before start at the route board's first phase", async () => {
      const { poll, commitRuleEvaluation } = setup({
        tasks: [task({ tags: ['docs'], createdAt: '2026-10-27T09:00:00.000Z' })],
        intakeRoutes: [docsRoute],
      });
      await poll();
      expect(decisionOf(commitRuleEvaluation)).toMatchObject({ board: 'docs', stage: 'inbox' });
    });

    it('skips a List without a board even when a route would take its task, as upstream skips an unboarded source', async () => {
      const { poll, listTasks, commitRuleEvaluation } = setup({
        tasks: [task({ tags: ['docs'] })],
        binding: { board: null },
        intakeRoutes: [docsRoute],
      });
      await poll();
      expect(listTasks).not.toHaveBeenCalled();
      expect(commitRuleEvaluation).not.toHaveBeenCalled();
    });

    it("places a task no route matches on the List's board, without naming a route", async () => {
      const { poll, commitRuleEvaluation } = setup({
        tasks: [task({ tags: ['bug'] })],
        binding: { board: 'bug' },
        intakeRoutes: [docsRoute, { ...docsRoute, id: 'route-off', enabled: false, when: null }],
      });
      await poll();
      const decision = decisionOf(commitRuleEvaluation);
      expect(decision).toMatchObject({ board: 'bug', stage: 'intake' });
      expect(decision.metadata).not.toHaveProperty('intakeRouteId');
    });

    it("leaves a task out when its List's status rules do not import it, whatever the routes say", async () => {
      const { poll, commitRuleEvaluation } = setup({
        tasks: [task({ tags: ['docs'], status: { name: 'backlog', type: 'open' } })],
        intakeRoutes: [docsRoute],
      });
      await poll();
      expect(commitRuleEvaluation).not.toHaveBeenCalled();
    });

    it('routes on ClickUp facts: the integration and the untrusted author', async () => {
      const { poll, commitRuleEvaluation } = setup({
        tasks: [task({ tags: [] })],
        intakeRoutes: [
          {
            id: 'route-clickup',
            enabled: true,
            on: ['work_item.created'],
            when: {
              operator: 'AND',
              conditions: [
                { field: 'source.integration', operator: 'equals', value: 'clickup' },
                { field: 'author.trusted', operator: 'equals', value: false },
              ],
            },
            target: { boardKey: 'work', phaseKey: 'triage' },
          },
        ],
      });
      await poll();
      expect(decisionOf(commitRuleEvaluation)).toMatchObject({
        board: 'work',
        stage: 'triage',
        metadata: { intakeRouteId: 'route-clickup' },
      });
    });
  });
});
