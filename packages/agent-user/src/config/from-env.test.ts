import { describe, expect, it } from 'vitest';

import { isAccountName } from './account-name.ts';
import { agentToolchain, agentUserFromEnv } from './from-env.ts';
import { parsePathList } from './path-list.ts';

const context = { serverUser: 'yura', sandboxRoot: '/Volumes/dot/Project/factory/sandboxes' };

describe('agentUserFromEnv', () => {
  it('is off unless FACTORY_AGENT_USER is set', () => {
    expect(agentUserFromEnv({}, context)).toBeUndefined();
    expect(agentUserFromEnv({ FACTORY_AGENT_USER: '  ' }, context)).toBeUndefined();
  });

  it('derives the home, profile, tools and work folder from the user', () => {
    expect(agentUserFromEnv({ FACTORY_AGENT_USER: 'factory' }, context)).toEqual({
      user: 'factory',
      home: '/Users/factory',
      profilePath: '/var/factory/agent-factory.sb',
      writableRoots: ['/Volumes/dot/Project/factory/sandboxes'],
      toolPath: [
        '/Users/factory/.local/bin',
        '/Users/factory/.local/node/bin',
        '/Users/factory/.local/fvm',
        '/opt/homebrew/bin',
        '/Users/factory/fvm/default/bin',
        '/Users/factory/.pub-cache/bin',
        '/Users/factory/.cargo/bin',
        '/Users/factory/go/bin',
        '/Users/factory/.npm-global/bin',
      ],
      seatbelt: true,
      xcodeConfigPath: '/var/factory/agent-factory.xcconfig',
      toolchainEnv: {},
      readableRoots: [],
    });
  });

  it("passes the server's toolchains on: their variables, command folders and read-only roots", () => {
    const config = agentUserFromEnv(
      {
        FACTORY_AGENT_USER: 'factory',
        FACTORY_AGENT_PATH: '/Users/factory/.local/bin',
        ANDROID_HOME: '/Volumes/dot/SDK/Android/',
        JAVA_HOME: '/opt/homebrew/opt/openjdk@17',
        FACTORY_AGENT_READABLE: '/Volumes/dot/SDK/Gradle',
        UNRELATED: 'x',
      },
      context,
    );
    expect(config?.toolchainEnv).toEqual({ ANDROID_HOME: '/Volumes/dot/SDK/Android/', JAVA_HOME: '/opt/homebrew/opt/openjdk@17' });
    expect(config?.readableRoots).toEqual(['/Volumes/dot/SDK/Android', '/opt/homebrew/opt/openjdk@17', '/Volumes/dot/SDK/Gradle']);
    expect(config?.toolPath).toEqual([
      '/Users/factory/.local/bin',
      '/Volumes/dot/SDK/Android/platform-tools',
      '/Volumes/dot/SDK/Android/cmdline-tools/latest/bin',
      '/Volumes/dot/SDK/Android/emulator',
      '/opt/homebrew/opt/openjdk@17/bin',
      '/Users/factory/fvm/default/bin',
      '/Users/factory/.pub-cache/bin',
      '/Users/factory/.cargo/bin',
      '/Users/factory/go/bin',
      '/Users/factory/.npm-global/bin',
    ]);
  });

  it('refuses FACTORY_AGENT_SEATBELT: Seatbelt is a Factory setting now', () => {
    expect(() => agentUserFromEnv({ FACTORY_AGENT_USER: 'factory', FACTORY_AGENT_SEATBELT: 'off' }, context)).toThrow(/Settings › Environment › Sandbox/);
  });

  it('takes its own home, profile, extra folders and PATH, without duplicates', () => {
    const config = agentUserFromEnv(
      {
        FACTORY_AGENT_USER: 'factory',
        FACTORY_AGENT_HOME: '/Users/agents/factory/',
        FACTORY_AGENT_PROFILE: '/var/factory/custom.sb',
        FACTORY_AGENT_WRITABLE: '/Volumes/dot/state/:/Volumes/dot/Project/factory/sandboxes',
        FACTORY_AGENT_PATH: '/opt/agent/bin',
      },
      context,
    );
    expect(config).toMatchObject({
      home: '/Users/agents/factory',
      profilePath: '/var/factory/custom.sb',
      writableRoots: ['/Volumes/dot/Project/factory/sandboxes', '/Volumes/dot/state'],
      toolPath: ['/opt/agent/bin', '/Users/agents/factory/fvm/default/bin', '/Users/agents/factory/.pub-cache/bin', '/Users/agents/factory/.cargo/bin', '/Users/agents/factory/go/bin', '/Users/agents/factory/.npm-global/bin'],
    });
  });

  it.each([
    [{ FACTORY_AGENT_USER: 'yura' }, context, /separate standard user/],
    [{ FACTORY_AGENT_USER: 'root' }, context, /separate standard user/],
    [{ FACTORY_AGENT_USER: 'fac tory' }, context, /valid account name/],
    [{ FACTORY_AGENT_USER: 'factory;id' }, context, /valid account name/],
    [{ FACTORY_AGENT_USER: 'factory' }, { ...context, sandboxRoot: '' }, /folder to work in/],
    [{ FACTORY_AGENT_USER: 'factory', FACTORY_AGENT_HOME: 'relative' }, context, /absolute/],
    [{ FACTORY_AGENT_USER: 'factory', FACTORY_AGENT_WRITABLE: '/ok:../up' }, context, /absolute/],
    [{ FACTORY_AGENT_USER: 'factory', FACTORY_AGENT_TOOLCHAIN_ENV: 'PATH' }, context, /cannot be passed/],
    [{ FACTORY_AGENT_USER: 'factory', FACTORY_AGENT_TOOLCHAIN_ENV: 'A;B' }, context, /cannot be passed/],
    [{ FACTORY_AGENT_USER: 'factory', FACTORY_AGENT_READABLE: 'rel' }, context, /absolute/],
  ])('refuses a configuration that would only look protected: %j', (env, ctx, message) => {
    expect(() => agentUserFromEnv(env, ctx)).toThrow(message);
  });
});

describe('agentToolchain', () => {
  it('takes only the variables the server has', () => {
    expect(agentToolchain({ ANDROID_HOME: '/sdk' })).toEqual({
      env: { ANDROID_HOME: '/sdk' },
      path: ['/sdk/platform-tools', '/sdk/cmdline-tools/latest/bin', '/sdk/emulator'],
      roots: ['/sdk'],
    });
    expect(agentToolchain({})).toEqual({ env: {}, path: [], roots: [] });
  });

  it('follows FACTORY_AGENT_TOOLCHAIN_ENV: its own names, none, and no PATH for names it does not know', () => {
    const env = { ANDROID_HOME: '/sdk', FVM_CACHE_PATH: '/fvm', GRADLE_OPTS: '-Xmx2g' };
    expect(agentToolchain({ ...env, FACTORY_AGENT_TOOLCHAIN_ENV: 'FVM_CACHE_PATH, GRADLE_OPTS' })).toEqual({
      env: { FVM_CACHE_PATH: '/fvm', GRADLE_OPTS: '-Xmx2g' },
      path: [],
      roots: ['/fvm'],
    });
    expect(agentToolchain({ ...env, FACTORY_AGENT_TOOLCHAIN_ENV: 'none' })).toEqual({ env: {}, path: [], roots: [] });
  });

  it('puts one SDK on the PATH once when both Android variables name it', () => {
    expect(agentToolchain({ ANDROID_HOME: '/sdk', ANDROID_SDK_ROOT: '/sdk' }).path).toEqual(['/sdk/platform-tools', '/sdk/cmdline-tools/latest/bin', '/sdk/emulator']);
  });
});

describe('isAccountName', () => {
  it.each(['factory', '_agent', 'agent-1', 'a'.repeat(32)])('accepts %s', name => expect(isAccountName(name)).toBe(true));
  it.each(['', 'Factory', '1agent', 'a b', 'a/b', 'a'.repeat(33), 'a\nb'])('refuses %j', name => expect(isAccountName(name)).toBe(false));
});

describe('parsePathList', () => {
  it('normalizes, drops empties and trailing slashes', () => {
    expect(parsePathList(' /a//b/ : :/c/./d ', 'X')).toEqual(['/a/b', '/c/d']);
    expect(parsePathList(undefined, 'X')).toEqual([]);
    expect(parsePathList('/', 'X')).toEqual(['/']);
  });
});
