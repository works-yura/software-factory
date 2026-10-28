import { describe, expect, it, vi } from 'vitest';

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
  autoStart?: boolean;
  enabled?: boolean;
  binding?: { board: string | null } | null;
  routes?: Array<{ label: string; board: string }>;
  closure?: boolean;
}

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
      listLabelRoutes: async () => (options.routes ?? []).map(route => ({ factoryProjectId: 'proj', integrationId: 'clickup', ...route })),
    } as never,
    autoStart: async () => options.autoStart ?? false,
    projects: { listAll: async () => [{ id: 'proj', orgId: 'org' }] as never },
    workItems: { getByProjectSource, commitRuleEvaluation, update } as never,
    boards: { get: () => board } as never,
    configVersion: 'v',
    now: () => START,
  });
  return { poll, listTasks, commitRuleEvaluation, update, getByProjectSource };
}

const decisionOf = (mock: { mock: { calls: unknown[][] } }) => (mock.mock.calls[0]![0] as any).decisions[0];

describe('createClickUpPoller', () => {
  it('files a new task on the board its tag routes to, in the initial phase', async () => {
    const { poll, commitRuleEvaluation } = setup({ tasks: [task()], routes: [{ label: 'Bug', board: 'bug' }] });
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

  it('falls back to the List binding board when no tag route matches', async () => {
    const { poll, commitRuleEvaluation } = setup({ tasks: [task({ tags: ['idea'] })], routes: [{ label: 'bug', board: 'bug' }] });
    await poll();
    expect(decisionOf(commitRuleEvaluation).board).toBe('work');
  });

  it('ignores a List that is not routed, disabled, or has no board', async () => {
    for (const options of [{ binding: null }, { enabled: false }, { binding: { board: null } }]) {
      const { poll, listTasks, commitRuleEvaluation } = setup({ tasks: [task()], ...options });
      await poll();
      expect(commitRuleEvaluation).not.toHaveBeenCalled();
      if (options.binding === null || options.enabled === false) expect(listTasks).not.toHaveBeenCalled();
    }
  });

  it('starts Triage only for autoStart tasks created after the poller started', async () => {
    const fresh = setup({ autoStart: true, tasks: [task()] });
    await fresh.poll();
    expect(decisionOf(fresh.commitRuleEvaluation).stage).toBe('triage');

    const old = setup({ autoStart: true, tasks: [task({ createdAt: '2026-10-27T00:00:00.000Z' })] });
    await old.poll();
    expect(decisionOf(old.commitRuleEvaluation).stage).toBe('intake');

    const off = setup({ autoStart: false, tasks: [task()] });
    await off.poll();
    expect(decisionOf(off.commitRuleEvaluation).stage).toBe('intake');
  });

  it('refreshes a known card instead of creating a second one', async () => {
    const { poll, commitRuleEvaluation, update } = setup({
      tasks: [task({ tags: ['bug', 'urgent'] })],
      existing: { id: 'card', metadata: { labels: ['bug'], keep: 1 } },
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
});
