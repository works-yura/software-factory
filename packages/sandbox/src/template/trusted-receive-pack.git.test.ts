import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { trustedReceivePack } from './session-work-stores.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

/**
 * The agent user pushing into a mirror the server owns: git takes every repository as someone
 * else's (GIT_TEST_ASSUME_DIFFERENT_OWNER), and the agent's environment trusts its folders through
 * GIT_CONFIG_COUNT, as the launcher sets it.
 */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mirror-o'wner-")));
  roots.push(root);
  const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env } });
  const mirror = join(root, 'mirror.git');
  const checkout = join(root, 'checkout');
  git(root, ['init', '--bare', '-q', mirror]);
  git(root, ['init', '-q', checkout]);
  writeFileSync(join(checkout, 'a.txt'), 'a');
  git(checkout, ['add', 'a.txt']);
  git(checkout, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a']);
  const asAgent = {
    GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: `${root}/*`,
  };
  return { git, mirror, checkout, asAgent };
}

describe('trustedReceivePack', () => {
  it('lets the agent push into a mirror it does not own, where a plain push is refused', () => {
    const { git, mirror, checkout, asAgent } = setup();
    const plain = git(checkout, ['push', '--quiet', mirror, 'HEAD:refs/factory/tmp/plain'], asAgent);
    expect(plain.status).not.toBe(0);
    expect(plain.stderr).toContain('dubious ownership');

    const trusted = git(checkout, ['push', '--quiet', trustedReceivePack(mirror), mirror, 'HEAD:refs/factory/tmp/trusted'], asAgent);
    expect(trusted.stderr).toBe('');
    expect(trusted.status).toBe(0);
    expect(git(mirror, ['rev-parse', 'refs/factory/tmp/trusted']).status).toBe(0);
  });
});
