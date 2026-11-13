/**
 * Puts local sandboxes to sleep (ADR-0039): the folder's work saved and read
 * back (mirror, and the remote's hidden refs), its processes stopped, the
 * folder removed. The next message restores it from the saved work.
 *
 * A sweep sleeps, per Factory, every sandbox idle longer than its policy's
 * `idleMs` and, over `maxActive`, the ones idle longest. Never one where an
 * agent runs or whose setup is under way, never one with work seen within
 * `graceMs` (which also covers a run in another process on this machine:
 * every process touches its running sessions on each sweep). Only folders
 * the server has a record of (owner known) are slept.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { LocalFactorySandbox } from '../local-factory-sandbox.ts';
import { peekSessionSandbox, peekWorkItemFolderSessions, withWorkItemFolderLock } from '../session-sandbox.ts';
import type { SandboxProblem, SandboxRecord, SandboxRegistry } from './sandbox-registry.ts';
import { chooseSandboxesToSleep, DEFAULT_SLEEP_POLICY } from './sleep-policy.ts';
import type { SleepPolicy } from './sleep-policy.ts';

/** What the sleeper needs from the host about sessions. */
export interface SandboxSleeperSessions {
  /**
   * The session is at work: a run in progress, or a run parked on a person's
   * answer or an approval (agent session id).
   */
  isRunning(sessionId: string): boolean;
  /**
   * The session's card is mid-pipeline: its run binding is active, so the next
   * stage may start any moment. Absent: not checked.
   */
  hasActiveBinding?(sessionId: string): Promise<boolean>;
  /** Stop the session's sandbox and drop it from memory, keeping the session; its next message sets it up again. */
  release(sessionId: string): Promise<void>;
}

export interface SandboxView {
  key: string;
  kind: SandboxRecord['kind'];
  orgId?: string;
  factoryProjectId?: string;
  sessionIds: string[];
  repos: string[];
  /** On disk, hard links counted once per folder; absent while asleep or not yet measured. */
  sizeBytes?: number;
  lastActivityAt?: string;
  state: 'active' | 'idle' | 'asleep';
  sleptAt?: string;
  sleepReason?: SandboxRecord['sleepReason'];
  problems: SandboxProblem[];
}

export type SleepOutcome =
  | { outcome: 'slept' }
  | { outcome: 'active' }
  | { outcome: 'missing' }
  | { outcome: 'unknown' }
  | { outcome: 'failed'; message: string };

export interface SweepReport {
  slept: Array<{ key: string; reason: 'idle' | 'limit' }>;
  failed: Array<{ key: string; message: string }>;
  /** Factories still over their limit because every remaining sandbox is active. */
  overLimit: Array<{ factoryProjectId: string; over: number }>;
}

export interface SandboxSleeperLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: SandboxSleeperLogger = {
  info: (message, meta) => console.info(`[factory:sleep] ${message}`, meta ?? {}),
  warn: (message, meta) => console.warn(`[factory:sleep] ${message}`, meta ?? {}),
};

/** Work seen this recently keeps a sandbox awake whatever the policy says. */
export const DEFAULT_SLEEP_GRACE_MS = 10 * 60_000;
/** Over the limit, a sandbox idle less than this stays awake. */
export const DEFAULT_MIN_IDLE_FOR_LIMIT_MS = 30 * 60_000;
const SIZE_CACHE_MS = 5 * 60_000;

export class SandboxSleeper {
  readonly #sandbox: LocalFactorySandbox;
  readonly #registry: SandboxRegistry;
  readonly #sessions: SandboxSleeperSessions;
  readonly #policyFor: (factoryProjectId: string) => Promise<SleepPolicy>;
  readonly #graceMs: number;
  readonly #minIdleForLimitMs: number;
  readonly #now: () => number;
  readonly #logger: SandboxSleeperLogger;
  readonly #sizes = new Map<string, { at: number; bytes: number }>();
  #sweeping: Promise<SweepReport> | undefined;
  readonly #maintain: (() => Promise<void>) | undefined;
  #maintainedAt = 0;

  constructor(options: {
    sandbox: LocalFactorySandbox;
    registry: SandboxRegistry;
    sessions: SandboxSleeperSessions;
    policyFor?: (factoryProjectId: string) => Promise<SleepPolicy>;
    graceMs?: number;
    /** Over the limit, only sandboxes idle at least this long sleep, so a busy machine does not churn. */
    minIdleForLimitMs?: number;
    /** Daily upkeep of the kept refs (the template's `pruneKeptRefsEverywhere`). */
    maintain?: () => Promise<void>;
    now?: () => number;
    logger?: SandboxSleeperLogger;
  }) {
    this.#sandbox = options.sandbox;
    this.#registry = options.registry;
    this.#sessions = options.sessions;
    this.#policyFor = options.policyFor ?? (async () => DEFAULT_SLEEP_POLICY);
    this.#graceMs = options.graceMs ?? DEFAULT_SLEEP_GRACE_MS;
    this.#minIdleForLimitMs = options.minIdleForLimitMs ?? DEFAULT_MIN_IDLE_FOR_LIMIT_MS;
    this.#maintain = options.maintain;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? consoleLogger;
  }

  /**
   * The one rule every decision uses (sweep, list, the manual stop): at work
   * now, or work seen within the grace period (which carries other
   * processes' heartbeats and the Files panel's reads), or its card
   * mid-pipeline.
   */
  async #busy(record: SandboxRecord): Promise<boolean> {
    if (this.#active(record)) return true;
    if (this.#now() - (Date.parse(record.lastActivityAt) || 0) < this.#graceMs) return true;
    if (this.#sessions.hasActiveBinding) {
      for (const sessionId of Object.keys(record.sessions)) {
        if (await this.#sessions.hasActiveBinding(sessionId).catch(() => true)) return true;
      }
    }
    return false;
  }

  /** An agent works in the folder, or a setup for it is under way in this process. */
  #active(record: SandboxRecord): boolean {
    if (Object.keys(record.sessions).some(sessionId => this.#sessions.isRunning(sessionId))) return true;
    const starting = (status: unknown) => status === 'starting' || status === 'pending-start';
    const entries =
      record.kind === 'card'
        ? peekWorkItemFolderSessions(record.key).map(({ entry }) => entry)
        : [peekSessionSandbox(record.key)].filter(entry => entry !== undefined);
    return entries.some(entry => {
      const sandbox = entry.sandbox as { status?: unknown; _startPromise?: unknown };
      return starting(sandbox.status) || Boolean(sandbox._startPromise);
    });
  }

  async #present(key: string): Promise<boolean> {
    const folder = this.#sandbox.folderPathOf(key);
    return Boolean(folder) && (await stat(folder!).then(() => true, () => false));
  }

  async #size(key: string): Promise<number | undefined> {
    const cached = this.#sizes.get(key);
    if (cached && this.#now() - cached.at < SIZE_CACHE_MS) return cached.bytes;
    const bytes = await this.#sandbox.folderSize(key);
    if (bytes !== undefined) this.#sizes.set(key, { at: this.#now(), bytes });
    return bytes;
  }

  /** Every sandbox of a Factory the server knows of: awake ones on disk, and the ones asleep. */
  async list(factoryProjectId: string): Promise<SandboxView[]> {
    const views: SandboxView[] = [];
    for (const record of await this.#registry.list()) {
      if (record.factoryProjectId !== factoryProjectId) continue;
      const present = await this.#present(record.key);
      if (!present && record.state !== 'asleep') continue;
      const state: SandboxView['state'] = !present ? 'asleep' : (await this.#busy(record)) ? 'active' : 'idle';
      const size = present ? await this.#size(record.key) : undefined;
      views.push({
        key: record.key,
        kind: record.kind,
        ...(record.orgId ? { orgId: record.orgId } : {}),
        factoryProjectId,
        sessionIds: Object.keys(record.sessions),
        repos: record.repos ?? [],
        ...(size !== undefined ? { sizeBytes: size } : {}),
        lastActivityAt: record.lastActivityAt,
        state,
        ...(record.sleptAt && state === 'asleep' ? { sleptAt: record.sleptAt } : {}),
        ...(record.sleepReason && state === 'asleep' ? { sleepReason: record.sleepReason } : {}),
        problems: record.problems ?? [],
      });
    }
    return views.sort((a, b) => Date.parse(b.lastActivityAt ?? '0') - Date.parse(a.lastActivityAt ?? '0'));
  }

  /**
   * Put one sandbox to sleep. Never one where an agent works; checked again
   * under the folder's lock, which every setup of the folder also takes.
   */
  async sleep(key: string, reason: 'idle' | 'limit' | 'manual'): Promise<SleepOutcome> {
    const record = await this.#registry.get(key);
    if (!record) return { outcome: 'unknown' };
    return withWorkItemFolderLock(key, async () => {
      const current = (await this.#registry.get(key)) ?? record;
      if (!(await this.#present(key))) return { outcome: 'missing' } as const;
      if (await this.#busy(current)) return { outcome: 'active' } as const;
      try {
        const slept = await this.#sandbox.sleepFolder(key, {
          sessionIds: Object.keys(current.sessions),
          release: sessionId => this.#sessions.release(sessionId),
          stillIdle: async () => !(await this.#busy((await this.#registry.get(key)) ?? current)),
        });
        if (slept === 'active') {
          this.#logger.info('sandbox became active while going to sleep; left awake', { key, reason });
          return { outcome: 'active' } as const;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#logger.warn('sandbox could not be put to sleep; its folder stays', { key, reason, message });
        await this.#registry
          .addProblem(key, { kind: 'save-failed', message })
          .catch(() => {});
        return { outcome: 'failed', message } as const;
      }
      this.#sizes.delete(key);
      await this.#registry.markAsleep(key, { reason });
      this.#logger.info('sandbox put to sleep', { key, reason });
      return { outcome: 'slept' } as const;
    });
  }

  /** Touch the records of sessions running in this process, so other processes see them active. */
  async #heartbeat(records: SandboxRecord[]): Promise<void> {
    for (const record of records) {
      for (const sessionId of Object.keys(record.sessions)) {
        if (!this.#sessions.isRunning(sessionId)) continue;
        await this.#registry.touch(record.key, { kind: record.kind, sessionId }).catch(() => {});
      }
    }
  }

  /** One pass over every Factory's sandboxes; concurrent calls share one pass. */
  sweep(): Promise<SweepReport> {
    this.#sweeping ??= this.#sweep().finally(() => {
      this.#sweeping = undefined;
    });
    return this.#sweeping;
  }

  async #sweep(): Promise<SweepReport> {
    const report: SweepReport = { slept: [], failed: [], overLimit: [] };
    // Once a day, kept refs past the retention go, so they never hold a mirror forever.
    if (this.#maintain && this.#now() - this.#maintainedAt >= 24 * 60 * 60_000) {
      this.#maintainedAt = this.#now();
      await this.#maintain().catch(error => this.#logger.warn('kept-ref maintenance failed', { reason: String(error) }));
    }
    let records = await this.#registry.list();
    await this.#heartbeat(records);
    records = await this.#registry.list();
    const byFactory = new Map<string, SandboxRecord[]>();
    for (const record of records) {
      if (!record.factoryProjectId || !(await this.#present(record.key))) continue;
      const group = byFactory.get(record.factoryProjectId) ?? [];
      group.push(record);
      byFactory.set(record.factoryProjectId, group);
    }
    for (const [factoryProjectId, group] of byFactory) {
      let policy: SleepPolicy;
      try {
        policy = await this.#policyFor(factoryProjectId);
      } catch (error) {
        this.#logger.warn('sleep policy could not be read; skipping this Factory', { factoryProjectId, reason: String(error) });
        continue;
      }
      const candidates = [];
      for (const record of group) {
        candidates.push({ key: record.key, active: await this.#busy(record), lastActivityAt: Date.parse(record.lastActivityAt) || 0 });
      }
      const choice = chooseSandboxesToSleep(candidates, policy, {
        now: this.#now(),
        graceMs: this.#graceMs,
        minIdleForLimitMs: this.#minIdleForLimitMs,
      });
      for (const { key, reason } of choice.sleep) {
        const outcome = await this.sleep(key, reason);
        if (outcome.outcome === 'slept') report.slept.push({ key, reason });
        else if (outcome.outcome === 'failed') report.failed.push({ key, message: outcome.message });
      }
      if (choice.overLimit > 0) {
        report.overLimit.push({ factoryProjectId, over: choice.overLimit });
        this.#logger.warn('more sandboxes awake than the limit, but every one is active; none put to sleep', {
          factoryProjectId,
          limit: policy.maxActive,
          over: choice.overLimit,
        });
      }
    }
    return report;
  }

  /** Start sweeping every `intervalMs`; returns the stop. */
  start(intervalMs: number): () => void {
    const timer = setInterval(() => {
      void this.sweep().catch(error => this.#logger.warn('sandbox sweep failed', { reason: String(error) }));
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

/** A folder key from its path relative to the sandbox root, in `/` form. */
export function sandboxKeyOf(relative: string): string {
  return relative.split(path.sep).join('/');
}
