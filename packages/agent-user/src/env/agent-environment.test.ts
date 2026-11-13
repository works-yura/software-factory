import { describe, expect, it } from 'vitest';

import { agentConfig } from '../testing/fixtures.ts';

import { agentEnvironment, agentIdentity, IDENTITY_KEYS } from './agent-environment.ts';

describe('agentEnvironment', () => {
  it("replaces every identity variable with the agent user's", () => {
    const env = agentEnvironment(agentConfig, { HOME: '/Users/yura', USER: 'yura', LOGNAME: 'yura', SHELL: '/bin/bash', PATH: '/Users/yura/.nvm/bin', TMPDIR: '/var/folders/x/' });
    expect(env).toEqual(agentIdentity(agentConfig));
    expect(Object.keys(env).sort()).toEqual([...IDENTITY_KEYS].sort());
  });

  it("puts the agent's tools before the system PATH", () => {
    expect(agentIdentity(agentConfig).PATH).toBe('/Users/factory/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('keeps the rest, drops unset values', () => {
    expect(agentEnvironment(agentConfig, { TOKEN: 'x', GONE: undefined, LANG: 'uk_UA.UTF-8' })).toMatchObject({ TOKEN: 'x', LANG: 'uk_UA.UTF-8' });
    expect(agentEnvironment(agentConfig, { GONE: undefined })).not.toHaveProperty('GONE');
  });

  it.each(['A;B', 'A B', '1A', 'A-B', '', 'A=B'])('refuses the name %j', name => {
    expect(() => agentEnvironment(agentConfig, { [name]: 'x' })).toThrow(/not allowed/);
  });

  it('refuses a NUL byte in a value', () => {
    expect(() => agentEnvironment(agentConfig, { A: 'x\0y' })).toThrow(/NUL/);
  });
});
