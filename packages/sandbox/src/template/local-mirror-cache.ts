/**
 * The local adapter of {@link RepositoryCache}: one bare `git` mirror per
 * repository on the server's disk, on the same volume as the sandboxes so a
 * session checkout is a `git clone --local` whose objects are hard links.
 *
 * Layout under the template root: `mirrors/<host>/<owner>/<repo>.git`, its
 * lock `<repo>.git.lock`, and `factory-mirror.json` inside the mirror (clone
 * URL, last fetch, last use, owner). See ADR-0039.
 *
 * Not `git clone --mirror`: its `+refs/*:refs/*` refspec with `--prune` would
 * delete the session work refs kept under `refs/factory/wip/*`, and its
 * `remote.origin.mirror` would make a push mirror everything. The refspecs
 * are explicit, the push URL is disabled, and only our own maintenance packs.
 */

import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExecutableSandbox, SandboxCommandResult } from '../materialization.ts';
import {
  CHECKOUT_COMMAND_TIMEOUT_MS,
  clearWorkdir,
  gitTransfer,
  normalizedRemoteUrl,
  runSandboxCommand,
} from '../github/sandbox.ts';
import { gitProgressReader, withoutGitProgress } from '../setup-progress.ts';
import type { SandboxSetupTransfer } from '../setup-progress.ts';
import { withFileLock } from './file-lock.ts';
import type { FileLockOptions } from './file-lock.ts';
import { hostExecutor } from './host-exec.ts';
import type {
  CachedRepository,
  RepositoryCache,
  RepositoryCheckoutOptions,
  RepositoryCheckoutResult,
  RepositoryRefreshResult,
} from './repository-cache.ts';

/** What a mirror fetches: branches, tags, pull-request heads, and session work published to the remote. */
export const MIRROR_FETCH_REFSPECS = [
  '+refs/heads/*:refs/heads/*',
  '+refs/tags/*:refs/tags/*',
  '+refs/pull/*/head:refs/pull/*/head',
  '+refs/factory/wip/*:refs/factory/origin-wip/*',
] as const;

/** A push from a mirror goes nowhere: the mirror is a cache, never a source. */
const DISABLED_PUSH_URL = 'factory-mirror-never-pushes:';

/** A mirror fetched this recently is not fetched again for a session. */
export const DEFAULT_MIRROR_FRESHNESS_MS = 15_000;
/** Mirrors no project names and nothing used for this long are removed. */
export const DEFAULT_MIRROR_IDLE_MS = 7 * 24 * 60 * 60_000;
/** Leftover temporary refs and directories older than this are removed by maintenance. */
const TEMPORARY_MAX_AGE_MS = 24 * 60 * 60_000;
const META_FILE = 'factory-mirror.json';

export interface MirrorMeta {
  cloneUrl: string;
  createdAt?: string;
  fetchedAt?: string;
  usedAt?: string;
  lastFetchError?: string;
  owner?: { orgId: string; repositoryId: string };
}

export interface LocalMirrorLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface LocalMirrorRepositoryCacheOptions {
  /** The template root; mirrors live under `<root>/mirrors`. */
  root: string;
  /** Runs git on the server host; defaults to {@link hostExecutor}. */
  host?: ExecutableSandbox;
  freshnessMs?: number;
  lock?: FileLockOptions;
  logger?: LocalMirrorLogger;
  now?: () => number;
  /** Test seam: called before each mirror fetch. */
  beforeFetch?: (mirrorPath: string) => Promise<void> | void;
}

const consoleLogger: LocalMirrorLogger = {
  info: (message, meta) => console.info(`[factory:mirror] ${message}`, meta ?? {}),
  warn: (message, meta) => console.warn(`[factory:mirror] ${message}`, meta ?? {}),
};

/** A path segment safe on disk. */
function segment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return safe || '_';
}

/**
 * The mirror's path under `mirrors/`: `<host>/<owner>/<repo>` for an HTTPS
 * URL (GitHub paths lower-cased, `.git` dropped, so both spellings of one
 * repository share a mirror), else `local/<hash>`.
 */
export function mirrorKey(cloneUrl: string): string {
  const normalized = normalizedRemoteUrl(cloneUrl);
  if (normalized) {
    const url = new URL(normalized);
    const parts = url.pathname.split('/').filter(Boolean).map(segment);
    if (parts.length > 0) return [segment(url.host), ...parts].join('/');
  }
  return `local/${createHash('sha256').update(cloneUrl).digest('hex').slice(0, 24)}`;
}

/** Whether two clone URLs name the same repository. */
function sameRepository(a: string, b: string): boolean {
  const left = normalizedRemoteUrl(a);
  const right = normalizedRemoteUrl(b);
  return left !== null && right !== null ? left === right : a === b;
}

type MirrorState = { state: 'ok' } | { state: 'missing' } | { state: 'empty' } | { state: 'corrupt'; reason: string };

function failure(result: SandboxCommandResult): string {
  return (withoutGitProgress(result.stderr) || result.stdout || `exit ${result.exitCode}`).trim().slice(-1000);
}

export class LocalMirrorRepositoryCache implements RepositoryCache {
  readonly kind = 'local-mirror';
  readonly root: string;
  readonly #host: ExecutableSandbox;
  readonly #freshnessMs: number;
  readonly #lock: FileLockOptions;
  readonly #logger: LocalMirrorLogger;
  readonly #now: () => number;
  readonly #beforeFetch: LocalMirrorRepositoryCacheOptions['beforeFetch'];
  readonly #repairs = new Map<string, Promise<void>>();

  constructor(options: LocalMirrorRepositoryCacheOptions) {
    this.root = path.resolve(options.root);
    this.#host = options.host ?? hostExecutor();
    this.#freshnessMs = options.freshnessMs ?? DEFAULT_MIRROR_FRESHNESS_MS;
    this.#lock = options.lock ?? {};
    this.#logger = options.logger ?? consoleLogger;
    this.#now = options.now ?? Date.now;
    this.#beforeFetch = options.beforeFetch;
  }

  /** The executor mirror git runs on (the server host). */
  get host(): ExecutableSandbox {
    return this.#host;
  }

  /** The mirror directory of a repository (whether or not it exists). */
  mirrorPath(cloneUrl: string): string {
    return path.join(this.root, 'mirrors', `${mirrorKey(cloneUrl)}.git`);
  }

  /** Repairs started in the background; tests and shutdown await them. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#repairs.values()]);
  }

  #git(args: string[], options: { env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {}) {
    return runSandboxCommand(this.#host, 'git', args, {
      timeoutMs: options.timeoutMs ?? CHECKOUT_COMMAND_TIMEOUT_MS,
      ...(options.env ? { env: options.env } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  }

  #withLock<T>(mirror: string, fn: () => Promise<T>) {
    return withFileLock(`${mirror}.lock`, fn, {
      ...this.#lock,
      onStale: owner => {
        this.#logger.warn('took over a stale mirror lock', { mirror, owner });
        this.#lock.onStale?.(owner);
      },
    });
  }

  async readMeta(mirror: string): Promise<MirrorMeta | undefined> {
    try {
      return JSON.parse(await readFile(path.join(mirror, META_FILE), 'utf8')) as MirrorMeta;
    } catch {
      return undefined;
    }
  }

  async #writeMeta(mirror: string, change: Partial<MirrorMeta> & { cloneUrl: string }): Promise<void> {
    const current = (await this.readMeta(mirror)) ?? { cloneUrl: change.cloneUrl };
    const next = { ...current, ...change };
    const temporary = path.join(mirror, `${META_FILE}.${randomUUID()}`);
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2));
      await rename(temporary, path.join(mirror, META_FILE));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      // Metadata only steers housekeeping; a full disk must not fail a checkout over it.
      this.#logger.warn('could not write mirror metadata', { mirror, error: String(error) });
    }
  }

  /** True when the mirror holds work of a session that only lives here. */
  async holdsSessionWork(mirror: string): Promise<boolean> {
    const listed = await this.#git(['-C', mirror, 'for-each-ref', '--count=1', '--format=%(refname)', 'refs/factory/wip']);
    if (listed.exitCode === 0) return listed.stdout.trim() !== '';
    // A repository too broken for git: look at the files themselves, and when in doubt keep it.
    try {
      await access(path.join(mirror, 'refs', 'factory', 'wip'));
      return true;
    } catch {
      // Not loose; maybe packed.
    }
    try {
      return (await readFile(path.join(mirror, 'packed-refs'), 'utf8')).includes(' refs/factory/wip/');
    } catch {
      return false;
    }
  }

  async #state(mirror: string, cloneUrl: string): Promise<MirrorState> {
    try {
      await stat(mirror);
    } catch {
      return { state: 'missing' };
    }
    const bare = await this.#git(['-C', mirror, 'rev-parse', '--is-bare-repository']);
    if (bare.exitCode !== 0 || bare.stdout.trim() !== 'true') {
      return { state: 'corrupt', reason: `not a bare repository: ${failure(bare)}` };
    }
    const url = await this.#git(['-C', mirror, 'config', '--get', 'remote.origin.url']);
    if (url.exitCode !== 0 || !sameRepository(url.stdout.trim(), cloneUrl)) {
      return { state: 'corrupt', reason: 'origin does not name this repository' };
    }
    const head = await this.#git(['-C', mirror, 'for-each-ref', '--count=1', '--format=%(objectname)', 'refs/heads']);
    if (head.exitCode !== 0) return { state: 'corrupt', reason: failure(head) };
    const sha = head.stdout.trim();
    if (!sha) return { state: 'empty' };
    const tree = await this.#git(['-C', mirror, 'cat-file', '-e', `${sha}^{tree}`]);
    if (tree.exitCode !== 0) return { state: 'corrupt', reason: `missing objects: ${failure(tree)}` };
    return { state: 'ok' };
  }

  async #configure(mirror: string, cloneUrl: string): Promise<void> {
    const settings: Array<[string, string]> = [
      ['remote.origin.url', cloneUrl],
      ['remote.origin.pushurl', DISABLED_PUSH_URL],
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      ['fetch.writeCommitGraph', 'false'],
      ['core.logAllRefUpdates', 'always'],
      ['core.hooksPath', '/dev/null'],
      ['receive.denyDeletes', 'false'],
    ];
    for (const [key, value] of settings) {
      const set = await this.#git(['-C', mirror, 'config', key, value]);
      if (set.exitCode !== 0) throw new Error(`git config ${key} failed: ${failure(set)}`);
    }
    await this.#git(['-C', mirror, 'config', '--unset-all', 'remote.origin.fetch']);
    for (const refspec of MIRROR_FETCH_REFSPECS) {
      const add = await this.#git(['-C', mirror, 'config', '--add', 'remote.origin.fetch', refspec]);
      if (add.exitCode !== 0) throw new Error(`git config remote.origin.fetch failed: ${failure(add)}`);
    }
  }

  async #fetch(mirror: string, repo: CachedRepository, onTransfer?: (transfer: SandboxSetupTransfer) => void) {
    await this.#beforeFetch?.(mirror);
    let read = gitProgressReader();
    const result = await gitTransfer(this.#host, ['-C', mirror, 'fetch', '--prune', '--progress', 'origin'], {
      ...(repo.authEnv ? { env: repo.authEnv } : {}),
      phase: 'mirror fetch',
      onStderr: chunk => {
        const transfer = read(chunk);
        if (transfer) onTransfer?.(transfer);
      },
      beforeRetry: async () => {
        read = gitProgressReader();
      },
    });
    if (result.exitCode !== 0) throw new Error(`mirror fetch failed: ${failure(result)}`);
    await this.#writeMeta(mirror, {
      cloneUrl: repo.cloneUrl,
      fetchedAt: new Date(this.#now()).toISOString(),
      lastFetchError: '',
      ...(repo.owner ? { owner: repo.owner } : {}),
    });
  }

  /** Create the mirror in a temporary directory and move it into place, so a half-made one is never seen. */
  async #create(mirror: string, repo: CachedRepository, onTransfer?: (transfer: SandboxSetupTransfer) => void) {
    await mkdir(path.dirname(mirror), { recursive: true });
    const temporary = `${mirror}.tmp-${randomUUID()}`;
    try {
      const init = await this.#git(['init', '--bare', '--quiet', temporary]);
      if (init.exitCode !== 0) throw new Error(`git init failed: ${failure(init)}`);
      await this.#configure(temporary, repo.cloneUrl);
      await this.#writeMeta(temporary, {
        cloneUrl: repo.cloneUrl,
        createdAt: new Date(this.#now()).toISOString(),
        ...(repo.owner ? { owner: repo.owner } : {}),
      });
      await this.#fetch(temporary, repo, onTransfer);
      await rename(temporary, mirror);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /** Move a broken mirror out of the way, unless it holds session work, which is never deleted. */
  async #quarantine(mirror: string, reason: string): Promise<boolean> {
    if (await this.holdsSessionWork(mirror)) {
      this.#logger.warn('mirror is broken but holds session work; keeping it', { mirror, reason });
      return false;
    }
    const away = `${mirror}.corrupt-${this.#now()}`;
    this.#logger.warn('mirror is broken; removing it', { mirror, reason });
    await rename(mirror, away);
    await rm(away, { recursive: true, force: true });
    return true;
  }

  /** Session path: see {@link RepositoryCache.checkout}. */
  async checkout(
    sandbox: ExecutableSandbox,
    repo: CachedRepository,
    options: RepositoryCheckoutOptions,
  ): Promise<RepositoryCheckoutResult> {
    const mirror = this.mirrorPath(repo.cloneUrl);
    let result: RepositoryCheckoutResult;
    try {
      const locked = await this.#withLock(mirror, async (): Promise<RepositoryCheckoutResult> => {
        const state = await this.#state(mirror, repo.cloneUrl);
        if (state.state === 'missing') return { source: 'network', reason: 'missing' };
        if (state.state === 'empty') return { source: 'network', reason: 'empty' };
        if (state.state === 'corrupt') {
          await this.#quarantine(mirror, state.reason);
          return { source: 'network', reason: `corrupt: ${state.reason}` };
        }
        let stale: string | undefined;
        const meta = await this.readMeta(mirror);
        const fetchedAt = meta?.fetchedAt ? Date.parse(meta.fetchedAt) : 0;
        if (!(this.#now() - fetchedAt < this.#freshnessMs)) {
          try {
            await this.#fetch(mirror, repo, options.onTransfer);
          } catch (error) {
            stale = error instanceof Error ? error.message : String(error);
            this.#logger.warn('mirror fetch failed; cloning from the mirror as it is', { mirror, reason: stale });
            await this.#writeMeta(mirror, { cloneUrl: repo.cloneUrl, lastFetchError: stale });
          }
        }
        const clone = await runSandboxCommand(
          sandbox,
          'git',
          ['clone', '--local', '--quiet', '--branch', options.branch, '--', mirror, options.workdir],
          { timeoutMs: CHECKOUT_COMMAND_TIMEOUT_MS, phase: 'mirror clone' },
        );
        if (clone.exitCode !== 0) {
          await clearWorkdir(sandbox, options.workdir).catch(() => {});
          return { source: 'network', reason: `clone failed: ${failure(clone)}` };
        }
        const origin = await runSandboxCommand(sandbox, 'git', [
          '-C',
          options.workdir,
          'remote',
          'set-url',
          'origin',
          repo.cloneUrl,
        ]);
        if (origin.exitCode !== 0) {
          await clearWorkdir(sandbox, options.workdir).catch(() => {});
          return { source: 'network', reason: `origin could not be set: ${failure(origin)}` };
        }
        await this.#writeMeta(mirror, {
          cloneUrl: repo.cloneUrl,
          usedAt: new Date(this.#now()).toISOString(),
          ...(repo.owner ? { owner: repo.owner } : {}),
        });
        return { source: 'mirror', ...(stale ? { stale } : {}), lockWaitMs: 0 };
      });
      result = locked.value.source === 'mirror' ? { ...locked.value, lockWaitMs: locked.waitedMs } : locked.value;
    } catch (error) {
      await clearWorkdir(sandbox, options.workdir).catch(() => {});
      result = { source: 'network', reason: error instanceof Error ? error.message : String(error) };
    }
    if (result.source === 'network') {
      this.#logger.warn('session checkout falls back to a network clone', { mirror, reason: result.reason });
      this.#repairInBackground(repo);
    }
    return result;
  }

  /** Create or refresh a mirror the session path could not use, once at a time per mirror. */
  #repairInBackground(repo: CachedRepository): void {
    const mirror = this.mirrorPath(repo.cloneUrl);
    if (this.#repairs.has(mirror)) return;
    const repair = this.refresh(repo)
      .then(
        refreshed =>
          this.#logger.info('mirror repaired in the background', { mirror, created: refreshed.created, ms: refreshed.durationMs }),
        (error: unknown) =>
          this.#logger.warn('background mirror repair failed', { mirror, reason: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => this.#repairs.delete(mirror));
    this.#repairs.set(mirror, repair);
  }

  /** Build path: see {@link RepositoryCache.refresh}. */
  async refresh(
    repo: CachedRepository,
    options: { onTransfer?: (transfer: SandboxSetupTransfer) => void } = {},
  ): Promise<RepositoryRefreshResult> {
    const mirror = this.mirrorPath(repo.cloneUrl);
    const { value, waitedMs } = await this.#withLock(mirror, async () => {
      const started = this.#now();
      const state = await this.#state(mirror, repo.cloneUrl);
      let created = false;
      if (state.state === 'corrupt') {
        const removed = await this.#quarantine(mirror, state.reason);
        if (!removed) {
          // Holds session work: a fetch brings back what the remote has, the work refs stay.
          await this.#configure(mirror, repo.cloneUrl);
          await this.#fetch(mirror, repo, options.onTransfer);
          return { created, durationMs: this.#now() - started };
        }
      }
      if (state.state === 'missing' || state.state === 'corrupt') {
        await this.#create(mirror, repo, options.onTransfer);
        created = true;
      } else {
        await this.#fetch(mirror, repo, options.onTransfer);
      }
      return { created, durationMs: this.#now() - started };
    });
    return { ...value, lockWaitMs: waitedMs };
  }

  async hasCommit(cloneUrl: string, sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{40}$/i.test(sha)) return false;
    const mirror = this.mirrorPath(cloneUrl);
    return (await this.#git(['-C', mirror, 'cat-file', '-e', `${sha}^{commit}`])).exitCode === 0;
  }

  /**
   * Make sure a mirror exists for session work to be kept in, without
   * fetching: an empty, configured mirror is enough to hold refs, and the next
   * build or repair fills it.
   */
  async ensureExists(repo: CachedRepository): Promise<string> {
    const mirror = this.mirrorPath(repo.cloneUrl);
    try {
      await stat(mirror);
      return mirror;
    } catch {
      // Create it below.
    }
    await this.#withLock(mirror, async () => {
      try {
        await stat(mirror);
        return;
      } catch {
        // Still missing.
      }
      await mkdir(path.dirname(mirror), { recursive: true });
      const temporary = `${mirror}.tmp-${randomUUID()}`;
      try {
        const init = await this.#git(['init', '--bare', '--quiet', temporary]);
        if (init.exitCode !== 0) throw new Error(`git init failed: ${failure(init)}`);
        await this.#configure(temporary, repo.cloneUrl);
        await this.#writeMeta(temporary, {
          cloneUrl: repo.cloneUrl,
          createdAt: new Date(this.#now()).toISOString(),
          ...(repo.owner ? { owner: repo.owner } : {}),
        });
        await rename(temporary, mirror);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
    return mirror;
  }

  async maintain(cloneUrl: string): Promise<void> {
    const mirror = this.mirrorPath(cloneUrl);
    try {
      await this.#withLock(mirror, async () => {
        await stat(mirror);
        const gc = await this.#git(
          ['-C', mirror, '-c', 'gc.auto=6700', '-c', 'gc.autoPackLimit=50', 'gc', '--auto', '--quiet'],
          { timeoutMs: 30 * 60_000 },
        );
        if (gc.exitCode !== 0) this.#logger.warn('mirror gc failed', { mirror, reason: failure(gc) });
        await this.#dropOldTemporaryRefs(mirror);
      });
    } catch (error) {
      this.#logger.warn('mirror maintenance failed', { mirror, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Temporary refs a crashed save left behind; their commits are dropped by the next gc. */
  async #dropOldTemporaryRefs(mirror: string): Promise<void> {
    const listed = await this.#git(['-C', mirror, 'for-each-ref', '--format=%(refname) %(objectname) %(creatordate:unix)', 'refs/factory/tmp']);
    if (listed.exitCode !== 0) return;
    for (const line of listed.stdout.split('\n')) {
      const [ref, sha, created] = line.trim().split(' ');
      if (!ref || !sha) continue;
      if (this.#now() - Number(created) * 1000 < TEMPORARY_MAX_AGE_MS) continue;
      await this.#git(['-C', mirror, 'update-ref', '-d', ref, sha]);
    }
  }

  /** Every mirror directory on disk. */
  async listMirrors(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string, depth: number) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name.endsWith('.git')) found.push(full);
        else if (depth < 4 && !/\.(lock|tmp-|corrupt-|stale-)/.test(entry.name)) await walk(full, depth + 1);
      }
    };
    await walk(path.join(this.root, 'mirrors'), 0);
    return found;
  }

  async prune(keep: Iterable<string>, options: { idleMs?: number } = {}): Promise<string[]> {
    const idleMs = options.idleMs ?? DEFAULT_MIRROR_IDLE_MS;
    const kept = new Set([...keep].map(url => this.mirrorPath(url)));
    const removed: string[] = [];
    await this.#removeLeftovers(path.join(this.root, 'mirrors'), 0);
    for (const mirror of await this.listMirrors()) {
      if (kept.has(mirror)) continue;
      const meta = await this.readMeta(mirror);
      const lastUse = Math.max(
        meta?.usedAt ? Date.parse(meta.usedAt) : 0,
        meta?.fetchedAt ? Date.parse(meta.fetchedAt) : 0,
        meta?.createdAt ? Date.parse(meta.createdAt) : 0,
      );
      if (this.#now() - lastUse < idleMs) continue;
      try {
        await this.#withLock(mirror, async () => {
          if (await this.holdsSessionWork(mirror)) return;
          const away = `${mirror}.corrupt-${this.#now()}`;
          await rename(mirror, away);
          await rm(away, { recursive: true, force: true });
          removed.push(mirror);
        });
      } catch (error) {
        this.#logger.warn('mirror prune failed', { mirror, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (removed.length) this.#logger.info('pruned unused mirrors', { removed });
    return removed;
  }

  /** Half-made mirrors and quarantined ones a crash left behind. */
  async #removeLeftovers(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (/\.git\.(tmp-|corrupt-)/.test(entry.name) || /\.lock\.stale-/.test(entry.name)) {
        const age = this.#now() - (await stat(full).then(s => s.mtimeMs, () => this.#now()));
        if (age > TEMPORARY_MAX_AGE_MS) await rm(full, { recursive: true, force: true }).catch(() => {});
      } else if (depth < 4 && !entry.name.endsWith('.git')) {
        await this.#removeLeftovers(full, depth + 1);
      }
    }
  }
}
