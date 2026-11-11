import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalSandbox } from '@mastra/core/workspace';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { createFactorySecretEncryption, SandboxEnvsStorage } from '@factory/store';
import type { ExecutableSandbox } from './materialization.ts';
import { attachSandboxEnvRefresh, resolveSandboxEnv } from './sandbox-env.ts';
import {
  ENV_FILES_EXCLUDE_BEGIN,
  ENV_FILES_EXCLUDE_END,
  envFilesCommand,
  writeEnvFiles,
  writeEnvFilesToCheckouts,
} from './sandbox-env-files.ts';

const ORG = 'org-1';
const PROJECT = 'proj-1';
const SCOPE = { orgId: ORG, projectId: PROJECT };
const LINK = 'link-1';

async function makeStore() {
  const backend = new LibSQLFactoryStorage({ id: 'sandbox-env-files-test', url: ':memory:' });
  const store = backend.registerDomain(
    new SandboxEnvsStorage(createFactorySecretEncryption({ primary: { id: 'v1', key: new Uint8Array(32).fill(5) } })),
  );
  await backend.init();
  onTestFinished(() => backend.close());
  return store;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

describe('env files in a real checkout', () => {
  let dir: string;
  let repo: string;
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-env-files-'));
    repo = path.join(dir, 'repo');
    await fs.mkdir(path.join(repo, 'ios'), { recursive: true });
    git(repo, 'init', '-q');
    await fs.writeFile(path.join(repo, 'ios', 'Config.xcconfig'), 'API_URL = placeholder\n');
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    sandbox = new LocalSandbox({ workingDirectory: dir, isolation: 'none' });
    await sandbox._start();
  });

  afterEach(async () => {
    await sandbox._destroy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const exec = () => sandbox as unknown as ExecutableSandbox;
  const read = (relative: string) => fs.readFile(path.join(repo, relative), 'utf8');
  const exists = (relative: string) =>
    fs.stat(path.join(repo, relative)).then(
      () => true,
      () => false,
    );
  const mode = async (relative: string) => (await fs.stat(path.join(repo, relative))).mode & 0o777;
  const exclude = () => fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  const status = () => git(repo, 'status', '--porcelain', '--untracked-files=all');

  it('writes each file with mode 0600, exactly as stored, and excludes it from git', async () => {
    await writeEnvFiles(exec(), repo, [
      { path: '.env.staging', content: 'A=1\nQUOTE="it\'s $HOME"\n\n' },
      { path: 'apps/mobile/.env', content: 'B=2' },
    ]);

    expect(await read('.env.staging')).toBe('A=1\nQUOTE="it\'s $HOME"\n\n');
    expect(await read('apps/mobile/.env')).toBe('B=2');
    expect(await mode('.env.staging')).toBe(0o600);
    expect(await mode('apps/mobile/.env')).toBe(0o600);
    expect(await exclude()).toContain(`${ENV_FILES_EXCLUDE_BEGIN}\n/.env.staging\n/apps/mobile/.env\n${ENV_FILES_EXCLUDE_END}\n`);
    // Neither shows up as a change nor gets staged by `git add -A`.
    expect(status()).toBe('');
    git(repo, 'add', '-A');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'ls-files', '--others', '--exclude-standard')).toBe('');
  });

  it('hides the real values of a tracked file from diffs and commits, and restores it on removal', async () => {
    await writeEnvFiles(exec(), repo, [{ path: 'ios/Config.xcconfig', content: 'API_URL = https://staging\n' }]);
    expect(await read('ios/Config.xcconfig')).toBe('API_URL = https://staging\n');
    expect(status()).toBe('');
    expect(git(repo, 'diff', 'HEAD', '--name-only')).toBe('');

    await writeEnvFiles(exec(), repo, []);
    expect(await read('ios/Config.xcconfig')).toBe('API_URL = placeholder\n');
    expect(git(repo, 'ls-files', '-v', 'ios/Config.xcconfig')).toMatch(/^H /);
  });

  it('rewrites changed files and removes the ones no longer wanted, keeping the rest of the exclude file', async () => {
    await fs.mkdir(path.join(repo, '.git', 'info'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git', 'info', 'exclude'), '# mine\n*.log\n');
    await writeEnvFiles(exec(), repo, [
      { path: '.env', content: 'A=1' },
      { path: '.env.staging', content: 'S=1' },
    ]);
    await writeEnvFiles(exec(), repo, [{ path: '.env', content: 'A=2' }]);

    expect(await read('.env')).toBe('A=2');
    expect(await exists('.env.staging')).toBe(false);
    expect(await exclude()).toBe(`# mine\n*.log\n${ENV_FILES_EXCLUDE_BEGIN}\n/.env\n${ENV_FILES_EXCLUDE_END}\n`);

    await writeEnvFiles(exec(), repo, []);
    expect(await exists('.env')).toBe(false);
    expect(await exclude()).toBe('# mine\n*.log\n');
  });

  it('never writes through a folder that leads outside the checkout', async () => {
    const outside = path.join(dir, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(repo, 'linked'));
    await writeEnvFiles(exec(), repo, [
      { path: 'linked/.env', content: 'LEAK=1' },
      { path: '.env', content: 'OK=1' },
    ]);
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await read('.env')).toBe('OK=1');
  });

  it('refuses unsafe paths before anything runs', () => {
    expect(() => envFilesCommand(repo, [{ path: '../escape', content: '' }])).toThrow(/leave/);
    expect(() => envFilesCommand(repo, [{ path: '.git/hooks/pre-commit', content: '' }])).toThrow(/\.git/);
    expect(() => envFilesCommand(repo, [{ path: '/etc/passwd', content: '' }])).toThrow(/relative/);
    // Paths and contents travel as arguments, never inside the script.
    const { args } = envFilesCommand(repo, [{ path: '.env', content: '$(touch pwned)' }]);
    expect(args[1]).not.toContain('pwned');
    expect(args.slice(-2)).toEqual(['.env', '$(touch pwned)']);
  });

  it('writes only enabled stages, never production, and follows edits on the next command', async () => {
    const store = await makeStore();
    const add = (relative: string, stage: 'development' | 'staging' | 'production', content: string) =>
      store.createFile(ORG, PROJECT, { projectRepositoryId: LINK, path: relative, stage, content }, 'admin');
    const dev = await add('.env.development', 'development', 'D=1');
    await add('.env.staging', 'staging', 'S=1');
    await add('.env.production', 'production', 'P=1');
    await store.createFile(
      ORG,
      PROJECT,
      { projectRepositoryId: 'other-link', path: '.env.other', stage: 'development', content: 'O=1' },
      'admin',
    );

    const targets = [{ projectRepositoryId: LINK, dir: repo }];
    // The boot writes what it resolved; the refresh rewrites after an edit.
    const initial = await resolveSandboxEnv(store, SCOPE);
    await writeEnvFilesToCheckouts(exec(), targets, initial.files);
    attachSandboxEnvRefresh(sandbox, {
      initial,
      revision: async () => (await store.revisions(ORG, PROJECT))?.revision ?? '',
      load: () => resolveSandboxEnv(store, SCOPE),
      applyFiles: files => writeEnvFilesToCheckouts(exec(), targets, files),
    });
    expect(await exists('.env.development')).toBe(true);
    expect(await exists('.env.staging')).toBe(false);
    expect(await exists('.env.production')).toBe(false);
    expect(await exists('.env.other')).toBe(false);

    await store.setStages(ORG, PROJECT, ['development', 'staging'], 'admin');
    await sandbox.executeCommand!('true');
    expect(await read('.env.staging')).toBe('S=1');
    expect(await exists('.env.production')).toBe(false);

    await store.updateFile(ORG, PROJECT, dev.id, { content: 'D=2' }, 'admin');
    await sandbox.executeCommand!('true');
    expect(await read('.env.development')).toBe('D=2');

    await store.deleteFile(ORG, PROJECT, dev.id);
    await store.setStages(ORG, PROJECT, ['development'], 'admin');
    await sandbox.executeCommand!('true');
    expect(await exists('.env.development')).toBe(false);
    expect(await exists('.env.staging')).toBe(false);
    expect(await exists('.env.production')).toBe(false);
    expect(status()).toBe('');
  });

  it('logs a checkout that cannot take its files and still writes the others', async () => {
    const errors: string[] = [];
    await writeEnvFilesToCheckouts(
      exec(),
      [
        { projectRepositoryId: 'missing', dir: path.join(dir, 'missing') },
        { projectRepositoryId: LINK, dir: repo },
      ],
      [
        { id: '1', projectRepositoryId: 'missing', path: '.env', stage: 'development', content: 'X=1' },
        { id: '2', projectRepositoryId: LINK, path: '.env', stage: 'development', content: 'Y=1' },
        { id: '3', projectRepositoryId: LINK, path: '.env.production', stage: 'production', content: 'P=1' },
      ],
      (_error, target) => errors.push(target.projectRepositoryId),
    );
    expect(errors).toEqual(['missing']);
    expect(await read('.env')).toBe('Y=1');
    expect(await exists('.env.production')).toBe(false);
  });
});
