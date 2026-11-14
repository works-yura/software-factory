import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it } from 'vitest';

import { IMPORTED_TOOL_OUTPUT_CHARS, listLocalOpenCodeSessions, localOpenCodeDatabasePath, LocalOpenCodeSessionsError, readLocalOpenCodeSession } from './local-sessions.ts';

let path: string;

/** A database in OpenCode's own shape (the tables and columns the reader touches). */
function seed(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  const run = (sql: string, ...values: Array<string | number | null>) => db.prepare(sql).run(...values);
  run('INSERT INTO project VALUES (?, ?)', 'prj_1', '/work/app');
  run('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'ses_a', 'prj_1', null, '/work/app', 'Fix login', 1, 2000, null);
  run('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'ses_b', 'prj_1', null, '/work/app', 'Older', 1, 1000, null);
  run('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'ses_child', 'prj_1', 'ses_a', '/work/app', 'Subagent', 1, 3000, null);
  run('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'ses_old', 'prj_1', null, '/work/app', 'Archived', 1, 4000, 5000);
  const message = (id: string, at: number, data: object) => run('INSERT INTO message VALUES (?, ?, ?, ?, ?)', id, 'ses_a', at, at, JSON.stringify(data));
  const part = (id: string, messageId: string, at: number, data: object) => run('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)', id, messageId, 'ses_a', at, at, JSON.stringify(data));
  message('msg_1', 10, { role: 'user' });
  part('prt_1', 'msg_1', 10, { type: 'text', text: 'Fix the login bug' });
  part('prt_2', 'msg_1', 11, { type: 'text', text: 'internal reminder', synthetic: true });
  message('msg_2', 20, { role: 'assistant', providerID: 'opencode', modelID: 'big-pickle' });
  part('prt_3', 'msg_2', 20, { type: 'step-start' });
  part('prt_4', 'msg_2', 21, { type: 'reasoning', text: 'Look at auth.ts' });
  part('prt_5', 'msg_2', 22, { type: 'tool', callID: 'call_1', tool: 'read', state: { status: 'completed', input: { filePath: 'auth.ts' }, output: 'x'.repeat(IMPORTED_TOOL_OUTPUT_CHARS + 10) } });
  part('prt_6', 'msg_2', 23, { type: 'tool', callID: 'call_2', tool: 'bash', state: { status: 'error', input: { command: 'npm test' }, error: 'failed' } });
  part('prt_7', 'msg_2', 24, { type: 'text', text: 'Fixed the check.' });
  db.close();
}

beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), 'opencode-local-')), 'opencode.db');
  seed(path);
});

describe('the person’s own OpenCode sessions', () => {
  it('lists top-level sessions newest first, leaving subagents and archived ones out', () => {
    const sessions = listLocalOpenCodeSessions(path);
    expect(sessions.map(session => [session.id, session.title, session.messages])).toEqual([
      ['ses_a', 'Fix login', 2],
      ['ses_b', 'Older', 0],
    ]);
    expect(sessions[0]).toMatchObject({ directory: '/work/app', worktree: '/work/app' });
  });

  it('reads a session as turns: the person’s words, then the reply as text, thinking and tool calls', () => {
    const { session, turns } = readLocalOpenCodeSession(path, 'ses_a');
    expect(session.title).toBe('Fix login');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.input).toBe('Fix the login bug');
    expect(turns[0]!.model).toBe('opencode/big-pickle');
    expect(turns[0]!.entries.map(entry => entry.kind)).toEqual(['thinking', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'text']);
    const output = turns[0]!.entries[2] as { content: string };
    expect(output.content).toContain('more characters left out on import');
    expect(turns[0]!.entries[4]).toMatchObject({ kind: 'tool_result', content: 'failed', isError: true });
  });

  it('opens the database read-only and changes nothing in it', async () => {
    const before = await readFile(path);
    listLocalOpenCodeSessions(path);
    readLocalOpenCodeSession(path, 'ses_a');
    expect((await readFile(path)).equals(before)).toBe(true);
  });

  it('says where it looked when there is no database, and when the session is not there', () => {
    expect(() => listLocalOpenCodeSessions(join(tmpdir(), 'nowhere', 'opencode.db'))).toThrow(LocalOpenCodeSessionsError);
    expect(() => readLocalOpenCodeSession(path, 'ses_missing')).toThrow(/no session ses_missing/);
  });

  it('finds the database where OpenCode keeps it', () => {
    expect(localOpenCodeDatabasePath({ HOME: '/home/me' })).toBe('/home/me/.local/share/opencode/opencode.db');
    expect(localOpenCodeDatabasePath({ HOME: '/home/me', XDG_DATA_HOME: '/data' })).toBe('/data/opencode/opencode.db');
  });
});
