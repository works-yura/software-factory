/**
 * A session's work outside its folder, so losing the folder loses nothing
 * (ADR-0039; the backlog's «Присипляння замість паузи»).
 *
 * Two refs per branch, wherever they are kept:
 * - `refs/factory/wip/heads/<branch>` — the branch's commits;
 * - `refs/factory/wip/tree/<branch>` — uncommitted work, new non-ignored files
 *   included, as a commit whose parent is the branch tip.
 *
 * {@link SessionWork} snapshots a checkout (without touching its working tree
 * or index), saves the snapshot into every {@link SessionWorkStore} it was
 * given, and restores a fresh checkout from the first store that has one,
 * never overwriting commits the remote branch does not contain.
 */

import { randomUUID } from 'node:crypto';

import type { ExecutableSandbox, SandboxCommandResult } from '../materialization.ts';
import { isValidGitRef } from '../git-ref.ts';
import { gitTransfer, runSandboxCommand } from '../github/sandbox.ts';

export const SESSION_WORK_HEADS = 'refs/factory/wip/heads/';
export const SESSION_WORK_TREES = 'refs/factory/wip/tree/';
/** Where a restore lands the objects it loaded in the checkout, until it is done. */
const RESTORE_REFS = 'refs/factory/restore/';
const ZERO = '0000000000000000000000000000000000000000';
const COMMAND_TIMEOUT_MS = 5 * 60_000;

/** The identity a snapshot commit is made with; it never reaches a branch. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Factory',
  GIT_AUTHOR_EMAIL: 'factory@localhost',
  GIT_COMMITTER_NAME: 'Factory',
  GIT_COMMITTER_EMAIL: 'factory@localhost',
};

/** A checkout of one repository inside some sandbox. */
export interface SessionCheckout {
  sandbox: ExecutableSandbox;
  /** The checkout directory. */
  dir: string;
  /** Its repository's clean clone URL (its `origin`). */
  cloneUrl: string;
  /** Process-scoped credentials for talking to `origin`, when a store or restore needs the network. */
  authEnv?: Record<string, string>;
}

/** What a checkout holds right now. */
export interface SessionWorkSnapshot {
  branch: string;
  /** The branch tip. */
  head: string;
  /** The uncommitted-work commit (parent `head`), absent when the tree is clean. */
  tree?: string;
}

export interface LoadedSessionWork {
  /** Where it came from, for logs and the chat (`mirror`, `mirror-published`, `remote`). */
  from: string;
  head: string;
  tree?: string;
}

/** Port: somewhere a session's work is kept. */
export interface SessionWorkStore {
  readonly kind: string;
  /** Keep the snapshot; resolves only once the stored refs were read back as the snapshot's commits. */
  save(checkout: SessionCheckout, snapshot: SessionWorkSnapshot): Promise<void>;
  /** Bring the branch's saved work into the checkout's object store, if this store has any. */
  load(checkout: SessionCheckout, branch: string): Promise<LoadedSessionWork | undefined>;
  /** Drop the branch's saved work. */
  forget(checkout: Pick<SessionCheckout, 'cloneUrl' | 'authEnv'> & Partial<SessionCheckout>, branch: string): Promise<void>;
  /** True when this store already sees what the sleep store published, so restore need not ask it. */
  coversPublished?(checkout: Pick<SessionCheckout, 'cloneUrl'>): Promise<boolean>;
}

/** Saves into every store (all must succeed) and loads from the first that has the branch. */
export class CompositeSessionWorkStore implements SessionWorkStore {
  readonly kind: string;
  readonly #stores: SessionWorkStore[];

  constructor(stores: SessionWorkStore[]) {
    this.#stores = stores;
    this.kind = stores.map(store => store.kind).join('+') || 'none';
  }

  async save(checkout: SessionCheckout, snapshot: SessionWorkSnapshot): Promise<void> {
    for (const store of this.#stores) await store.save(checkout, snapshot);
  }

  async load(checkout: SessionCheckout, branch: string): Promise<LoadedSessionWork | undefined> {
    for (const store of this.#stores) {
      const loaded = await store.load(checkout, branch);
      if (loaded) return loaded;
    }
    return undefined;
  }

  async forget(checkout: Parameters<SessionWorkStore['forget']>[0], branch: string): Promise<void> {
    for (const store of this.#stores) await store.forget(checkout, branch);
  }
}

export class SessionWorkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionWorkError';
  }
}

function output(result: SandboxCommandResult): string {
  return (result.stderr || result.stdout || `exit ${result.exitCode}`).trim().slice(-1000);
}

export async function runGitIn(
  sandbox: ExecutableSandbox,
  dir: string,
  args: string[],
  env?: Record<string, string>,
): Promise<SandboxCommandResult> {
  return runSandboxCommand(sandbox, 'git', ['-C', dir, ...args], {
    timeoutMs: COMMAND_TIMEOUT_MS,
    ...(env ? { env } : {}),
  });
}

async function gitOk(sandbox: ExecutableSandbox, dir: string, args: string[], env?: Record<string, string>): Promise<string> {
  const result = await runGitIn(sandbox, dir, args, env);
  if (result.exitCode !== 0) throw new SessionWorkError(`git ${args[0]} failed: ${output(result)}`);
  return result.stdout.trim();
}

async function resolveRef(sandbox: ExecutableSandbox, dir: string, ref: string): Promise<string | undefined> {
  const result = await runGitIn(sandbox, dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

/** `git merge-base --is-ancestor a b`: true, false, or undefined when it cannot tell. */
async function isAncestor(sandbox: ExecutableSandbox, dir: string, a: string, b: string): Promise<boolean | undefined> {
  const result = await runGitIn(sandbox, dir, ['merge-base', '--is-ancestor', a, b]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return undefined;
}

/** Refs in `<repository>` set to the expected values in one transaction; old values guard against a concurrent writer. */
export async function updateRefsAtomically(
  sandbox: ExecutableSandbox,
  repository: string,
  updates: Array<{ ref: string; next: string | null; old: string | null }>,
): Promise<boolean> {
  const lines = updates.map(update =>
    update.next === null
      ? `delete ${update.ref} ${update.old ?? ''}`.trim()
      : `update ${update.ref} ${update.next} ${update.old ?? ZERO}`,
  );
  const script = `printf '%s\\n' ${lines.map(line => `'${line}'`).join(' ')} | git -C '${repository.replace(/'/g, `'\\''`)}' update-ref --stdin`;
  const result = await runSandboxCommand(sandbox, 'sh', ['-c', script], { timeoutMs: COMMAND_TIMEOUT_MS });
  return result.exitCode === 0;
}

export interface SessionWorkRestore {
  /** `none`: nothing saved; `restored`: the branch now holds saved work; `remote`: the remote branch already contains it. */
  outcome: 'none' | 'restored' | 'remote';
  from?: string;
  /** The saved commits and the remote branch went apart: the branch keeps the saved ones, the remote stays at `origin/<branch>`. */
  diverged?: { saved: string; remote: string };
  /** What became of the uncommitted work. */
  tree?: 'restored' | 'conflict';
}

export interface SessionWorkLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: SessionWorkLogger = {
  info: (message, meta) => console.info(`[factory:session-work] ${message}`, meta ?? {}),
  warn: (message, meta) => console.warn(`[factory:session-work] ${message}`, meta ?? {}),
};

/**
 * The provider-neutral service. `store` keeps every save (the local mirror);
 * `sleepStore` is added on top when the folder goes to sleep (card closed):
 * the remote's hidden ref, which outlives the server's disk.
 */
export class SessionWork {
  readonly store: SessionWorkStore;
  readonly sleepStore: SessionWorkStore | undefined;
  readonly #logger: SessionWorkLogger;

  constructor(options: { store: SessionWorkStore; sleepStore?: SessionWorkStore; logger?: SessionWorkLogger }) {
    this.store = options.store;
    this.sleepStore = options.sleepStore;
    this.#logger = options.logger ?? consoleLogger;
  }

  /**
   * What the checkout holds: its branch, tip and uncommitted work. Uses a
   * throwaway index, so the session's index and working tree stay exactly as
   * they were and no hook runs. `undefined` for a detached or unborn HEAD.
   */
  async snapshot(checkout: Pick<SessionCheckout, 'sandbox' | 'dir'>): Promise<SessionWorkSnapshot | undefined> {
    const { sandbox, dir } = checkout;
    const branchResult = await runGitIn(sandbox, dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : '';
    if (!branch || !isValidGitRef(branch)) return undefined;
    const head = await resolveRef(sandbox, dir, 'HEAD');
    if (!head) return undefined;
    const indexPath = await gitOk(sandbox, dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const scratch = `${indexPath}.factory-snapshot-${randomUUID()}`;
    try {
      // Start from the real index so staged state and intent-to-add entries carry over.
      const seeded = await runSandboxCommand(sandbox, 'sh', ['-c', 'if [ -f "$1" ]; then cp "$1" "$2"; fi', 'sh', indexPath, scratch]);
      if (seeded.exitCode !== 0) throw new SessionWorkError(`could not copy the index: ${output(seeded)}`);
      const env = { GIT_INDEX_FILE: scratch };
      await gitOk(sandbox, dir, ['add', '--all', '--', '.'], env);
      const tree = await gitOk(sandbox, dir, ['write-tree'], env);
      const headTree = await gitOk(sandbox, dir, ['rev-parse', `${head}^{tree}`]);
      if (tree === headTree) return { branch, head };
      const commit = await gitOk(
        sandbox,
        dir,
        ['commit-tree', tree, '-p', head, '-m', `factory: uncommitted work on ${branch}`],
        SNAPSHOT_IDENTITY,
      );
      return { branch, head, tree: commit };
    } finally {
      await runSandboxCommand(sandbox, 'rm', ['-f', '--', scratch]).catch(() => {});
    }
  }

  /**
   * Snapshot the checkout and keep it. With `sleep`, the sleep store keeps it
   * too. Throws when any store failed: the caller must then keep the folder.
   */
  async save(checkout: SessionCheckout, options: { sleep?: boolean } = {}): Promise<SessionWorkSnapshot | undefined> {
    const snapshot = await this.snapshot(checkout);
    if (!snapshot) return undefined;
    await this.store.save(checkout, snapshot);
    if (options.sleep && this.sleepStore) await this.sleepStore.save(checkout, snapshot);
    return snapshot;
  }

  /**
   * Restore a fresh checkout's branch from saved work, before the branch
   * checkout runs. Saved work wins over the remote branch unless the remote
   * already contains it; when the two went apart the saved commits stay on the
   * branch and the remote stays at `origin/<branch>`. Uncommitted work comes
   * back as uncommitted changes; a conflict leaves the checkout as it was and
   * the saved ref in place.
   */
  async restore(checkout: SessionCheckout, branch: string): Promise<SessionWorkRestore> {
    const { sandbox, dir } = checkout;
    if (!isValidGitRef(branch)) return { outcome: 'none' };
    // Restoring switches branches and applies changes: only into a checkout with nothing of its own in flight.
    const status = await runGitIn(sandbox, dir, ['status', '--porcelain']);
    if (status.exitCode !== 0 || status.stdout.trim()) {
      const local = await resolveRef(sandbox, dir, `refs/heads/${branch}`);
      if (!local) this.#logger.warn('saved session work not restored: the checkout has changes of its own', { dir, branch });
      return { outcome: 'none' };
    }
    let loaded = await this.store.load(checkout, branch);
    if (!loaded && this.sleepStore && !(await this.store.coversPublished?.(checkout))) {
      loaded = await this.sleepStore.load(checkout, branch).catch((error: unknown) => {
        // The remote being unreachable must not stop a session that has nothing saved there.
        this.#logger.warn('could not ask the remote for saved session work', {
          dir,
          branch,
          reason: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      });
    }
    if (!loaded) return { outcome: 'none' };
    try {
      const remote = await this.#remoteHead(checkout, branch);
      let chosen = loaded.head;
      let diverged: SessionWorkRestore['diverged'];
      if (remote && remote !== loaded.head) {
        const remoteContainsSaved = await isAncestor(sandbox, dir, loaded.head, remote);
        if (remoteContainsSaved) {
          chosen = remote;
        } else if (!(await isAncestor(sandbox, dir, remote, loaded.head))) {
          diverged = { saved: loaded.head, remote };
          this.#logger.warn('saved session work and the remote branch diverged; keeping the saved commits', {
            dir,
            branch,
            saved: loaded.head,
            remote,
          });
        }
      }
      const current = await runGitIn(sandbox, dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (current.exitCode === 0 && current.stdout.trim() === branch) {
        await gitOk(sandbox, dir, ['reset', '--keep', chosen]);
      } else {
        await gitOk(sandbox, dir, ['checkout', '--quiet', '-B', branch, chosen]);
      }
      // Track the remote branch when there is one, as a resumed branch does.
      if (remote) await runGitIn(sandbox, dir, ['branch', '--quiet', `--set-upstream-to=origin/${branch}`, branch]);
      let tree: SessionWorkRestore['tree'];
      if (loaded.tree) tree = await this.#applyTree(checkout, loaded.tree, branch);
      const outcome: SessionWorkRestore['outcome'] = chosen === loaded.head ? 'restored' : 'remote';
      return { outcome, from: loaded.from, ...(diverged ? { diverged } : {}), ...(tree ? { tree } : {}) };
    } finally {
      await this.#dropRestoreRefs(checkout);
    }
  }

  /** The remote branch's tip in the checkout: the fresh `origin/<branch>`, else asked of the remote. */
  async #remoteHead(checkout: SessionCheckout, branch: string): Promise<string | undefined> {
    const { sandbox, dir } = checkout;
    const tracked = await resolveRef(sandbox, dir, `refs/remotes/origin/${branch}`);
    if (tracked) return tracked;
    // A network clone of one branch knows nothing of the session branch: ask the remote.
    const probe = await gitTransfer(sandbox, ['-C', dir, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`], {
      ...(checkout.authEnv ? { env: checkout.authEnv } : {}),
      timeoutMs: COMMAND_TIMEOUT_MS,
      phase: 'session work remote probe',
    });
    if (probe.exitCode !== 0 || !probe.stdout.trim()) return undefined;
    const fetched = await gitTransfer(
      sandbox,
      ['-C', dir, 'fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { ...(checkout.authEnv ? { env: checkout.authEnv } : {}), timeoutMs: COMMAND_TIMEOUT_MS, phase: 'session work remote fetch' },
    );
    if (fetched.exitCode !== 0) {
      // Without the remote's commits nothing can be compared; keeping the saved work loses nothing.
      this.#logger.warn('could not fetch the remote session branch to compare with saved work', { dir, branch, reason: output(fetched) });
      return undefined;
    }
    return resolveRef(sandbox, dir, `refs/remotes/origin/${branch}`);
  }

  async #applyTree(checkout: SessionCheckout, tree: string, branch: string): Promise<'restored' | 'conflict'> {
    const { sandbox, dir } = checkout;
    const picked = await runGitIn(sandbox, dir, ['cherry-pick', '--no-commit', '--allow-empty', tree], SNAPSHOT_IDENTITY);
    if (picked.exitCode !== 0) {
      await runGitIn(sandbox, dir, ['cherry-pick', '--abort']);
      await runGitIn(sandbox, dir, ['reset', '--quiet', '--hard', 'HEAD']);
      this.#logger.warn('saved uncommitted work does not apply; left in the saved ref', { dir, branch, tree, reason: output(picked) });
      return 'conflict';
    }
    // Back to plain uncommitted changes: modified files unstaged, new files untracked.
    await gitOk(sandbox, dir, ['reset', '--quiet']);
    return 'restored';
  }

  async #dropRestoreRefs(checkout: SessionCheckout): Promise<void> {
    const listed = await runGitIn(checkout.sandbox, checkout.dir, ['for-each-ref', '--format=%(refname)', RESTORE_REFS]);
    for (const ref of listed.stdout.split('\n').map(line => line.trim()).filter(Boolean)) {
      await runGitIn(checkout.sandbox, checkout.dir, ['update-ref', '-d', ref]);
    }
  }

  async forget(checkout: Parameters<SessionWorkStore['forget']>[0], branch: string, options: { sleep?: boolean } = {}): Promise<void> {
    await this.store.forget(checkout, branch);
    if (options.sleep && this.sleepStore) await this.sleepStore.forget(checkout, branch);
  }
}

/** Where a store's loaded refs go in the checkout. */
export function restoreRef(kind: 'head' | 'tree'): string {
  return `${RESTORE_REFS}${kind}`;
}
