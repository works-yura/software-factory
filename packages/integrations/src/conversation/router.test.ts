import { describe, expect, it, vi } from 'vitest';

import type { WorkItemRow } from '@factory/store';

import { ConnectCodes } from './connect-codes.ts';
import { ConversationRouter } from './router.ts';
import type { ConversationRouterOptions } from './router.ts';
import { TranscriptionError } from './types.ts';
import type { ConversationThreadRef, InboundMessage } from './types.ts';

const thread: ConversationThreadRef = { platform: 'clickup', id: 'task-1:c-1' };

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'clickup',
    id: 'c-1',
    thread,
    sender: { teamId: 'team-1', userId: 'u-7', name: 'Olena', mention: '@Olena' },
    fromBot: false,
    addressedToBot: true,
    text: 'please check the login bug',
    attachments: [],
    subject: { integrationId: 'clickup', type: 'task', externalId: 'task-1', url: 'https://app.clickup.com/t/task-1', title: 'Login' },
    createdAt: '2026-11-11T10:00:00.000Z',
    ...overrides,
  };
}

function card(sessions: Record<string, unknown> = { execute: { threadId: 't' } }): WorkItemRow {
  return { id: 'card-1', revision: 4, sessions } as unknown as WorkItemRow;
}

function setup(overrides: Partial<ConversationRouterOptions> = {}) {
  const replies: string[] = [];
  const commits: Array<Record<string, unknown>> = [];
  const links = new Map<string, { userId: string; orgId?: string; linkedAt: Date }>();
  const codes = new ConnectCodes();
  const options: ConversationRouterOptions = {
    channel: {
      platform: 'clickup',
      reply: async (_thread, text) => {
        replies.push(text);
      },
      download: async () => new Uint8Array([1, 2, 3]),
    },
    identities: {
      getAccountLink: async key => links.get(`${key.externalTeamId}:${key.externalUserId}`) ?? null,
      saveAccountLink: async input => {
        const link = { userId: input.userId, orgId: input.orgId, linkedAt: new Date() };
        links.set(`${input.externalTeamId}:${input.externalUserId}`, link);
        return link;
      },
    },
    codes,
    findCard: async () => ({ orgId: 'org-1', factoryProjectId: 'p-1', card: card() }),
    workItems: {
      commitRuleEvaluation: async input => {
        commits.push(input as unknown as Record<string, unknown>);
        return { status: 'committed', result: {} };
      },
    },
    connectUrl: 'http://factory.test/connect/clickup',
    configVersion: 'test',
    ...overrides,
  };
  const link = () => links.set('team-1:u-7', { userId: 'user-1', orgId: 'org-1', linkedAt: new Date() });
  return { router: new ConversationRouter(options), replies, commits, codes, links, link };
}

describe('ConversationRouter', () => {
  it("never reacts to Factory's own messages", async () => {
    const { router, replies, commits } = setup();
    expect(await router.handle(message({ fromBot: true }))).toBe('own-message');
    expect(replies).toEqual([]);
    expect(commits).toEqual([]);
  });

  it('ignores messages that do not address Factory', async () => {
    const { router, link } = setup();
    link();
    expect(await router.handle(message({ addressedToBot: false }))).toBe('not-addressed');
  });

  it('asks an unlinked sender to connect, publicly and once per thread', async () => {
    const { router, replies, commits } = setup();
    expect(await router.handle(message())).toBe('connect-card');
    expect(await router.handle(message({ id: 'c-2' }))).toBe('connect-card');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('@Olena');
    expect(replies[0]).toContain('http://factory.test/connect/clickup');
    // The link carries no identity.
    expect(replies[0]).not.toContain('u-7');
    expect(commits).toEqual([]);
  });

  it('links the sender who posts a valid code, and refuses an unknown one', async () => {
    const { router, replies, codes, links } = setup();
    const { code } = codes.issue('clickup', { userId: 'user-1', orgId: 'org-1' });
    expect(await router.handle(message({ id: 'c-3', text: 'connect FCT-ZZZZZZ' }))).toBe('invalid-code');
    expect(await router.handle(message({ id: 'c-4', text: `connect ${code}` }))).toBe('linked');
    expect(links.get('team-1:u-7')).toMatchObject({ userId: 'user-1', orgId: 'org-1' });
    // A code is single-use.
    expect(await router.handle(message({ id: 'c-5', text: `connect ${code}` }))).toBe('invalid-code');
    expect(replies).toHaveLength(3);
  });

  it("delivers a linked sender's message to the card's live session, once", async () => {
    const { router, commits, link } = setup();
    link();
    expect(await router.handle(message())).toBe('delivered');
    expect(await router.handle(message())).toBe('duplicate');
    expect(commits).toHaveLength(1);
    const commit = commits[0] as {
      workItemId: string;
      expectedRevision: number;
      ingress: { identity: string };
      decisions: Array<{ type: string; message: string; idleBehavior: string }>;
    };
    expect(commit.workItemId).toBe('card-1');
    expect(commit.expectedRevision).toBe(4);
    expect(commit.ingress.identity).toBe('clickup:message:c-1');
    expect(commit.decisions[0]).toMatchObject({ type: 'sendMessage', idleBehavior: 'wake' });
    expect(commit.decisions[0]!.message).toContain('please check the login bug');
    expect(commit.decisions[0]!.message).toContain('factory_conversation_reply');
    expect(commit.decisions[0]!.message).toContain('"task-1:c-1"');
  });

  it('says so in the thread when no agent works on the card', async () => {
    const { router, replies, commits, link } = setup({
      findCard: async () => ({ orgId: 'org-1', factoryProjectId: 'p-1', card: card({}) }),
    });
    link();
    expect(await router.handle(message())).toBe('no-session');
    expect(replies[0]).toContain('no agent is working on this card');
    expect(commits).toEqual([]);
  });

  it('refuses a sender linked in another organization', async () => {
    const { router, links } = setup();
    links.set('team-1:u-7', { userId: 'user-1', orgId: 'org-2', linkedAt: new Date() });
    expect(await router.handle(message())).toBe('other-organization');
  });

  it("replaces a voice clip with its transcript, under the card's Factory and the sender", async () => {
    const transcriber = vi.fn(async () => 'deploy it after lunch');
    const { router, commits, link } = setup({ transcriber });
    link();
    await router.handle(
      message({ text: '', attachments: [{ id: 'a-1', name: 'clip.m4a', mimeType: 'audio/mp4', url: 'https://files/clip.m4a' }] }),
    );
    expect(transcriber).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', factoryProjectId: 'p-1', userId: 'user-1', fileName: 'clip.m4a' }),
    );
    const text = (commits[0] as { decisions: Array<{ message: string }> }).decisions[0]!.message;
    expect(text).toContain('[Voice clip clip.m4a, transcribed:] deploy it after lunch');
  });

  it('keeps a clip it could not transcribe, with a note naming it and why', async () => {
    const { router, commits, link } = setup({
      transcriber: async () => {
        throw new TranscriptionError('no speech-to-text key is configured');
      },
    });
    link();
    await router.handle(message({ attachments: [{ id: 'a-1', name: 'clip.ogg', mimeType: '', url: 'https://files/clip.ogg' }] }));
    const text = (commits[0] as { decisions: Array<{ message: string }> }).decisions[0]!.message;
    expect(text).toContain("[Voice clip clip.ogg — https://files/clip.ogg — couldn't be transcribed: no speech-to-text key is configured]");
  });

  it('says transcription is not set up when no transcriber is wired', async () => {
    const { router, commits, link } = setup();
    link();
    await router.handle(message({ attachments: [{ id: 'a-1', name: 'v.wav', mimeType: 'audio/wav', url: 'u' }] }));
    const text = (commits[0] as { decisions: Array<{ message: string }> }).decisions[0]!.message;
    expect(text).toContain('voice transcription is not set up on this Factory');
  });

  it('retries a message whose card moved meanwhile instead of marking it seen', async () => {
    let stale = true;
    const { router, link } = setup({
      workItems: {
        commitRuleEvaluation: async () => {
          if (stale) {
            stale = false;
            return { status: 'stale' };
          }
          return { status: 'committed', result: {} };
        },
      },
    });
    link();
    await expect(router.handle(message())).rejects.toThrow('changed while');
    expect(await router.handle(message())).toBe('delivered');
  });
});
