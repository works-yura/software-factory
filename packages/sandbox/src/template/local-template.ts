/**
 * The local provider's environment template (ADR-0039): repository mirrors
 * ({@link LocalMirrorRepositoryCache}), builds that keep them and the package
 * stores warm ({@link LocalEnvironmentBuilds}), and session work kept in the
 * mirrors and, when a folder goes to sleep, on the remote
 * ({@link SessionWork}). `LocalFactorySandbox` owns one and hands its ports to
 * materialization through {@link FactorySandboxCheckoutServices}.
 */

import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FactoryRepositoryAccess } from '@mastra/core/workspace';

import { createHash } from 'node:crypto';

import { gitAuthenticationEnvironment, gitTransfer, runSandboxCommand } from '../github/sandbox.ts';
import { sanitizeSegment } from '../workdir.ts';
import { hostExecutor } from './host-exec.ts';
import { LocalEnvironmentBuilds } from './local-builds.ts';
import { LocalMirrorRepositoryCache } from './local-mirror-cache.ts';
import type { LocalMirrorLogger } from './local-mirror-cache.ts';
import type { RepositoryCache } from './repository-cache.ts';
import { SessionWork, runGitIn } from './session-work.ts';
import type { SessionCheckout, SessionWorkSaveResult, SessionWorkSnapshot } from './session-work.ts';
import { MirrorSessionWorkStore, RemoteHiddenRefSessionWorkStore } from './session-work-stores.ts';
import { SandboxRegistry } from './sandbox-registry.ts';

/**
 * What a provider offers session materialization beyond a sandbox: a cache to
 * clone from and a place to keep and restore session work. Optional on any
 * `FactorySandbox`; a remote provider can expose its own later.
 */
export interface FactorySandboxCheckoutServices {
  repositoryCache?: RepositoryCache;
  sessionWork?: SessionWork;
}

/** The checkout services a factory sandbox exposes, if any. */
export function checkoutServicesOf(sandbox: unknown): FactorySandboxCheckoutServices | undefined {
  const services = (sandbox as { checkoutServices?: FactorySandboxCheckoutServices } | null | undefined)?.checkoutServices;
  return services && (services.repositoryCache || services.sessionWork) ? services : undefined;
}

export type RepositoryVisibility = 'public' | 'private' | 'unknown';

/** A repository's visibility as its integration knows it (GitHub's `private`); `unknown` when it cannot say. */
export type RepositoryVisibilityResolver = (owner: { orgId: string; repositoryId: string }) => Promise<RepositoryVisibility>;

const AUTH_REFUSED = /authentication failed|could not read username|terminal prompts disabled|repository not found|not found|\b40[134]\b|permission denied|access denied/i;

/**
 * Ask the remote anonymously whether it serves the repository: readable means
 * public, refused means private, anything else (no network) unknown. No
 * configuration of the host's git takes part: no global or system config
 * (credential helpers, `insteadOf` rewrites), no helper, no prompt.
 */
export async function probeRepositoryVisibility(sandbox: SessionCheckout['sandbox'], cloneUrl: string): Promise<RepositoryVisibility> {
  const probe = await gitTransfer(
    sandbox,
    ['-c', 'credential.helper=', '-c', 'core.askPass=', 'ls-remote', '--heads', '--', cloneUrl, 'refs/heads/__factory_probe__'],
    {
      env: {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/usr/bin/false',
        SSH_ASKPASS: '/usr/bin/false',
      },
      phase: 'visibility probe',
      timeoutMs: 60_000,
    },
  );
  if (probe.exitCode === 0) return 'public';
  return AUTH_REFUSED.test(`${probe.stderr}\n${probe.stdout}`) ? 'private' : 'unknown';
}

/** Credentials for a repository the server knows by its owner ids; set by the host once integrations exist. */
export type RepositoryAccessResolver = (owner: { orgId: string; repositoryId: string }) => Promise<FactoryRepositoryAccess>;

export interface LocalEnvironmentTemplateOptions {
  /** Template root, on the sandboxes' volume (hard links need one volume). */
  root: string;
  /** The sandbox's base environment (allow-list); builds run setup commands with it. */
  env?: Record<string, string>;
  /**
   * Point package managers at shared stores under the root. Off by default:
   * it moves pnpm off the store existing checkouts were installed from, and on
   * HFS+ `clone-or-copy` copies every file (ADR-0039).
   */
  packageStores?: boolean;
  logger?: LocalMirrorLogger;
  /** Mirrors no project names are removed after this long unused. */
  pruneIdleMs?: number;
  /** A mirror fetched this recently is not fetched again for a session. */
  freshnessMs?: number;
  /** Whether a repository is public (then uncommitted work is never published); probes it anonymously by default. */
  isPublicRepository?: (checkout: SessionCheckout) => Promise<boolean>;
}

const consoleLogger: LocalMirrorLogger = {
  info: (message, meta) => console.info(`[factory:template] ${message}`, meta ?? {}),
  warn: (message, meta) => console.warn(`[factory:template] ${message}`, meta ?? {}),
};

/** Directories inside a session folder that are never checkouts. */
const NOT_CHECKOUTS = new Set(['.mastra-sandbox', 'node_modules', '.git']);

/** Something the person should hear about kept work: saved commits set aside, a public repository kept local. */
export interface SessionWorkNotice {
  kind: 'superseded';
  dir: string;
  branch: string;
  ref: string;
}

export interface FolderSaveResult {
  saved: Array<{ dir: string; snapshot: SessionWorkSnapshot | undefined; superseded?: SessionWorkSaveResult['superseded'] }>;
  failures: Array<{ dir: string; error: string }>;
}

export class SessionWorkNotSavedError extends Error {
  readonly failures: FolderSaveResult['failures'];

  constructor(folder: string, failures: FolderSaveResult['failures']) {
    super(
      `The work in ${folder} could not be saved, so the folder is kept: ${failures.map(failure => `${path.basename(failure.dir)}: ${failure.error}`).join('; ')}`,
    );
    this.name = 'SessionWorkNotSavedError';
    this.failures = failures;
  }
}

export class LocalEnvironmentTemplate implements FactorySandboxCheckoutServices {
  readonly root: string;
  readonly repositoryCache: LocalMirrorRepositoryCache;
  readonly sessionWork: SessionWork;
  readonly builds: LocalEnvironmentBuilds;
  /** What the server knows about each sandbox folder: owner, activity, sleep, problems. */
  readonly sandboxes: SandboxRegistry;
  readonly #packageStores: boolean;
  readonly #logger: LocalMirrorLogger;
  readonly #queues = new Map<string, Promise<unknown>>();
  /** Folders (real paths) being put to sleep and removed right now. */
  readonly #removing = new Map<string, number>();
  #repositoryAccess: RepositoryAccessResolver | undefined;
  #repositoryVisibility: RepositoryVisibilityResolver | undefined;
  readonly #isPublicRepository: LocalEnvironmentTemplateOptions['isPublicRepository'];
  /** Told about kept work the person should know of; the host routes it to them. */
  onNotice: ((notice: SessionWorkNotice) => void) | undefined;

  constructor(options: LocalEnvironmentTemplateOptions) {
    this.root = path.resolve(options.root);
    this.#packageStores = options.packageStores ?? false;
    this.#logger = options.logger ?? consoleLogger;
    this.#isPublicRepository = options.isPublicRepository;
    this.repositoryCache = new LocalMirrorRepositoryCache({
      root: this.root,
      logger: this.#logger,
      host: hostExecutor({ ...(options.env ? { env: options.env } : {}) }),
      ...(options.freshnessMs !== undefined ? { freshnessMs: options.freshnessMs } : {}),
    });
    this.sandboxes = new SandboxRegistry({ root: this.root });
    this.sessionWork = new SessionWork({
      store: new MirrorSessionWorkStore(this.repositoryCache),
      sleepStore: new RemoteHiddenRefSessionWorkStore(),
      logger: this.#logger,
    });
    this.builds = new LocalEnvironmentBuilds({
      root: this.root,
      cache: this.repositoryCache,
      host: hostExecutor({ env: { ...options.env, ...this.packageStoreEnv() } }),
      logger: this.#logger,
      ...(options.pruneIdleMs !== undefined ? { pruneIdleMs: options.pruneIdleMs } : {}),
      pruneHiddenRefs: input => this.pruneHiddenRefs(input),
      pruneKeptRefs: input => this.pruneKeptRefs(input),
    });
  }

  get checkoutServices(): FactorySandboxCheckoutServices {
    return { repositoryCache: this.repositoryCache, sessionWork: this.sessionWork };
  }

  /**
   * Package managers' shared stores, on the template's volume. pnpm imports
   * by reflink where the disk can, else by copy (never by hard link: a write
   * into one session's `node_modules` would change every other's).
   */
  packageStoreEnv(): Record<string, string> {
    if (!this.#packageStores) return {};
    const stores = path.join(this.root, 'package-stores');
    return {
      npm_config_store_dir: path.join(stores, 'pnpm'),
      npm_config_package_import_method: 'clone-or-copy',
      npm_config_cache: path.join(stores, 'npm'),
      YARN_CACHE_FOLDER: path.join(stores, 'yarn'),
    };
  }

  /** Lets publishing mint credentials for a repository by its owner ids. */
  setRepositoryAccess(resolver: RepositoryAccessResolver | undefined): void {
    this.#repositoryAccess = resolver;
  }

  /** Lets publishing ask the integration whether a repository is public. */
  setRepositoryVisibility(resolver: RepositoryVisibilityResolver | undefined): void {
    this.#repositoryVisibility = resolver;
  }

  /** The checkouts in a session or card folder: the folder itself, or each repository directory in it. */
  async checkoutsIn(folder: string): Promise<string[]> {
    const isCheckout = (dir: string) =>
      stat(path.join(dir, '.git')).then(
        () => true,
        () => false,
      );
    if (await isCheckout(folder)) return [folder];
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return [];
    }
    const found: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || NOT_CHECKOUTS.has(entry.name)) continue;
      const dir = path.join(folder, entry.name);
      if (await isCheckout(dir)) found.push(dir);
    }
    return found;
  }

  /** The checkout as a {@link SessionCheckout}; `undefined` when its origin is missing or carries credentials. */
  async #checkout(dir: string): Promise<SessionCheckout | undefined> {
    const host = this.repositoryCache.host;
    // The configured URL, not `remote get-url`, which applies `insteadOf` rewrites.
    const origin = await runGitIn(host, dir, ['config', '--get', 'remote.origin.url']);
    const cloneUrl = origin.exitCode === 0 ? origin.stdout.trim() : '';
    if (!cloneUrl || /\/\/[^/]*@/.test(cloneUrl)) return undefined;
    const owner = await readCheckoutOwner(host, dir);
    return { sandbox: host, dir, cloneUrl, ...(owner ? { owner } : {}) };
  }

  /** Credentials to publish with: the owner recorded on the checkout, else on its mirror. */
  async #withCredentials(checkout: SessionCheckout): Promise<SessionCheckout> {
    const owner =
      checkout.owner ?? (await this.repositoryCache.readMeta(this.repositoryCache.mirrorPath(checkout.cloneUrl)))?.owner;
    if (!owner || !this.#repositoryAccess) throw new Error(`no credentials to publish ${checkout.cloneUrl}: the repository's owner is unknown`);
    const access = await this.#repositoryAccess(owner);
    const token = access.authorization?.token;
    if (!token) throw new Error(`no token to publish ${checkout.cloneUrl}`);
    return {
      ...checkout,
      authEnv: gitAuthenticationEnvironment(access.cloneUrl, token, access.authorization?.username ?? 'x-access-token'),
    };
  }

  /** True when a remote-tracking ref already holds `head` (pushed or merged somewhere). */
  async #onRemote(checkout: Pick<SessionCheckout, 'sandbox' | 'dir'>, head: string): Promise<boolean> {
    const contains = await runGitIn(checkout.sandbox, checkout.dir, [
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      '--contains',
      head,
      'refs/remotes/origin',
    ]);
    return contains.exitCode === 0 && contains.stdout.trim() !== '';
  }

  /** Bring `origin/*` up to date before trusting it to say what the remote holds. */
  async #refreshRemote(checkout: SessionCheckout): Promise<void> {
    const fetched = await gitTransfer(checkout.sandbox, ['-C', checkout.dir, 'fetch', '--quiet', '--prune', '--no-tags', 'origin'], {
      ...(checkout.authEnv ? { env: checkout.authEnv } : {}),
      phase: 'sleep remote refresh',
      timeoutMs: 5 * 60_000,
    });
    if (fetched.exitCode !== 0) throw new Error(`could not refresh what the remote holds: ${(fetched.stderr || fetched.stdout).trim().slice(-500)}`);
  }

  /**
   * The repository's visibility: the integration's answer when the host gave
   * one (GitHub's `private`), else an anonymous probe. Public: nothing is
   * published. Unknown: commits are, uncommitted work (which can hold
   * anything) is not.
   */
  async #visibility(checkout: SessionCheckout): Promise<RepositoryVisibility> {
    if (this.#isPublicRepository) return (await this.#isPublicRepository(checkout)) ? 'public' : 'private';
    const owner =
      checkout.owner ?? (await this.repositoryCache.readMeta(this.repositoryCache.mirrorPath(checkout.cloneUrl)))?.owner;
    if (owner && this.#repositoryVisibility) {
      const answer = await this.#repositoryVisibility(owner).catch(() => 'unknown' as const);
      if (answer !== 'unknown') return answer;
    }
    return probeRepositoryVisibility(checkout.sandbox, checkout.cloneUrl);
  }

  /** The real path, so one checkout reached through a link or another spelling queues once. */
  async #real(dir: string): Promise<string> {
    return realpath(dir).catch(() => path.resolve(dir));
  }

  /** One save or sleep of a checkout at a time, whoever asks. */
  #serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.#queues.set(key, next);
    void next
      .finally(() => {
        if (this.#queues.get(key) === next) this.#queues.delete(key);
      })
      .catch(() => {});
    return next;
  }

  /** True while the folder holding `dir` is being put to sleep and removed: a run-end save then does nothing. */
  #beingRemoved(real: string): boolean {
    for (const folder of this.#removing.keys()) if (real === folder || real.startsWith(folder + path.sep)) return true;
    return false;
  }

  /** Remember what this session saved, so forgetting it later drops exactly that and nothing another session saved. */
  async #recordSave(sessionId: string | undefined, checkout: SessionCheckout, snapshot: SessionWorkSnapshot): Promise<void> {
    if (!sessionId) return;
    const file = path.join(this.root, 'session-saves', `${sanitizeSegment(sessionId)}.json`);
    try {
      const current = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Record<string, SavedBySession>;
      current[`${checkout.cloneUrl}\n${snapshot.branch}`] = {
        cloneUrl: checkout.cloneUrl,
        branch: snapshot.branch,
        head: snapshot.head,
        ...(snapshot.tree ? { tree: snapshot.tree } : {}),
      };
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${Date.now()}`;
      await writeFile(temporary, JSON.stringify(current));
      await rename(temporary, file);
    } catch (error) {
      this.#logger.warn('could not record what a session saved', { sessionId, reason: String(error) });
    }
  }

  /**
   * Keep every checkout's work in its mirror (a run ended). Never throws: a
   * failure is logged with the folder and repository and returned. Does
   * nothing for a folder being put to sleep, whose own save is the last word.
   */
  async saveFolder(folder: string, context: { sessionId?: string } & Record<string, unknown> = {}): Promise<FolderSaveResult> {
    const result: FolderSaveResult = { saved: [], failures: [] };
    for (const dir of await this.checkoutsIn(folder)) {
      const real = await this.#real(dir);
      await this.#serial(real, async () => {
        if (this.#beingRemoved(real)) return;
        try {
          const checkout = await this.#checkout(dir);
          if (!checkout) return;
          const snapshot = await this.sessionWork.snapshot(checkout);
          // An untouched default-branch checkout has nothing to keep.
          if (snapshot && (snapshot.tree || !(await this.#onRemote(checkout, snapshot.head)) || (await this.#hasSaved(checkout, snapshot.branch)))) {
            const saved = await this.sessionWork.store.save(checkout, snapshot);
            await this.#recordSave(context.sessionId, checkout, snapshot);
            await this.#reopened(checkout.cloneUrl, snapshot.branch);
            this.#report(saved, dir, snapshot, context);
            result.saved.push({ dir, snapshot, ...(saved.superseded ? { superseded: saved.superseded } : {}) });
          } else {
            result.saved.push({ dir, snapshot });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.failures.push({ dir, error: message });
          this.#logger.warn('session work could not be saved', { ...context, dir, reason: message });
        }
      });
    }
    return result;
  }

  #report(saved: SessionWorkSaveResult, dir: string, snapshot: SessionWorkSnapshot, context: Record<string, unknown>): void {
    if (saved.superseded) {
      this.#logger.warn('saved commits the new tip does not contain were kept aside', {
        ...context,
        dir,
        branch: snapshot.branch,
        kept: saved.superseded,
      });
      this.onNotice?.({ kind: 'superseded', dir, branch: snapshot.branch, ref: saved.superseded.ref });
    }
    if (snapshot.skipped?.length) {
      this.#logger.warn('files over the size limit were left out of the saved work', { ...context, dir, files: snapshot.skipped });
    }
  }

  async #hasSaved(checkout: SessionCheckout, branch: string): Promise<boolean> {
    const mirror = this.repositoryCache.mirrorPath(checkout.cloneUrl);
    const ref = await runGitIn(checkout.sandbox, mirror, ['rev-parse', '--verify', '--quiet', `refs/factory/wip/heads/${branch}`]);
    return ref.exitCode === 0;
  }

  /**
   * Put one checkout to sleep: work saved to the mirror and read back;
   * with `publish`, the remote is refreshed first, and work it does not hold
   * goes to its hidden refs (never on a public repository: mirror only, and
   * a notice), while saved refs of work it already holds are dropped from the
   * mirror. A checkout whose work cannot be named (detached or unborn HEAD,
   * no usable origin) only passes when it is clean and holds nothing the
   * remote lacks.
   */
  async #sleepCheckout(dir: string, options: { publish?: boolean; closing?: boolean; sessionId?: string }): Promise<string[]> {
    const notices: string[] = [];
    const checkout = await this.#checkout(dir);
    if (!checkout) throw new Error('its origin is missing or carries credentials, so its work cannot be saved');
    const snapshot = await this.sessionWork.snapshot(checkout);
    if (!snapshot) {
      const status = await runGitIn(checkout.sandbox, dir, ['status', '--porcelain']);
      if (status.exitCode !== 0 || status.stdout.trim()) throw new Error('it is not on a branch and has uncommitted changes');
      const head = await runGitIn(checkout.sandbox, dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      // An unborn branch with a clean tree holds nothing.
      if (head.exitCode !== 0) return notices;
      const credentialed = options.publish ? await this.#withCredentials(checkout) : checkout;
      if (options.publish) await this.#refreshRemote(credentialed);
      if (!(await this.#onRemote(checkout, head.stdout.trim()))) throw new Error('it is not on a branch and holds commits the remote does not');
      return notices;
    }
    // The mirror always gets it: local and cheap, and it never trusts what `origin/*` last said.
    const saved = await this.sessionWork.store.save(checkout, snapshot);
    await this.#recordSave(options.sessionId, checkout, snapshot);
    this.#report(saved, dir, snapshot, { sessionId: options.sessionId });
    if (!options.publish || !this.sessionWork.sleepStore) return notices;
    const credentialed = await this.#withCredentials(checkout);
    await this.#refreshRemote(credentialed);
    if (!snapshot.tree && (await this.#onRemote(checkout, snapshot.head))) {
      // The remote holds it all: the card closes with nothing to keep.
      await this.sessionWork.store.forget(checkout, snapshot.branch, { head: snapshot.head });
      return notices;
    }
    const visibility = await this.#visibility(checkout);
    if (visibility === 'public') {
      notices.push(`${checkout.cloneUrl}: public repository, work kept in the mirror only`);
      this.#logger.warn('public repository: session work is kept in the mirror only, never published', { dir, branch: snapshot.branch });
      return notices;
    }
    let published = snapshot;
    if (visibility === 'unknown' && snapshot.tree) {
      // Commits only: uncommitted work never goes where it might be public.
      const { tree: _tree, ...commitsOnly } = snapshot;
      published = commitsOnly;
      notices.push(`${checkout.cloneUrl}: visibility unknown, uncommitted work kept in the mirror only`);
      this.#logger.warn('repository visibility unknown: uncommitted work kept in the mirror only', { dir, branch: snapshot.branch });
    }
    await this.sessionWork.sleepStore.save(credentialed, published);
    await this.#recordPublished(checkout.cloneUrl, snapshot.branch, Boolean(options.closing));
    return notices;
  }

  /**
   * Put a folder to sleep before it is deleted and delete it (`remove`).
   * Every checkout's save is verified first; while this runs, run-end saves
   * of the folder do nothing, so none can record the deletion. Throws
   * {@link SessionWorkNotSavedError} when anything could not be kept, and
   * then the folder stays.
   */
  async removeFolder(
    folder: string,
    options: { publish?: boolean; closing?: boolean; sessionId?: string; remove: () => Promise<void> },
  ): Promise<string[]> {
    const real = await this.#real(folder);
    const notices: string[] = [];
    const failures: FolderSaveResult['failures'] = [];
    // Marked first: a run-end save queued from here on does nothing, whenever it runs.
    this.#removing.set(real, (this.#removing.get(real) ?? 0) + 1);
    try {
      const dirs = await this.checkoutsIn(folder);
      for (const dir of dirs) {
        // In the checkout's queue: after any save already queued, never beside one.
        await this.#serial(await this.#real(dir), async () => {
          try {
            notices.push(...(await this.#sleepCheckout(dir, options)));
          } catch (error) {
            failures.push({ dir, error: error instanceof Error ? error.message : String(error) });
          }
        });
      }
      if (failures.length) {
        this.#logger.warn('folder not put to sleep; keeping it', { folder, failures });
        throw new SessionWorkNotSavedError(folder, failures);
      }
      await options.remove();
      return notices;
    } finally {
      const left = (this.#removing.get(real) ?? 1) - 1;
      if (left > 0) this.#removing.set(real, left);
      else this.#removing.delete(real);
    }
  }

  /** Verified save of a folder without removing it (tests, a manual save). */
  async sleepFolder(folder: string, options: { publish?: boolean; sessionId?: string } = {}): Promise<string[]> {
    return this.removeFolder(folder, { ...options, remove: async () => {} });
  }

  /** Work on a branch whose card had closed: the card is open again, its published work must not age out as closed. */
  async #reopened(cloneUrl: string, branch: string): Promise<void> {
    const file = this.#publishedFile(cloneUrl, branch);
    let current: Partial<PublishedRecord>;
    try {
      current = JSON.parse(await readFile(file, 'utf8')) as Partial<PublishedRecord>;
    } catch {
      return;
    }
    if (!current.closedAt) return;
    const { closedAt: _closedAt, ...open } = current;
    const temporary = `${file}.${process.pid}.${Date.now()}`;
    await writeFile(temporary, JSON.stringify(open)).then(() => rename(temporary, file)).catch(() => rm(temporary, { force: true }));
  }

  #publishedFile(cloneUrl: string, branch: string): string {
    return path.join(this.root, 'published', `${createHash('sha256').update(`${cloneUrl}\n${branch}`).digest('hex').slice(0, 32)}.json`);
  }

  /** When work went to the remote's hidden refs, and whether its card closed then (it may be pruned sooner). */
  async #recordPublished(cloneUrl: string, branch: string, closing: boolean): Promise<void> {
    const file = this.#publishedFile(cloneUrl, branch);
    const at = new Date().toISOString();
    try {
      // Published while not closing: the card is open (again), so an earlier close no longer counts.
      const next: PublishedRecord = { cloneUrl, branch, publishedAt: at, ...(closing ? { closedAt: at } : {}) };
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${Date.now()}`;
      await writeFile(temporary, JSON.stringify(next));
      await rename(temporary, file);
    } catch (error) {
      this.#logger.warn('could not record published work', { cloneUrl, branch, reason: String(error) });
    }
  }

  /**
   * Drop work published to the remote's hidden refs once it is no longer
   * needed: right away when its card closed and the remote's branches hold it
   * (no uncommitted work), after `retentionMs` when the branches hold it but
   * the card is open (asleep), and after `retentionMs` from its card closing
   * otherwise. Never work only the hidden refs hold while its card is open.
   * Reads the mirror (fetched just before), deletes on the remote with each
   * ref guarded by the value it judged; answers the branches it dropped.
   */
  async pruneHiddenRefs(input: { cloneUrl: string; authEnv?: Record<string, string>; retentionMs: number; now?: number }): Promise<string[]> {
    const host = this.repositoryCache.host;
    const mirror = this.repositoryCache.mirrorPath(input.cloneUrl);
    const now = input.now ?? Date.now();
    const listed = await runGitIn(host, mirror, ['for-each-ref', '--format=%(refname) %(objectname) %(committerdate:unix)', 'refs/factory/origin-wip/heads']);
    if (listed.exitCode !== 0) return [];
    const pruned: string[] = [];
    for (const line of listed.stdout.split('\n').map(text => text.trim()).filter(Boolean)) {
      const [ref, head, committed] = line.split(' ');
      if (!ref || !head) continue;
      const branch = ref.slice('refs/factory/origin-wip/heads/'.length);
      const treeRef = `refs/factory/origin-wip/tree/${branch}`;
      const tree = await runGitIn(host, mirror, ['rev-parse', '--verify', '--quiet', treeRef]);
      const treeSha = tree.exitCode === 0 ? tree.stdout.trim() : undefined;
      const onBranch = await runGitIn(host, mirror, ['for-each-ref', '--count=1', '--format=%(refname)', '--contains', head, 'refs/heads']);
      const contained = !treeSha && onBranch.exitCode === 0 && onBranch.stdout.trim() !== '';
      const record = JSON.parse(await readFile(this.#publishedFile(input.cloneUrl, branch), 'utf8').catch(() => '{}')) as Partial<PublishedRecord>;
      const closedAt = record.closedAt ? Date.parse(record.closedAt) : undefined;
      const since = Date.parse(record.publishedAt ?? '') || Number(committed) * 1000 || now;
      const due = contained
        ? closedAt !== undefined || now - since >= input.retentionMs
        : closedAt !== undefined && now - closedAt >= input.retentionMs;
      if (!due) continue;
      const doomed: Array<[string, string]> = [[`refs/factory/wip/heads/${branch}`, head], ...(treeSha ? [[`refs/factory/wip/tree/${branch}`, treeSha] as [string, string]] : [])];
      const pushed = await runSandboxCommand(
        host,
        'git',
        [
          '-C',
          mirror,
          '-c',
          'core.hooksPath=/dev/null',
          'push',
          '--quiet',
          '--atomic',
          ...doomed.map(([remoteRef, sha]) => `--force-with-lease=${remoteRef}:${sha}`),
          input.cloneUrl,
          ...doomed.map(([remoteRef]) => `:${remoteRef}`),
        ],
        { ...(input.authEnv ? { env: input.authEnv } : {}), timeoutMs: 5 * 60_000, phase: 'hidden ref prune' },
      );
      if (pushed.exitCode !== 0) {
        this.#logger.warn('published work could not be pruned', { cloneUrl: input.cloneUrl, branch, reason: (pushed.stderr || pushed.stdout).trim().slice(-500) });
        continue;
      }
      await runGitIn(host, mirror, ['update-ref', '-d', ref, head]);
      if (treeSha) await runGitIn(host, mirror, ['update-ref', '-d', treeRef, treeSha]);
      await rm(this.#publishedFile(input.cloneUrl, branch), { force: true });
      pruned.push(branch);
    }
    if (pruned.length) this.#logger.info('pruned published work the remote no longer needs', { cloneUrl: input.cloneUrl, branches: pruned });
    return pruned;
  }

  /**
   * Drop kept refs older than `retentionMs` from a mirror: the trash of
   * forgotten work, commits set aside as superseded, and uncommitted work that
   * did not apply. Their time is in their name; younger ones stay, so nothing
   * goes before the retention passed. Answers the refs dropped.
   */
  async pruneKeptRefs(input: { cloneUrl: string; retentionMs: number; now?: number }): Promise<string[]> {
    const host = this.repositoryCache.host;
    const mirror = this.repositoryCache.mirrorPath(input.cloneUrl);
    const now = input.now ?? Date.now();
    const listed = await runGitIn(host, mirror, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/factory/trash',
      'refs/factory/wip/superseded',
      'refs/factory/wip/conflict',
    ]);
    if (listed.exitCode !== 0) return [];
    const dropped: string[] = [];
    for (const line of listed.stdout.split('\n').map(text => text.trim()).filter(Boolean)) {
      const [ref, sha] = line.split(' ');
      if (!ref || !sha) continue;
      // trash/<time>/…, or wip/superseded|conflict/<branch>/<time>.
      const time = ref.startsWith('refs/factory/trash/') ? Number(ref.split('/')[3]) : Number(ref.split('/').at(-1));
      if (!Number.isFinite(time) || now - time < input.retentionMs) continue;
      if ((await runGitIn(host, mirror, ['update-ref', '-d', ref, sha])).exitCode === 0) dropped.push(ref);
    }
    if (dropped.length) this.#logger.info('dropped kept refs past their retention', { mirror, dropped });
    return dropped;
  }

  /** Kept refs past the retention in every mirror (the sweep runs it daily). */
  async pruneKeptRefsEverywhere(retentionMs: number): Promise<void> {
    for (const mirror of await this.repositoryCache.listMirrors()) {
      const meta = await this.repositoryCache.readMeta(mirror);
      if (meta?.cloneUrl) await this.pruneKeptRefs({ cloneUrl: meta.cloneUrl, retentionMs }).catch(() => []);
    }
  }

  /**
   * A deleted session's saved work goes to the mirror's trash: exactly the
   * refs this session saved and nothing a later save of the same branch
   * (another session's) put there.
   */
  async forgetSession(sessionId: string): Promise<void> {
    const file = path.join(this.root, 'session-saves', `${sanitizeSegment(sessionId)}.json`);
    let saves: Record<string, SavedBySession>;
    try {
      saves = JSON.parse(await readFile(file, 'utf8')) as Record<string, SavedBySession>;
    } catch {
      return;
    }
    for (const save of Object.values(saves)) {
      await this.sessionWork.store
        .forget({ cloneUrl: save.cloneUrl }, save.branch, { head: save.head, ...(save.tree ? { tree: save.tree } : {}) })
        .catch((error: unknown) =>
          this.#logger.warn('could not drop saved session work', { sessionId, branch: save.branch, reason: String(error) }),
        );
    }
    await rm(file, { force: true });
  }
}

interface PublishedRecord {
  cloneUrl: string;
  branch: string;
  publishedAt: string;
  /** Published as its card closed. */
  closedAt?: string;
}

interface SavedBySession {
  cloneUrl: string;
  branch: string;
  head: string;
  tree?: string;
}

/** The checkout's repository owner, recorded in its git config by materialization (`factory.orgId`, `factory.repositoryId`). */
export async function readCheckoutOwner(
  sandbox: SessionCheckout['sandbox'],
  dir: string,
): Promise<{ orgId: string; repositoryId: string } | undefined> {
  const org = await runGitIn(sandbox, dir, ['config', '--get', 'factory.orgId']);
  const repository = await runGitIn(sandbox, dir, ['config', '--get', 'factory.repositoryId']);
  const orgId = org.exitCode === 0 ? org.stdout.trim() : '';
  const repositoryId = repository.exitCode === 0 ? repository.stdout.trim() : '';
  return orgId && repositoryId ? { orgId, repositoryId } : undefined;
}
