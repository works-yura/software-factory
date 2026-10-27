import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deferred, fakeClaude, fixture } from './__fixtures__/fake-claude.ts';
import { createClaudeCodeHarness } from './harness.ts';
import { createInMemorySessionStore, createJsonFileSessionStore } from './store.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-code-harness-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(directory: string, name: string, source: string) {
  await mkdir(join(directory, name), { recursive: true });
  await writeFile(join(directory, name, 'SKILL.md'), source);
}

describe('createClaudeCodeHarness', () => {
  it('rehydrates a stored session once and hands every caller the same object', async () => {
    const store = createInMemorySessionStore();
    const first = createClaudeCodeHarness({ store, credentials: async () => ({}), cwdFor: () => root });
    await first.createSession({ sessionId: 'card-1', threadId: 'thread-1' });

    const second = createClaudeCodeHarness({ store, credentials: async () => ({}), cwdFor: () => root });
    const [a, b] = await Promise.all([second.getSession('card-1'), second.getSession('card-1')]);
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a?.thread.requireId()).toBe('thread-1');
    expect(await second.getSession('missing')).toBeUndefined();
  });

  it('hands every session object it builds to onSession once, created or rehydrated', async () => {
    const store = createInMemorySessionStore();
    const seen: string[] = [];
    const harness = createClaudeCodeHarness({
      store,
      credentials: async () => ({}),
      cwdFor: () => root,
      onSession: session => seen.push(session.id),
    });
    await harness.createSession({ sessionId: 'card-1', threadId: 'thread-1' });
    await harness.createSession({ sessionId: 'card-1', threadId: 'thread-1' });
    await harness.getSession('card-1');
    expect(seen).toEqual(['card-1']);

    const restarted = createClaudeCodeHarness({
      store,
      credentials: async () => ({}),
      cwdFor: () => root,
      onSession: session => seen.push(`restarted:${session.id}`),
    });
    await Promise.all([restarted.getSession('card-1'), restarted.getSession('card-1')]);
    expect(seen).toEqual(['card-1', 'restarted:card-1']);
  });

  it('lists the runs in flight by thread', async () => {
    const hold = deferred();
    const fake = fakeClaude([{ lines: fixture('turn-complete.jsonl'), holdAt: 1, hold: hold.promise }]);
    const harness = createClaudeCodeHarness({
      store: createInMemorySessionStore(),
      spawn: fake.spawn,
      credentials: async () => ({}),
      cwdFor: () => root,
    });
    const session = await harness.createSession({ sessionId: 'card-1', threadId: 'thread-1', resourceId: 'fp-1' });
    expect(harness.listActiveThreadRuns()).toEqual([]);

    const context = harness.runContext(session, { userId: 'u', orgId: 'o', threadId: 'thread-1', resourceId: 'fp-1' });
    const { runId } = await session.sendSignal(
      { id: 'k', type: 'user', tagName: 'user', contents: 'go' },
      { requestContext: context, requireDelivery: true },
    ).accepted;

    expect(harness.listActiveThreadRuns()).toEqual([{ threadId: 'thread-1', runId, resourceId: 'fp-1' }]);
    const ended = new Promise(resolve => session.subscribe(event => event.type === 'agent_end' && resolve(undefined)));
    hold.resolve();
    await ended;
    expect(harness.listActiveThreadRuns()).toEqual([]);
  });

  it('builds the run context from the caller and the binding', async () => {
    const harness = createClaudeCodeHarness({
      store: createInMemorySessionStore(),
      credentials: async () => ({}),
      cwdFor: () => root,
    });
    const session = await harness.createSession({ sessionId: 'card-1', threadId: 'thread-1' });
    const context = harness.runContext(session, { userId: 'user-2', orgId: 'org-1', threadId: 'thread-1', resourceId: 'fp-1' });

    expect(context.get('user')).toEqual({ workosId: 'user-2', organizationId: 'org-1' });
    expect(context.get('controller')).toMatchObject({ threadId: 'thread-1', resourceId: 'fp-1', session: { id: 'card-1' } });
  });

  describe('findSkill', () => {
    it("reads a skill from the session's .claude/skills", async () => {
      await writeSkill(
        join(root, '.claude', 'skills'),
        'factory-review',
        '---\nname: factory-review\ndescription: Review a change\n---\n\nFollow the review protocol.\n',
      );
      const harness = createClaudeCodeHarness({
        store: createInMemorySessionStore(),
        credentials: async () => ({}),
        cwdFor: () => root,
      });
      const session = await harness.createSession({ sessionId: 'card-1', threadId: 'thread-1' });

      expect(await harness.findSkill(session, 'factory-review')).toEqual({
        name: 'factory-review',
        userInvocable: true,
        activation: 'Follow the review protocol.',
      });
      expect(await harness.findSkill(session, 'missing')).toBeUndefined();
      expect(await harness.findSkill(session, '../etc')).toBeUndefined();
    });

    it('prefers the configured skills directory and honours user-invocable: false', async () => {
      await writeSkill(join(root, '.claude', 'skills'), 'internal', 'workspace copy');
      await writeSkill(join(root, 'factory-skills'), 'internal', '---\nuser-invocable: false\n---\nFactory copy');
      const harness = createClaudeCodeHarness({
        store: createInMemorySessionStore(),
        credentials: async () => ({}),
        cwdFor: () => root,
        skillsDir: 'factory-skills',
      });
      const session = await harness.createSession({ sessionId: 'card-1', threadId: 'thread-1' });

      expect(await harness.findSkill(session, 'internal')).toEqual({
        name: 'internal',
        userInvocable: false,
        activation: 'Factory copy',
      });
    });
  });

  it('persists sessions as JSON files', async () => {
    const store = createJsonFileSessionStore(join(root, 'sessions'));
    const harness = createClaudeCodeHarness({ store, credentials: async () => ({}), cwdFor: () => root });
    const session = await harness.createSession({ sessionId: 'org/card 1', threadId: 'thread-1' });
    await session.thread.setSetting({ key: 'k', value: { n: 1 } });

    const reread = createJsonFileSessionStore(join(root, 'sessions'));
    expect((await reread.get('org/card 1'))?.threads['thread-1']?.settings).toEqual({ k: { n: 1 } });
    expect((await reread.list()).map(record => record.sessionId)).toEqual(['org/card 1']);
    expect(await reread.get('nope')).toBeUndefined();
  });
});
