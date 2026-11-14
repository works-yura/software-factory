// The person's own OpenCode sessions (`~/.local/share/opencode/opencode.db`), read for an import they
// asked for: listed, and one read into transcript turns. Read only, with the database opened
// read-only by this process; OpenCode is never run against it, nothing is written to it, and no
// agent reads it (ADR-0043, amendment). Only where the server runs on the person's own machine.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { TranscriptEntry } from '@factory/harness/transcript';

import { openCodeToolCall } from './events.ts';
import type { OpenCodeImportedTurn } from './session.ts';

/** One of the person's OpenCode sessions, as the import list shows it. */
export interface LocalOpenCodeSession {
  id: string;
  title: string;
  /** The folder OpenCode ran in. */
  directory: string;
  /** The project's root folder (its git worktree), when OpenCode knew one. */
  worktree?: string;
  /** ISO time of its last change. */
  updatedAt: string;
  /** How many messages it holds (the person's and the agent's). */
  messages: number;
}

/** How long a tool's output may be in imported history; the rest is cut with a note. */
export const IMPORTED_TOOL_OUTPUT_CHARS = 4_000;
/** The most sessions the list offers, newest first. */
export const LOCAL_SESSION_LIST_LIMIT = 100;

/** Where OpenCode keeps a person's database: `$XDG_DATA_HOME/opencode/opencode.db`, `~/.local/share` by default. */
export function localOpenCodeDatabasePath(env: Record<string, string | undefined> = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'opencode.db');
}

export class LocalOpenCodeSessionsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LocalOpenCodeSessionsError';
  }
}

type Row = Record<string, unknown>;

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const parse = (value: unknown): Row => {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Row) : {};
  } catch {
    return {};
  }
};
const iso = (ms: unknown): string => new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : 0).toISOString();

/**
 * The person's OpenCode database, opened read-only for one read and closed after. A missing
 * database is an error that says where it was looked for: nothing is made up in its place.
 */
function withDatabase<T>(path: string, read: (db: DatabaseSync) => T): T {
  if (!existsSync(path)) throw new LocalOpenCodeSessionsError(`No OpenCode database at ${path}: OpenCode has not run on this machine as this user.`);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new LocalOpenCodeSessionsError(`Could not open the OpenCode database at ${path} read-only.`, { cause: error });
  }
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    return read(db);
  } catch (error) {
    if (error instanceof LocalOpenCodeSessionsError) throw error;
    throw new LocalOpenCodeSessionsError(`Could not read the OpenCode database at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    db.close();
  }
}

/** The person's top-level OpenCode sessions (not subagents', not archived), newest first. */
export function listLocalOpenCodeSessions(path: string, limit = LOCAL_SESSION_LIST_LIMIT): LocalOpenCodeSession[] {
  return withDatabase(path, db => {
    const rows = db
      .prepare(
        `SELECT s.id, s.title, s.directory, s.time_updated, p.worktree,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages
           FROM session s LEFT JOIN project p ON p.id = s.project_id
          WHERE s.parent_id IS NULL AND s.time_archived IS NULL
          ORDER BY s.time_updated DESC
          LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, LOCAL_SESSION_LIST_LIMIT))) as Row[];
    return rows.map(row => {
      const worktree = text(row.worktree);
      return {
        id: String(row.id),
        title: text(row.title)?.trim() || String(row.id),
        directory: text(row.directory) ?? '',
        ...(worktree && worktree !== '/' ? { worktree } : {}),
        updatedAt: iso(row.time_updated),
        messages: Number(row.messages ?? 0),
      };
    });
  });
}

function clip(output: string): string {
  if (output.length <= IMPORTED_TOOL_OUTPUT_CHARS) return output;
  return `${output.slice(0, IMPORTED_TOOL_OUTPUT_CHARS)}\n… (${output.length - IMPORTED_TOOL_OUTPUT_CHARS} more characters left out on import)`;
}

/** One assistant part as transcript entries; parts that say nothing to a reader (step marks, patches) are left out. */
function partEntries(part: Row, messageId: string): TranscriptEntry[] {
  switch (part.type) {
    case 'text': {
      const body = text(part.text);
      return body?.trim() && part.synthetic !== true ? [{ kind: 'text', text: body, messageId }] : [];
    }
    case 'reasoning': {
      const body = text(part.text);
      return body?.trim() ? [{ kind: 'thinking', text: body, messageId }] : [];
    }
    case 'tool': {
      const callId = text(part.callID) ?? text(part.id);
      const tool = text(part.tool);
      const state = part.state && typeof part.state === 'object' ? (part.state as Row) : {};
      if (!callId || !tool) return [];
      const { toolName, input } = openCodeToolCall(tool, state.input);
      const entries: TranscriptEntry[] = [{ kind: 'tool_call', toolCallId: callId, toolName, input }];
      if (state.status === 'completed') entries.push({ kind: 'tool_result', toolCallId: callId, content: clip(text(state.output) ?? ''), isError: false });
      else if (state.status === 'error') entries.push({ kind: 'tool_result', toolCallId: callId, content: clip(text(state.error) ?? 'The call failed.'), isError: true });
      else entries.push({ kind: 'tool_result', toolCallId: callId, content: 'The call never finished in OpenCode.', isError: true });
      return entries;
    }
    default:
      return [];
  }
}

/** The session's title and folder, for the import's record. */
export interface LocalOpenCodeSessionHistory {
  session: LocalOpenCodeSession;
  turns: OpenCodeImportedTurn[];
}

/**
 * One of the person's OpenCode sessions as transcript turns, in order: each of their messages,
 * then the replies that followed it. Text, thinking, tool calls and results come over (long tool
 * output cut); attachments and file snapshots do not.
 */
export function readLocalOpenCodeSession(path: string, sessionId: string): LocalOpenCodeSessionHistory {
  return withDatabase(path, db => {
    const head = db
      .prepare(
        `SELECT s.id, s.title, s.directory, s.time_updated, s.parent_id, p.worktree,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages
           FROM session s LEFT JOIN project p ON p.id = s.project_id WHERE s.id = ?`,
      )
      .get(sessionId) as Row | undefined;
    if (!head) throw new LocalOpenCodeSessionsError(`OpenCode has no session ${sessionId} on this machine.`);
    const worktree = text(head.worktree);
    const session: LocalOpenCodeSession = {
      id: String(head.id),
      title: text(head.title)?.trim() || String(head.id),
      directory: text(head.directory) ?? '',
      ...(worktree && worktree !== '/' ? { worktree } : {}),
      updatedAt: iso(head.time_updated),
      messages: Number(head.messages ?? 0),
    };
    const messages = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(sessionId) as Row[];
    const parts = db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(sessionId) as Row[];
    const partsOf = new Map<string, Row[]>();
    for (const part of parts) {
      const id = String(part.message_id);
      const list = partsOf.get(id);
      const parsed = parse(part.data);
      if (list) list.push(parsed);
      else partsOf.set(id, [parsed]);
    }
    const turns: OpenCodeImportedTurn[] = [];
    let current: OpenCodeImportedTurn | undefined;
    for (const message of messages) {
      const id = String(message.id);
      const data = parse(message.data);
      const own = partsOf.get(id) ?? [];
      if (data.role === 'user') {
        const input = own
          .filter(part => part.type === 'text' && part.synthetic !== true)
          .map(part => text(part.text) ?? '')
          .join('\n\n')
          .trim();
        current = { input, entries: [] };
        turns.push(current);
        continue;
      }
      if (data.role !== 'assistant') continue;
      if (!current) {
        current = { entries: [] };
        turns.push(current);
      }
      const provider = text(data.providerID);
      const model = text(data.modelID);
      if (provider && model) current.model = `${provider}/${model}`;
      for (const part of own) current.entries.push(...partEntries(part, id));
    }
    return { session, turns: turns.filter(turn => turn.input || turn.entries.length > 0) };
  });
}
