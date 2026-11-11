import { describe, expect, it } from 'vitest';

import { codexAppServerArgs, codexExecLaunchArgs, resolveCodexLaunchArgs } from './launchArgs.ts';

describe('codexAppServerArgs', () => {
  it('preserves escaped TOML quotes in config values', () => {
    expect(codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`)).toEqual([
      '--config',
      'model="gpt-6.1-sol"',
      '--strict-config',
    ]);
  });

  it('prefers the environment over the configured arguments', () => {
    expect(resolveCodexLaunchArgs('--a', { FACTORY_CODEX_LAUNCH_ARGS: ' --b ' })).toBe('--b');
    expect(resolveCodexLaunchArgs(' --a ', {})).toBe('--a');
  });
});

describe('codexExecLaunchArgs', () => {
  it('keeps shared codex flags and omits app-server-only flags', () => {
    expect(codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"')).toEqual([
      '--strict-config',
      '--enable',
      'foo',
      '--config',
      'model=gpt 5',
    ]);
  });

  it('does not pair value-taking flags with adjacent flags', () => {
    expect(codexExecLaunchArgs('--config --strict-config --enable --disable')).toEqual(['--strict-config']);
  });
});
