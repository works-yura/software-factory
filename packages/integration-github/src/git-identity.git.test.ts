import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutableSandbox, GitIdentity } from '@factory/sandbox';
import { checkoutSessionBranch, runSetupCommand, syncEnvironmentRepository } from '@factory/sandbox';

import { GithubIntegration } from './integration.ts';
import { PlatformGithubIntegration } from './platform/integration.ts';

// Provider authorship block of sandbox.git.test.ts from upstream ca08ed414a (#28292). It lives here because
// @factory/sandbox cannot import the GitHub integrations; the setup is a copy of that file's.

describe('environment branch selection with real Git', () => {
  let root: string;
  let origin: string;
  let seed: string;
  let checkout: string;
  let sandbox: ExecutableSandbox;

  function gitEnvironment() {
    return {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
      EMAIL: undefined,
    };
  }

  function git(dir: string, ...args: string[]) {
    const result = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: gitEnvironment(),
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'factory-branch-review-'));
    origin = path.join(root, 'origin.git');
    seed = path.join(root, 'seed');
    checkout = path.join(root, 'checkout');
    git(root, 'init', '--bare', '--initial-branch=main', origin);
    git(root, 'clone', origin, seed);
    git(seed, 'config', 'user.email', 'test@example.com');
    git(seed, 'config', 'user.name', 'Test');
    await writeFile(path.join(seed, 'tracked.txt'), 'A\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'A');
    git(seed, 'push', 'origin', 'main');
    git(root, 'clone', '--no-local', '--depth=1', origin, checkout);
    git(checkout, 'config', 'user.email', 'test@example.com');
    git(checkout, 'config', 'user.name', 'Test');
    await writeFile(path.join(seed, 'tracked.txt'), 'B\n');
    git(seed, 'commit', '-am', 'B');
    git(seed, 'push', 'origin', 'main');
    sandbox = {
      id: 'real-git',
      async executeCommand(command, args = [], options) {
        const result = spawnSync(command, args, {
          encoding: 'utf8',
          cwd: root,
          env: { ...gitEnvironment(), ...options?.env },
          timeout: 10_000,
        });
        if (result.error) throw result.error;
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const sync = (identity?: GitIdentity) =>
    syncEnvironmentRepository(sandbox, checkout, {
      identity,
      branch: 'session/task',
      defaultBranch: 'main',
      token: 'test-token',
      repoFullName: 'test/repo',
    });

  async function commitAndCheckIdentity({ name, email }: { name: string; email: string }) {
    await runSetupCommand(sandbox, checkout, 'git commit --allow-empty -m "Setup commit"');
    await writeFile(path.join(checkout, 'agent.txt'), 'Agent work\n');
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-m', 'Agent commit');
    expect(git(checkout, 'log', '-2', '--format=%an <%ae>|%cn <%ce>')).toBe(
      Array(2).fill(`${name} <${email}>|${name} <${email}>`).join('\n'),
    );
    expect(git(checkout, 'config', '--local', 'user.name')).toBe(name);
    expect(git(checkout, 'config', '--local', 'user.email')).toBe(email);
  }

  describe.each(['primary', 'secondary'] as const)('%s provider authorship', role => {
    it.each(['self-hosted', 'platform', 'platform with deployment slug', 'platform observed writer'])(
      'uses the actual %s App identity when startup resumes a session (#28233)',
      async provider => {
        vi.stubEnv('MASTRA_INTEGRATIONS_API_URL', 'https://platform.example.com');
        vi.stubEnv('MASTRA_PLATFORM_SECRET_KEY', 'test-platform-key');
        vi.stubEnv('MASTRA_PLATFORM_GITHUB_APP_SLUG', '');
        const integration =
          provider === 'self-hosted'
            ? new GithubIntegration({
                appId: '1',
                privateKey: 'test-key',
                clientId: 'test-client',
                clientSecret: 'test-secret',
                slug: 'deployment-app',
              })
            : new PlatformGithubIntegration(
                provider === 'platform with deployment slug' ? { slug: 'different-deployment-app' } : {},
              );
        if (provider === 'platform observed writer' && integration instanceof PlatformGithubIntegration) {
          integration.identity.observeSelfAuthor('actual-platform[bot]');
        }
        const name =
          provider === 'self-hosted'
            ? 'deployment-app[bot]'
            : provider === 'platform observed writer'
              ? 'actual-platform[bot]'
              : 'mastra-platform[bot]';
        git(checkout, 'checkout', '-b', 'session/task');
        git(checkout, 'config', '--unset-all', 'user.name');
        git(checkout, 'config', '--unset-all', 'user.email');
        if (role === 'primary') {
          await checkoutSessionBranch(sandbox, checkout, {
            identity: integration.gitIdentity,
            branch: 'session/task',
            baseBranch: 'main',
            token: 'test-token',
            repoFullName: 'test/repo',
          });
        } else {
          await sync(integration.gitIdentity);
        }
        await commitAndCheckIdentity({ name, email: `${name}@users.noreply.github.com` });
      },
    );
  });
});
