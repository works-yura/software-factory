import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemorySessionStore, createJsonFileSessionStore, emptyThreadState, type ClaudeSessionRecord } from './store.ts';

const record = (sessionId: string): ClaudeSessionRecord => ({
  sessionId,
  threadId: 'thread-1',
  threads: { 'thread-1': emptyThreadState() },
  updatedAt: '2026-10-01T00:00:00.000Z',
});

describe('emptyThreadState', () => {
  it('starts a thread with nothing pending, delivered or remembered', () => {
    expect(emptyThreadState()).toEqual({ settings: {}, pendingInputs: [], deliveredIds: [], dedupeKeys: [] });
  });
});

describe('createInMemorySessionStore', () => {
  it('lists copies of what was put', async () => {
    const store = createInMemorySessionStore();
    await store.put(record('card-1'));
    await store.put(record('card-2'));
    const listed = await store.list();
    expect(listed).toEqual([record('card-1'), record('card-2')]);
    listed[0]!.threadId = 'changed';
    expect((await store.get('card-1'))!.threadId).toBe('thread-1');
  });
});

describe('createJsonFileSessionStore', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'factory-store-test-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads back what it wrote and knows nothing of a session it never saw', async () => {
    const store = createJsonFileSessionStore(join(directory, 'sessions'));
    await store.put(record('card/1'));
    expect(await store.get('card/1')).toEqual(record('card/1'));
    expect(await store.get('card-2')).toBeUndefined();
    expect(await readdir(join(directory, 'sessions'))).toEqual(['card%2F1.json']);
  });

  it('fails a read of a damaged record instead of treating it as missing', async () => {
    const store = createJsonFileSessionStore(directory);
    await writeFile(join(directory, 'card-1.json'), '{"sessionId":');
    await expect(store.get('card-1')).rejects.toThrow(SyntaxError);
  });

  it('lists only session records, skipping stray files and records gone before they were read', async () => {
    const store = createJsonFileSessionStore(directory);
    await store.put(record('card-1'));
    await writeFile(join(directory, 'card-2.json.4242.1.tmp'), '{"half');
    await symlink(join(directory, 'missing.json'), join(directory, 'gone.json'));
    expect(await store.list()).toEqual([record('card-1')]);
  });
});
