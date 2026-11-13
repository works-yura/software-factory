/**
 * What the server knows about each local sandbox folder beyond the disk:
 * whose it is (organization, Factory, sessions), when it last saw work, and
 * whether it sleeps; plus the problems the person must hear about (a save
 * that failed before a removal, saved commits set aside). One JSON file per
 * folder under `<template root>/sandboxes/`, written atomically, so every
 * process on the machine (two replicas) reads the same records (ADR-0039).
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type SandboxKind = 'card' | 'session';

export interface SandboxSessionRecord {
  /** The session's row id, which names its own folder and its saved work. */
  rowId?: string;
  lastActivityAt: string;
}

/** A problem with the sandbox's kept work the person should hear about. */
export interface SandboxProblem {
  kind: 'save-failed' | 'superseded' | 'public-repository' | 'processes-unchecked';
  message: string;
  at: string;
  /** Stable per occurrence, for the attention list's read state. */
  occurrence: string;
}

export interface SandboxRecord {
  /** The folder relative to the sandbox root: `<session row id>` or `work-items/<factory>/<card>`. */
  key: string;
  kind: SandboxKind;
  orgId?: string;
  factoryProjectId?: string;
  /** Sessions that worked in the folder, by agent session id. */
  sessions: Record<string, SandboxSessionRecord>;
  lastActivityAt: string;
  state: 'awake' | 'asleep';
  sleptAt?: string;
  sleepReason?: 'idle' | 'limit' | 'manual';
  /** Repository slugs of its checkouts, as last seen. */
  repos?: string[];
  problems?: SandboxProblem[];
}

export class SandboxRegistry {
  readonly #dir: string;
  readonly #now: () => number;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: { root: string; now?: () => number }) {
    this.#dir = path.join(path.resolve(options.root), 'sandboxes');
    this.#now = options.now ?? Date.now;
  }

  #file(key: string): string {
    return path.join(this.#dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  }

  async get(key: string): Promise<SandboxRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.#file(key), 'utf8')) as SandboxRecord;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<SandboxRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const records: SandboxRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        records.push(JSON.parse(await readFile(path.join(this.#dir, name), 'utf8')) as SandboxRecord);
      } catch {
        // A record half-written by a crash is skipped until its next write.
      }
    }
    return records;
  }

  /** Change one record, one change at a time per folder; `undefined` from `change` removes it. */
  async #update(key: string, change: (current: SandboxRecord | undefined) => SandboxRecord | undefined): Promise<SandboxRecord | undefined> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const updated = change(await this.get(key));
      const file = this.#file(key);
      if (!updated) {
        await rm(file, { force: true });
        return undefined;
      }
      await mkdir(this.#dir, { recursive: true });
      const temporary = `${file}.${randomUUID()}`;
      try {
        await writeFile(temporary, JSON.stringify(updated, null, 2));
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      return updated;
    });
    this.#queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.#queues.get(key) === next) this.#queues.delete(key);
    }
  }

  /** Work was seen in the folder: it is awake, and the session and owner are recorded. */
  touch(
    key: string,
    input: { kind: SandboxKind; sessionId?: string; rowId?: string; orgId?: string; factoryProjectId?: string; repos?: string[] },
  ): Promise<SandboxRecord | undefined> {
    const at = new Date(this.#now()).toISOString();
    return this.#update(key, current => {
      const sessions = { ...current?.sessions };
      if (input.sessionId) {
        sessions[input.sessionId] = { ...(input.rowId ? { rowId: input.rowId } : {}), lastActivityAt: at };
      }
      const { sleptAt: _sleptAt, sleepReason: _sleepReason, ...rest } = current ?? ({} as Partial<SandboxRecord>);
      return {
        ...rest,
        key,
        kind: input.kind,
        ...(input.orgId ? { orgId: input.orgId } : current?.orgId ? { orgId: current.orgId } : {}),
        ...(input.factoryProjectId
          ? { factoryProjectId: input.factoryProjectId }
          : current?.factoryProjectId
            ? { factoryProjectId: current.factoryProjectId }
            : {}),
        sessions,
        lastActivityAt: at,
        state: 'awake',
        ...(input.repos ? { repos: input.repos } : current?.repos ? { repos: current.repos } : {}),
      };
    });
  }

  markAsleep(key: string, input: { reason: 'idle' | 'limit' | 'manual'; repos?: string[] }): Promise<SandboxRecord | undefined> {
    return this.#update(key, current =>
      current
        ? {
            ...current,
            state: 'asleep',
            sleptAt: new Date(this.#now()).toISOString(),
            sleepReason: input.reason,
            ...(input.repos ? { repos: input.repos } : {}),
            // A save that succeeded settles the failure it replaced.
            problems: (current.problems ?? []).filter(problem => problem.kind !== 'save-failed'),
          }
        : undefined,
    );
  }

  /** Record a problem; one of each kind is kept, the newest. */
  addProblem(key: string, problem: Omit<SandboxProblem, 'at' | 'occurrence'>, defaults: Partial<SandboxRecord> = {}): Promise<SandboxRecord | undefined> {
    const at = new Date(this.#now()).toISOString();
    return this.#update(key, current => {
      const base: SandboxRecord = current ?? {
        key,
        kind: defaults.kind ?? 'session',
        sessions: {},
        lastActivityAt: at,
        state: 'awake',
        ...(defaults.orgId ? { orgId: defaults.orgId } : {}),
        ...(defaults.factoryProjectId ? { factoryProjectId: defaults.factoryProjectId } : {}),
      };
      return {
        ...base,
        problems: [...(base.problems ?? []).filter(existing => existing.kind !== problem.kind), { ...problem, at, occurrence: at }],
      };
    });
  }

  /** The person dealt with it, or a later save made it moot. */
  clearProblem(key: string, kind: SandboxProblem['kind']): Promise<SandboxRecord | undefined> {
    return this.#update(key, current =>
      current ? { ...current, problems: (current.problems ?? []).filter(problem => problem.kind !== kind) } : undefined,
    );
  }

  /** The folder is gone for good (its card closed, its session deleted). */
  remove(key: string): Promise<void> {
    return this.#update(key, () => undefined).then(() => {});
  }
}
