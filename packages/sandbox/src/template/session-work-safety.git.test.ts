import { mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalFactorySandbox } from '../local-factory-sandbox.ts';
import { ENV_FILES_MANIFEST } from '../sandbox-env-files.ts';
import { withFileLock } from './file-lock.ts';
import { hostExecutor } from './host-exec.ts';
import { LocalEnvironmentTemplate, probeRepositoryVisibility, SessionWorkNotSavedError } from './local-template.ts';
import { gitFixture, mirrorsOf } from './test-git.ts';
import type { GitFixture } from './test-git.ts';

const silent = { info() {}, warn() {} };

/** The guarantees that keep saved work from being lost or leaked (ADR-0039 review). */
describe('session work safety, with real git', () => {
  let fx: GitFixture;
  let template: LocalEnvironmentTemplate;
  let n = 0;
  let isPublic = false;

  const freshCheckout = async (folderName = `session-${++n}`, repoName = 'repo', cloneUrl?: string) => {
    const folder = path.join(fx.root, 'sandboxes', folderName);
    const dir = path.join(folder, repoName);
    await mkdir(dir, { recursive: true });
    const result = await mirrorsOf(template).checkout(fx.host, { cloneUrl: cloneUrl ?? fx.origin }, { workdir: dir, branch: 'main' });
    expect(result.source).toBe('mirror');
    fx.git(dir, 'config', 'factory.orgId', 'org-1');
    fx.git(dir, 'config', 'factory.repositoryId', 'repo-1');
    return { folder, dir };
  };

  beforeEach(async () => {
    fx = await gitFixture('factory-safety-');
    isPublic = false;
    template = new LocalEnvironmentTemplate({
      root: path.join(fx.root, 'template'),
      env: fx.env,
      logger: silent,
      freshnessMs: 0,
      isPublicRepository: async () => isPublic,
    });
    template.setRepositoryAccess(async () => ({ cloneUrl: 'https://github.com/acme/repo.git', authorization: { scheme: 'bearer', token: 't' } }));
    await mirrorsOf(template).refresh({ cloneUrl: fx.origin });
  });

  afterEach(async () => {
    await mirrorsOf(template).settled();
    await rm(fx.root, { recursive: true, force: true });
  });

  it('a run-end save during removal does nothing, so it never records the deletion over the good snapshot', async () => {
    const { folder, dir } = await freshCheckout();
    fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-1');
    await fx.commit(dir, 'a.txt', 'a\n');
    await writeFile(path.join(dir, 'wip.txt'), 'wip\n');
    const mirror = mirrorsOf(template).mirrorPath(fx.origin);
    let racing: Promise<unknown> | undefined;
    await template.removeFolder(folder, {
      remove: async () => {
        // Half-deleted, and a run ends right now (through another spelling of the path).
        await rm(path.join(dir, 'wip.txt'));
        await rm(path.join(dir, 'a.txt'));
        racing = template.saveFolder(path.join(folder, '.', 'repo', '..'));
        await racing;
        await rm(folder, { recursive: true, force: true });
      },
    });
    await racing;
    const tree = fx.git(mirror, 'rev-parse', 'refs/factory/wip/tree/factory/item-1');
    expect(fx.git(mirror, 'show', `${tree}:wip.txt`)).toBe('wip');
    expect(fx.git(mirror, 'show', `${tree}:a.txt`)).toBe('a');
  });

  it('a run-end save queued as removal starts never runs beside it or after the files go', async () => {
    const { folder, dir } = await freshCheckout();
    fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-30');
    await writeFile(path.join(dir, 'keep.txt'), 'keep\n');
    const mirror = mirrorsOf(template).mirrorPath(fx.origin);
    // Removal starts, and a run ends in the same tick: its save is queued before the removal's own.
    const removing = template.removeFolder(folder, {
      remove: async () => {
        await rm(folder, { recursive: true, force: true });
      },
    });
    const saving = template.saveFolder(folder);
    await Promise.all([removing, saving]);
    const tree = fx.git(mirror, 'rev-parse', 'refs/factory/wip/tree/factory/item-30');
    expect(fx.git(mirror, 'show', `${tree}:keep.txt`)).toBe('keep');
  });

  it('an amend or a rebase that keeps every change sets nothing aside; a dropped commit does', async () => {
    const { folder, dir } = await freshCheckout();
    const mirror = mirrorsOf(template).mirrorPath(fx.origin);
    fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-31');
    await fx.commit(dir, 'one.txt', 'one\n', 'one');
    await fx.commit(dir, 'two.txt', 'two\n', 'two');
    await template.saveFolder(folder);
    // Reword the tip: same change, new commit.
    fx.git(dir, 'commit', '--quiet', '--amend', '-m', 'two, reworded');
    expect((await template.saveFolder(folder)).saved[0]?.superseded).toBeUndefined();
    // Rebase onto a newer main: same changes again.
    await fx.commit(fx.seed, 'main.txt', 'main\n');
    fx.git(fx.seed, 'push', '--quiet', 'origin', 'main');
    fx.git(dir, 'fetch', '--quiet', 'origin');
    fx.git(dir, 'rebase', '--quiet', 'origin/main');
    expect((await template.saveFolder(folder)).saved[0]?.superseded).toBeUndefined();
    expect(fx.git(mirror, 'for-each-ref', 'refs/factory/wip/superseded')).toBe('');
    // Drop `two`: its change is gone from the new tip.
    fx.git(dir, 'reset', '--quiet', '--hard', 'HEAD~1');
    expect((await template.saveFolder(folder)).saved[0]?.superseded).toBeTruthy();
  });

  it('drops forgotten work after the retention, and set-aside work only the retention after its card closed', async () => {
    const mirror = mirrorsOf(template).mirrorPath(fx.origin);
    const main = fx.git(mirror, 'rev-parse', 'refs/heads/main');
    const day = 24 * 60 * 60_000;
    const old = Date.now() - 40 * day;
    const recent = Date.now() - day;
    for (const ref of [
      `refs/factory/trash/${old}/heads/a`,
      `refs/factory/trash/${recent}/heads/d`,
      `refs/factory/wip/superseded/factory/item-32/${old}`,
      `refs/factory/wip/conflict/factory/item-32/${old}`,
    ]) {
      fx.git(mirror, 'update-ref', ref, main);
    }
    // The card is open: its set-aside work stays however old; old trash goes.
    expect(await template.pruneKeptRefs({ cloneUrl: fx.origin, retentionMs: 30 * day })).toEqual([`refs/factory/trash/${old}/heads/a`]);
    // The card closes now: not yet past the retention from the close.
    const { folder, dir } = await freshCheckout();
    fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-32');
    await fx.commit(dir, 'c.txt', 'c\n');
    await template.removeFolder(folder, { publish: true, closing: true, remove: async () => rm(folder, { recursive: true, force: true }) });
    expect(await template.pruneKeptRefs({ cloneUrl: fx.origin, retentionMs: 30 * day })).toEqual([]);
    const later = Date.now() + 31 * day;
    expect((await template.pruneKeptRefs({ cloneUrl: fx.origin, retentionMs: 30 * day, now: later })).sort()).toEqual([
      `refs/factory/trash/${recent}/heads/d`,
      `refs/factory/wip/conflict/factory/item-32/${old}`,
      `refs/factory/wip/superseded/factory/item-32/${old}`,
    ]);
    // Reopened, a branch's set-aside work is kept again.
    fx.git(mirror, 'update-ref', `refs/factory/wip/conflict/factory/item-32/${old + 1}`, main);
    const again = await freshCheckout();
    fx.git(again.dir, 'checkout', '--quiet', '-b', 'factory/item-32');
    await fx.commit(again.dir, 'd.txt', 'd\n');
    await template.saveFolder(again.folder);
    expect(await template.pruneKeptRefs({ cloneUrl: fx.origin, retentionMs: 30 * day, now: later })).toEqual([]);
  });

  it('refuses to remove a checkout whose work cannot be named: detached with commits of its own', async () => {
    const { folder, dir } = await freshCheckout();
    fx.git(dir, 'checkout', '--quiet', '--detach');
    await fx.commit(dir, 'lost.txt', 'would be lost\n');
    let removed = false;
    await expect(template.removeFolder(folder, { remove: async () => void (removed = true) })).rejects.toBeInstanceOf(SessionWorkNotSavedError);
    expect(removed).toBe(false);
    // Clean and on a commit the remote has: nothing to keep, it may go.
    fx.git(dir, 'checkout', '--quiet', '--detach', 'origin/main');
    await template.removeFolder(folder, { remove: async () => void (removed = true) });
    expect(removed).toBe(true);
  });

  it('refuses to remove a checkout without a usable origin', async () => {
    const { folder, dir } = await freshCheckout();
    fx.git(dir, 'remote', 'set-url', 'origin', 'https://user:secret@github.com/acme/repo.git');
    await expect(template.removeFolder(folder, { remove: async () => {} })).rejects.toThrow(/origin/);
  });

  it('a closing card trusts no stale origin/*: a branch deleted on the remote still gets its work published', async () => {
    const { folder, dir } = await freshCheckout();
    fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-2');
    const head = await fx.commit(dir, 'b.txt', 'b\n');
    fx.git(dir, 'push', '--quiet', '-u', 'origin', 'factory/item-2');
    // Gone on the remote; the checkout's origin/factory/item-2 still says it holds the work.
    fx.git(fx.origin, 'update-ref', '-d', 'refs/heads/factory/item-2');
    await template.sleepFolder(folder, { publish: true });
    expect(fx.git(fx.origin, 'rev-parse', 'refs/factory/wip/heads/factory/item-2')).toBe(head);
    expect(fx.git(mirrorsOf(template).mirrorPath(fx.origin), 'rev-parse', 'refs/factory/wip/heads/factory/item-2')).toBe(head);
  });

  it('never publishes to a public repository: the mirror keeps it and the caller hears why', async () => {
    isPublic = true;
    const { folder, dir } = await freshCheckout();
    fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-3');
    await fx.commit(dir, 'c.txt', 'c\n');
    const notices = await template.sleepFolder(folder, { publish: true });
    expect(notices.join('\n')).toMatch(/public repository/);
    expect(fx.tryGit(fx.origin, 'rev-parse', '--verify', 'refs/factory/wip/heads/factory/item-3').status).not.toBe(0);
    expect(fx.tryGit(mirrorsOf(template).mirrorPath(fx.origin), 'rev-parse', '--verify', 'refs/factory/wip/heads/factory/item-3').status).toBe(0);
  });

  it('keeps env files, secrets and huge files out of the saved work, even staged by hand', async () => {
    const { folder, dir } = await freshCheckout();
    fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-4');
    // Factory's env files, listed in the manifest (as if the exclude list were missing: written partway).
    await writeFile(path.join(dir, 'config.yml'), 'token: s3cret\n');
    await writeFile(path.join(dir, '.git', ENV_FILES_MANIFEST), 'config.yml\n');
    await mkdir(path.join(dir, '.secrets'), { recursive: true });
    await writeFile(path.join(dir, '.secrets', 'factory-sa.json'), '{"private_key":"x"}\n');
    await writeFile(path.join(dir, '.env.local'), 'KEY=1\n');
    await writeFile(path.join(dir, 'deploy.pem'), 'pem\n');
    await writeFile(path.join(dir, '.env'), 'STAGED=1\n');
    fx.git(dir, 'add', '-f', '.env');
    await truncate(path.join(dir, 'huge.bin'), 101 * 1024 * 1024).catch(async () => {
      await writeFile(path.join(dir, 'huge.bin'), '');
      await truncate(path.join(dir, 'huge.bin'), 101 * 1024 * 1024);
    });
    await writeFile(path.join(dir, 'kept.txt'), 'kept\n');
    for (const name of ['credentials.json', 'id_rsa', 'id_ed25519.pub', '.npmrc', '.pypirc', 'cert.p12', '.netrc']) {
      await writeFile(path.join(dir, name), 'secret\n');
    }
    const saved = await template.saveFolder(folder);
    expect(saved.saved[0]?.snapshot?.skipped).toEqual(['huge.bin']);
    const mirror = mirrorsOf(template).mirrorPath(fx.origin);
    const files = fx.git(mirror, 'ls-tree', '-r', '--name-only', 'refs/factory/wip/tree/factory/item-4');
    expect(files).toContain('kept.txt');
    for (const secret of [
      'config.yml',
      '.secrets/factory-sa.json',
      '.env.local',
      'deploy.pem',
      '.env',
      'huge.bin',
      'credentials.json',
      'id_rsa',
      'id_ed25519.pub',
      '.npmrc',
      '.pypirc',
      'cert.p12',
      '.netrc',
    ]) {
      expect(files.split('\n')).not.toContain(secret);
    }
    // The session's own index still has what it staged.
    expect(fx.git(dir, 'diff', '--cached', '--name-only')).toBe('.env');
  });

  it('saves when an env file in the manifest sits in an ignored folder (git refuses to name an ignored path)', async () => {
    const { folder, dir } = await freshCheckout();
    fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-ignored');
    // As setup writes it in a repository that ignores the folder: `.secrets/` in .gitignore.
    await writeFile(path.join(dir, '.gitignore'), '.secrets/\n');
    await mkdir(path.join(dir, '.secrets'), { recursive: true });
    await writeFile(path.join(dir, '.secrets', 'factory-sa.json'), '{"private_key":"x"}\n');
    await writeFile(path.join(dir, '.git', ENV_FILES_MANIFEST), '.secrets/factory-sa.json\n');
    await writeFile(path.join(dir, 'kept.txt'), 'kept\n');

    const saved = await template.saveFolder(folder);
    expect(saved.failures).toEqual([]);
    const mirror = template.repositoryCache.mirrorPath(fx.origin);
    const files = fx.git(mirror, 'ls-tree', '-r', '--name-only', 'refs/factory/wip/tree/factory/item-ignored').split('\n');
    expect(files).toContain('kept.txt');
    expect(files).not.toContain('.secrets/factory-sa.json');
  });

  it('records the owner on a mirror a save has to create, so publishing later can find credentials', async () => {
    const elsewhere = path.join(fx.root, 'second.git');
    fx.git(fx.root, 'clone', '--quiet', '--bare', fx.origin, elsewhere);
    const folder = path.join(fx.root, 'sandboxes', 'network');
    const dir = path.join(folder, 'repo');
    // A network clone: no mirror exists for it.
    fx.git(fx.root, 'clone', '--quiet', elsewhere, dir);
    fx.git(dir, 'config', 'factory.orgId', 'org-9');
    fx.git(dir, 'config', 'factory.repositoryId', 'repo-9');
    fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-5');
    await fx.commit(dir, 'e.txt', 'e\n');
    await template.saveFolder(folder);
    const meta = JSON.parse(await readFile(path.join(mirrorsOf(template).mirrorPath(elsewhere), 'factory-mirror.json'), 'utf8'));
    expect(meta.owner).toEqual({ orgId: 'org-9', repositoryId: 'repo-9' });
  });

  it('a session never waits behind a mirror being created: no mirror yet answers network at once', async () => {
    const other = path.join(fx.root, 'other.git');
    fx.git(fx.root, 'clone', '--quiet', '--bare', fx.origin, other);
    const mirror = mirrorsOf(template).mirrorPath(other);
    await mkdir(path.dirname(mirror), { recursive: true });
    let release!: () => void;
    // A build holds the lock while it creates the mirror.
    const held = withFileLock(`${mirror}.lock`, () => new Promise<void>(resolve => (release = resolve)));
    await new Promise(resolve => setTimeout(resolve, 50));
    const workdir = path.join(fx.root, 'sandboxes', 'waiting', 'repo');
    await mkdir(workdir, { recursive: true });
    const started = Date.now();
    const result = await mirrorsOf(template).checkout(fx.host, { cloneUrl: other }, { workdir, branch: 'main' });
    expect(result).toEqual({ source: 'network', reason: 'missing' });
    expect(Date.now() - started).toBeLessThan(2_000);
    release();
    await held;
  });

  it('saves every repository of the folder when a run ends, whichever checkout the session names', async () => {
    const second = path.join(fx.root, 'second.git');
    fx.git(fx.root, 'clone', '--quiet', '--bare', fx.origin, second);
    await mirrorsOf(template).refresh({ cloneUrl: second });
    const sandboxRoot = path.join(fx.root, 'sandboxes');
    const sandbox = new LocalFactorySandbox({ root: sandboxRoot, template });
    const one = await freshCheckout('work-items/f/card-1'.replaceAll('/', path.sep), 'api');
    const two = await freshCheckout('work-items/f/card-1'.replaceAll('/', path.sep), 'web', second);
    for (const dir of [one.dir, two.dir]) {
      fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-6');
      await writeFile(path.join(dir, 'w.txt'), 'w\n');
    }
    expect(sandbox.folderRootOf(one.dir)).toBe(path.join(sandboxRoot, 'work-items', 'f', 'card-1'));
    await sandbox.saveSessionWork(one.dir);
    for (const url of [fx.origin, second]) {
      expect(fx.tryGit(mirrorsOf(template).mirrorPath(url), 'rev-parse', '--verify', 'refs/factory/wip/tree/factory/item-6').status).toBe(0);
    }
  });
});

describe('repository visibility for publishing, with real git', () => {
  const PRIVATE_URL = 'https://example.invalid/acme/private.git';

  it('the default probe never trusts the host git config: a rewrite or helper cannot make a private repository look public', async () => {
    const fx = await gitFixture('factory-visibility-');
    try {
      // The host's own git maps the private URL onto a repository it can read.
      const config = path.join(fx.root, 'host-gitconfig');
      await writeFile(config, `[url "${fx.origin}"]\n\tinsteadOf = ${PRIVATE_URL}\n[credential]\n\thelper = store\n`);
      const host = hostExecutor({ env: { ...fx.env, GIT_CONFIG_GLOBAL: config } });
      expect(await probeRepositoryVisibility(host, PRIVATE_URL)).toBe('unknown');
      // A repository readable with no configuration at all is public.
      expect(await probeRepositoryVisibility(host, fx.origin)).toBe('public');

      // Unknown: the commits are published, uncommitted work is not, and the person hears why.
      const template = new LocalEnvironmentTemplate({ root: path.join(fx.root, 'template'), env: { ...fx.env, GIT_CONFIG_GLOBAL: config }, logger: silent, freshnessMs: 0 });
      template.setRepositoryAccess(async () => ({ cloneUrl: 'https://github.com/acme/repo.git', authorization: { scheme: 'bearer', token: 't' } }));
      await mirrorsOf(template).refresh({ cloneUrl: PRIVATE_URL });
      const folder = path.join(fx.root, 'sandboxes', 'card');
      const dir = path.join(folder, 'repo');
      await mkdir(dir, { recursive: true });
      expect((await mirrorsOf(template).checkout(host, { cloneUrl: PRIVATE_URL }, { workdir: dir, branch: 'main' })).source).toBe('mirror');
      fx.git(dir, 'config', 'factory.orgId', 'org-1');
      fx.git(dir, 'config', 'factory.repositoryId', 'repo-1');
      fx.git(dir, 'checkout', '--quiet', '-b', 'factory/item-40');
      const head = await fx.commit(dir, 'forty.txt', '40\n');
      await writeFile(path.join(dir, 'draft.txt'), 'draft\n');
      const notices = await template.sleepFolder(folder, { publish: true });
      expect(notices.join('\n')).toMatch(/visibility unknown/);
      expect(fx.git(fx.origin, 'rev-parse', 'refs/factory/wip/heads/factory/item-40')).toBe(head);
      expect(fx.tryGit(fx.origin, 'rev-parse', '--verify', 'refs/factory/wip/tree/factory/item-40').status).not.toBe(0);

      // The integration's answer wins over the probe: private means everything is published.
      template.setRepositoryVisibility(async () => 'private');
      await template.sleepFolder(folder, { publish: true });
      expect(fx.tryGit(fx.origin, 'rev-parse', '--verify', 'refs/factory/wip/tree/factory/item-40').status).toBe(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe('file lock takeover', () => {
  it('three processes taking over one stale lock never hold it together', async () => {
    const fx = await gitFixture('factory-lock-');
    try {
      const lock = path.join(fx.root, 'repo.git.lock');
      await mkdir(lock);
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ host: hostname(), pid: 999_999, token: 'dead', acquiredAt: '' }));
      let holders = 0;
      let most = 0;
      const takeovers: unknown[] = [];
      // Three acquirers that do not share this process's queue, as three processes would not.
      await Promise.all(
        Array.from({ length: 3 }, () =>
          withFileLock(
            lock,
            async () => {
              holders++;
              most = Math.max(most, holders);
              await new Promise(resolve => setTimeout(resolve, 60));
              holders--;
            },
            { inProcessQueue: false, pollMs: 10, onStale: owner => takeovers.push(owner) },
          ),
        ),
      );
      expect(most).toBe(1);
      expect(takeovers).toHaveLength(1);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});
