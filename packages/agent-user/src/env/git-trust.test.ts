import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withGitTrust } from './git-trust.ts';

describe('withGitTrust', () => {
  it('adds safe.directory for each root', () => {
    expect(withGitTrust({ A: '1' }, ['/w/', '/x'])).toEqual({
      A: '1',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '/w/*',
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: '/x/*',
    });
  });

  it('appends after config entries the environment already has', () => {
    const env = withGitTrust({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'x' }, ['/w']);
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: '/w/*' });
  });

  it('git reads it: the root counts as safe', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-trust-'));
    try {
      mkdirSync(join(root, 'repo'));
      const env = withGitTrust({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root }, [root]);
      const out = spawnSync('git', ['config', '--get-all', 'safe.directory'], { env, encoding: 'utf8' }).stdout;
      expect(out.trim()).toBe(`${root}/*`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
