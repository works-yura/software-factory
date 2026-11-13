import { describe, expect, it } from 'vitest';

import { agentUserFromEnv } from './config.ts';

const base = { serverUser: 'yura', sandboxRoot: '/Volumes/dot/Project/factory/sandboxes' };

describe('agentUserFromEnv', () => {
  it('is off when FACTORY_AGENT_USER is not set', () => {
    expect(agentUserFromEnv({}, base)).toBeUndefined();
    expect(agentUserFromEnv({ FACTORY_AGENT_USER: '  ' }, base)).toBeUndefined();
  });

  it('defaults the home, profile, tools and work folder from the user', () => {
    expect(agentUserFromEnv({ FACTORY_AGENT_USER: 'factory' }, base)).toEqual({
      user: 'factory',
      home: '/Users/factory',
      profilePath: '/var/factory/agent-factory.sb',
      writableRoots: ['/Volumes/dot/Project/factory/sandboxes'],
      toolPath: ['/Users/factory/.local/bin', '/Users/factory/.local/node/bin'],
    });
  });

  it('takes extra writable folders and its own PATH', () => {
    const config = agentUserFromEnv(
      { FACTORY_AGENT_USER: 'factory', FACTORY_AGENT_WRITABLE: '/Volumes/dot/agent-state/:/Volumes/dot/Project/factory/sandboxes', FACTORY_AGENT_PATH: '/opt/agent/bin' },
      base,
    );
    expect(config?.writableRoots).toEqual(['/Volumes/dot/Project/factory/sandboxes', '/Volumes/dot/agent-state']);
    expect(config?.toolPath).toEqual(['/opt/agent/bin']);
  });

  it('refuses a configuration that would look protected and is not', () => {
    expect(() => agentUserFromEnv({ FACTORY_AGENT_USER: 'yura' }, base)).toThrow(/separate standard user/);
    expect(() => agentUserFromEnv({ FACTORY_AGENT_USER: 'root' }, base)).toThrow(/separate standard user/);
    expect(() => agentUserFromEnv({ FACTORY_AGENT_USER: 'fac tory' }, base)).toThrow(/valid account name/);
    expect(() => agentUserFromEnv({ FACTORY_AGENT_USER: 'factory' }, { ...base, sandboxRoot: '' })).toThrow(/folder to work in/);
    expect(() => agentUserFromEnv({ FACTORY_AGENT_USER: 'factory', FACTORY_AGENT_HOME: 'relative' }, base)).toThrow(/absolute/);
  });
});
