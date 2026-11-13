/**
 * Port: where a session's repository checkout comes from before the network.
 *
 * A provider that keeps repositories warm (the local mirror store, a remote
 * provider's volume later) implements it; one that does not uses
 * {@link NetworkRepositoryCache}, which always answers "clone from the
 * network". Materialization asks the cache first and falls back to the
 * network clone it always had, saying which path it took.
 */

import type { ExecutableSandbox } from '../materialization.ts';
import type { SandboxSetupTransfer } from '../setup-progress.ts';

/** One repository as a cache needs it: its clean clone URL and, for network work, process-scoped git credentials. */
export interface CachedRepository {
  /** Credential-free HTTPS clone URL (or a local path in tests). */
  cloneUrl: string;
  /** Git environment that authenticates one process (`gitAuthenticationEnvironment`); never stored. */
  authEnv?: Record<string, string>;
  /** Who the repository belongs to, so housekeeping can mint credentials later; stored beside the cache entry. */
  owner?: { orgId: string; repositoryId: string };
}

/** Where a checkout came from: the cache, or the caller's own network clone. */
export type RepositorySource = 'mirror' | 'network';

export type RepositoryCheckoutResult =
  | {
      source: 'mirror';
      /** The cache could not be refreshed and served what it had; the branch checkout still talks to the remote. */
      stale?: string;
      /** Time spent waiting for the repository's lock. */
      lockWaitMs: number;
    }
  | {
      source: 'network';
      /** Why the cache did not serve this checkout (`missing`, `corrupt: …`, `clone failed: …`, `disabled`). */
      reason: string;
    };

export interface RepositoryCheckoutOptions {
  /** The empty directory to clone into (it exists; LocalSandbox runs commands in it). */
  workdir: string;
  /** The branch to check out, the repository default. */
  branch: string;
  /** Told how far the cache refresh got. */
  onTransfer?: (transfer: SandboxSetupTransfer) => void;
}

export interface RepositoryRefreshResult {
  /** True when this refresh created the cache entry. */
  created: boolean;
  durationMs: number;
  lockWaitMs: number;
}

export interface RepositoryCache {
  /** `local-mirror`, `network`, … for logs. */
  readonly kind: string;
  /**
   * Session path: bring the cache up to date cheaply and clone from it into
   * `workdir` with `origin` set to `cloneUrl`. Never fails the session: when
   * it cannot serve the checkout it answers `network` (leaving `workdir`
   * empty) and repairs itself in the background.
   */
  checkout(
    sandbox: ExecutableSandbox,
    repo: CachedRepository,
    options: RepositoryCheckoutOptions,
  ): Promise<RepositoryCheckoutResult>;
  /** Build path: create or refresh the entry from the network; throws on failure. */
  refresh(repo: CachedRepository, options?: { onTransfer?: (transfer: SandboxSetupTransfer) => void }): Promise<RepositoryRefreshResult>;
  /** True when the cache holds the commit. */
  hasCommit(cloneUrl: string, sha: string): Promise<boolean>;
  /** Pack, prune temporary refs; under the entry's lock. Best-effort. */
  maintain(cloneUrl: string): Promise<void>;
  /** Remove entries outside `keep` (clone URLs) that are idle and hold no session work; returns what was removed. */
  prune(keep: Iterable<string>, options?: { idleMs?: number }): Promise<string[]>;
}

/** The no-cache adapter: every checkout is the caller's network clone. */
export class NetworkRepositoryCache implements RepositoryCache {
  readonly kind = 'network';

  async checkout(): Promise<RepositoryCheckoutResult> {
    return { source: 'network', reason: 'disabled' };
  }

  async refresh(): Promise<RepositoryRefreshResult> {
    return { created: false, durationMs: 0, lockWaitMs: 0 };
  }

  async hasCommit(): Promise<boolean> {
    return false;
  }

  async maintain(): Promise<void> {}

  async prune(): Promise<string[]> {
    return [];
  }
}
