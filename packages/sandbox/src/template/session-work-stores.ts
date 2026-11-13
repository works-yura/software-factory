/**
 * Adapters of {@link SessionWorkStore}:
 * - {@link MirrorSessionWorkStore} keeps the refs in the repository's local
 *   mirror: no network, every turn;
 * - {@link RemoteHiddenRefSessionWorkStore} pushes them to the remote under
 *   `refs/factory/wip/*` (not a branch: no CI, not in the branch list), from
 *   inside whichever sandbox holds the checkout, so any provider can use it.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

import {
  GIT_TRANSFER_STALL_BYTES_PER_SECOND,
  GIT_TRANSFER_STALL_SECONDS,
  gitTransfer,
  runSandboxCommand,
} from '../github/sandbox.ts';
import type { LocalMirrorRepositoryCache } from './local-mirror-cache.ts';
import {
  SessionWorkError,
  runGitIn,
  restoreRef,
  updateRefsAtomically,
} from './session-work.ts';
import type { LoadedSessionWork, SessionCheckout, SessionWorkSnapshot, SessionWorkStore } from './session-work.ts';

/** Where the mirror keeps work published to the remote (its fetch maps `refs/factory/wip/*` here). */
const PUBLISHED_PREFIX = 'refs/factory/origin-wip/';
const SAVE_ATTEMPTS = 3;
const TRANSFER_TIMEOUT_MS = 5 * 60_000;
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

function headRef(branch: string, prefix = 'refs/factory/wip/') {
  return `${prefix}heads/${branch}`;
}
function treeRef(branch: string, prefix = 'refs/factory/wip/') {
  return `${prefix}tree/${branch}`;
}

async function resolveIn(checkout: Pick<SessionCheckout, 'sandbox'>, repository: string, ref: string) {
  const result = await runGitIn(checkout.sandbox, repository, ['rev-parse', '--verify', '--quiet', ref]);
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

export class MirrorSessionWorkStore implements SessionWorkStore {
  readonly kind = 'mirror';
  readonly #cache: LocalMirrorRepositoryCache;

  constructor(cache: LocalMirrorRepositoryCache) {
    this.#cache = cache;
  }

  /**
   * Objects go into the mirror under temporary refs first; one `update-ref`
   * transaction then moves the work refs (guarded by their old values) and
   * drops the temporary ones, and the result is read back. A crash in between
   * leaves only temporary refs, which maintenance removes.
   */
  async save(checkout: SessionCheckout, snapshot: SessionWorkSnapshot): Promise<void> {
    const mirror = await this.#cache.ensureExists({ cloneUrl: checkout.cloneUrl });
    const id = randomUUID();
    const temporaryHead = `refs/factory/tmp/${id}/head`;
    const temporaryTree = `refs/factory/tmp/${id}/tree`;
    const pushed = await runGitIn(checkout.sandbox, checkout.dir, [
      ...NO_HOOKS,
      'push',
      '--no-verify',
      '--quiet',
      mirror,
      `${snapshot.head}:${temporaryHead}`,
      ...(snapshot.tree ? [`${snapshot.tree}:${temporaryTree}`] : []),
    ]);
    if (pushed.exitCode !== 0) {
      throw new SessionWorkError(`could not copy the work into the mirror: ${(pushed.stderr || pushed.stdout).trim().slice(-1000)}`);
    }
    const heads = headRef(snapshot.branch);
    const trees = treeRef(snapshot.branch);
    let saved = false;
    for (let attempt = 0; attempt < SAVE_ATTEMPTS && !saved; attempt++) {
      const oldHead = await resolveIn(checkout, mirror, heads);
      const oldTree = await resolveIn(checkout, mirror, trees);
      const updates = [
        ...(oldHead === snapshot.head ? [] : [{ ref: heads, next: snapshot.head, old: oldHead }]),
        ...(snapshot.tree
          ? oldTree === snapshot.tree
            ? []
            : [{ ref: trees, next: snapshot.tree, old: oldTree }]
          : oldTree
            ? [{ ref: trees, next: null, old: oldTree }]
            : []),
        { ref: temporaryHead, next: null, old: snapshot.head },
        ...(snapshot.tree ? [{ ref: temporaryTree, next: null, old: snapshot.tree }] : []),
      ];
      saved = await updateRefsAtomically(checkout.sandbox, mirror, updates);
    }
    if (!saved) throw new SessionWorkError('the mirror refs changed under every save attempt');
    const head = await resolveIn(checkout, mirror, heads);
    const tree = await resolveIn(checkout, mirror, trees);
    if (head !== snapshot.head || tree !== (snapshot.tree ?? null)) {
      throw new SessionWorkError(`the saved refs read back as ${head}/${tree}, not ${snapshot.head}/${snapshot.tree ?? 'none'}`);
    }
  }

  async load(checkout: SessionCheckout, branch: string): Promise<LoadedSessionWork | undefined> {
    const mirror = this.#cache.mirrorPath(checkout.cloneUrl);
    try {
      await stat(mirror);
    } catch {
      return undefined;
    }
    for (const [prefix, from] of [
      ['refs/factory/wip/', 'mirror'],
      [PUBLISHED_PREFIX, 'mirror-published'],
    ] as const) {
      const head = await resolveIn(checkout, mirror, headRef(branch, prefix));
      if (!head) continue;
      const tree = await resolveIn(checkout, mirror, treeRef(branch, prefix));
      const fetched = await runGitIn(checkout.sandbox, checkout.dir, [
        'fetch',
        '--no-tags',
        '--quiet',
        mirror,
        `+${headRef(branch, prefix)}:${restoreRef('head')}`,
        ...(tree ? [`+${treeRef(branch, prefix)}:${restoreRef('tree')}`] : []),
      ]);
      if (fetched.exitCode !== 0) {
        throw new SessionWorkError(`could not load saved work from the mirror: ${(fetched.stderr || fetched.stdout).trim().slice(-1000)}`);
      }
      return { from, head, ...(tree ? { tree } : {}) };
    }
    return undefined;
  }

  /** Whether the mirror's last fetch brought in the work published to the remote, so asking the remote adds nothing. */
  async coversPublished(checkout: Pick<SessionCheckout, 'cloneUrl'>): Promise<boolean> {
    const meta = await this.#cache.readMeta(this.#cache.mirrorPath(checkout.cloneUrl));
    return Boolean(meta?.fetchedAt) && !meta?.lastFetchError;
  }

  async forget(checkout: Parameters<SessionWorkStore['forget']>[0], branch: string): Promise<void> {
    const mirror = this.#cache.mirrorPath(checkout.cloneUrl);
    try {
      await stat(mirror);
    } catch {
      return;
    }
    const sandbox = checkout.sandbox ?? this.#cache.host;
    for (const ref of [headRef(branch), treeRef(branch)]) {
      const sha = await resolveIn({ sandbox }, mirror, ref);
      if (sha) await runGitIn(sandbox, mirror, ['update-ref', '-d', ref, sha]);
    }
  }
}

export class RemoteHiddenRefSessionWorkStore implements SessionWorkStore {
  readonly kind = 'remote-hidden-ref';

  #env(checkout: Pick<SessionCheckout, 'authEnv'>): Record<string, string> {
    return checkout.authEnv ?? {};
  }

  /** A push stalls out like a fetch does (c17061a0), instead of hanging to the command guard. */
  #pushEnv(checkout: Pick<SessionCheckout, 'authEnv'>): Record<string, string> {
    return {
      GIT_HTTP_LOW_SPEED_LIMIT: String(GIT_TRANSFER_STALL_BYTES_PER_SECOND),
      GIT_HTTP_LOW_SPEED_TIME: String(GIT_TRANSFER_STALL_SECONDS),
      ...this.#env(checkout),
    };
  }

  async #remoteRefs(checkout: SessionCheckout, branch: string): Promise<Map<string, string>> {
    const listed = await gitTransfer(
      checkout.sandbox,
      ['-C', checkout.dir, 'ls-remote', 'origin', headRef(branch), treeRef(branch)],
      { env: this.#env(checkout), timeoutMs: TRANSFER_TIMEOUT_MS, phase: 'hidden ref probe' },
    );
    if (listed.exitCode !== 0) {
      throw new SessionWorkError(`could not list the remote's saved work: ${(listed.stderr || listed.stdout).trim().slice(-1000)}`);
    }
    const refs = new Map<string, string>();
    for (const line of listed.stdout.split('\n')) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (sha && ref) refs.set(ref, sha);
    }
    return refs;
  }

  async save(checkout: SessionCheckout, snapshot: SessionWorkSnapshot): Promise<void> {
    const before = await this.#remoteRefs(checkout, snapshot.branch);
    const refspecs = [
      `+${snapshot.head}:${headRef(snapshot.branch)}`,
      ...(snapshot.tree
        ? [`+${snapshot.tree}:${treeRef(snapshot.branch)}`]
        : before.has(treeRef(snapshot.branch))
          ? [`:${treeRef(snapshot.branch)}`]
          : []),
    ];
    // A push is never retried: only reads are.
    const pushed = await runSandboxCommand(
      checkout.sandbox,
      'git',
      ['-C', checkout.dir, ...NO_HOOKS, 'push', '--no-verify', '--quiet', '--atomic', 'origin', ...refspecs],
      { env: this.#pushEnv(checkout), timeoutMs: TRANSFER_TIMEOUT_MS, phase: 'hidden ref push' },
    );
    if (pushed.exitCode !== 0) {
      throw new SessionWorkError(`could not publish the work to the remote: ${(pushed.stderr || pushed.stdout).trim().slice(-1000)}`);
    }
    const after = await this.#remoteRefs(checkout, snapshot.branch);
    if (after.get(headRef(snapshot.branch)) !== snapshot.head || (after.get(treeRef(snapshot.branch)) ?? undefined) !== snapshot.tree) {
      throw new SessionWorkError('the remote did not keep the published work');
    }
  }

  async load(checkout: SessionCheckout, branch: string): Promise<LoadedSessionWork | undefined> {
    const refs = await this.#remoteRefs(checkout, branch);
    const head = refs.get(headRef(branch));
    if (!head) return undefined;
    const tree = refs.get(treeRef(branch));
    const fetched = await gitTransfer(
      checkout.sandbox,
      [
        '-C',
        checkout.dir,
        'fetch',
        '--no-tags',
        '--quiet',
        'origin',
        `+${headRef(branch)}:${restoreRef('head')}`,
        ...(tree ? [`+${treeRef(branch)}:${restoreRef('tree')}`] : []),
      ],
      { env: this.#env(checkout), timeoutMs: TRANSFER_TIMEOUT_MS, phase: 'hidden ref fetch' },
    );
    if (fetched.exitCode !== 0) {
      throw new SessionWorkError(`could not fetch the remote's saved work: ${(fetched.stderr || fetched.stdout).trim().slice(-1000)}`);
    }
    return { from: 'remote', head, ...(tree ? { tree } : {}) };
  }

  async forget(checkout: Parameters<SessionWorkStore['forget']>[0], branch: string): Promise<void> {
    if (!checkout.sandbox || !checkout.dir) return;
    const full = checkout as SessionCheckout;
    const refs = await this.#remoteRefs(full, branch);
    const deletes = [headRef(branch), treeRef(branch)].filter(ref => refs.has(ref)).map(ref => `:${ref}`);
    if (!deletes.length) return;
    const pushed = await runSandboxCommand(full.sandbox, 'git', ['-C', full.dir, ...NO_HOOKS, 'push', '--no-verify', '--quiet', 'origin', ...deletes], {
      env: this.#pushEnv(full),
      timeoutMs: TRANSFER_TIMEOUT_MS,
      phase: 'hidden ref delete',
    });
    if (pushed.exitCode !== 0) {
      throw new SessionWorkError(`could not delete the remote's saved work: ${(pushed.stderr || pushed.stdout).trim().slice(-1000)}`);
    }
  }
}

