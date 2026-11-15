/**
 * The template's cache and session work stores are ports (ADR-0049): another
 * cache and store work without a single local mirror, and what needs a
 * capability the configured cache lacks fails at construction.
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalEnvironmentBuilds } from './local-builds.ts';
import { LocalMirrorRepositoryCache } from './local-mirror-cache.ts';
import { LocalEnvironmentTemplate } from './local-template.ts';
import { NetworkRepositoryCache, localRepositoriesOf } from './repository-cache.ts';
import type { CachedRepository, LocalRepositories, RepositoryCache, RepositoryCheckoutResult } from './repository-cache.ts';
import type { LoadedSessionWork, SessionCheckout, SessionWorkSnapshot, SessionWorkStore } from './session-work.ts';
import { gitFixture } from './test-git.ts';
import type { GitFixture } from './test-git.ts';

const silent = { info() {}, warn() {} };
const OWNER = { orgId: 'org-9', repositoryId: 'repo-9' };

/** A cache that keeps nothing on disk: every checkout is a network clone; it only knows owners. */
class FakeCache implements RepositoryCache {
  readonly kind = 'fake';
  readonly calls: string[] = [];
  async checkout(): Promise<RepositoryCheckoutResult> {
    this.calls.push('checkout');
    return { source: 'network', reason: 'disabled' };
  }
  async refresh() {
    this.calls.push('refresh');
    return { created: false, durationMs: 0, lockWaitMs: 0 };
  }
  async hasCommit() {
    return false;
  }
  async maintain() {}
  async prune() {
    return [];
  }
  async ownerOf(cloneUrl: string): Promise<CachedRepository['owner']> {
    this.calls.push(`ownerOf ${cloneUrl}`);
    return OWNER;
  }
}

/** A store in memory: what was saved, per clone URL and branch. */
class FakeStore implements SessionWorkStore {
  readonly saved = new Map<string, SessionWorkSnapshot>();
  readonly kind: string;
  constructor(kind: string) {
    this.kind = kind;
  }
  async save(checkout: SessionCheckout, snapshot: SessionWorkSnapshot) {
    this.saved.set(`${checkout.cloneUrl} ${snapshot.branch}`, snapshot);
    return {};
  }
  async load(): Promise<LoadedSessionWork | undefined> {
    return undefined;
  }
  async forget(checkout: { cloneUrl: string }, branch: string) {
    this.saved.delete(`${checkout.cloneUrl} ${branch}`);
  }
  async hasSaved(checkout: SessionCheckout, branch: string) {
    return this.saved.has(`${checkout.cloneUrl} ${branch}`);
  }
}

describe('LocalEnvironmentTemplate with another cache and store', () => {
  let fx: GitFixture;
  let root: string;

  beforeEach(async () => {
    fx = await gitFixture('factory-ports-');
    root = path.join(fx.root, 'template');
  });

  afterEach(async () => {
    await rm(fx.root, { recursive: true, force: true });
  });

  /** A session folder with the repository cloned straight from the "remote", as a network checkout leaves it. */
  const networkCheckout = async (name: string) => {
    const folder = path.join(fx.root, 'sandboxes', name);
    const dir = path.join(folder, 'repo');
    await mkdir(folder, { recursive: true });
    fx.git(fx.root, 'clone', '--quiet', fx.origin, dir);
    return { folder, dir };
  };

  it('saves and puts to sleep through the given ports, without a single local mirror', async () => {
    const cache = new FakeCache();
    const store = new FakeStore('fake-store');
    const sleepStore = new FakeStore('fake-sleep');
    const template = new LocalEnvironmentTemplate({
      root,
      env: fx.env,
      logger: silent,
      repositoryCache: cache,
      sessionWorkStore: store,
      sessionWorkSleepStore: sleepStore,
      builds: false,
      isPublicRepository: async () => false,
    });
    template.setRepositoryAccess(async () => ({ cloneUrl: 'https://github.com/acme/repo.git', authorization: { scheme: 'bearer', token: 't' } }));

    expect(template.builds).toBeUndefined();
    expect(template.checkoutServices.repositoryCache).toBe(cache);
    expect(template.sessionWork.store).toBe(store);

    // Run end: a commit the remote lacks plus uncommitted work go to the given store.
    const { folder, dir } = await networkCheckout('session-1');
    fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-1');
    const head = await fx.commit(dir, 'feature.txt', 'feature\n');
    await writeFile(path.join(dir, 'src.txt'), 'changed\n');
    const saved = await template.saveFolder(folder, { sessionId: 's1' });
    expect(saved.failures).toEqual([]);
    expect(store.saved.get(`${fx.origin} factory/item-1`)).toMatchObject({ head, tree: expect.any(String) });

    // A branch the store already holds keeps being saved once the remote has its tip (asked through hasSaved).
    await writeFile(path.join(dir, 'src.txt'), 'a\nb\nc\n');
    fx.git(dir, 'push', '--quiet', 'origin', 'factory/item-1');
    fx.git(dir, 'fetch', '--quiet', 'origin');
    await template.saveFolder(folder, { sessionId: 's1' });
    expect(store.saved.get(`${fx.origin} factory/item-1`)).toEqual({ branch: 'factory/item-1', head });

    // Sleep with publish: credentials come from the owner the cache records (the checkout records none).
    await fx.commit(dir, 'more.txt', 'more\n');
    await template.sleepFolder(folder, { publish: true, sessionId: 's1' });
    expect(cache.calls).toContain(`ownerOf ${fx.origin}`);
    expect(sleepStore.saved.get(`${fx.origin} factory/item-1`)?.branch).toBe('factory/item-1');

    // Nothing was kept in local mirrors, and housekeeping that needs them says so.
    expect(await readdir(root).catch(() => [])).not.toContain('mirrors');
    await expect(template.pruneKeptRefsEverywhere(1)).rejects.toThrow(/LocalRepositories.*'fake'/);
  });

  it('builds over another cache that keeps local repositories', async () => {
    const mirrors = new LocalMirrorRepositoryCache({ root: path.join(fx.root, 'elsewhere'), host: fx.host, logger: silent });
    const local: RepositoryCache & LocalRepositories = {
      kind: 'local-elsewhere',
      checkout: (...args) => mirrors.checkout(...args),
      refresh: (...args) => mirrors.refresh(...args),
      hasCommit: (...args) => mirrors.hasCommit(...args),
      maintain: (...args) => mirrors.maintain(...args),
      prune: (...args) => mirrors.prune(...args),
      ownerOf: (...args) => mirrors.ownerOf(...args),
      localRepositoryPath: (...args) => mirrors.localRepositoryPath(...args),
      listLocalRepositories: () => mirrors.listLocalRepositories(),
      withLocalRepository: (cloneUrl, fn) => mirrors.withLocalRepository(cloneUrl, fn),
    };
    expect(localRepositoriesOf(local)).toBe(local);
    const template = new LocalEnvironmentTemplate({ root, env: fx.env, logger: silent, repositoryCache: local, sessionWorkStore: new FakeStore('fake-store') });
    expect(template.builds).toBeInstanceOf(LocalEnvironmentBuilds);

    await mirrors.refresh({ cloneUrl: fx.origin });
    expect(await local.listLocalRepositories()).toEqual([fx.origin]);
    await expect(template.pruneKeptRefsEverywhere(1)).resolves.toBeUndefined();
  });

  it('fails at construction when a required capability is missing', () => {
    const base = { root, env: fx.env, logger: silent };
    expect(() => new LocalEnvironmentTemplate({ ...base, repositoryCache: new FakeCache(), builds: false })).toThrow(
      /default session work store keeps work in local mirrors.*'fake'.*pass sessionWorkStore/,
    );
    expect(
      () => new LocalEnvironmentTemplate({ ...base, repositoryCache: new FakeCache(), sessionWorkStore: new FakeStore('fake-store') }),
    ).toThrow(/environment builds clone the template copy from a local repository.*'fake'.*builds: false/);
    const blind = new FakeStore('blind');
    const withoutHasSaved: SessionWorkStore = {
      kind: 'blind',
      save: (checkout, snapshot) => blind.save(checkout, snapshot),
      load: () => blind.load(),
      forget: (checkout, branch) => blind.forget(checkout, branch),
    };
    expect(
      () => new LocalEnvironmentTemplate({ ...base, repositoryCache: new FakeCache(), sessionWorkStore: withoutHasSaved, builds: false }),
    ).toThrow(/'blind' cannot tell whether a branch has saved work \(hasSaved\)/);
    expect(
      () =>
        new LocalEnvironmentTemplate({
          ...base,
          repositoryCache: new FakeCache(),
          sessionWorkStore: new FakeStore('fake-store'),
          builds: false,
          freshnessMs: 0,
        }),
    ).toThrow(/freshnessMs configures the default mirror cache/);
    expect(
      () => new LocalEnvironmentBuilds({ root, cache: new NetworkRepositoryCache(), host: fx.host, logger: silent }),
    ).toThrow(/Local environment builds .* needs a repository cache that keeps local repositories \(LocalRepositories\); the configured cache 'network' has none/);
  });

  it('defaults to the local mirrors, as before', () => {
    const template = new LocalEnvironmentTemplate({ root, env: fx.env, logger: silent });
    expect(template.repositoryCache).toBeInstanceOf(LocalMirrorRepositoryCache);
    expect((template.repositoryCache as LocalMirrorRepositoryCache).mirrorPath('https://github.com/Acme/Repo.git')).toBe(
      path.join(root, 'mirrors', 'github.com', 'acme', 'repo.git'),
    );
    expect(template.sessionWork.store.kind).toBe('mirror');
    expect(template.sessionWork.sleepStore?.kind).toBe('remote-hidden-ref');
    expect(template.builds).toBeInstanceOf(LocalEnvironmentBuilds);
  });
});
