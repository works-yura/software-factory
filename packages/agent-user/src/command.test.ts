import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { agentEnv, agentLaunch, ENV, encodeAgentEnv, SANDBOX_EXEC, SUDO } from './command.ts';
import type { AgentUserConfig } from './config.ts';

const config: AgentUserConfig = {
  user: 'factory',
  home: '/Users/factory',
  profilePath: '/var/factory/agent-factory.sb',
  writableRoots: ['/Volumes/dot/Project/factory/sandboxes'],
  toolPath: ['/Users/factory/.local/bin'],
};

const secret = `sk-'quoted' "double" $HOME \`tick\` \\ new\nline`;

describe('agentLaunch', () => {
  const launch = agentLaunch(config, {
    command: '/Users/factory/.local/bin/claude',
    args: ['-p', '--output-format', 'stream-json'],
    env: { HOME: '/Users/yura', PATH: '/Users/yura/.nvm/bin', CLAUDE_CODE_OAUTH_TOKEN: secret, LANG: 'en_US.UTF-8', UNSET: undefined },
  });

  it('runs sudo without a password, as the agent user, with a cleared environment, under the profile', () => {
    expect(launch.command).toBe(SUDO);
    expect(launch.args.slice(0, 8)).toEqual(['-n', '-C', '4', '-u', 'factory', '--', ENV, '-i']);
    const profileAt = launch.args.indexOf(SANDBOX_EXEC);
    expect(launch.args.slice(profileAt, profileAt + 3)).toEqual([SANDBOX_EXEC, '-f', '/var/factory/agent-factory.sb']);
    expect(launch.args.slice(-4)).toEqual(['/Users/factory/.local/bin/claude', '-p', '--output-format', 'stream-json']);
    expect(launch.env).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  });

  it('never puts the environment on the command line, which every local user can read', () => {
    expect(launch.args.join(' ')).not.toContain('sk-');
    expect(launch.args.join(' ')).not.toContain('/Users/yura');
    expect(launch.envPayload).toContain('CLAUDE_CODE_OAUTH_TOKEN=');
  });

  it("gives the agent its own identity and PATH, never the server's", () => {
    expect(agentEnv(config, { HOME: '/Users/yura', USER: 'yura', TMPDIR: '/var/folders/yura/' })).toEqual({
      HOME: '/Users/factory',
      USER: 'factory',
      LOGNAME: 'factory',
      SHELL: '/bin/zsh',
      PATH: '/Users/factory/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: '/Users/factory/.tmp/',
    });
  });

  it('refuses names the loader could misread', () => {
    expect(() => agentEnv(config, { 'A;rm -rf /': 'x' })).toThrow(/not allowed/);
    expect(() => agentEnv(config, { A: 'x\0y' })).toThrow(/NUL/);
  });

  it('leaves the profile out for tools that sandbox themselves', () => {
    const xcode = agentLaunch(config, { command: '/usr/bin/xcodebuild', args: [], env: {}, seatbelt: false });
    expect(xcode.args).not.toContain(SANDBOX_EXEC);
  });

  it('the loader exports exactly what it was given, quotes and newlines included', async () => {
    // The real chain without sudo: env -i … sh -c <loader> … <command>, fed on fd 3 as spawnAsAgent does.
    const fromEnv = launch.args.indexOf(ENV);
    const shAt = launch.args.indexOf('/bin/sh');
    const chain = [...launch.args.slice(fromEnv + 1, shAt + 4), '/usr/bin/env'];
    const child = spawn(ENV, chain, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    (child.stdio[3] as Writable).end(launch.envPayload);
    let out = '';
    let err = '';
    child.stdout?.on('data', chunk => (out += chunk));
    child.stderr?.on('data', chunk => (err += chunk));
    const code = await new Promise(resolve => child.on('close', resolve));
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${secret}`);
    expect(out).toContain('HOME=/Users/factory');
    expect(out).toContain('LANG=en_US.UTF-8');
    expect(out).not.toContain('/Users/yura');
  });
});
