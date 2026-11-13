/**
 * The local provider's environment template (ADR-0039): repository mirrors
 * ({@link LocalMirrorRepositoryCache}), builds that keep them and the package
 * stores warm ({@link LocalEnvironmentBuilds}), and session work kept in the
 * mirrors and, when a folder goes to sleep, on the remote
 * ({@link SessionWork}). `LocalFactorySandbox` owns one and hands its ports to
 * materialization through {@link FactorySandboxCheckoutServices}.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FactoryRepositoryAccess } from '@mastra/core/workspace';

import { gitAuthenticationEnvironment } from '../github/sandbox.ts';
import { hostExecutor } from './host-exec.ts';
import { LocalEnvironmentBuilds } from './local-builds.ts';
import { LocalMirrorRepositoryCache } from './local-mirror-cache.ts';
import type { LocalMirrorLogger } from './local-mirror-cache.ts';
import type { RepositoryCache } from './repository-cache.ts';
import { SessionWork, runGitIn } from './session-work.ts';
import type { SessionCheckout, SessionWorkSnapshot } from './session-work.ts';
import { MirrorSessionWorkStore, RemoteHiddenRefSessionWorkStore } from './session-work-stores.ts';

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

/** Credentials for a repository the server knows by its owner ids; set by the host once integrations exist. */
export type RepositoryAccessResolver = (owner: { orgId: string; repositoryId: string }) => Promise<FactoryRepositoryAccess>;

export interface LocalEnvironmentTemplateOptions {
  /** Template root, on the sandboxes' volume (hard links need one volume). */
  root: string;
  /** The sandbox's base environment (allow-list); builds run setup commands with it. */
  env?: Record<string, string>;
  /** Point package managers at shared stores under the root (default true). */
  packageStores?: boolean;
  logger?: LocalMirrorLogger;
  /** Mirrors no project names are removed after this long unused. */
  pruneIdleMs?: number;
  /** A mirror fetched this recently is not fetched again for a session. */
  freshnessMs?: number;
}

const consoleLogger: LocalMirrorLogger = {
  info: (message, meta) => console.info(`[factory:template] ${message}`, meta ?? {}),
  warn: (message, meta) => console.warn(`[factory:template] ${message}`, meta ?? {}),
};

/** Directories inside a session folder that are never checkouts. */
const NOT_CHECKOUTS = new Set(['.mastra-sandbox', 'node_modules', '.git']);

export interface FolderSaveResult {
  saved: Array<{ dir: string; snapshot: SessionWorkSnapshot | undefined }>;
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
  readonly #packageStores: boolean;
  readonly #logger: LocalMirrorLogger;
  readonly #folderQueues = new Map<string, Promise<unknown>>();
  #repositoryAccess: RepositoryAccessResolver | undefined;

  constructor(options: LocalEnvironmentTemplateOptions) {
    this.root = path.resolve(options.root);
    this.#packageStores = options.packageStores ?? true;
    this.#logger = options.logger ?? consoleLogger;
    this.repositoryCache = new LocalMirrorRepositoryCache({
      root: this.root,
      logger: this.#logger,
      host: hostExecutor({ ...(options.env ? { env: options.env } : {}) }),
      ...(options.freshnessMs !== undefined ? { freshnessMs: options.freshnessMs } : {}),
    });
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

  /** Lets card-close publishing mint credentials for a repository by its owner ids. */
  setRepositoryAccess(resolver: RepositoryAccessResolver | undefined): void {
    this.#repositoryAccess = resolver;
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

  async #checkout(dir: string, withCredentials: boolean): Promise<SessionCheckout | undefined> {
    const host = this.repositoryCache.host;
    const origin = await runGitIn(host, dir, ['remote', 'get-url', 'origin']);
    const cloneUrl = origin.exitCode === 0 ? origin.stdout.trim() : '';
    if (!cloneUrl || /\/\/[^/]*@/.test(cloneUrl)) return undefined;
    const checkout: SessionCheckout = { sandbox: host, dir, cloneUrl };
    if (withCredentials) {
      const owner = (await this.repositoryCache.readMeta(this.repositoryCache.mirrorPath(cloneUrl)))?.owner;
      if (!owner || !this.#repositoryAccess) throw new Error(`no credentials to publish ${cloneUrl}: the repository's owner is unknown`);
      const access = await this.#repositoryAccess(owner);
      const token = access.authorization?.token;
      if (!token) throw new Error(`no token to publish ${cloneUrl}`);
      checkout.authEnv = gitAuthenticationEnvironment(access.cloneUrl, token, access.authorization?.username ?? 'x-access-token');
    }
    return checkout;
  }

  /** True when the remote-tracking refs already hold the tip (pushed or merged somewhere). */
  async #onRemote(checkout: SessionCheckout, head: string): Promise<boolean> {
    const contains = await runGitIn(checkout.sandbox, checkout.dir, ['for-each-ref', '--count=1', '--format=%(refname)', '--contains', head, 'refs/remotes/origin']);
    return contains.exitCode === 0 && contains.stdout.trim() !== '';
  }

  /** One save of a folder at a time; a later one waits for the earlier. */
  #serial<T>(folder: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#folderQueues.get(folder) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.#folderQueues.set(folder, next);
    void next.finally(() => {
      if (this.#folderQueues.get(folder) === next) this.#folderQueues.delete(folder);
    }).catch(() => {});
    return next;
  }

  /**
   * Keep every checkout's work in its mirror (a run ended). Never throws: a
   * failure is logged with the folder and repository and returned.
   */
  saveFolder(folder: string, context: Record<string, unknown> = {}): Promise<FolderSaveResult> {
    return this.#serial(folder, async () => {
      const result: FolderSaveResult = { saved: [], failures: [] };
      for (const dir of await this.checkoutsIn(folder)) {
        try {
          const checkout = await this.#checkout(dir, false);
          if (!checkout) continue;
          const snapshot = await this.sessionWork.snapshot(checkout);
          // An untouched default-branch checkout has nothing to keep.
          if (snapshot && (snapshot.tree || !(await this.#onRemote(checkout, snapshot.head)) || (await this.#hasSaved(checkout, snapshot.branch)))) {
            await this.sessionWork.store.save(checkout, snapshot);
          }
          result.saved.push({ dir, snapshot });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.failures.push({ dir, error: message });
          this.#logger.warn('session work could not be saved', { ...context, dir, reason: message });
        }
      }
      return result;
    });
  }

  async #hasSaved(checkout: SessionCheckout, branch: string): Promise<boolean> {
    const mirror = this.repositoryCache.mirrorPath(checkout.cloneUrl);
    const ref = await runGitIn(checkout.sandbox, mirror, ['rev-parse', '--verify', '--quiet', `refs/factory/wip/heads/${branch}`]);
    return ref.exitCode === 0;
  }

  /**
   * Put a folder to sleep before it is deleted: every checkout's work saved
   * and read back from the mirror; with `publish` (card closed) work the
   * remote does not have yet also goes to its hidden refs, and saved refs of
   * work the remote already has are dropped from the mirror. Throws
   * {@link SessionWorkNotSavedError} when anything could not be kept: the
   * caller must keep the folder then.
   */
  sleepFolder(folder: string, options: { publish?: boolean } = {}): Promise<void> {
    return this.#serial(folder, async () => {
      const failures: FolderSaveResult['failures'] = [];
      for (const dir of await this.checkoutsIn(folder)) {
        try {
          const plain = await this.#checkout(dir, false);
          if (!plain) continue;
          const snapshot = await this.sessionWork.snapshot(plain);
          if (!snapshot) continue;
          const onRemote = await this.#onRemote(plain, snapshot.head);
          if (onRemote && !snapshot.tree) {
            // Already on the remote: nothing to keep; a card that closes drops what the mirror held for it.
            if (options.publish) await this.sessionWork.store.forget(plain, snapshot.branch);
            continue;
          }
          await this.sessionWork.store.save(plain, snapshot);
          if (options.publish && this.sessionWork.sleepStore) {
            const withCredentials = await this.#checkout(dir, true);
            await this.sessionWork.sleepStore.save(withCredentials!, snapshot);
          }
        } catch (error) {
          failures.push({ dir, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (failures.length) {
        const error = new SessionWorkNotSavedError(folder, failures);
        this.#logger.warn('folder not put to sleep; keeping it', { folder, failures });
        throw error;
      }
    });
  }

  /** A deleted session's saved work is dropped from every mirror (the person discarded it). */
  async forgetBranch(branch: string): Promise<void> {
    for (const mirror of await this.repositoryCache.listMirrors()) {
      const meta = await this.repositoryCache.readMeta(mirror);
      if (!meta?.cloneUrl) continue;
      await this.sessionWork.store.forget({ cloneUrl: meta.cloneUrl }, branch).catch((error: unknown) =>
        this.#logger.warn('could not drop saved session work', { mirror, branch, reason: String(error) }),
      );
    }
  }
}
