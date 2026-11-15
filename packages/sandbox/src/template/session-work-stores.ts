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
import { SessionWorkError, runGitIn, restoreRef, updateRefsAtomically } from './session-work.ts';
import type {
  LoadedSessionWork,
  SessionCheckout,
  SessionWorkExpected,
  SessionWorkSaveResult,
  SessionWorkSnapshot,
  SessionWorkStore,
} from './session-work.ts';

/** Where the mirror keeps work published to the remote (its fetch maps `refs/factory/wip/*` here). */
const PUBLISHED_PREFIX = 'refs/factory/origin-wip/';
const SAVE_ATTEMPTS = 3;
const TRANSFER_TIMEOUT_MS = 5 * 60_000;
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

/**
 * The receiving side of a push into the mirror, trusting the mirror. Git starts it for a local
 * path with the repository-local variables cleared, `GIT_CONFIG_COUNT` among them, so the trust the
 * agent user's environment carries (ADR-0041) does not reach it, and a mirror the server owns is
 * then refused as "dubious ownership".
 */
export function trustedReceivePack(mirror: string): string {
  const trusted = `safe.directory=${mirror}`.replaceAll("'", `'\\''`);
  return `--receive-pack=git -c '${trusted}' receive-pack`;
}

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
  readonly #now: () => number;

  constructor(cache: LocalMirrorRepositoryCache, options: { now?: () => number } = {}) {
    this.#cache = cache;
    this.#now = options.now ?? Date.now;
  }

  /** The mirror to keep work in; made (empty, no network) when there is none, owner recorded. */
  async #mirrorFor(checkout: SessionCheckout): Promise<string> {
    return this.#cache.ensureExists({ cloneUrl: checkout.cloneUrl, ...(checkout.owner ? { owner: checkout.owner } : {}) });
  }

  /** Copy commits from the checkout into the mirror under one temporary ref each; answers their names. */
  async #pushTemporary(checkout: SessionCheckout, mirror: string, commits: string[]): Promise<string[]> {
    const id = randomUUID();
    const refs = commits.map((_, index) => `refs/factory/tmp/${id}/${index}`);
    const pushed = await runGitIn(checkout.sandbox, checkout.dir, [
      ...NO_HOOKS,
      'push',
      '--no-verify',
      '--quiet',
      trustedReceivePack(mirror),
      mirror,
      ...commits.map((commit, index) => `${commit}:${refs[index]}`),
    ]);
    if (pushed.exitCode !== 0) {
      throw new SessionWorkError(`could not copy the work into the mirror: ${(pushed.stderr || pushed.stdout).trim().slice(-1000)}`);
    }
    return refs;
  }

  /**
   * Objects go into the mirror under temporary refs first; one `update-ref`
   * transaction then moves the work refs (guarded by their old values) and
   * drops the temporary ones, and the result is read back. A crash in between
   * leaves only temporary refs, which maintenance removes.
   *
   * Saved commits the new tip does not contain are never replaced: they move
   * to `refs/factory/wip/superseded/<branch>/<time>` in the same transaction
   * (a restore that failed or was skipped, then new work from the base).
   */
  async save(checkout: SessionCheckout, snapshot: SessionWorkSnapshot): Promise<SessionWorkSaveResult> {
    const mirror = await this.#mirrorFor(checkout);
    const commits = [snapshot.head, ...(snapshot.tree ? [snapshot.tree] : [])];
    const temporary = await this.#pushTemporary(checkout, mirror, commits);
    const heads = headRef(snapshot.branch);
    const trees = treeRef(snapshot.branch);
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      const oldHead = await resolveIn(checkout, mirror, heads);
      const oldTree = await resolveIn(checkout, mirror, trees);
      let superseded: SessionWorkSaveResult['superseded'];
      if (oldHead && oldHead !== snapshot.head && (await this.#losesWork(checkout, mirror, oldHead, snapshot.head))) {
        superseded = { ref: `refs/factory/wip/superseded/${snapshot.branch}/${this.#now()}`, head: oldHead };
      }
      const updates = [
        ...(oldHead === snapshot.head ? [] : [{ ref: heads, next: snapshot.head, old: oldHead }]),
        ...(superseded ? [{ ref: superseded.ref, next: superseded.head, old: null }] : []),
        ...(snapshot.tree
          ? oldTree === snapshot.tree
            ? []
            : [{ ref: trees, next: snapshot.tree, old: oldTree }]
          : oldTree
            ? [{ ref: trees, next: null, old: oldTree }]
            : []),
        ...temporary.map((ref, index) => ({ ref, next: null, old: commits[index]! })),
      ];
      if (await updateRefsAtomically(checkout.sandbox, mirror, updates)) {
        const head = await resolveIn(checkout, mirror, heads);
        const tree = await resolveIn(checkout, mirror, trees);
        if (head !== snapshot.head || tree !== (snapshot.tree ?? null)) {
          throw new SessionWorkError(`the saved refs read back as ${head}/${tree}, not ${snapshot.head}/${snapshot.tree ?? 'none'}`);
        }
        return superseded ? { superseded } : {};
      }
    }
    throw new SessionWorkError('the mirror refs changed under every save attempt');
  }

  /**
   * Whether replacing `oldHead` with `newHead` would lose work: a commit of
   * the old tip that no remote branch holds and whose change (patch-id) the
   * new tip does not carry. An amend that keeps the change or a rebase is not
   * a loss; a dropped commit is. When git cannot tell, the old commits are kept.
   */
  async #losesWork(checkout: SessionCheckout, mirror: string, oldHead: string, newHead: string): Promise<boolean> {
    const contained = await runGitIn(checkout.sandbox, mirror, ['merge-base', '--is-ancestor', oldHead, newHead]);
    if (contained.exitCode === 0) return false;
    const unpublished = await runGitIn(checkout.sandbox, mirror, ['rev-list', oldHead, '--not', newHead, '--branches']);
    if (unpublished.exitCode !== 0) return true;
    const candidates = new Set(unpublished.stdout.split('\n').map(line => line.trim()).filter(Boolean));
    if (candidates.size === 0) return false;
    const cherry = await runGitIn(checkout.sandbox, mirror, ['cherry', newHead, oldHead]);
    if (cherry.exitCode !== 0) return true;
    return cherry.stdout
      .split('\n')
      .map(line => line.trim())
      .some(line => line.startsWith('+ ') && candidates.has(line.slice(2)));
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

  async hasSaved(checkout: SessionCheckout, branch: string): Promise<boolean> {
    const ref = await runGitIn(checkout.sandbox, this.#cache.mirrorPath(checkout.cloneUrl), ['rev-parse', '--verify', '--quiet', headRef(branch)]);
    return ref.exitCode === 0;
  }

  /** Whether the mirror's last fetch brought in the work published to the remote, so asking the remote adds nothing. */
  async coversPublished(checkout: Pick<SessionCheckout, 'cloneUrl'>): Promise<boolean> {
    const meta = await this.#cache.readMeta(this.#cache.mirrorPath(checkout.cloneUrl));
    return Boolean(meta?.fetchedAt) && !meta?.lastFetchError;
  }

  /**
   * Set uncommitted work that did not apply aside under
   * `refs/factory/wip/conflict/<branch>/<time>`, and drop it from the
   * branch's tree ref (only if that still holds it), so no later save
   * replaces it. Protected like all of `refs/factory/wip/`.
   */
  async keepConflict(checkout: SessionCheckout, branch: string, tree: string): Promise<string> {
    const mirror = await this.#mirrorFor(checkout);
    const [temporary] = await this.#pushTemporary(checkout, mirror, [tree]);
    const ref = `refs/factory/wip/conflict/${branch}/${this.#now()}`;
    const current = await resolveIn(checkout, mirror, treeRef(branch));
    const ok = await updateRefsAtomically(checkout.sandbox, mirror, [
      { ref, next: tree, old: null },
      ...(current === tree ? [{ ref: treeRef(branch), next: null, old: tree }] : []),
      { ref: temporary!, next: null, old: tree },
    ]);
    if (!ok) throw new SessionWorkError('could not set the conflicting work aside in the mirror');
    return ref;
  }

  /**
   * Move the branch's refs that still hold `expected` to
   * `refs/factory/trash/<time>/…` (`LocalEnvironmentTemplate.pruneKeptRefs` drops it after the retention):
   * another session's later save of the same branch is left alone, and a
   * mistaken forget can be undone.
   */
  async forget(checkout: Parameters<SessionWorkStore['forget']>[0], branch: string, expected: SessionWorkExpected): Promise<void> {
    const mirror = this.#cache.mirrorPath(checkout.cloneUrl);
    try {
      await stat(mirror);
    } catch {
      return;
    }
    const sandbox = checkout.sandbox ?? this.#cache.host;
    const at = this.#now();
    const updates: Array<{ ref: string; next: string | null; old: string | null }> = [];
    for (const [ref, kind, wanted] of [
      [headRef(branch), 'heads', expected.head],
      [treeRef(branch), 'tree', expected.tree],
    ] as const) {
      if (!wanted) continue;
      const sha = await resolveIn({ sandbox }, mirror, ref);
      if (sha !== wanted) continue;
      updates.push({ ref: `refs/factory/trash/${at}/${kind}/${branch}`, next: sha, old: null }, { ref, next: null, old: sha });
    }
    if (updates.length && !(await updateRefsAtomically(sandbox, mirror, updates))) {
      throw new SessionWorkError('the saved refs changed while they were being forgotten');
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

  async save(checkout: SessionCheckout, snapshot: SessionWorkSnapshot): Promise<SessionWorkSaveResult> {
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
    return {};
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

  /** Delete the published refs that still hold `expected`, each guarded by that value (`--force-with-lease`). */
  async forget(checkout: Parameters<SessionWorkStore['forget']>[0], branch: string, expected: SessionWorkExpected): Promise<void> {
    if (!checkout.sandbox || !checkout.dir) return;
    const full = checkout as SessionCheckout;
    const refs = await this.#remoteRefs(full, branch);
    const doomed = (
      [
        [headRef(branch), expected.head],
        [treeRef(branch), expected.tree],
      ] as const
    ).filter(([ref, wanted]) => wanted && refs.get(ref) === wanted);
    if (!doomed.length) return;
    const leases = doomed.map(([ref, wanted]) => `--force-with-lease=${ref}:${wanted}`);
    const deletes = doomed.map(([ref]) => `:${ref}`);
    const pushed = await runSandboxCommand(full.sandbox, 'git', ['-C', full.dir, ...NO_HOOKS, 'push', '--no-verify', '--quiet', '--atomic', ...leases, 'origin', ...deletes], {
      env: this.#pushEnv(full),
      timeoutMs: TRANSFER_TIMEOUT_MS,
      phase: 'hidden ref delete',
    });
    if (pushed.exitCode !== 0) {
      throw new SessionWorkError(`could not delete the remote's saved work: ${(pushed.stderr || pushed.stdout).trim().slice(-1000)}`);
    }
  }
}

