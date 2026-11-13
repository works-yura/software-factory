/**
 * A lock on one directory-shaped resource (a repository mirror) that holds
 * across processes and replicas on one machine: an atomic `mkdir` of
 * `<resource>.lock` plus an `owner.json` naming the holder. Inside one process
 * holders queue on a promise chain, so they never poll each other.
 *
 * A holder renews the owner file while it works. A lock is stale, and is taken
 * over, when its holder is a dead process on this host or when it went
 * unrenewed longer than `staleMs` (a holder on another host, or a hung one).
 * Takeover renames the lock directory away first, so of two processes that
 * both find it stale only one wins.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

export const DEFAULT_LOCK_STALE_MS = 10 * 60_000;
export const DEFAULT_LOCK_WAIT_MS = 15 * 60_000;

export interface FileLockOptions {
  /** An unrenewed lock older than this is taken over. */
  staleMs?: number;
  /** How long to wait for the lock before failing with {@link LockTimeoutError}. */
  waitMs?: number;
  /** Poll interval while another process holds the lock. */
  pollMs?: number;
  /** How often the holder renews its owner file; a third of `staleMs` by default. */
  renewMs?: number;
  /** Told when a stale lock is taken over, with the dead holder. */
  onStale?: (owner: LockOwner | undefined) => void;
  now?: () => number;
}

export interface LockOwner {
  host: string;
  pid: number;
  token: string;
  acquiredAt: string;
}

export class LockTimeoutError extends Error {
  constructor(lockPath: string, waitedMs: number) {
    super(`Timed out after ${Math.round(waitedMs / 1000)}s waiting for the lock ${lockPath}.`);
    this.name = 'LockTimeoutError';
  }
}

const inProcess = new Map<string, Promise<unknown>>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive but owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(lockDir: string): Promise<LockOwner | undefined> {
  try {
    return JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8')) as LockOwner;
  } catch {
    return undefined;
  }
}

/** When the lock was last renewed: the owner file's mtime, else the directory's. */
async function lastRenewed(lockDir: string): Promise<number | undefined> {
  for (const candidate of [path.join(lockDir, 'owner.json'), lockDir]) {
    try {
      return (await stat(candidate)).mtimeMs;
    } catch {
      // Try the next one.
    }
  }
  return undefined;
}

async function isStale(lockDir: string, staleMs: number, now: number): Promise<{ stale: boolean; owner?: LockOwner }> {
  const owner = await readOwner(lockDir);
  if (owner && owner.host === hostname() && owner.pid !== process.pid && !pidAlive(owner.pid)) {
    return { stale: true, owner };
  }
  const renewed = await lastRenewed(lockDir);
  // Gone between the failed mkdir and here: not stale, just free; the caller retries.
  if (renewed === undefined) return { stale: false, ...(owner ? { owner } : {}) };
  return { stale: now - renewed > staleMs, ...(owner ? { owner } : {}) };
}

async function acquire(lockDir: string, options: Required<Pick<FileLockOptions, 'staleMs' | 'waitMs' | 'pollMs'>> & FileLockOptions): Promise<{ token: string; waitedMs: number }> {
  const now = options.now ?? Date.now;
  const started = now();
  const token = randomUUID();
  await mkdir(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      await mkdir(lockDir);
      const owner: LockOwner = { host: hostname(), pid: process.pid, token, acquiredAt: new Date(now()).toISOString() };
      await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify(owner));
      return { token, waitedMs: now() - started };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const { stale, owner } = await isStale(lockDir, options.staleMs, now());
    if (stale) {
      const away = `${lockDir}.stale-${randomUUID()}`;
      try {
        await rename(lockDir, away);
        options.onStale?.(owner);
        await rm(away, { recursive: true, force: true });
      } catch {
        // Another process took it over first; go round again.
      }
      continue;
    }
    const waited = now() - started;
    if (waited >= options.waitMs) throw new LockTimeoutError(lockDir, waited);
    await new Promise(resolve => setTimeout(resolve, options.pollMs));
  }
}

async function release(lockDir: string, token: string): Promise<void> {
  const owner = await readOwner(lockDir);
  // A lock taken over as stale belongs to its new holder now.
  if (owner?.token !== token) return;
  await rm(lockDir, { recursive: true, force: true });
}

/**
 * Run `fn` holding the lock `lockDir`. Resolves with its value and how long
 * the caller waited for the lock (in-process queue plus cross-process wait).
 */
export async function withFileLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<{ value: T; waitedMs: number }> {
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? 250;
  const now = options.now ?? Date.now;
  const queuedAt = now();
  const previous = inProcess.get(lockDir) ?? Promise.resolve();
  let done!: () => void;
  const turn = new Promise<void>(resolve => {
    done = resolve;
  });
  const chain = previous.then(() => turn);
  inProcess.set(lockDir, chain);
  try {
    // Waiting behind a holder in this process counts against the same budget.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      previous.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), waitMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (!waited) throw new LockTimeoutError(lockDir, now() - queuedAt);
    const { token } = await acquire(lockDir, { ...options, staleMs, waitMs: Math.max(1, waitMs - (now() - queuedAt)), pollMs });
    const waitedMs = now() - queuedAt;
    const renew = setInterval(
      () => {
        const at = new Date();
        void utimes(path.join(lockDir, 'owner.json'), at, at).catch(() => {});
      },
      options.renewMs ?? Math.max(1000, Math.floor(staleMs / 3)),
    );
    renew.unref?.();
    try {
      return { value: await fn(), waitedMs };
    } finally {
      clearInterval(renew);
      await release(lockDir, token).catch(() => {});
    }
  } finally {
    done();
    if (inProcess.get(lockDir) === chain) inProcess.delete(lockDir);
  }
}
