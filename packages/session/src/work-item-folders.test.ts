import { describe, expect, it, vi } from 'vitest';

import { workItemBranch } from '@factory/pipelines';
import { workItemFolderKey } from '@factory/sandbox';

import {
  CardSessionRunningError,
  createWorkItemFolders,
  runningCardSession,
  workItemFolderForCard,
} from './work-item-folders.ts';

const FACTORY = 'factory-1';
const CARD_ID = '9f1c3b2a-0000-4000-8000-000000000001';

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: CARD_ID,
    orgId: 'org-1',
    factoryProjectId: FACTORY,
    externalSource: {
      integrationId: 'github',
      type: 'issue',
      externalId: 'github:1:42',
      url: 'https://github.com/o/r/issues/42',
    },
    workItem: { metadata: { githubIssueNumber: 42 } },
    sessions: {},
    ...overrides,
  };
}

const cardBranch = workItemBranch({ id: CARD_ID, source: 'github-issue', metadata: { githubIssueNumber: 42 } });

function workItemsWith(bindings: Array<{ sessionId: string; workItemId: string }>, cards = [card()]) {
  return {
    listWorkItemIdsForSession: vi.fn(async ({ sessionId }: { sessionId: string }) => [
      ...new Set(bindings.filter(binding => binding.sessionId === sessionId).map(binding => binding.workItemId)),
    ]),
    get: vi.fn(async ({ id }: { id: string }) => cards.find(candidate => candidate.id === id) ?? null),
    listRunBindings: vi.fn(async (_orgId: string, _factory: string, workItemId?: string) =>
      bindings.filter(binding => binding.workItemId === workItemId),
    ),
  };
}

const session = (sessionId: string, branch: string, factoryProjectId: string | null = FACTORY) => ({
  sessionId,
  orgId: 'org-1',
  factoryProjectId,
  branch,
});

describe('createWorkItemFolders', () => {
  it("gives a session on the card's branch the card's folder, named after the branch under its factory", async () => {
    const folders = createWorkItemFolders({ workItems: workItemsWith([]) as never });

    const folder = await folders.forSession(session('triage', cardBranch));

    expect(folder).toEqual({ key: workItemFolderKey(FACTORY, cardBranch), factoryProjectId: FACTORY, branch: cardBranch });
    expect(folder?.key).toBe(`work-items/${FACTORY}/${cardBranch.replaceAll('/', '-')}`);
  });

  it("puts a role session started on its own branch in its card's folder once a run binds it to the card", async () => {
    const workItems = workItemsWith([
      { sessionId: 'triage', workItemId: CARD_ID },
      { sessionId: 'work', workItemId: CARD_ID },
    ]);
    const folders = createWorkItemFolders({ workItems: workItems as never });

    const triage = await folders.forSession(session('triage', cardBranch));
    const work = await folders.forSession(session('work', 'user/session-work'));

    expect(work).toEqual({ ...triage, workItemId: CARD_ID });
    expect(triage?.workItemId).toBe(CARD_ID);
    // The binding is remembered: a session is bound to its card for good.
    await folders.forSession(session('work', 'user/session-work'));
    expect(workItems.listWorkItemIdsForSession.mock.calls.filter(([args]) => args.sessionId === 'work')).toHaveLength(1);
  });

  it('keeps a folder of its own for a session that works no card', async () => {
    const folders = createWorkItemFolders({ workItems: workItemsWith([]) as never });

    await expect(folders.forSession(session('chat', 'user/session-chat'))).resolves.toBeUndefined();
    // The pre-suffix GitHub branch names a number several repositories share, not one card.
    await expect(folders.forSession(session('legacy', 'factory/issue-42'))).resolves.toBeUndefined();
    // Without the factory there is nothing to scope a shared folder by.
    await expect(folders.forSession(session('old', cardBranch, null))).resolves.toBeUndefined();
  });

  it('shares card-branch folders without a work-items store', async () => {
    const folders = createWorkItemFolders({});

    await expect(folders.forSession(session('triage', cardBranch))).resolves.toMatchObject({ branch: cardBranch });
    await expect(folders.forSession(session('work', 'user/session-work'))).resolves.toBeUndefined();
  });

  it('refuses a session bound to several cards', async () => {
    const folders = createWorkItemFolders({
      workItems: workItemsWith([
        { sessionId: 's', workItemId: 'card-a' },
        { sessionId: 's', workItemId: 'card-b' },
      ]) as never,
    });

    await expect(folders.forSession(session('s', 'user/session-s'))).rejects.toThrow(
      /bound to several work items \(card-a, card-b\)/,
    );
  });

  it('leaves a session whose card was deleted with no card folder', async () => {
    const folders = createWorkItemFolders({
      workItems: workItemsWith([{ sessionId: 'work', workItemId: CARD_ID }], []) as never,
    });

    await expect(folders.forSession(session('work', 'user/session-work'))).resolves.toBeUndefined();
  });

  it("lists the sessions bound to a folder's card", async () => {
    const folders = createWorkItemFolders({
      workItems: workItemsWith([
        { sessionId: 'triage', workItemId: CARD_ID },
        { sessionId: 'work', workItemId: CARD_ID },
        { sessionId: 'work', workItemId: CARD_ID },
      ]) as never,
    });

    const folder = workItemFolderForCard(card() as never);
    await expect(folders.boundSessionIds({ orgId: 'org-1', folder })).resolves.toEqual(['triage', 'work']);
    await expect(
      folders.boundSessionIds({ orgId: 'org-1', folder: { ...folder, workItemId: undefined } }),
    ).resolves.toEqual([]);
  });

  it('derives the same folder from the card as from its sessions', async () => {
    const folders = createWorkItemFolders({ workItems: workItemsWith([]) as never });

    const fromCard = workItemFolderForCard(card() as never);
    const fromSession = await folders.forSession(session('triage', cardBranch));

    expect(fromCard.key).toBe(fromSession?.key);
    expect(fromCard.workItemId).toBe(CARD_ID);
  });
});

describe('runningCardSession', () => {
  const sessions = { triage: { sessionId: 's-triage' }, work: { sessionId: 's-work' } };

  it("finds another of the card's sessions that is running", () => {
    expect(runningCardSession(sessions, 's-review', id => id === 's-work')).toEqual({
      role: 'work',
      sessionId: 's-work',
    });
  });

  it('ignores the session being started and sessions at rest', () => {
    expect(runningCardSession(sessions, 's-work', id => id === 's-work')).toBeUndefined();
    expect(runningCardSession(sessions, undefined, () => false)).toBeUndefined();
  });

  it('says which run blocks the start and why', () => {
    const error = new CardSessionRunningError('review', { role: 'work', sessionId: 's-work' });
    expect(error.code).toBe('card_session_running');
    expect(error.message).toMatch(/work session s-work is still running/);
    expect(error.message).toMatch(/one sandbox folder/);
  });
});
