import { describe, expect, it, vi } from 'vitest';

import type { ConversationOutcome, InboundMessage } from '@factory/integrations';
import type { WorkItemRow } from '@factory/store';

import { ClickUpClient } from './api.ts';
import type { ClickUpTask, ClickUpThreadComment } from './api.ts';
import { clickUpThreadId, createClickUpChannel, createClickUpConversationPoller } from './conversation.ts';
import type { ClickUpConversationClient } from './conversation.ts';

const START = new Date('2026-11-11T10:00:00.000Z');
const LATER = '2026-11-11T10:05:00.000Z';
const EARLIER = '2026-11-11T09:00:00.000Z';

const task: ClickUpTask = {
  id: 'task-1',
  name: 'Login breaks',
  description: '',
  url: 'https://app.clickup.com/t/task-1',
  status: { name: 'in progress', type: 'custom' },
  tags: [],
  creator: null,
  assignees: [],
  priority: null,
  listId: 'list-1',
  teamId: 'team-9',
  createdAt: EARLIER,
  updatedAt: LATER,
};

function comment(overrides: Partial<ClickUpThreadComment>): ClickUpThreadComment {
  return {
    id: 'c-1',
    authorId: 'u-7',
    authorName: 'olena',
    text: 'hey factory, look at this',
    mentions: ['bot-1'],
    attachments: [],
    replyCount: 0,
    createdAt: LATER,
    ...overrides,
  };
}

function setup(comments: ClickUpThreadComment[], replies: ClickUpThreadComment[] = []) {
  const handled: InboundMessage[] = [];
  const client: ClickUpConversationClient = {
    listTasks: async () => [task],
    listThreadComments: async () => comments,
    listReplies: async () => replies,
    replyToComment: vi.fn(async () => {}),
    authorizedUser: async () => ({ id: 'bot-1', username: 'factory-bot' }),
    download: async () => new Uint8Array(),
  };
  const outcomes: ConversationOutcome[] = [];
  const poller = createClickUpConversationPoller({
    client,
    router: {
      handle: async message => {
        handled.push(message);
        const outcome: ConversationOutcome = message.fromBot ? 'own-message' : message.addressedToBot ? 'delivered' : 'not-addressed';
        outcomes.push(outcome);
        return outcome;
      },
    },
    intake: {
      getConfig: async () => ({ clickup: { enabled: true, sourceIds: ['list-1'] } }) as never,
      listBindings: async () => [{ sourceId: 'list-1', factoryProjectId: 'p-1', board: 'work' }] as never,
    },
    projects: { listAll: async () => [{ id: 'p-1', orgId: 'org-1' }] as never },
    workItems: { getByProjectSource: async () => ({ id: 'card-1', revision: 2, sessions: {} }) as unknown as WorkItemRow },
    now: () => START,
  });
  return { poller, handled, client };
}

describe('ClickUp conversation poller', () => {
  it('hands a new comment mentioning Factory to the router, as a message on its own thread', async () => {
    const { poller, handled } = setup([comment({})]);
    await poller.sweep();
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      platform: 'clickup',
      id: 'c-1',
      thread: { platform: 'clickup', id: 'task-1:c-1' },
      sender: { teamId: 'team-9', userId: 'u-7', name: 'olena', mention: '@olena' },
      fromBot: false,
      addressedToBot: true,
      subject: { integrationId: 'clickup', type: 'task', externalId: 'task-1' },
    });
    expect(await poller.findCard(handled[0]!)).toMatchObject({ orgId: 'org-1', factoryProjectId: 'p-1', card: { id: 'card-1' } });
  });

  it("marks Factory's own comments and never replays comments from before the server started", async () => {
    const { poller, handled } = setup([comment({ id: 'c-2', authorId: 'bot-1' }), comment({ id: 'c-3', createdAt: EARLIER })]);
    await poller.sweep();
    expect(handled.map(message => [message.id, message.fromBot])).toEqual([['c-2', true]]);
  });

  it('reads replies only in threads Factory was addressed in, where every reply is addressed to it', async () => {
    const reply = comment({ id: 'r-1', mentions: [], text: 'and the signup page too' });
    const { poller, handled } = setup([comment({ replyCount: 1 })], [reply]);
    await poller.sweep();
    expect(handled.map(message => message.id)).toEqual(['c-1']);
    await poller.sweep();
    const replyMessage = handled.find(message => message.id === 'r-1');
    expect(replyMessage).toMatchObject({ addressedToBot: true, thread: { id: 'task-1:c-1' } });
  });
});

describe('ClickUp channel', () => {
  it('replies under the thread comment', async () => {
    const client = { replyToComment: vi.fn(async () => {}), download: async () => new Uint8Array() };
    await createClickUpChannel(client).reply({ platform: 'clickup', id: clickUpThreadId('task-1', 'c-1') }, 'on it');
    expect(client.replyToComment).toHaveBeenCalledWith('c-1', 'on it');
  });

  it('refuses a thread reference that is not ClickUp’s', async () => {
    const client = { replyToComment: vi.fn(async () => {}), download: async () => new Uint8Array() };
    await expect(createClickUpChannel(client).reply({ platform: 'clickup', id: 'nonsense' }, 'x')).rejects.toThrow(
      'Not a ClickUp thread reference',
    );
  });
});

describe('ClickUpClient thread comments', () => {
  it('parses mentions and attachments, and refuses to download outside ClickUp', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        comments: [
          {
            id: 77,
            comment_text: '@factory-bot listen',
            comment: [
              { type: 'tag', user: { id: 5 } },
              { text: ' listen' },
              { type: 'attachment', attachment: { id: 'a1', title: 'voice.m4a', url: 'https://t.clickup-attachments.com/voice.m4a', mimetype: 'audio/mp4' } },
            ],
            user: { id: 9, username: 'olena' },
            reply_count: 2,
            date: String(Date.parse(LATER)),
          },
        ],
      }),
    );
    const client = new ClickUpClient({ token: 'pk_test', fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await client.listThreadComments('task-1')).toEqual([
      {
        id: '77',
        authorId: '9',
        authorName: 'olena',
        text: '@factory-bot listen',
        mentions: ['5'],
        attachments: [{ id: 'a1', name: 'voice.m4a', mimeType: 'audio/mp4', url: 'https://t.clickup-attachments.com/voice.m4a' }],
        replyCount: 2,
        createdAt: LATER,
      },
    ]);
    await expect(client.download('https://evil.example.com/x')).rejects.toThrow('non-ClickUp URL');
  });
});
