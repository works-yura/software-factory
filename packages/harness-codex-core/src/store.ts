import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PlanDecision } from '@factory/harness';
import type { MessageAuthor, NotificationRecord, PermissionRequest, PlanGate } from '@factory/harness/transcript';

/** How a thread's turns run: planning (read-only, Codex's plan mode, ends with a plan to approve) or not. */
export type CodexSessionMode = 'planning' | 'default';

/** Input that waits for the next turn: a persisted notification, or signals queued when a gate parked the run. */
export interface CodexPendingInput {
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

export interface CodexThreadState {
  /** Codex's own thread id; every later turn resumes it. */
  codexThreadId?: string;
  /** The thread's mode for its next turn; the session's configured mode when unset. */
  mode?: CodexSessionMode;
  settings: Record<string, unknown>;
  /** The plan gate the thread is parked on. */
  pendingGate?: PlanGate;
  /** The call (or question) the thread is parked on until a person answers. */
  pendingPermission?: PermissionRequest;
  /** Calls a person allowed for the rest of this thread, by transcript tool name. */
  grantedTools?: string[];
  pendingInputs: CodexPendingInput[];
  /** Input that starts a run of its own once the current run ends (a person's follow-up, a high notice mid-run). */
  followUps?: CodexPendingInput[];
  /** Recent signal ids Codex received, newest last; the dispatcher's replay guard reads them. */
  deliveredIds: string[];
  /** Recent notification dedupe keys, newest last. */
  dedupeKeys: string[];
}

export interface CodexSessionRecord {
  sessionId: string;
  threadId: string;
  resourceId?: string;
  /** Where Codex runs. Fixed after the first turn. */
  cwd?: string;
  /** The account (credential pool id) the session's latest turn ran on; the next turn prefers it. */
  accountId?: string;
  threads: Record<string, CodexThreadState>;
  updatedAt: string;
}

/** Where Codex sessions keep what must survive a restart. */
export interface CodexSessionStore {
  get(sessionId: string): Promise<CodexSessionRecord | undefined>;
  put(record: CodexSessionRecord): Promise<void>;
  list(): Promise<CodexSessionRecord[]>;
}

export function emptyCodexThreadState(): CodexThreadState {
  return { settings: {}, pendingInputs: [], deliveredIds: [], dedupeKeys: [] };
}

const clone = <T>(value: T): T => structuredClone(value);

export function createInMemoryCodexSessionStore(): CodexSessionStore {
  const records = new Map<string, CodexSessionRecord>();
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
export function createJsonFileCodexSessionStore(directory: string): CodexSessionStore {
  let ready: Promise<unknown> | undefined;
  const ensureDir = () => (ready ??= mkdir(directory, { recursive: true }));
  let writes = 0;

  const read = async (file: string): Promise<CodexSessionRecord | undefined> => {
    try {
      return JSON.parse(await readFile(join(directory, file), 'utf8')) as CodexSessionRecord;
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
      return records.filter((record): record is CodexSessionRecord => record !== undefined);
    },
  };
}
