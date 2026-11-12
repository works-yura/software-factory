import { mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { HarnessExecutableUnavailableError } from '@factory/harness/executable';
import { createFactoryStorageForTests } from '@factory/testing';

import {
  captureCodexSignIn,
  CODEX_SIGN_IN_TIMEOUT_MS,
  CodexSignInError,
  createCodexSignInService,
  runCodexSignInCommand,
} from './sign-in.ts';
import type { CodexSignInRunner } from './sign-in.ts';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const AUTH = { chatgpt_plan_type: 'plus', chatgpt_account_id: 'ws-1', chatgpt_user_id: 'user-1' };
const authJson = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: {
    id_token: jwt({ email: 'alice@example.com', 'https://api.openai.com/auth': AUTH }),
    access_token: jwt({ exp: 2_000_000_000, 'https://api.openai.com/auth': AUTH }),
    refresh_token: 'refresh-1',
    account_id: 'ws-1',
  },
});

interface Call {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** The throwaway home as the CLI found it. */
  homeMode: number;
  config: string;
}

/** A fake `codex login` that files `auth.json` in its CODEX_HOME once the person "signed in" in the browser. */
function fakeCli(outcome: { code?: number; auth?: string | null } = {}) {
  const calls: Call[] = [];
  const run: CodexSignInRunner = async (command, args, options) => {
    const home = options.env.CODEX_HOME!;
    calls.push({
      command,
      args,
      env: options.env,
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      homeMode: (await stat(home)).mode & 0o777,
      config: await readFile(join(home, 'config.toml'), 'utf8'),
    });
    const code = outcome.code ?? 0;
    const auth = outcome.auth === undefined ? authJson : outcome.auth;
    if (code === 0 && auth !== null) await writeFile(join(home, 'auth.json'), auth, { mode: 0o600 });
    return { code, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('sign-in limits', () => {
  it('gives a person five minutes to finish signing in', () => {
    expect(CODEX_SIGN_IN_TIMEOUT_MS).toBe(300_000);
  });
});

describe('captureCodexSignIn', () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'codex-sign-in-test-'));
  });

  it('runs `codex login` in a throwaway 0700 home kept as a file, and captures the pair and who signed in', async () => {
    const cli = fakeCli();
    const controller = new AbortController();
    const oauth = await captureCodexSignIn({
      run: cli.run,
      tempRoot,
      env: { PATH: '/bin', HOME: '/home/me', OPENAI_API_KEY: 'server-key', CODEX_HOME: '/home/me/.codex' },
      signal: controller.signal,
      timeoutMs: 1234,
    });
    expect(oauth).toMatchObject({
      refreshToken: 'refresh-1',
      email: 'alice@example.com',
      workspaceId: 'ws-1',
      subscriptionType: 'plus',
      accountUuid: 'user-1:ws-1',
      expiresAt: 2_000_000_000_000,
    });
    const [call] = cli.calls;
    expect(call).toMatchObject({ command: 'codex', args: ['login', '-c', 'cli_auth_credentials_store="file"'], timeoutMs: 1234 });
    expect(call!.signal).toBe(controller.signal);
    // Never the person's own home or keyring, nothing of the server's keys.
    expect(call!.env.CODEX_HOME!.startsWith(await realpath(tempRoot))).toBe(true);
    expect(call!.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(call!.env.PATH).toBe('/bin');
    expect(call!.homeMode).toBe(0o700);
    expect(call!.config).toBe('cli_auth_credentials_store = "file"\n');
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('uses the given command and the default timeout', async () => {
    const cli = fakeCli();
    await captureCodexSignIn({ run: cli.run, command: '/opt/codex', tempRoot, env: {} });
    expect(cli.calls[0]).toMatchObject({ command: '/opt/codex', timeoutMs: CODEX_SIGN_IN_TIMEOUT_MS });
  });

  it("runs the resolver's path, and says the CLI is not installed as an error the person may read", async () => {
    const cli = fakeCli();
    await captureCodexSignIn({ run: cli.run, command: { command: () => '/opt/homebrew/bin/codex', spawnFailed: () => {} }, tempRoot, env: {} });
    expect(cli.calls[0]).toMatchObject({ command: '/opt/homebrew/bin/codex' });

    const missing = {
      command: () => {
        throw new HarnessExecutableUnavailableError({ harness: 'Codex', executable: 'codex', message: 'Codex is not installed on this server.' });
      },
      spawnFailed: () => {},
    };
    await expect(captureCodexSignIn({ run: cli.run, command: missing, tempRoot, env: {} })).rejects.toThrow(
      new CodexSignInError('Codex is not installed on this server.'),
    );
    expect(cli.calls).toHaveLength(1);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('fails when the CLI did not finish, stored no login, or runs out of time, and removes the home each time', async () => {
    await expect(captureCodexSignIn({ run: fakeCli({ code: 1 }).run, tempRoot, env: {} })).rejects.toThrow(
      new CodexSignInError('ChatGPT sign-in did not finish (codex exited with 1).'),
    );
    await expect(captureCodexSignIn({ run: fakeCli({ auth: null }).run, tempRoot, env: {} })).rejects.toThrow(
      'ChatGPT sign-in finished without a stored ChatGPT login.',
    );
    await expect(captureCodexSignIn({ run: fakeCli({ auth: '{"OPENAI_API_KEY":"sk-x"}' }).run, tempRoot, env: {} })).rejects.toBeInstanceOf(
      CodexSignInError,
    );
    const slow: CodexSignInRunner = async () => {
      throw new CodexSignInError('codex login timed out.');
    };
    await expect(captureCodexSignIn({ run: slow, tempRoot, env: {}, timeoutMs: 1 })).rejects.toThrow('timed out');
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('does not start the CLI for a sign-in already cancelled', async () => {
    const cli = fakeCli();
    const controller = new AbortController();
    controller.abort();
    await expect(captureCodexSignIn({ run: cli.run, tempRoot, env: {}, signal: controller.signal })).rejects.toThrow(
      'ChatGPT sign-in was cancelled.',
    );
    expect(cli.calls).toEqual([]);
    expect(await readdir(tempRoot)).toEqual([]);
  });
});

describe('runCodexSignInCommand', () => {
  const node = process.execPath;
  const env = { PATH: process.env.PATH ?? '' };

  it('stops a command when the sign-in is cancelled, with a ChatGPT error the person may read', async () => {
    const controller = new AbortController();
    const running = runCodexSignInCommand(node, ['-e', 'setTimeout(()=>{},30000)'], { env, timeoutMs: 30_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toBeInstanceOf(CodexSignInError);
    await expect(running).rejects.toThrow('ChatGPT sign-in was cancelled.');
    await expect(runCodexSignInCommand(node, ['-e', 'setTimeout(()=>{},30000)'], { env, timeoutMs: 100 })).rejects.toThrow(
      new CodexSignInError(`${node} -e timed out.`),
    );
  });
});

describe('createCodexSignInService', () => {
  const settle = async (service: ReturnType<typeof createCodexSignInService>, id: string) => {
    for (let i = 0; i < 200 && service.get(id)?.status === 'pending'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    return service.get(id)!;
  };

  it("files the sign-in as the person's codex_login account, and a second sign-in to it replaces its pair", async () => {
    const storage = await createFactoryStorageForTests();
    const service = createCodexSignInService({ credentials: storage.credentials, run: fakeCli().run, env: {} });
    const flow = service.start({ orgId: 'org-1', userId: 'alice' });
    expect(flow).toEqual({ id: flow.id, orgId: 'org-1', userId: 'alice', status: 'pending' });
    const done = await settle(service, flow.id);
    expect(done).toMatchObject({ status: 'done' });
    const [account] = await storage.credentials.listAccounts('org-1', 'openai-codex');
    expect(account).toMatchObject({ id: done.accountId, kind: 'codex_login', label: 'alice@example.com', ownerUserId: 'alice', hint: '' });

    const again = createCodexSignInService({ credentials: storage.credentials, run: fakeCli().run, env: {} });
    const second = again.start({ orgId: 'org-1', userId: 'alice' });
    expect(await settle(again, second.id)).toMatchObject({ status: 'done', accountId: account!.id });
    expect(await storage.credentials.listAccounts('org-1', 'openai-codex')).toHaveLength(1);
  });

  it('says why a sign-in failed, and cancels one still running', async () => {
    const storage = await createFactoryStorageForTests();
    const failing = createCodexSignInService({ credentials: storage.credentials, run: fakeCli({ code: 1 }).run, env: {} });
    const failed = failing.start({ orgId: 'org-1', userId: 'alice' });
    expect(await settle(failing, failed.id)).toMatchObject({ status: 'error', error: 'ChatGPT sign-in did not finish (codex exited with 1).' });

    let seen: AbortSignal | undefined;
    const waiting = createCodexSignInService({
      credentials: storage.credentials,
      capture: ({ signal }) => {
        seen = signal;
        return new Promise(() => {});
      },
    });
    const pending = waiting.start({ orgId: 'org-1', userId: 'bob' });
    expect(waiting.cancel(pending.id)).toBe(true);
    expect(seen?.aborted).toBe(true);
    expect(waiting.get(pending.id)).toMatchObject({ status: 'error', error: 'ChatGPT sign-in was cancelled.' });
    expect(await storage.credentials.listAccounts('org-1', 'openai-codex')).toEqual([]);
  });
});
