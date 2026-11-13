import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withFileLock } from './file-lock.ts';
import { LocalMirrorRepositoryCache, mirrorKey } from './local-mirror-cache.ts';
import { gitFixture } from './test-git.ts';
import type { GitFixture } from './test-git.ts';

const silent = { info() {}, warn() {} };

describe('LocalMirrorRepositoryCache with real git', () => {
  let fx: GitFixture;
  let templateRoot: string;
  let cache: LocalMirrorRepositoryCache;
  let workdirs = 0;

  const newWorkdir = async () => {
    const dir = path.join(fx.root, 'sessions', `s${++workdirs}`, 'repo');
    await mkdir(dir, { recursive: true });
    return dir;
  };
  const makeCache = (options: Partial<ConstructorParameters<typeof LocalMirrorRepositoryCache>[0]> = {}) =>
    new LocalMirrorRepositoryCache({ root: templateRoot, host: fx.host, logger: silent, freshnessMs: 0, ...options });

  beforeEach(async () => {
    fx = await gitFixture();
    templateRoot = path.join(fx.root, 'template');
    cache = makeCache();
  });

  afterEach(async () => {
    await cache.settled();
    await chmod(path.join(templateRoot, 'mirrors'), 0o755).catch(() => {});
    await rm(fx.root, { recursive: true, force: true });
  });

  it('keys a GitHub repository by host and lower-cased path, either spelling', () => {
    expect(mirrorKey('https://github.com/Acme/Repo.git')).toBe('github.com/acme/repo');
    expect(mirrorKey('https://github.com/acme/repo')).toBe('github.com/acme/repo');
    expect(mirrorKey('/tmp/x/origin.git')).toMatch(/^local\/[0-9a-f]{24}$/);
  });

  it('clones a session from the mirror with full history, hard-linked objects and origin on the remote', async () => {
    const refreshed = await cache.refresh({ cloneUrl: fx.origin });
    expect(refreshed.created).toBe(true);
    const mirror = cache.mirrorPath(fx.origin);
    expect(fx.git(mirror, 'config', '--get-all', 'remote.origin.fetch')).toContain('+refs/factory/wip/*:refs/factory/origin-wip/*');
    expect(fx.tryGit(mirror, 'config', '--get', 'remote.origin.mirror').status).not.toBe(0);

    const workdir = await newWorkdir();
    const result = await cache.checkout(fx.host, { cloneUrl: fx.origin }, { workdir, branch: 'main' });
    expect(result.source).toBe('mirror');
    expect(fx.git(workdir, 'remote', 'get-url', 'origin')).toBe(fx.origin);
    expect(fx.git(workdir, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(fx.git(workdir, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(fx.git(workdir, 'rev-parse', 'origin/main')).toBe(fx.git(fx.seed, 'rev-parse', 'HEAD'));
    // Objects are hard links into the mirror's packs (same volume).
    const packs = (await readdir(path.join(workdir, '.git', 'objects', 'pack'))).filter(name => name.endsWith('.pack'));
    const links = await Promise.all(packs.map(async name => (await stat(path.join(workdir, '.git', 'objects', 'pack', name))).nlink));
    expect(Math.max(...links, 0) > 1 || packs.length === 0).toBe(true);
    // The mirror can never push.
    expect(fx.tryGit(mirror, 'push', 'origin', 'refs/heads/main').status).not.toBe(0);
  });

  it('answers network for a missing mirror and builds it in the background for the next session', async () => {
    const first = await cache.checkout(fx.host, { cloneUrl: fx.origin }, { workdir: await newWorkdir(), branch: 'main' });
    expect(first).toEqual({ source: 'network', reason: 'missing' });
    await cache.settled();
    const second = await cache.checkout(fx.host, { cloneUrl: fx.origin }, { workdir: await newWorkdir(), branch: 'main' });
    expect(second.source).toBe('mirror');
  });

  it('fetches only the delta before a session, unless the mirror is fresh', async () => {
    cache = makeCache({ freshnessMs: 60_000 });
    await cache.refresh({ cloneUrl: fx.origin });
    const newer = await fx.commit(fx.seed, 'src.txt', 'changed\n');
    fx.git(fx.seed, 'push', '--quiet', 'origin', 'main');
    const fresh = await newWorkdir();
    await cache.checkout(fx.host, { cloneUrl: fx.origin }, { workdir: fresh, branch: 'main' });
    expect(fx.git(fresh, 'rev-parse', 'HEAD')).not.toBe(newer);

    cache = makeCache({ freshnessMs: 0 });
    const later = await newWorkdir();
    await cache.checkout(fx.host, { cloneUrl: fx.origin }, { workdir: later, branch: 'main' });
    expect(fx.git(later, 'rev-parse', 'HEAD')).toBe(newer);
  });

  it('clones from the mirror as it is when the remote cannot be fetched, and says so', async () => {
    await cache.refresh({ cloneUrl: fx.origin });
    await rm(fx.origin, { recursive: true, force: true });
    const workdir = await newWorkdir();
    const result = await cache.checkout(fx.host, { cloneUrl: fx.origin }, { workdir, branch: 'main' });
    expect(result.source).toBe('mirror');
    expect(result.source === 'mirror' && result.stale).toMatch(/mirror fetch failed/);
    expect(fx.git(workdir, 'rev-list', '--count', 'HEAD')).toBe('2');
  });

  it('quarantines a corrupt mirror, falls back to the network and repairs it', async () => {
    await cache.refresh({ cloneUrl: fx.origin });
    const mirror = cache.mirrorPath(fx.origin);
    await rm(path.join(mirror, 'objects'), { recursive: true, force: true });
    await mkdir(path.join(mirror, 'objects'));
    const workdir = await newWorkdir();
    const result = await cache.checkout(fx.host, { cloneUrl: fx.origin }, { workdir, branch: 'main' });
    expect(result.source).toBe('network');
    expect(result.source === 'network' && result.reason).toMatch(/^corrupt/);
    expect(await readdir(workdir)).toEqual([]);
    await cache.settled();
    expect(fx.tryGit(mirror, 'fsck', '--connectivity-only').status).toBe(0);
  });

  it('never deletes a broken mirror that holds session work', async () => {
    await cache.refresh({ cloneUrl: fx.origin });
    const mirror = cache.mirrorPath(fx.origin);
    const head = fx.git(mirror, 'rev-parse', 'refs/heads/main');
    fx.git(mirror, 'update-ref', 'refs/factory/wip/heads/factory/item-1', head);
    await rm(path.join(mirror, 'objects'), { recursive: true, force: true });
    await mkdir(path.join(mirror, 'objects'));
    const result = await cache.checkout(fx.host, { cloneUrl: fx.origin }, { workdir: await newWorkdir(), branch: 'main' });
    expect(result.source).toBe('network');
    await cache.settled();
    // Kept, and repaired by a fetch: the work ref is still there.
    expect(fx.git(mirror, 'rev-parse', 'refs/factory/wip/heads/factory/item-1')).toBe(head);
  });

  it('leaves no half-made mirror when creating it fails (disk full, no remote)', async () => {
    await mkdir(path.join(templateRoot, 'mirrors', 'local'), { recursive: true });
    await chmod(path.join(templateRoot, 'mirrors', 'local'), 0o555);
    await expect(cache.refresh({ cloneUrl: fx.origin })).rejects.toThrow();
    await chmod(path.join(templateRoot, 'mirrors', 'local'), 0o755);
    expect(await readdir(path.join(templateRoot, 'mirrors', 'local'))).toEqual([]);

    await expect(cache.refresh({ cloneUrl: path.join(fx.root, 'no-such-remote.git') })).rejects.toThrow(/mirror fetch failed/);
    const leftovers = (await readdir(path.join(templateRoot, 'mirrors', 'local'))).filter(name => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('serializes concurrent session checkouts of one repository and keeps the mirror sound', async () => {
    await cache.refresh({ cloneUrl: fx.origin });
    const other = makeCache();
    const dirs = await Promise.all(Array.from({ length: 6 }, () => newWorkdir()));
    const results = await Promise.all(
      dirs.map((workdir, index) => (index % 2 ? other : cache).checkout(fx.host, { cloneUrl: fx.origin }, { workdir, branch: 'main' })),
    );
    expect(results.every(result => result.source === 'mirror')).toBe(true);
    expect(fx.tryGit(cache.mirrorPath(fx.origin), 'fsck', '--connectivity-only').status).toBe(0);
    for (const dir of dirs) expect(fx.git(dir, 'status', '--porcelain')).toBe('');
  });

  it('takes over a lock a dead process left behind', async () => {
    await cache.refresh({ cloneUrl: fx.origin });
    const lock = `${cache.mirrorPath(fx.origin)}.lock`;
    await mkdir(lock);
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ host: (await import('node:os')).hostname(), pid: 999_999, token: 'dead', acquiredAt: '' }));
    const stale: unknown[] = [];
    cache = makeCache({ lock: { onStale: owner => stale.push(owner) } });
    const result = await cache.checkout(fx.host, { cloneUrl: fx.origin }, { workdir: await newWorkdir(), branch: 'main' });
    expect(result.source).toBe('mirror');
    expect(stale).toHaveLength(1);
  });

  it('falls back to the network when the lock is held past the wait', async () => {
    await cache.refresh({ cloneUrl: fx.origin });
    cache = makeCache({ lock: { waitMs: 300, pollMs: 50 } });
    let release!: () => void;
    const held = withFileLock(`${cache.mirrorPath(fx.origin)}.lock`, () => new Promise<void>(resolve => (release = resolve)));
    // Let the holder take it; a second process would see the directory.
    await new Promise(resolve => setTimeout(resolve, 50));
    const other = new LocalMirrorRepositoryCache({ root: templateRoot, host: fx.host, logger: silent, freshnessMs: 0, lock: { waitMs: 300, pollMs: 50 } });
    const result = await other.checkout(fx.host, { cloneUrl: fx.origin }, { workdir: await newWorkdir(), branch: 'main' });
    expect(result.source).toBe('network');
    release();
    await held;
    await other.settled();
  });

  it('prunes idle mirrors no project names, never one holding session work', async () => {
    const second = path.join(fx.root, 'second.git');
    fx.git(fx.root, 'clone', '--quiet', '--bare', fx.origin, second);
    const third = path.join(fx.root, 'third.git');
    fx.git(fx.root, 'clone', '--quiet', '--bare', fx.origin, third);
    for (const url of [fx.origin, second, third]) await cache.refresh({ cloneUrl: url });
    const thirdMirror = cache.mirrorPath(third);
    fx.git(thirdMirror, 'update-ref', 'refs/factory/wip/heads/x', fx.git(thirdMirror, 'rev-parse', 'refs/heads/main'));
    const later = makeCache({ now: () => Date.now() + 8 * 24 * 60 * 60_000 });
    const removed = await later.prune([fx.origin]);
    expect(removed).toEqual([cache.mirrorPath(second)]);
    await expect(stat(cache.mirrorPath(fx.origin))).resolves.toBeTruthy();
    await expect(stat(thirdMirror)).resolves.toBeTruthy();
    // Recently used mirrors stay.
    expect(await cache.prune([])).toEqual([]);
  });

  it('drops temporary refs a crashed save left behind, once they are old', async () => {
    await cache.refresh({ cloneUrl: fx.origin });
    const mirror = cache.mirrorPath(fx.origin);
    fx.git(mirror, 'update-ref', 'refs/factory/tmp/abc/head', fx.git(mirror, 'rev-parse', 'refs/heads/main'));
    await cache.maintain(fx.origin);
    expect(fx.tryGit(mirror, 'rev-parse', '--verify', 'refs/factory/tmp/abc/head').status).toBe(0);
    await makeCache({ now: () => Date.now() + 2 * 24 * 60 * 60_000 }).maintain(fx.origin);
    expect(fx.tryGit(mirror, 'rev-parse', '--verify', 'refs/factory/tmp/abc/head').status).not.toBe(0);
    const meta = JSON.parse(await readFile(path.join(mirror, 'factory-mirror.json'), 'utf8'));
    expect(meta.cloneUrl).toBe(fx.origin);
  });

  describe('over a misbehaving HTTP remote', () => {
    let server: Server;
    let url: string;
    afterEach(() => new Promise<void>(resolve => server.close(() => resolve())));

    it('aborts a stalled fetch, retries, and serves the stale mirror (c17061a0)', async () => {
      await cache.refresh({ cloneUrl: fx.origin });
      server = createServer(() => {
        // Accept and never answer: a stalled transfer.
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/repo.git`;
      // Point the existing mirror at the stalled remote, keeping its objects.
      const mirror = cache.mirrorPath(fx.origin);
      const stalledMirror = cache.mirrorPath(url);
      await mkdir(path.dirname(stalledMirror), { recursive: true });
      fx.git(fx.root, 'clone', '--quiet', '--mirror', mirror, stalledMirror);
      fx.git(stalledMirror, 'config', 'remote.origin.url', url);
      const started = Date.now();
      const result = await cache.checkout(
        fx.host,
        { cloneUrl: url, authEnv: { GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '1' } },
        { workdir: await newWorkdir(), branch: 'main' },
      );
      expect(result.source).toBe('mirror');
      expect(result.source === 'mirror' && result.stale).toMatch(/too slow|timed out|fetch failed/i);
      // Aborted by the low-speed limit and retried, not hung to the 15-minute guard.
      expect(Date.now() - started).toBeLessThan(30_000);
    }, 40_000);

    it('treats a connection dropped mid-transfer as a failed fetch and keeps serving', async () => {
      await cache.refresh({ cloneUrl: fx.origin });
      server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
        response.write('001e# service=git-upload-pack\n');
        response.socket?.destroy();
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/repo.git`;
      const mirror = cache.mirrorPath(fx.origin);
      const droppedMirror = cache.mirrorPath(url);
      await mkdir(path.dirname(droppedMirror), { recursive: true });
      fx.git(fx.root, 'clone', '--quiet', '--mirror', mirror, droppedMirror);
      fx.git(droppedMirror, 'config', 'remote.origin.url', url);
      const result = await cache.checkout(fx.host, { cloneUrl: url }, { workdir: await newWorkdir(), branch: 'main' });
      expect(result.source).toBe('mirror');
      expect(result.source === 'mirror' && result.stale).toBeTruthy();
    }, 40_000);
  });
});
