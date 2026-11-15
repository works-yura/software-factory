/**
 * Real-git fixtures for the template tests: an isolated git environment (no
 * user or system config), a bare "remote" with commits, and helpers.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { hostExecutor } from './host-exec.ts';
import { LocalMirrorRepositoryCache } from './local-mirror-cache.ts';
import type { RepositoryCache } from './repository-cache.ts';

export function isolatedGitEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

export interface GitFixture {
  root: string;
  env: Record<string, string>;
  /** The bare "remote". */
  origin: string;
  /** A working clone that pushes to it. */
  seed: string;
  git(dir: string, ...args: string[]): string;
  /** Like `git` but returns the exit status instead of throwing. */
  tryGit(dir: string, ...args: string[]): { status: number; stdout: string; stderr: string };
  commit(dir: string, file: string, content: string, message?: string): Promise<string>;
  host: ReturnType<typeof hostExecutor>;
}

export async function gitFixture(prefix = 'factory-template-'): Promise<GitFixture> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const env = isolatedGitEnv(root);
  const run = (dir: string, args: string[]) =>
    spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const git = (dir: string, ...args: string[]) => {
    const result = run(dir, args);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const tryGit = (dir: string, ...args: string[]) => {
    const result = run(dir, args);
    return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  git(root, 'init', '--bare', '--quiet', '--initial-branch=main', origin);
  git(root, 'clone', '--quiet', origin, seed);
  const commit = async (dir: string, file: string, content: string, message = `change ${file}`) => {
    await writeFile(path.join(dir, file), content);
    git(dir, 'add', '--all');
    git(dir, 'commit', '--quiet', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  await commit(seed, 'README.md', 'one\n', 'first');
  await commit(seed, 'src.txt', 'a\nb\nc\n', 'second');
  git(seed, 'push', '--quiet', 'origin', 'main');
  return { root, env, origin, seed, git, tryGit, commit, host: hostExecutor({ env }) };
}

/** The template's default cache, the local mirrors; tests that look inside a mirror reach it through this. */
export function mirrorsOf(template: { repositoryCache: RepositoryCache }): LocalMirrorRepositoryCache {
  const cache = template.repositoryCache;
  if (!(cache instanceof LocalMirrorRepositoryCache)) throw new Error(`expected the local mirror cache, got '${cache.kind}'`);
  return cache;
}
