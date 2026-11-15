import { describe, expect, it } from 'vitest';

import { isAccountName } from './account-name.ts';
import { agentUserFromEnv } from './from-env.ts';
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
        '/Users/factory/.pub-cache/bin',
        '/Users/factory/.cargo/bin',
        '/Users/factory/go/bin',
        '/Users/factory/.npm-global/bin',
      ],
      seatbelt: true,
      xcodeConfigPath: '/var/factory/agent-factory.xcconfig',
    });
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
      toolPath: ['/opt/agent/bin', '/Users/agents/factory/.pub-cache/bin', '/Users/agents/factory/.cargo/bin', '/Users/agents/factory/go/bin', '/Users/agents/factory/.npm-global/bin'],
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
  ])('refuses a configuration that would only look protected: %j', (env, ctx, message) => {
    expect(() => agentUserFromEnv(env, ctx)).toThrow(message);
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
