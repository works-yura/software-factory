import { describe, expect, it } from 'vitest';

import { ClickUpApiError, ClickUpClient, parseClickUpTask } from './api.ts';

function clientWith(routes: Record<string, unknown | number>) {
  const calls: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = url.replace('https://api.clickup.com/api/v2', '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const hit = Object.entries(routes).find(([route]) => path.startsWith(route));
    const value = hit?.[1];
    if (typeof value === 'number') return new Response(JSON.stringify({ err: 'denied' }), { status: value });
    return new Response(JSON.stringify(value ?? {}), { status: hit ? 200 : 404 });
  }) as typeof globalThis.fetch;
  return { client: new ClickUpClient({ token: 'pk_test', fetch }), calls };
}

const workspace = { id: 'w1', name: 'W' };

describe('ClickUpClient.listLists', () => {
  it('walks Spaces, Folders and folderless Lists', async () => {
    const { client } = clientWith({
      '/team/w1/space': { spaces: [{ id: 's1', name: 'Eng' }] },
      '/space/s1/list': { lists: [{ id: 'l1', name: 'Inbox' }] },
      '/space/s1/folder': { folders: [{ id: 'f1', name: 'Syncta', lists: [{ id: 'l2', name: 'Bugs' }] }] },
      '/team/w1/shared': { shared: {} },
    });
    expect((await client.listLists(workspace)).map(list => [list.id, list.path])).toEqual([
      ['l1', 'Eng'],
      ['l2', 'Eng / Syncta'],
    ]);
  });

  it('falls back to what was shared when the Space hierarchy is denied (guest token)', async () => {
    const { client } = clientWith({
      '/team/w1/space': { spaces: [] },
      '/team/w1/shared': {
        shared: {
          folders: [{ id: 'f1', name: 'Syncta', lists: [{ id: 'l1', name: 'Bugs' }, { id: 'l2', name: 'Development' }] }],
          lists: [{ id: 'l3', name: 'SkinAI' }],
        },
      },
    });
    expect((await client.listLists(workspace)).map(list => [list.name, list.path])).toEqual([
      ['Bugs', 'Syncta'],
      ['Development', 'Syncta'],
      ['SkinAI', 'Shared with me'],
    ]);
  });

  it('keeps one entry per List when it is both in a Space and shared', async () => {
    const { client } = clientWith({
      '/team/w1/space': { spaces: [{ id: 's1', name: 'Eng' }] },
      '/space/s1/list': { lists: [] },
      '/space/s1/folder': { folders: [{ id: 'f1', name: 'Syncta', lists: [{ id: 'l1', name: 'Bugs' }] }] },
      '/team/w1/shared': { shared: { folders: [{ id: 'f1', name: 'Syncta', lists: [{ id: 'l1', name: 'Bugs' }] }] } },
    });
    expect(await client.listLists(workspace)).toHaveLength(1);
  });

  it('tolerates a denied Space and still returns the shared Lists', async () => {
    const { client } = clientWith({
      '/team/w1/space': { spaces: [{ id: 's1', name: 'Eng' }] },
      '/space/s1': 403,
      '/team/w1/shared': { shared: { lists: [{ id: 'l1', name: 'Only' }] } },
    });
    expect((await client.listLists(workspace)).map(list => list.id)).toEqual(['l1']);
  });

  it('surfaces other failures instead of hiding them', async () => {
    const { client } = clientWith({ '/team/w1/space': 500 });
    await expect(client.listLists(workspace)).rejects.toBeInstanceOf(ClickUpApiError);
  });
});

describe('ClickUpClient tasks', () => {
  it('pages until the last page and sends the token', async () => {
    const { client, calls } = clientWith({
      '/list/L/task': { tasks: [{ id: 'a', name: 'A', status: { status: 'to do', type: 'open' } }], last_page: true },
    });
    const tasks = await client.listTasks({ listId: 'L', updatedAfter: new Date(0) });
    expect(tasks.map(task => task.id)).toEqual(['a']);
    expect(calls).toHaveLength(1);
  });

  it('parses ClickUp task fields', () => {
    const task = parseClickUpTask({
      id: 't',
      name: 'N',
      text_content: 'body',
      status: { status: 'dev fixed', type: 'custom' },
      tags: [{ name: 'bug' }],
      assignees: [{ username: 'bob' }],
      creator: { username: 'ann' },
      priority: { priority: 'high' },
      list: { id: 'L' },
      date_created: '1761640000000',
      date_updated: '1761640100000',
    });
    expect(task).toMatchObject({ id: 't', description: 'body', tags: ['bug'], assignees: ['bob'], creator: 'ann', priority: 'high', listId: 'L' });
    expect(task?.status).toEqual({ name: 'dev fixed', type: 'custom' });
    expect(parseClickUpTask({})).toBeNull();
  });
});
