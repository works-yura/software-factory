import { describe, expect, it, vi } from 'vitest';

import { createBoardRegistry, defineBoard } from '@factory/core';
import type { IntakeRoute, RuleGroup } from '@factory/core';

import type { ClickUpTask } from './api.ts';
import { createClickUpPoller } from './poller.ts';
import type { StatusRule } from './settings.ts';
import { statusRoute } from './status-routes.ts';

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

const workLike = (id: string, closes = true) =>
  defineBoard({
    id,
    title: id === 'bug' ? 'Bug' : 'Work',
    initialPhase: 'intake',
    phases: {
      intake: { title: 'Intake', kind: 'resting', nextPhases: ['triage', 'execute', 'done'] },
      triage: { title: 'Triage', kind: 'working', role: 'triage', nextPhases: ['execute', 'done'] },
      execute: { title: 'Execute', kind: 'working', role: 'work', nextPhases: ['done'] },
      done: { title: 'Done', kind: 'terminal' },
    },
    ...(closes ? { sourceClosed: { completed: 'done', canceled: 'done' } } : {}),
  });

/** The project's boards: Work, a Bug board a List may be routed to, and a stored Docs board. */
const registry = createBoardRegistry({
  boards: [
    workLike('work'),
    workLike('bug'),
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

interface SetupOptions {
  tasks: ClickUpTask[];
  existing?: unknown;
  /**
   * The List's status rules as they were set in Settings before routes took them over; the setup
   * turns them into routes with `statusRoute`, so each case also checks that the moved routes do
   * what the rules did.
   */
  rules?: Record<string, StatusRule>;
  /** The board the List was routed to, which its status rules moved cards on. */
  listBoard?: string;
  enabled?: boolean;
  /** False: no route names the List, so the project doesn't read it. */
  bound?: boolean;
  /** Other routes of the project, ahead of the moved status routes; a catch-all stays last. */
  intakeRoutes?: IntakeRoute[];
}

function setup(options: SetupOptions) {
  const listTasks = vi.fn(async (_input: unknown) => options.tasks);
  const commitRuleEvaluation = vi.fn(async (_input: unknown) => ({ status: 'committed', result: {} }));
  const update = vi.fn(async (_input: unknown) => null);
  const getByProjectSource = vi.fn(async (_input: unknown) => options.existing ?? null);
  const listBoard = registry.get(options.listBoard ?? 'work')!;
  const rules = options.rules ?? { 'to do': { action: 'phase', phase: 'intake' } };
  const statusRoutes =
    options.bound === false
      ? []
      : Object.entries(rules).flatMap(([status, rule], index): IntakeRoute[] => {
          const route = statusRoute('L1', status, rule, listBoard);
          return route ? [{ id: `status-${index}`, enabled: true, ...route }] : [];
        });
  const others = options.intakeRoutes ?? [];
  const catchAll = others.filter(route => route.when === null);
  const routes = [...others.filter(route => route.when !== null), ...statusRoutes, ...catchAll];
  const poll = createClickUpPoller({
    client: { listTasks } as never,
    intake: { getConfig: async () => ({ clickup: { enabled: options.enabled ?? true } }) } as never,
    projects: { listAll: async () => [{ id: 'proj', orgId: 'org' }] as never },
    workItems: { getByProjectSource, commitRuleEvaluation, update } as never,
    intakeRoutes: { listIntakeRoutes: async () => routes },
    projectBoards: { load: async () => registry },
    configVersion: 'v',
    now: () => START,
  });
  return { poll, listTasks, commitRuleEvaluation, update, getByProjectSource };
}

const decisionOf = (mock: { mock: { calls: unknown[][] } }) => (mock.mock.calls[0]![0] as any).decisions[0];

describe('createClickUpPoller', () => {
  it("files a new task on the List's board, in the phase its status maps to", async () => {
    const { poll, commitRuleEvaluation } = setup({ tasks: [task()], listBoard: 'bug' });
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
    expect(input.decisions[0].metadata).toMatchObject({ labels: ['bug'], description: 'Steps: open app', listId: 'L1' });
  });

  it("files a task whose status imports it in the first phase of the List's board, even a new one", async () => {
    const { poll, commitRuleEvaluation } = setup({ tasks: [task()], rules: { 'to do': { action: 'import' } } });
    await poll();
    expect(decisionOf(commitRuleEvaluation)).toMatchObject({ board: 'work', stage: 'intake' });
  });

  it('ignores a List that is not routed to a Factory, or disabled', async () => {
    for (const options of [{ bound: false }, { enabled: false }]) {
      const { poll, listTasks, commitRuleEvaluation } = setup({ tasks: [task()], ...options });
      await poll();
      expect(commitRuleEvaluation).not.toHaveBeenCalled();
      expect(listTasks).not.toHaveBeenCalled();
    }
  });

  it('files a task in the phase its status maps to, but only a task created after start runs ahead', async () => {
    const rules: Record<string, StatusRule> = { 'to do': { action: 'phase', phase: 'triage' } };
    const fresh = setup({ rules, tasks: [task()] });
    await fresh.poll();
    expect(decisionOf(fresh.commitRuleEvaluation).stage).toBe('triage');

    const old = setup({ rules, tasks: [task({ createdAt: '2026-10-27T00:00:00.000Z' })] });
    await old.poll();
    expect(decisionOf(old.commitRuleEvaluation).stage).toBe('intake');
  });

  it('ignores tasks whose status has no route or is ignored', async () => {
    const cases: Record<string, StatusRule>[] = [
      {},
      { 'to do': { action: 'ignore' } },
      { backlog: { action: 'phase', phase: 'intake' } },
      // A close status never imports a new task: there is nothing to finish yet.
      { 'to do': { action: 'close' } },
    ];
    for (const rules of cases) {
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

  it('fails visibly when no route can take a task its List imports', async () => {
    const { poll, commitRuleEvaluation } = setup({
      rules: {},
      tasks: [task()],
      intakeRoutes: [
        {
          id: 'route-gone',
          enabled: true,
          on: ['work_item.created'],
          when: { operator: 'AND', conditions: [{ field: 'source.list', operator: 'equals', value: 'L1' }] },
          target: { boardKey: 'retired', phaseKey: null },
        },
      ],
    });
    const summary = await poll();
    expect(summary.failed).toBe(1);
    expect(summary.errors[0]!.error).toContain('No intake route can take ClickUp task abc');
    expect(commitRuleEvaluation).not.toHaveBeenCalled();
  });

  it('closes the card of a task whose status is mapped to close', async () => {
    const { poll, commitRuleEvaluation } = setup({
      rules: { 'dev fixed': { action: 'close' } },
      listBoard: 'bug',
      tasks: [task({ status: { name: 'DEV FIXED', type: 'custom' } })],
      existing: { id: 'card', board: 'bug', stages: ['triage'], revision: 2, externalSource: null, metadata: {}, workItem: { metadata: {} } },
    });
    expect(await poll()).toMatchObject({ updated: 1 });
    // The dispatcher applies the route (it finishes the card on Bug › Done), as for any provider event.
    expect(decisionOf(commitRuleEvaluation)).toMatchObject({ type: 'routeEvent', event: { type: 'work_item.state_changed' } });
  });

  it('moves a card into the phase of its new status while it is still where sync put it', async () => {
    const rules: Record<string, StatusRule> = {
      backlog: { action: 'phase', phase: 'intake' },
      'to do': { action: 'phase', phase: 'triage' },
    };
    const card = (stages: string[]) => ({
      id: 'card',
      board: 'bug',
      stages,
      revision: 3,
      externalSource: null,
      metadata: {},
      workItem: { metadata: { state: 'BACKLOG' } },
    });
    const moved = setup({ rules, listBoard: 'bug', tasks: [task()], existing: card(['intake']) });
    expect(await moved.poll()).toMatchObject({ updated: 1 });
    expect(decisionOf(moved.commitRuleEvaluation)).toMatchObject({
      type: 'routeEvent',
      event: { type: 'work_item.state_changed' },
    });

    const owned = setup({ rules, listBoard: 'bug', tasks: [task()], existing: card(['execute']) });
    await owned.poll();
    expect(owned.commitRuleEvaluation).not.toHaveBeenCalled();
  });

  it('does not move a card on a status its List only imports', async () => {
    const { poll, commitRuleEvaluation } = setup({
      rules: { 'to do': { action: 'import' } },
      tasks: [task()],
      existing: {
        id: 'card',
        board: 'work',
        stages: ['triage'],
        revision: 3,
        externalSource: null,
        metadata: {},
        workItem: { metadata: { state: 'backlog' } },
      },
    });
    await poll();
    expect(commitRuleEvaluation).not.toHaveBeenCalled();
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
    // The board's own close, unless a route on `work_item.closed` says otherwise (the dispatcher decides).
    expect(input.decisions[0]).toMatchObject({
      type: 'transition',
      board: 'bug',
      stage: 'done',
      event: { type: 'work_item.closed', reason: 'completed' },
    });
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

  it('finds an existing card’s board among the stored boards (a List routed to a board made in settings)', async () => {
    const docsCard = {
      id: 'card',
      board: 'docs',
      stages: ['inbox'],
      revision: 1,
      externalSource: null,
      metadata: {},
      workItem: { metadata: { state: 'to do' } },
    };
    const docsRoute: IntakeRoute = {
      id: 'docs-close',
      enabled: true,
      on: ['work_item.state_changed'],
      when: {
        operator: 'AND',
        conditions: [
          { field: 'source.list', operator: 'equals', value: 'L1' },
          { field: 'item.state', operator: 'equals', value: 'review' },
        ],
      },
      target: { boardKey: 'docs', phaseKey: 'drafting' },
    };
    const { poll, commitRuleEvaluation } = setup({
      rules: {},
      intakeRoutes: [docsRoute],
      tasks: [task({ status: { name: 'review', type: 'custom' } })],
      existing: docsCard,
    });
    await poll();
    expect(decisionOf(commitRuleEvaluation)).toMatchObject({ type: 'routeEvent', event: { type: 'work_item.state_changed' } });
  });

  describe('other intake routes', () => {
    const docsRoute: IntakeRoute = {
      id: 'route-docs',
      enabled: true,
      on: ['work_item.created'],
      when: tagged('docs'),
      target: { boardKey: 'docs', phaseKey: 'drafting' },
    };

    it("files a new task where the first matching route says, ahead of the List's own route, and names the route", async () => {
      const { poll, commitRuleEvaluation } = setup({
        tasks: [task({ tags: ['docs', 'bug'] })],
        listBoard: 'bug',
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

    it("places a task the catch-all would take by its List's route instead, naming that route", async () => {
      const { poll, commitRuleEvaluation } = setup({
        tasks: [task({ tags: ['bug'] })],
        listBoard: 'bug',
        intakeRoutes: [docsRoute, { ...docsRoute, id: 'everything-else', when: null, target: { boardKey: 'work', phaseKey: 'intake' } }],
      });
      await poll();
      expect(decisionOf(commitRuleEvaluation)).toMatchObject({
        board: 'bug',
        stage: 'intake',
        routesApplied: true,
        metadata: { intakeRouteId: 'status-0' },
      });
    });

    it('leaves a task out when no route names its List, whatever the other routes say', async () => {
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

    it('imports by a route that names the List and a status, with no moved rules at all', async () => {
      const { poll, commitRuleEvaluation } = setup({
        rules: {},
        tasks: [task({ status: { name: 'ready', type: 'custom' } })],
        intakeRoutes: [
          {
            id: 'route-ready',
            enabled: true,
            on: ['work_item.created'],
            when: {
              operator: 'AND',
              conditions: [
                { field: 'source.list', operator: 'equals', value: 'L1' },
                { field: 'item.state', operator: 'equals', value: 'Ready' },
              ],
            },
            target: { boardKey: 'docs', phaseKey: null },
          },
        ],
      });
      await poll();
      expect(decisionOf(commitRuleEvaluation)).toMatchObject({ board: 'docs', stage: 'inbox' });
    });
  });
});
