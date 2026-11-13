import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkoutSessionBranch, materializeRepo } from '../github/sandbox.ts';
import { createSandboxSetupReporter, onSandboxSetupProgress } from '../setup-progress.ts';
import type { SandboxSetupProgressEvent } from '../setup-progress.ts';
import { hostExecutor } from './host-exec.ts';
import { LocalEnvironmentTemplate } from './local-template.ts';
import { gitFixture } from './test-git.ts';
import type { GitFixture } from './test-git.ts';

const silent = { info() {}, warn() {} };
/** The GitHub URL sessions see; git rewrites it to the local "remote". */
const CLONE_URL = 'https://github.com/acme/repo.git';

describe('materializing a session from the mirror, with real git', () => {
  let fx: GitFixture;
  let template: LocalEnvironmentTemplate;
  let host: ReturnType<typeof hostExecutor>;
  let n = 0;

  const materialize = async (sessionId = `s${++n}`) => {
    const dir = path.join(fx.root, 'sandboxes', sessionId, 'repo');
    await mkdir(dir, { recursive: true });
    const events: SandboxSetupProgressEvent[] = [];
    const off = onSandboxSetupProgress((id, event) => {
      if (id === sessionId) events.push(event);
    });
    const reporter = createSandboxSetupReporter(sessionId, ['acme/repo']);
    try {
      const result = await materializeRepo({
        row: { id: sessionId, sandboxWorkdir: dir, materializedAt: null },
        repoInfo: { repoFullName: 'acme/repo', defaultBranch: 'main', cloneUrl: CLONE_URL },
        sandbox: host,
        token: 'token',
        storage: { markMaterialized: async () => {} },
        progress: {
          cloning: source => reporter.step('clone', 'acme/repo', { source }),
          transfer: transfer => reporter.transfer('acme/repo', transfer),
        },
        repositoryCache: template.repositoryCache,
      });
      reporter.finish();
      return { dir, folder: path.dirname(dir), result, events };
    } finally {
      off();
    }
  };
  const checkout = (dir: string, branch: string) =>
    checkoutSessionBranch(host, dir, { branch, baseBranch: 'main', token: 'token', repoFullName: 'acme/repo', cloneUrl: CLONE_URL, identity: { name: 'T', email: 't@example.com' } });

  beforeEach(async () => {
    fx = await gitFixture('factory-materialize-');
    const config = path.join(fx.root, 'gitconfig');
    await writeFile(config, `[url "${fx.origin}"]\n\tinsteadOf = ${CLONE_URL}\n`);
    const env = { ...fx.env, GIT_CONFIG_GLOBAL: config };
    host = hostExecutor({ env });
    template = new LocalEnvironmentTemplate({ root: path.join(fx.root, 'template'), env, logger: silent, freshnessMs: 0 });
  });

  afterEach(async () => {
    await template.repositoryCache.settled();
    await rm(fx.root, { recursive: true, force: true });
  });

  it('clones from the network once, then from the mirror, and the chat hears which', async () => {
    const first = await materialize();
    expect(first.result).toMatchObject({ cloned: true, source: 'network', fallbackReason: 'missing' });
    expect(first.events.some(event => event.phase === 'clone' && event.source === 'network')).toBe(true);
    await template.repositoryCache.settled();

    const second = await materialize();
    expect(second.result).toMatchObject({ cloned: true, source: 'mirror' });
    expect(second.events.some(event => event.phase === 'clone' && event.source === 'mirror')).toBe(true);
    expect(fx.git(second.dir, 'remote', 'get-url', 'origin')).toBe(CLONE_URL);
    // Full history, not --depth=1.
    expect(fx.git(second.dir, 'rev-parse', '--is-shallow-repository')).toBe('false');

  });

  it('still resumes a session branch the remote already has (b770b10a) after a mirror clone', async () => {
    await template.repositoryCache.refresh({ cloneUrl: CLONE_URL });
    fx.git(fx.seed, 'checkout', '--quiet', '-b', 'user/session-1');
    const pushed = await fx.commit(fx.seed, 'pushed.txt', 'pushed\n');
    fx.git(fx.seed, 'push', '--quiet', 'origin', 'user/session-1');

    const { dir, result } = await materialize();
    expect(result.source).toBe('mirror');
    const restored = await template.sessionWork.restore({ sandbox: host, dir, cloneUrl: CLONE_URL }, 'user/session-1');
    expect(restored.outcome).toBe('none');
    await checkout(dir, 'user/session-1');
    expect(fx.git(dir, 'branch', '--show-current')).toBe('user/session-1');
    expect(fx.git(dir, 'rev-parse', 'HEAD')).toBe(pushed);
  });

  it('round trip: commit, folder removed, re-materialized from the mirror with the commit and uncommitted work back', async () => {
    await template.repositoryCache.refresh({ cloneUrl: CLONE_URL });
    const first = await materialize();
    await checkout(first.dir, 'factory/item-42');
    const committed = await fx.commit(first.dir, 'work.txt', 'work\n');
    await writeFile(path.join(first.dir, 'draft.txt'), 'draft\n');
    // The removal path: put to sleep (verified), then delete.
    await template.sleepFolder(first.folder);
    await rm(first.folder, { recursive: true, force: true });

    const second = await materialize();
    expect(second.result.source).toBe('mirror');
    const restored = await template.sessionWork.restore({ sandbox: host, dir: second.dir, cloneUrl: CLONE_URL }, 'factory/item-42');
    expect(restored).toMatchObject({ outcome: 'restored', tree: 'restored' });
    // The branch checkout that follows keeps the restored branch as it is.
    await checkout(second.dir, 'factory/item-42');
    expect(fx.git(second.dir, 'rev-parse', 'HEAD')).toBe(committed);
    expect(fx.git(second.dir, 'status', '--porcelain')).toBe('?? draft.txt');
  });
});
