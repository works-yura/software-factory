import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PlanDecision } from '@factory/harness';
import type { MessageAuthor, NotificationRecord, PermissionRequest, PlanGate } from '@factory/harness/transcript';

/** How a thread's turns run: planning (OpenCode's read-only `plan` agent, ends with a plan to approve) or not. */
export type OpenCodeSessionMode = 'planning' | 'default';

/** Input that waits for the next turn: a persisted notification, or signals queued when a gate parked the run. */
export interface OpenCodePendingInput {
  kind: 'signal' | 'notification';
  text: string;
  id?: string;
  /** The prompt that answers a gate; the transcript records the decision instead of an input. */
  gate?: true;
  /** A plan answer queued for the next turn (`queuePlanAnswer`); recorded when that turn starts. */
  planDecision?: { toolCallId: string; decision: PlanDecision };
  author?: MessageAuthor;
  notification?: NotificationRecord;
  /** Already recorded in the transcript. */
  echoed?: true;
}

export interface OpenCodeThreadState {
  /** OpenCode's own session id; every later turn goes on in it. */
  openCodeSessionId?: string;
  /** The thread's mode for its next turn; the session's configured mode when unset. */
  mode?: OpenCodeSessionMode;
  settings: Record<string, unknown>;
  /** The plan gate the thread is parked on. */
  pendingGate?: PlanGate;
  /** The call (or question) the thread is parked on until a person answers. */
  pendingPermission?: PermissionRequest;
  /** Calls a person allowed for the rest of this thread, by transcript tool name. */
  grantedTools?: string[];
  pendingInputs: OpenCodePendingInput[];
  /** Input that starts a run of its own once the current run ends (a person's follow-up). */
  followUps?: OpenCodePendingInput[];
  /** Recent signal ids OpenCode received, newest last; the dispatcher's replay guard reads them. */
  deliveredIds: string[];
  /** Recent notification dedupe keys, newest last. */
  dedupeKeys: string[];
}

export interface OpenCodeSessionRecord {
  sessionId: string;
  threadId: string;
  resourceId?: string;
  /** Where OpenCode runs. Fixed after the first turn. */
  cwd?: string;
  threads: Record<string, OpenCodeThreadState>;
  updatedAt: string;
}

/** Where OpenCode sessions keep what must survive a restart. */
export interface OpenCodeSessionStore {
  get(sessionId: string): Promise<OpenCodeSessionRecord | undefined>;
  put(record: OpenCodeSessionRecord): Promise<void>;
  list(): Promise<OpenCodeSessionRecord[]>;
  /** Forgets a session's record (it moved to another harness, or was deleted). */
  delete?(sessionId: string): Promise<void>;
}

export function emptyOpenCodeThreadState(): OpenCodeThreadState {
  return { settings: {}, pendingInputs: [], deliveredIds: [], dedupeKeys: [] };
}

const clone = <T>(value: T): T => structuredClone(value);

export function createInMemoryOpenCodeSessionStore(): OpenCodeSessionStore {
  const records = new Map<string, OpenCodeSessionRecord>();
  return {
    get: async sessionId => {
      const record = records.get(sessionId);
      return record ? clone(record) : undefined;
    },
    put: async record => {
      records.set(record.sessionId, clone(record));
    },
    list: async () => [...records.values()].map(clone),
    delete: async sessionId => {
      records.delete(sessionId);
    },
  };
}

function fileName(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}.json`;
}

/** One JSON file per session, replaced atomically so a crash mid-write never leaves half a record. */
export function createJsonFileOpenCodeSessionStore(directory: string): OpenCodeSessionStore {
  let ready: Promise<unknown> | undefined;
  const ensureDir = () => (ready ??= mkdir(directory, { recursive: true }));
  let writes = 0;

  const read = async (file: string): Promise<OpenCodeSessionRecord | undefined> => {
    try {
      return JSON.parse(await readFile(join(directory, file), 'utf8')) as OpenCodeSessionRecord;
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
      return records.filter((record): record is OpenCodeSessionRecord => record !== undefined);
    },
    async delete(sessionId) {
      await rm(join(directory, fileName(sessionId)), { force: true });
    },
  };
}
