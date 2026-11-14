import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import type { OpenCodeImportedTurn, OpenCodeImportSource } from '@factory/harness-opencode';

import { createOpenCodeLocalSessions, remoteSlug } from './local-import.ts';

async function database(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'opencode-import-')), 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    INSERT INTO project VALUES ('prj_1', '/work/syncta-back');
    INSERT INTO session VALUES ('ses_a', 'prj_1', NULL, '/work/syncta-back', 'Fix login', 1, 2000, NULL);
    INSERT INTO message VALUES ('msg_1', 'ses_a', 10, 10, '{"role":"user"}');
    INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_a', 10, 10, '{"type":"text","text":"Fix it"}');
    INSERT INTO message VALUES ('msg_2', 'ses_a', 20, 20, '{"role":"assistant","providerID":"opencode","modelID":"big-pickle"}');
    INSERT INTO part VALUES ('prt_2', 'msg_2', 'ses_a', 20, 20, '{"type":"text","text":"Done."}');
  `);
  db.close();
  return path;
}

describe('remoteSlug', () => {
  it('reads owner/name from the remotes git writes', () => {
    expect(remoteSlug('git@github.com:Eclipt-AI/syncta_back.git\n')).toBe('Eclipt-AI/syncta_back');
    expect(remoteSlug('https://github.com/Eclipt-AI/syncta_back')).toBe('Eclipt-AI/syncta_back');
    expect(remoteSlug('https://gitlab.com/group/sub/app.git')).toBe('group/sub/app');
    expect(remoteSlug('not a url')).toBeUndefined();
  });
});

describe('createOpenCodeLocalSessions', () => {
  it('lists the person’s sessions with the repository their folder is a clone of', async () => {
    const local = createOpenCodeLocalSessions({
      harness: { getSession: async () => undefined },
      databasePath: await database(),
      flushed: async () => {},
      handOff: async () => {},
      slugOf: async folder => (folder === '/work/syncta-back' ? 'Eclipt-AI/syncta_back' : undefined),
    });
    expect(await local.list()).toEqual([
      expect.objectContaining({ id: 'ses_a', title: 'Fix login', directory: '/work/syncta-back', repositorySlug: 'Eclipt-AI/syncta_back', messages: 2 }),
    ]);
  });

  it('writes a read session into the Factory session, waits for it to be stored, then hands it to the first turn', async () => {
    const calls: string[] = [];
    let imported: { turns: readonly OpenCodeImportedTurn[]; source: OpenCodeImportSource } | undefined;
    const session = {
      resourceId: 'res-1',
      thread: { requireId: () => 'thread-1' },
      importHistory: async (turns: readonly OpenCodeImportedTurn[], source: OpenCodeImportSource) => {
        calls.push('import');
        imported = { turns, source };
      },
    };
    const local = createOpenCodeLocalSessions({
      harness: { getSession: async id => (id === 'session-1' ? (session as never) : undefined) },
      databasePath: await database(),
      flushed: async id => {
        calls.push(`flushed:${id}`);
      },
      handOff: async input => {
        calls.push(`handoff:${input.threadId}:${input.resourceId}`);
      },
      slugOf: async () => undefined,
    });
    const history = await local.read('ses_a');
    expect(history).toMatchObject({ title: 'Fix login', turns: 1 });
    await local.write('session-1', history);
    expect(calls).toEqual(['import', 'flushed:session-1', 'handoff:thread-1:res-1']);
    expect(imported?.source).toEqual({ openCodeSessionId: 'ses_a', directory: '/work/syncta-back', title: 'Fix login' });
    expect(imported?.turns[0]).toMatchObject({ input: 'Fix it', entries: [{ kind: 'text', text: 'Done.' }] });
    await expect(local.write('other', history)).rejects.toThrow(/not an OpenCode session/);
  });
});
