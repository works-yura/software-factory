import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsControl = vi.hoisted(() => ({ writeError: undefined as NodeJS.ErrnoException | undefined }));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsControl.writeError) throw fsControl.writeError;
      return actual.writeFileSync(...args);
    },
  };
});

import { CLAUDE_SESSION_CONFIG_SEED, claudeSessionConfigName, createClaudeSessionConfigDirs } from './config-dir.ts';

describe('claudeSessionConfigName', () => {
  it('keeps the readable part of a session id, made filesystem-safe, and adds 8 hex of its hash', () => {
    expect(claudeSessionConfigName('factory-supervisor:p-1')).toMatch(/^factory-supervisor_p-1-[0-9a-f]{8}$/);
    // Ids that read the same once made safe still get different dirs.
    expect(claudeSessionConfigName('a:b')).not.toBe(claudeSessionConfigName('a/b'));
  });

  it('cuts a long id to 80 characters before the hash', () => {
    const name = claudeSessionConfigName('x'.repeat(200));
    expect(name).toMatch(/^x{80}-[0-9a-f]{8}$/);
  });
});

describe('createClaudeSessionConfigDirs', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-config-dirs-'));
  });
  afterEach(async () => {
    fsControl.writeError = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('makes a new session’s dir, owner-only, seeded so the CLI skips onboarding', () => {
    const dirs = createClaudeSessionConfigDirs(root);
    const dir = dirs.dirFor({ id: 'session-1', cwd: undefined });

    expect(dir).toBe(join(root, claudeSessionConfigName('session-1')));
    expect(statSync(dir!).mode & 0o777).toBe(0o700);
    const seed = join(dir!, '.claude.json');
    expect(JSON.parse(readFileSync(seed, 'utf8'))).toEqual(CLAUDE_SESSION_CONFIG_SEED);
    expect(CLAUDE_SESSION_CONFIG_SEED).toEqual({ hasCompletedOnboarding: true });
    expect(statSync(seed).mode & 0o777).toBe(0o600);
    // The same dir on every later turn.
    expect(dirs.dirFor({ id: 'session-1', cwd: '/work' })).toBe(dir);
  });

  it('leaves a session that already ran on the default dir there', () => {
    const dirs = createClaudeSessionConfigDirs(root);
    expect(dirs.dirFor({ id: 'session-old', cwd: '/work' })).toBeUndefined();
    expect(existsSync(join(root, claudeSessionConfigName('session-old')))).toBe(false);
  });

  it('accepts a seed another turn wrote first, and fails on any other write error', () => {
    const dirs = createClaudeSessionConfigDirs(root);
    fsControl.writeError = Object.assign(new Error('exists'), { code: 'EEXIST' });
    expect(dirs.dirFor({ id: 'session-race', cwd: undefined })).toBe(join(root, claudeSessionConfigName('session-race')));

    fsControl.writeError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    expect(() => dirs.dirFor({ id: 'session-full', cwd: undefined })).toThrow('disk full');
  });

  it('removes a deleted session’s dir, and a missing one is fine', async () => {
    const dirs = createClaudeSessionConfigDirs(root);
    const dir = dirs.dirFor({ id: 'session-1', cwd: undefined })!;
    mkdirSync(join(dir, 'projects'), { recursive: true });

    await dirs.remove('session-1');
    expect(existsSync(dir)).toBe(false);
    await expect(dirs.remove('never-made')).resolves.toBeUndefined();
  });
});
