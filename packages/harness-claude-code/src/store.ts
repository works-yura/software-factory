import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PlanGate } from './events.ts';
import type { ClaudeSessionMode } from './cli.ts';

/** Input that waits for the next turn: a persisted notification, or signals queued when a gate parked the run. */
export interface ClaudePendingInput {
  kind: 'signal' | 'notification';
  text: string;
  id?: string;
}

export interface ClaudeThreadState {
  /** The CLI's own session id; every later turn resumes it. */
  claudeSessionId?: string;
  /** The thread's mode for its next turn; the session's configured mode when unset. */
  mode?: ClaudeSessionMode;
  settings: Record<string, unknown>;
  /** The plan gate the thread is parked on. */
  pendingGate?: PlanGate;
  pendingInputs: ClaudePendingInput[];
  /** Recent signal ids Claude received, newest last; the dispatcher's replay guard reads them. */
  deliveredIds: string[];
  /** Recent notification dedupe keys, newest last. */
  dedupeKeys: string[];
}

export interface ClaudeSessionRecord {
  sessionId: string;
  threadId: string;
  resourceId?: string;
  /** Where the CLI runs. Fixed after the first turn: the CLI files sessions by project directory. */
  cwd?: string;
  threads: Record<string, ClaudeThreadState>;
  updatedAt: string;
}

/** Where Claude Code sessions keep what must survive a restart. */
export interface ClaudeSessionStore {
  get(sessionId: string): Promise<ClaudeSessionRecord | undefined>;
  put(record: ClaudeSessionRecord): Promise<void>;
  list(): Promise<ClaudeSessionRecord[]>;
}

export function emptyThreadState(): ClaudeThreadState {
  return { settings: {}, pendingInputs: [], deliveredIds: [], dedupeKeys: [] };
}

const clone = <T>(value: T): T => structuredClone(value);

export function createInMemorySessionStore(): ClaudeSessionStore {
  const records = new Map<string, ClaudeSessionRecord>();
  return {
    get: async sessionId => {
      const record = records.get(sessionId);
      return record ? clone(record) : undefined;
    },
    put: async record => {
      records.set(record.sessionId, clone(record));
    },
    list: async () => [...records.values()].map(clone),
  };
}

function fileName(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}.json`;
}

/** One JSON file per session, replaced atomically so a crash mid-write never leaves half a record. */
export function createJsonFileSessionStore(directory: string): ClaudeSessionStore {
  let ready: Promise<unknown> | undefined;
  const ensureDir = () => (ready ??= mkdir(directory, { recursive: true }));
  let writes = 0;

  const read = async (file: string): Promise<ClaudeSessionRecord | undefined> => {
    try {
      return JSON.parse(await readFile(join(directory, file), 'utf8')) as ClaudeSessionRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };

  return {
    get: sessionId => read(fileName(sessionId)),
    async put(record) {
      await ensureDir();
      const target = join(directory, fileName(record.sessionId));
      const temp = `${target}.${process.pid}.${(writes += 1)}.tmp`;
      await writeFile(temp, JSON.stringify(record, null, 2));
      await rename(temp, target);
    },
    async list() {
      await ensureDir();
      const files = (await readdir(directory)).filter(file => file.endsWith('.json'));
      const records = await Promise.all(files.map(read));
      return records.filter((record): record is ClaudeSessionRecord => record !== undefined);
    },
  };
}
