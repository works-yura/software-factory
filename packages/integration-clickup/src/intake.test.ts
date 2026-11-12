import { describe, expect, it, vi } from 'vitest';

import type { ClickUpTask } from './api.ts';
import { ClickUpClients } from './connection.ts';
import type { ClickUpApi } from './connection.ts';
import { ClickUpIntake, stateTypeOf } from './intake.ts';

const task: ClickUpTask = {
  id: 't1',
  name: 'Crash',
  description: 'body',
  url: 'https://app.clickup.com/t/t1',
  status: { name: 'in progress', type: 'custom' },
  tags: ['bug'],
  creator: 'ann',
  assignees: ['bob'],
  priority: 'high',
  listId: 'L1',
  createdAt: '2026-10-28T10:00:00.000Z',
  updatedAt: '2026-10-28T11:00:00.000Z',
};

/** Org `o` stored `pk_test`; every token gets `client`, recorded so a test can say which token was used. */
function intakeWith(client: Record<string, unknown>, tokens: string[] = []) {
  const stored: Record<string, string> = { o: 'pk_test' };
  const clients = new ClickUpClients({
    storage: () => ({
      connections: {
        get: async (orgId: string) => (stored[orgId] ? ({ data: { apiToken: stored[orgId] } } as never) : null),
      } as never,
    }),
    create: token => {
      tokens.push(token);
      return client as unknown as ClickUpApi;
    },
  });
  return new ClickUpIntake(clients);
}

describe('ClickUpIntake', () => {
  it('lists every List with its Space / Folder path as a source', async () => {
    const intake = intakeWith({
      listWorkspaces: async () => [{ id: 'w', name: 'W' }],
      listLists: async () => [
        { id: 'L1', name: 'Backlog', path: 'Eng / Mobile', workspaceId: 'w' },
        { id: 'L2', name: 'Inbox', path: '', workspaceId: 'w' },
      ],
    });
    const sources = await intake.listSources({ orgId: 'o', userId: 'u' });
    expect(sources.map(source => [source.id, source.name])).toEqual([
      ['L1', 'Eng / Mobile / Backlog'],
      ['L2', 'Inbox'],
    ]);
  });

  it('pages through the selected Lists with an opaque cursor', async () => {
    const listTasksPage = vi
      .fn()
      .mockResolvedValueOnce({ tasks: [task], lastPage: false })
      .mockResolvedValueOnce({ tasks: [], lastPage: true })
      .mockResolvedValueOnce({ tasks: [{ ...task, id: 't2' }], lastPage: true });
    const intake = intakeWith({ listTasksPage });
    const first = await intake.listItems({ orgId: 'o', userId: 'u', sourceIds: ['L1', 'L2'] });
    expect(first.items[0]).toMatchObject({ sourceId: 'L1', source: { type: 'task', externalId: 't1' }, labels: ['bug'] });
    const second = await intake.listItems({ orgId: 'o', userId: 'u', sourceIds: ['L1', 'L2'], cursor: first.nextCursor! });
    expect(second.nextCursor).not.toBeNull();
    const third = await intake.listItems({ orgId: 'o', userId: 'u', sourceIds: ['L1', 'L2'], cursor: second.nextCursor! });
    expect(third.items[0]!.sourceId).toBe('L2');
    expect(third.nextCursor).toBeNull();
  });

  it('rejects a tampered cursor by returning nothing', async () => {
    const intake = intakeWith({ listTasksPage: vi.fn() });
    const page = await intake.listItems({ orgId: 'o', userId: 'u', sourceIds: ['L1'], cursor: 'not-a-cursor' });
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('moves a task to the List status of the requested type', async () => {
    const setTaskStatus = vi.fn(async () => undefined);
    const intake = intakeWith({
      getTask: async () => task,
      getList: async () => ({ id: 'L1', name: 'L', statuses: [{ name: 'to do', type: 'open' }, { name: 'complete', type: 'closed' }] }),
      setTaskStatus,
    });
    await intake.updateIssue({ connection: { type: 'oauth', accessToken: 'x' }, issueId: 't1', state: { kind: 'byType', stateType: 'completed' } });
    expect(setTaskStatus).toHaveBeenCalledWith('t1', 'complete');
    expect(
      await intake.updateIssue({ connection: { type: 'oauth', accessToken: 'x' }, issueId: 't1', state: { kind: 'byType', stateType: 'canceled' } }),
    ).toBeNull();
  });

  it("reads an organization's Lists with its own token and refuses an organization without one", async () => {
    const tokens: string[] = [];
    const intake = intakeWith({ listWorkspaces: async () => [], listLists: async () => [] }, tokens);
    await intake.listSources({ orgId: 'o', userId: 'u' });
    expect(tokens).toEqual(['pk_test']);
    await expect(intake.listSources({ orgId: 'other', userId: 'u' })).rejects.toThrow(/ClickUp is not connected for organization other/);
    await expect(intake.listItems({ orgId: 'other', userId: 'u', sourceIds: ['L1'] })).rejects.toThrow(/not connected/);
    await expect(
      intake.resolveIntakeDispatch!({ orgId: 'other', externalSource: { type: 'task', externalId: 't1' } }),
    ).rejects.toThrow(/not connected/);
  });

  it("hands a dispatch the organization's token and acts on the task with the token it is given", async () => {
    const tokens: string[] = [];
    const intake = intakeWith({ getTask: async () => task, createComment: async () => ({ id: 'c1' }) }, tokens);
    const resolved = await intake.resolveIntakeDispatch!({ orgId: 'o', externalSource: { type: 'task', externalId: 't1' } });
    expect(resolved).toEqual({ connection: { type: 'oauth', accessToken: 'pk_test' }, sourceId: 'L1', issueId: 't1' });
    await intake.createComment({ connection: { type: 'oauth', accessToken: 'pk_other' }, issueId: 't1', body: 'hi' });
    expect(tokens).toEqual(['pk_test', 'pk_other']);
  });

  it('maps ClickUp status types to shared state types', () => {
    expect(stateTypeOf({ status: { name: 'a', type: 'open' } })).toBe('unstarted');
    expect(stateTypeOf({ status: { name: 'a', type: 'custom' } })).toBe('started');
    expect(stateTypeOf({ status: { name: 'a', type: 'closed' } })).toBe('completed');
  });
});
