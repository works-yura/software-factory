import { describe, expect, it } from 'vitest';

import { supervisorResourceId } from '@factory/session';

import { resolveMcpSessionScope } from './scope.ts';

const coordinates = { orgId: 'org-1', sessionId: 'session-1', factoryProjectId: 'syncts' };

function workItems(cards: Record<string, { board?: string; stages: string[] } | null>) {
  return {
    listWorkItemIdsForSession: async ({ sessionId }: { sessionId: string }) => (sessionId in cards ? [`card-of-${sessionId}`] : []),
    get: async ({ id }: { id: string }) => {
      const card = cards[id.replace('card-of-', '')];
      return card ? ({ id, ...card } as never) : null;
    },
  } as never;
}

describe('resolveMcpSessionScope', () => {
  it('names the Factory chat by its supervisor id or resource', async () => {
    const chat = { ...coordinates, sessionId: supervisorResourceId('syncts') };
    expect(await resolveMcpSessionScope(chat, workItems({}))).toMatchObject({ kind: 'chat', factoryProjectId: 'syncts' });
    const byResource = { ...coordinates, resourceId: supervisorResourceId('syncts') };
    expect(await resolveMcpSessionScope(byResource, workItems({}))).toMatchObject({ kind: 'chat' });
  });

  it('names a card session with its board and single phase', async () => {
    const scope = await resolveMcpSessionScope(coordinates, workItems({ 'session-1': { board: 'audits', stages: ['analysis'] } }));
    expect(scope).toMatchObject({ kind: 'card', board: 'audits', phase: 'analysis' });
    const fanOut = await resolveMcpSessionScope(coordinates, workItems({ 'session-1': { board: 'work', stages: ['a', 'b'] } }));
    expect(fanOut).toMatchObject({ kind: 'card', board: 'work' });
    expect(fanOut).not.toHaveProperty('phase');
  });

  it('names any other session of the Factory a member’s own (personal) session', async () => {
    expect(await resolveMcpSessionScope(coordinates, workItems({}))).toMatchObject({ kind: 'personal' });
    expect(await resolveMcpSessionScope(coordinates, undefined)).toMatchObject({ kind: 'personal' });
  });

  it('gives no scope outside a Factory', async () => {
    expect(await resolveMcpSessionScope({ orgId: 'org-1', sessionId: 's' }, workItems({}))).toBeUndefined();
    expect(await resolveMcpSessionScope(undefined, workItems({}))).toBeUndefined();
  });
});
