import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalEnvironmentTemplate, SessionWorkNotSavedError } from './local-template.ts';
import { updateRefsAtomically } from './session-work.ts';
import { gitFixture, mirrorsOf } from './test-git.ts';
import type { GitFixture } from './test-git.ts';

const silent = { info() {}, warn() {} };

describe('session work kept in the mirror, with real git', () => {
  let fx: GitFixture;
  let template: LocalEnvironmentTemplate;
  let sessions = 0;

  /** A session folder with one repository checked out from the mirror, as materialization leaves it. */
  const freshCheckout = async () => {
    const folder = path.join(fx.root, 'sandboxes', `session-${++sessions}`);
    const dir = path.join(folder, 'repo');
    await mkdir(dir, { recursive: true });
    const result = await mirrorsOf(template).checkout(fx.host, { cloneUrl: fx.origin }, { workdir: dir, branch: 'main' });
    expect(result.source).toBe('mirror');
    // As materialization records it: who the repository belongs to.
    fx.git(dir, 'config', 'factory.orgId', 'org-1');
    fx.git(dir, 'config', 'factory.repositoryId', 'repo-1');
    return { folder, dir, checkout: { sandbox: fx.host, dir, cloneUrl: fx.origin } };
  };

  beforeEach(async () => {
    fx = await gitFixture('factory-work-');
    template = new LocalEnvironmentTemplate({
      root: path.join(fx.root, 'template'),
      env: fx.env,
      logger: silent,
      freshnessMs: 0,
      isPublicRepository: async () => false,
    });
    template.setRepositoryAccess(async () => ({ cloneUrl: 'https://github.com/acme/repo.git', authorization: { scheme: 'bearer', token: 't' } }));
    await mirrorsOf(template).refresh({ cloneUrl: fx.origin });
  });

  afterEach(async () => {
    await mirrorsOf(template).settled();
    await rm(fx.root, { recursive: true, force: true });
  });

  it('restores a commit and uncommitted work after the folder is deleted', async () => {
    const first = await freshCheckout();
    fx.git(first.dir, 'checkout', '--quiet', '-b', 'factory/item-1');
    const committed = await fx.commit(first.dir, 'feature.txt', 'feature\n');
    // Uncommitted: a modified file, a new file, a deleted file, and a staged change.
    await writeFile(path.join(first.dir, 'src.txt'), 'a\nB\nc\n');
    await writeFile(path.join(first.dir, 'new.txt'), 'brand new\n');
    await rm(path.join(first.dir, 'README.md'));
    await writeFile(path.join(first.dir, 'staged.txt'), 'staged\n');
    fx.git(first.dir, 'add', 'staged.txt');
    const indexBefore = await readFile(path.join(first.dir, '.git', 'index'));
    const statusBefore = fx.git(first.dir, 'status', '--porcelain');

    const saved = await template.saveFolder(first.folder);
    expect(saved.failures).toEqual([]);
    // The snapshot touched neither the index nor the working tree.
    expect(await readFile(path.join(first.dir, '.git', 'index'))).toEqual(indexBefore);
    expect(fx.git(first.dir, 'status', '--porcelain')).toBe(statusBefore);

    await rm(first.folder, { recursive: true, force: true });
    const second = await freshCheckout();
    const restored = await template.sessionWork.restore(second.checkout, 'factory/item-1');
    expect(restored).toMatchObject({ outcome: 'restored', from: 'mirror', tree: 'restored' });
    expect(fx.git(second.dir, 'branch', '--show-current')).toBe('factory/item-1');
    expect(fx.git(second.dir, 'rev-parse', 'HEAD')).toBe(committed);
    expect(await readFile(path.join(second.dir, 'src.txt'), 'utf8')).toBe('a\nB\nc\n');
    expect(await readFile(path.join(second.dir, 'new.txt'), 'utf8')).toBe('brand new\n');
    expect(await readFile(path.join(second.dir, 'staged.txt'), 'utf8')).toBe('staged\n');
    const status = fx.git(second.dir, 'status', '--porcelain');
    expect(status).toContain(' M src.txt');
    expect(status).toMatch(/(^| )D README\.md/m);
    expect(status).toContain('?? new.txt');
    // The restore leaves no helper refs behind.
    expect(fx.git(second.dir, 'for-each-ref', 'refs/factory')).toBe('');
  });

  it('keeps the saved commits when the remote branch went another way, and says so', async () => {
    const first = await freshCheckout();
    fx.git(first.dir, 'checkout', '--quiet', '-b', 'factory/item-2');
    const local = await fx.commit(first.dir, 'local.txt', 'local\n');
    await template.saveFolder(first.folder);
    // Meanwhile someone force-pushes another history to the branch on the remote.
    fx.git(fx.seed, 'checkout', '--quiet', '-b', 'factory/item-2');
    const remote = await fx.commit(fx.seed, 'remote.txt', 'remote\n');
    fx.git(fx.seed, 'push', '--quiet', '--force', 'origin', 'factory/item-2');
    await rm(first.folder, { recursive: true, force: true });

    const second = await freshCheckout();
    const restored = await template.sessionWork.restore(second.checkout, 'factory/item-2');
    expect(restored.outcome).toBe('restored');
    expect(restored.diverged).toEqual({ saved: local, remote });
    expect(fx.git(second.dir, 'rev-parse', 'HEAD')).toBe(local);
    expect(fx.git(second.dir, 'rev-parse', 'origin/factory/item-2')).toBe(remote);
  });

  it('takes the remote branch when it already contains the saved work (pushed, then continued)', async () => {
    const first = await freshCheckout();
    fx.git(first.dir, 'checkout', '--quiet', '-b', 'factory/item-3');
    await fx.commit(first.dir, 'mine.txt', 'mine\n');
    await template.saveFolder(first.folder);
    fx.git(first.dir, 'push', '--quiet', 'origin', 'factory/item-3');
    fx.git(fx.seed, 'fetch', '--quiet', 'origin');
    fx.git(fx.seed, 'checkout', '--quiet', '-b', 'factory/item-3', 'origin/factory/item-3');
    const further = await fx.commit(fx.seed, 'theirs.txt', 'theirs\n');
    fx.git(fx.seed, 'push', '--quiet', 'origin', 'factory/item-3');
    await rm(first.folder, { recursive: true, force: true });

    const second = await freshCheckout();
    const restored = await template.sessionWork.restore(second.checkout, 'factory/item-3');
    expect(restored.outcome).toBe('remote');
    expect(restored.diverged).toBeUndefined();
    expect(fx.git(second.dir, 'rev-parse', 'HEAD')).toBe(further);
  });

  it('leaves the checkout clean and reports when uncommitted work no longer applies', async () => {
    const first = await freshCheckout();
    fx.git(first.dir, 'checkout', '--quiet', '-b', 'factory/item-4');
    fx.git(first.dir, 'push', '--quiet', 'origin', 'factory/item-4');
    await writeFile(path.join(first.dir, 'src.txt'), 'mine\n');
    await template.saveFolder(first.folder);
    // The remote branch moves on, changing the same lines.
    fx.git(fx.seed, 'fetch', '--quiet', 'origin');
    fx.git(fx.seed, 'checkout', '--quiet', '-b', 'factory/item-4', 'origin/factory/item-4');
    await fx.commit(fx.seed, 'src.txt', 'theirs\n');
    fx.git(fx.seed, 'push', '--quiet', 'origin', 'factory/item-4');
    await rm(first.folder, { recursive: true, force: true });

    const second = await freshCheckout();
    const restored = await template.sessionWork.restore(second.checkout, 'factory/item-4');
    expect(restored).toMatchObject({ outcome: 'remote', tree: 'conflict' });
    expect(restored.conflictRef).toMatch(/^refs\/factory\/wip\/conflict\/factory\/item-4\/\d+$/);
    expect(fx.git(second.dir, 'status', '--porcelain')).toBe('');
    // The work that did not apply is set aside, and the next save (a clean tree) never drops it.
    const mirror = mirrorsOf(template).mirrorPath(fx.origin);
    const kept = fx.git(mirror, 'rev-parse', restored.conflictRef!);
    await template.saveFolder(second.folder);
    expect(fx.git(mirror, 'rev-parse', restored.conflictRef!)).toBe(kept);
    expect(fx.git(mirror, 'show', `${kept}:src.txt`)).toBe('mine');
  });

  it('saves atomically: a concurrent writer is detected by the old value, and a crashed save leaves only temporary refs', async () => {
    const mirror = mirrorsOf(template).mirrorPath(fx.origin);
    const main = fx.git(mirror, 'rev-parse', 'refs/heads/main');
    // Expecting a ref to be absent fails when it exists: nothing is changed.
    fx.git(mirror, 'update-ref', 'refs/factory/wip/heads/b', main);
    const ok = await updateRefsAtomically(fx.host, mirror, [
      { ref: 'refs/factory/wip/heads/b', next: main, old: null },
      { ref: 'refs/factory/wip/tree/b', next: main, old: null },
    ]);
    expect(ok).toBe(false);
    expect(fx.tryGit(mirror, 'rev-parse', '--verify', 'refs/factory/wip/tree/b').status).not.toBe(0);

    // A save that pushed objects and then died: only its temporary ref exists, the work refs are untouched.
    const first = await freshCheckout();
    fx.git(first.dir, 'checkout', '--quiet', '-b', 'factory/item-5');
    const head = await fx.commit(first.dir, 'x.txt', 'x\n');
    fx.git(first.dir, 'push', '--quiet', mirror, `${head}:refs/factory/tmp/crashed/head`);
    expect(fx.tryGit(mirror, 'rev-parse', '--verify', 'refs/factory/wip/heads/factory/item-5').status).not.toBe(0);
    // The next save completes normally beside it.
    await template.saveFolder(first.folder);
    expect(fx.git(mirror, 'rev-parse', 'refs/factory/wip/heads/factory/item-5')).toBe(head);
    // Saved commits the new tip does not contain are set aside, never replaced.
    fx.git(first.dir, 'reset', '--quiet', '--hard', 'HEAD~1');
    const other = await fx.commit(first.dir, 'y.txt', 'y\n');
    const saved = await template.saveFolder(first.folder);
    expect(fx.git(mirror, 'rev-parse', 'refs/factory/wip/heads/factory/item-5')).toBe(other);
    const superseded = saved.saved[0]?.superseded;
    expect(superseded?.head).toBe(head);
    expect(fx.git(mirror, 'rev-parse', superseded!.ref)).toBe(head);
    expect(fx.git(mirror, 'reflog', 'show', '--format=%H', 'refs/factory/wip/heads/factory/item-5')).toContain(head);
  });

  it('puts a card folder to sleep: mirror and hidden refs on the remote; a lost mirror restores from the remote', async () => {
    const first = await freshCheckout();
    fx.git(first.dir, 'checkout', '--quiet', '-b', 'factory/item-6');
    const head = await fx.commit(first.dir, 'six.txt', 'six\n');
    await writeFile(path.join(first.dir, 'wip.txt'), 'wip\n');
    await template.sleepFolder(first.folder, { publish: true });
    expect(fx.git(fx.origin, 'rev-parse', 'refs/factory/wip/heads/factory/item-6')).toBe(head);
    expect(fx.tryGit(fx.origin, 'rev-parse', '--verify', 'refs/factory/wip/tree/factory/item-6').status).toBe(0);
    // Not a branch: the branch list does not show it.
    expect(fx.git(fx.origin, 'branch', '--list')).not.toContain('item-6');
    await rm(first.folder, { recursive: true, force: true });

    // The server's disk loses the mirror; a new one fetches the published work.
    await rm(mirrorsOf(template).mirrorPath(fx.origin), { recursive: true, force: true });
    await mirrorsOf(template).refresh({ cloneUrl: fx.origin });
    const second = await freshCheckout();
    const restored = await template.sessionWork.restore(second.checkout, 'factory/item-6');
    expect(restored).toMatchObject({ outcome: 'restored', from: 'mirror-published', tree: 'restored' });
    expect(fx.git(second.dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(path.join(second.dir, 'wip.txt'), 'utf8')).toBe('wip\n');
  });

  it('refuses to put a folder to sleep when its work cannot be kept, so the folder stays', async () => {
    const first = await freshCheckout();
    fx.git(first.dir, 'checkout', '--quiet', '-b', 'factory/item-7');
    await fx.commit(first.dir, 'seven.txt', '7\n');
    const mirror = mirrorsOf(template).mirrorPath(fx.origin);
    // The mirror cannot be written (a full or read-only disk).
    await chmod(path.join(mirror, 'objects'), 0o555);
    await chmod(path.join(mirror, 'refs'), 0o555);
    try {
      await expect(template.sleepFolder(first.folder)).rejects.toBeInstanceOf(SessionWorkNotSavedError);
    } finally {
      await chmod(path.join(mirror, 'objects'), 0o755);
      await chmod(path.join(mirror, 'refs'), 0o755);
    }
    // Publishing without credentials also fails loudly instead of deleting.
    template.setRepositoryAccess(undefined);
    await expect(template.sleepFolder(first.folder, { publish: true })).rejects.toThrow(/credentials/);
  });

  it('a card closing on work already on the remote drops its saved refs; a deleted session forgets its branch', async () => {
    const first = await freshCheckout();
    fx.git(first.dir, 'checkout', '--quiet', '-b', 'factory/item-8');
    await fx.commit(first.dir, 'eight.txt', '8\n');
    await template.saveFolder(first.folder);
    const mirror = mirrorsOf(template).mirrorPath(fx.origin);
    expect(fx.tryGit(mirror, 'rev-parse', '--verify', 'refs/factory/wip/heads/factory/item-8').status).toBe(0);
    fx.git(first.dir, 'push', '--quiet', 'origin', 'factory/item-8');
    await template.sleepFolder(first.folder, { publish: true });
    expect(fx.tryGit(mirror, 'rev-parse', '--verify', 'refs/factory/wip/heads/factory/item-8').status).not.toBe(0);

    // A deleted session forgets exactly what it saved, into the trash; another session's later save of the branch stays.
    fx.git(first.dir, 'checkout', '--quiet', '-b', 'user/session-9');
    const mine = await fx.commit(first.dir, 'nine.txt', '9\n');
    await template.saveFolder(first.folder, { sessionId: 'row-a' });
    await template.forgetSession('row-a');
    expect(fx.tryGit(mirror, 'rev-parse', '--verify', 'refs/factory/wip/heads/user/session-9').status).not.toBe(0);
    expect(fx.git(mirror, 'for-each-ref', '--format=%(objectname)', 'refs/factory/trash')).toContain(mine);

    const theirs = await fx.commit(first.dir, 'ten.txt', '10\n');
    await template.saveFolder(first.folder, { sessionId: 'row-a' });
    await template.saveFolder(first.folder, { sessionId: 'row-b' });
    // row-a's record names `theirs` too now; make another session move the branch on first.
    const later = await fx.commit(first.dir, 'eleven.txt', '11\n');
    await template.saveFolder(first.folder, { sessionId: 'row-b' });
    await template.forgetSession('row-a');
    expect(fx.git(mirror, 'rev-parse', 'refs/factory/wip/heads/user/session-9')).toBe(later);
    expect(theirs).not.toBe(later);
  });

  it('never restores into a checkout with changes of its own', async () => {
    const first = await freshCheckout();
    fx.git(first.dir, 'checkout', '--quiet', '-b', 'factory/item-10');
    await fx.commit(first.dir, 'ten.txt', '10\n');
    await template.saveFolder(first.folder);
    const second = await freshCheckout();
    await writeFile(path.join(second.dir, 'mine.txt'), 'in flight\n');
    expect(await template.sessionWork.restore(second.checkout, 'factory/item-10')).toEqual({ outcome: 'none', skipped: 'local-changes' });
    expect(fx.git(second.dir, 'branch', '--show-current')).toBe('main');
    expect(await readFile(path.join(second.dir, 'mine.txt'), 'utf8')).toBe('in flight\n');
  });

  it('keeps nothing for an untouched default-branch checkout', async () => {
    const first = await freshCheckout();
    await template.saveFolder(first.folder);
    const mirror = mirrorsOf(template).mirrorPath(fx.origin);
    expect(fx.git(mirror, 'for-each-ref', 'refs/factory/wip')).toBe('');
  });
});
