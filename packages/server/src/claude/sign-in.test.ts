import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFactoryStorageForTests } from '@factory/testing';
import type { ClaudeLoginOAuth } from '@factory/store';

import {
  captureClaudeSignIn,
  CLAUDE_KEYCHAIN_SERVICE,
  CLAUDE_SIGN_IN_TIMEOUT_MS,
  claudeKeychainService,
  ClaudeSignInError,
  createClaudeSignInService,
  parseClaudeStoredCredentials,
  runClaudeSignInCommand,
} from './sign-in.ts';
import type { ClaudeSignInCommandResult, ClaudeSignInRunner } from './sign-in.ts';

const stored = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fake-access',
      refreshToken: 'fake-refresh',
      expiresAt: 1_900_000_000_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'team',
      ...overrides,
    },
  });

const oauthAccount = {
  oauthAccount: { emailAddress: 'alice@example.com', accountUuid: 'acct-1', organizationUuid: 'org-uuid-1' },
};

const ok = (stdout = ''): ClaudeSignInCommandResult => ({ code: 0, stdout, stderr: '' });
const notFound: ClaudeSignInCommandResult = { code: 44, stdout: '', stderr: 'could not be found' };

describe('sign-in limits', () => {
  it('gives a person five minutes to finish signing in', () => {
    expect(CLAUDE_SIGN_IN_TIMEOUT_MS).toBe(300_000);
  });
});

describe('parseClaudeStoredCredentials', () => {
  it('reads the CLI’s stored pair, and nothing from what holds none', () => {
    expect(parseClaudeStoredCredentials(stored())).toEqual({
      accessToken: 'fake-access',
      refreshToken: 'fake-refresh',
      expiresAt: 1_900_000_000_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'team',
    });
    expect(parseClaudeStoredCredentials(stored({ expiresAt: undefined, scopes: 'x' }))).toMatchObject({ expiresAt: 0, scopes: [] });
    expect(parseClaudeStoredCredentials('{"mcpOAuth":{}}')).toBeUndefined();
    expect(parseClaudeStoredCredentials(stored({ refreshToken: '' }))).toBeUndefined();
    expect(parseClaudeStoredCredentials('not json')).toBeUndefined();
  });

  it('drops what is not a usable pair, and keeps only the string scopes and a numeric expiry', () => {
    expect(parseClaudeStoredCredentials('null')).toBeUndefined();
    expect(parseClaudeStoredCredentials('{"claudeAiOauth":"x"}')).toBeUndefined();
    expect(parseClaudeStoredCredentials('{"claudeAiOauth":null}')).toBeUndefined();
    expect(parseClaudeStoredCredentials(stored({ accessToken: '' }))).toBeUndefined();
    expect(parseClaudeStoredCredentials(stored({ accessToken: 7 }))).toBeUndefined();
    expect(parseClaudeStoredCredentials(stored({ refreshToken: 7 }))).toBeUndefined();
    expect(parseClaudeStoredCredentials(stored({ expiresAt: '1900000000000' }))?.expiresAt).toBe(0);
    expect(parseClaudeStoredCredentials(stored({ scopes: ['a', 3, 'b'] }))?.scopes).toEqual(['a', 'b']);
    expect(parseClaudeStoredCredentials(stored({ subscriptionType: '' }))).not.toHaveProperty('subscriptionType');
    expect(parseClaudeStoredCredentials(stored({ subscriptionType: 5 }))).not.toHaveProperty('subscriptionType');
  });

  it('names a config dir’s Keychain item as the CLI does', () => {
    expect(claudeKeychainService('/tmp/x')).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(claudeKeychainService('/tmp/x')).not.toBe(claudeKeychainService('/tmp/y'));
  });
});

describe('captureClaudeSignIn', () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'claude-sign-in-test-'));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  /** A fake `claude` (and `security`): login writes what a real CLI would into the dir it was given. */
  function fakeCli({
    platform,
    keychain = new Map<string, string>(),
    login = async () => ok(),
  }: {
    platform: 'darwin' | 'linux';
    keychain?: Map<string, string>;
    login?: (dir: string) => Promise<ClaudeSignInCommandResult>;
  }) {
    const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const run: ClaudeSignInRunner = async (command, args, { env }) => {
      calls.push({ command, args, env });
      if (command === 'security') {
        const service = args[args.indexOf('-s') + 1]!;
        if (args[0] === 'find-generic-password') return keychain.has(service) ? ok(`${keychain.get(service)}\n`) : notFound;
        if (args[0] === 'delete-generic-password') return keychain.delete(service) ? ok() : notFound;
        if (args[0] === 'add-generic-password') {
          keychain.set(service, args[args.indexOf('-w') + 1]!);
          return ok();
        }
      }
      const dir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR!;
      expect(env.CLAUDE_CONFIG_DIR).toBe(dir);
      const result = await login(dir);
      if (result.code === 0) {
        await writeFile(join(dir, '.claude.json'), JSON.stringify(oauthAccount));
        if (platform === 'darwin') {
          keychain.set(claudeKeychainService(dir), stored());
          // A real login may overwrite the person's own default item too.
          keychain.set(CLAUDE_KEYCHAIN_SERVICE, 'overwritten-by-login');
        } else {
          await writeFile(join(dir, '.credentials.json'), stored());
        }
      }
      return result;
    };
    return { run, calls, keychain };
  }

  it('captures the pair and who signed in on Linux, and leaves no throwaway dir', async () => {
    const cli = fakeCli({ platform: 'linux' });
    const oauth = await captureClaudeSignIn({ run: cli.run, platform: 'linux', tempRoot, env: { PATH: '/bin', ANTHROPIC_API_KEY: 'server-key' } });

    expect(oauth).toMatchObject({
      accessToken: 'fake-access',
      refreshToken: 'fake-refresh',
      email: 'alice@example.com',
      accountUuid: 'acct-1',
      organizationUuid: 'org-uuid-1',
    });
    expect(cli.calls.map(call => [call.command, ...call.args])).toEqual([['claude', 'auth', 'login', '--claudeai']]);
    // The server's own key never reaches the CLI.
    expect(cli.calls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('reads the throwaway Keychain item on macOS, deletes it, and puts the person’s own login back', async () => {
    const keychain = new Map([[CLAUDE_KEYCHAIN_SERVICE, 'own-login']]);
    const cli = fakeCli({ platform: 'darwin', keychain });

    const oauth = await captureClaudeSignIn({ run: cli.run, platform: 'darwin', tempRoot, user: 'alice', env: { PATH: '/bin' } });

    expect(oauth.accessToken).toBe('fake-access');
    expect([...keychain.entries()]).toEqual([[CLAUDE_KEYCHAIN_SERVICE, 'own-login']]);
    expect(cli.calls.filter(call => call.command === 'security').every(call => call.args.includes('alice'))).toBe(true);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('removes a default item the sign-in created when the person had none', async () => {
    const keychain = new Map<string, string>();
    const cli = fakeCli({ platform: 'darwin', keychain });
    await captureClaudeSignIn({ run: cli.run, platform: 'darwin', tempRoot, user: 'alice', env: {} });
    expect(keychain.size).toBe(0);
  });

  it('cleans up on macOS even when the sign-in fails', async () => {
    const keychain = new Map([[CLAUDE_KEYCHAIN_SERVICE, 'own-login']]);
    const cli = fakeCli({
      platform: 'darwin',
      keychain,
      login: async dir => {
        // The CLI got as far as storing something before giving up.
        keychain.set(claudeKeychainService(dir), stored());
        keychain.set(CLAUDE_KEYCHAIN_SERVICE, 'overwritten-by-login');
        return { code: 1, stdout: '', stderr: 'cancelled' };
      },
    });

    await expect(captureClaudeSignIn({ run: cli.run, platform: 'darwin', tempRoot, user: 'alice', env: {} })).rejects.toThrow(
      'claude exited with 1',
    );
    expect([...keychain.entries()]).toEqual([[CLAUDE_KEYCHAIN_SERVICE, 'own-login']]);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('runs the CLI in a throwaway dir under the given root, with the given env, timeout and signal', async () => {
    const cli = fakeCli({ platform: 'linux' });
    const controller = new AbortController();
    const seen: Array<{ timeoutMs: number; signal?: AbortSignal }> = [];
    const run: ClaudeSignInRunner = (command, args, options) => {
      seen.push({ timeoutMs: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
      return cli.run(command, args, options);
    };
    await captureClaudeSignIn({ run, platform: 'linux', tempRoot, env: { PATH: '/custom/bin' }, signal: controller.signal, timeoutMs: 1234 });

    const { env } = cli.calls[0]!;
    expect(env.CLAUDE_CONFIG_DIR!.startsWith(await realpath(tempRoot))).toBe(true);
    expect(env.PATH).toBe('/custom/bin');
    expect(seen).toEqual([{ timeoutMs: 1234, signal: controller.signal }]);

    seen.length = 0;
    await captureClaudeSignIn({ run, platform: 'linux', tempRoot, env: {} });
    expect(seen).toEqual([{ timeoutMs: CLAUDE_SIGN_IN_TIMEOUT_MS }]);
  });

  it('records who signed in only from the CLI’s text fields, and nothing when it wrote no account', async () => {
    const identity = async (account: unknown) => {
      const run: ClaudeSignInRunner = async (_command, _args, { env }) => {
        const dir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR!;
        await writeFile(join(dir, '.credentials.json'), stored());
        if (account !== undefined) await writeFile(join(dir, '.claude.json'), JSON.stringify(account));
        return ok();
      };
      const { email, accountUuid, organizationUuid } = await captureClaudeSignIn({ run, platform: 'linux', tempRoot, env: {} });
      return { email, accountUuid, organizationUuid };
    };
    const none = { email: undefined, accountUuid: undefined, organizationUuid: undefined };
    expect(await identity(undefined)).toEqual(none);
    expect(await identity({})).toEqual(none);
    expect(await identity({ oauthAccount: { emailAddress: '', accountUuid: '', organizationUuid: '' } })).toEqual(none);
    expect(await identity({ oauthAccount: { emailAddress: 1, accountUuid: 2, organizationUuid: 3 } })).toEqual(none);
    expect(await identity(oauthAccount)).toEqual({ email: 'alice@example.com', accountUuid: 'acct-1', organizationUuid: 'org-uuid-1' });
  });

  it('asks the Keychain with the dir’s env and a timeout, and fails when the stored login cannot be read', async () => {
    const keychain = new Map([[CLAUDE_KEYCHAIN_SERVICE, 'own-login']]);
    const cli = fakeCli({ platform: 'darwin', keychain });
    const timeouts: number[] = [];
    let failCaptureRead = false;
    const run: ClaudeSignInRunner = async (command, args, options) => {
      if (command === 'security') {
        timeouts.push(options.timeoutMs);
        expect(options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeTruthy();
        const service = args[args.indexOf('-s') + 1]!;
        if (failCaptureRead && args[0] === 'find-generic-password' && service !== CLAUDE_KEYCHAIN_SERVICE) {
          return { code: 51, stdout: '', stderr: 'user interaction is not allowed' };
        }
      }
      return cli.run(command, args, options);
    };
    await captureClaudeSignIn({ run, platform: 'darwin', tempRoot, user: 'alice', env: {} });
    expect(new Set(timeouts)).toEqual(new Set([10_000]));

    failCaptureRead = true;
    await expect(captureClaudeSignIn({ run, platform: 'darwin', tempRoot, user: 'alice', env: {} })).rejects.toThrow(
      'The macOS Keychain could not be read.',
    );
    expect([...keychain.entries()]).toEqual([[CLAUDE_KEYCHAIN_SERVICE, 'own-login']]);
  });

  it('takes an empty Keychain answer as no item', async () => {
    const cli = fakeCli({ platform: 'darwin' });
    const run: ClaudeSignInRunner = async (command, args, options) => {
      if (command === 'security' && args[0] === 'find-generic-password' && args.includes(CLAUDE_KEYCHAIN_SERVICE)) {
        // The person has no own login yet: `security` printed nothing.
        if (!cli.keychain.has(CLAUDE_KEYCHAIN_SERVICE)) return ok('  \n');
      }
      return cli.run(command, args, options);
    };
    await captureClaudeSignIn({ run, platform: 'darwin', tempRoot, user: 'alice', env: {} });
    // No own login before, so the default item the sign-in wrote is removed again.
    expect(cli.keychain.size).toBe(0);
  });

  it('leaves the person’s own login alone when the sign-in did not touch it or it cannot be read', async () => {
    const untouched = new Map([[CLAUDE_KEYCHAIN_SERVICE, 'own-login']]);
    const keepsOwn = fakeCli({ platform: 'darwin', keychain: untouched });
    const run: ClaudeSignInRunner = async (command, args, options) => {
      const result = await keepsOwn.run(command, args, options);
      // This CLI stores only the dir's item and leaves the default one as it was.
      if (command !== 'security') untouched.set(CLAUDE_KEYCHAIN_SERVICE, 'own-login');
      return result;
    };
    await captureClaudeSignIn({ run, platform: 'darwin', tempRoot, user: 'alice', env: {} });
    const writes = keepsOwn.calls.filter(call => call.command === 'security' && call.args[0] !== 'find-generic-password');
    // Only the throwaway item is deleted; the own login is neither rewritten nor deleted.
    expect(writes.map(call => call.args.slice(0, 3))).toEqual([['delete-generic-password', '-s', expect.not.stringMatching(/^Claude Code-credentials$/)]]);

    const locked = new Map([[CLAUDE_KEYCHAIN_SERVICE, 'own-login']]);
    const lockedCli = fakeCli({ platform: 'darwin', keychain: locked });
    let defaultReads = 0;
    const lockedRun: ClaudeSignInRunner = async (command, args, options) => {
      if (command === 'security' && args[0] === 'find-generic-password' && args.includes(CLAUDE_KEYCHAIN_SERVICE)) {
        defaultReads += 1;
        return { code: 51, stdout: '', stderr: 'locked' };
      }
      return lockedCli.run(command, args, options);
    };
    await captureClaudeSignIn({ run: lockedRun, platform: 'darwin', tempRoot, user: 'alice', env: {} });
    // The own login could not be read before the sign-in: it is left exactly as the sign-in left it.
    expect(defaultReads).toBe(1);
    expect(locked.get(CLAUDE_KEYCHAIN_SERVICE)).toBe('overwritten-by-login');
  });

  it('does not put the own login back when it cannot be read after the sign-in', async () => {
    const keychain = new Map([[CLAUDE_KEYCHAIN_SERVICE, 'own-login']]);
    const cli = fakeCli({ platform: 'darwin', keychain });
    let defaultReads = 0;
    const run: ClaudeSignInRunner = async (command, args, options) => {
      if (command === 'security' && args[0] === 'find-generic-password' && args.includes(CLAUDE_KEYCHAIN_SERVICE)) {
        defaultReads += 1;
        if (defaultReads > 1) return { code: 51, stdout: '', stderr: 'locked' };
      }
      return cli.run(command, args, options);
    };
    await captureClaudeSignIn({ run, platform: 'darwin', tempRoot, user: 'alice', env: {} });
    expect(keychain.get(CLAUDE_KEYCHAIN_SERVICE)).toBe('overwritten-by-login');
  });

  it('files Keychain items under the account the CLI uses: $USER, else $USERNAME, else a safe default', async () => {
    const accountOf = async () => {
      const cli = fakeCli({ platform: 'darwin' });
      await captureClaudeSignIn({ run: cli.run, platform: 'darwin', tempRoot, env: {} });
      const call = cli.calls.find(entry => entry.command === 'security')!;
      return call.args[call.args.indexOf('-a') + 1];
    };
    try {
      vi.stubEnv('USER', 'alice');
      vi.stubEnv('USERNAME', 'bob');
      expect(await accountOf()).toBe('alice');
      vi.stubEnv('USER', '');
      expect(await accountOf()).toBe('bob');
      vi.stubEnv('USERNAME', '');
      expect(await accountOf()).toBe(userInfo().username.match(/^[a-zA-Z0-9._-]+$/) ? userInfo().username : 'claude-code-user');
      vi.stubEnv('USER', 'not a safe name');
      expect(await accountOf()).toBe('claude-code-user');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails when the CLI stored no login, and when it runs out of time', async () => {
    const empty: ClaudeSignInRunner = async () => ok();
    await expect(captureClaudeSignIn({ run: empty, platform: 'linux', tempRoot, env: {} })).rejects.toBeInstanceOf(ClaudeSignInError);

    const slow: ClaudeSignInRunner = async () => {
      throw new ClaudeSignInError('claude auth timed out.');
    };
    await expect(captureClaudeSignIn({ run: slow, platform: 'linux', tempRoot, env: {}, timeoutMs: 1 })).rejects.toThrow('timed out');
    expect(await readdir(tempRoot)).toEqual([]);
  });
});

describe('createClaudeSignInService', () => {
  const pair = (overrides: Partial<ClaudeLoginOAuth> = {}): ClaudeLoginOAuth => ({
    accessToken: 'fake-access',
    refreshToken: 'fake-refresh',
    expiresAt: 1_900_000_000_000,
    scopes: [],
    email: 'alice@example.com',
    accountUuid: 'acct-1',
    ...overrides,
  });

  async function service(capture: (options: { signal: AbortSignal }) => Promise<ClaudeLoginOAuth>) {
    const seeded = await createFactoryStorageForTests();
    return { credentials: seeded.credentials, signIn: createClaudeSignInService({ credentials: seeded.credentials, capture }) };
  }

  it('files a finished sign-in as the person’s account, and a new sign-in to it replaces its pair', async () => {
    const pairs = [pair(), pair({ accessToken: 'fake-access-2', refreshToken: 'fake-refresh-2' })];
    const { credentials, signIn } = await service(async () => pairs.shift()!);

    const first = signIn.start({ orgId: 'org-1', userId: 'alice' });
    expect(first.status).toBe('pending');
    await vi.waitFor(() => expect(signIn.get(first.id)?.status).toBe('done'));
    const accountId = signIn.get(first.id)!.accountId!;
    expect(await credentials.getAccount('org-1', accountId)).toMatchObject({
      kind: 'claude_login',
      ownerUserId: 'alice',
      label: 'alice@example.com',
      hint: '',
    });

    await credentials.markAccountFailed('org-1', accountId, 'expired');
    const second = signIn.start({ orgId: 'org-1', userId: 'alice' });
    await vi.waitFor(() => expect(signIn.get(second.id)?.status).toBe('done'));
    expect(signIn.get(second.id)!.accountId).toBe(accountId);
    expect(await credentials.listAccounts('org-1')).toHaveLength(1);
    expect(await credentials.getAccount('org-1', accountId)).toMatchObject({ disabled: false });
    expect(await credentials.getAccountOAuth('org-1', accountId)).toMatchObject({ refreshToken: 'fake-refresh-2' });
  });

  it('shows a person’s pending sign-in again instead of starting a second, and reports a failure', async () => {
    const failures: Array<(error: Error) => void> = [];
    const { signIn } = await service(() => new Promise((_resolve, reject) => failures.push(reject)));

    const first = signIn.start({ orgId: 'org-1', userId: 'alice' });
    expect(signIn.start({ orgId: 'org-1', userId: 'alice' }).id).toBe(first.id);
    expect(signIn.start({ orgId: 'org-1', userId: 'bob' }).id).not.toBe(first.id);

    failures[0]!(new ClaudeSignInError('Claude sign-in did not finish (claude exited with 1).'));
    await vi.waitFor(() => expect(signIn.get(first.id)).toMatchObject({ status: 'error', error: expect.stringContaining('did not finish') }));
    expect(signIn.get('missing')).toBeUndefined();
  });

  it('hides an unexpected failure’s details and cancels a pending sign-in', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { signIn } = await service(async () => {
      throw new Error('secret detail');
    });
    const failed = signIn.start({ orgId: 'org-1', userId: 'alice' });
    await vi.waitFor(() => expect(signIn.get(failed.id)).toMatchObject({ status: 'error', error: 'Claude sign-in failed.' }));
    warn.mockRestore();

    let signal!: AbortSignal;
    const pending = await service(options => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const flow = pending.signIn.start({ orgId: 'org-1', userId: 'alice' });
    expect(pending.signIn.cancel(flow.id)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(pending.signIn.get(flow.id)).toMatchObject({ status: 'error', error: 'Claude sign-in was cancelled.' });
    expect(pending.signIn.cancel(flow.id)).toBe(false);
  });
});

describe('createClaudeSignInService filing and lifetime', () => {
  const pair = (overrides: Partial<ClaudeLoginOAuth> = {}): ClaudeLoginOAuth => ({
    accessToken: 'fake-access',
    refreshToken: 'fake-refresh',
    expiresAt: 1_900_000_000_000,
    scopes: [],
    email: 'alice@example.com',
    accountUuid: 'acct-1',
    ...overrides,
  });

  async function seeded() {
    const storage = await createFactoryStorageForTests();
    const credentials = storage.credentials;
    const addLogin = (ownerUserId: string, oauth: ClaudeLoginOAuth, label = oauth.email ?? 'Claude') =>
      credentials.addAccount({
        orgId: 'org-1',
        provider: 'anthropic',
        label,
        kind: 'claude_login',
        ownerUserId,
        secret: oauth.accessToken,
        oauth,
        createdBy: ownerUserId,
      });
    return { credentials, addLogin };
  }

  const finish = async (signIn: ReturnType<typeof createClaudeSignInService>, userId = 'alice') => {
    const flow = signIn.start({ orgId: 'org-1', userId });
    await vi.waitFor(() => expect(signIn.get(flow.id)?.status).not.toBe('pending'));
    return signIn.get(flow.id)!;
  };

  it('replaces only the person’s own sign-in to the same Claude account', async () => {
    const { credentials, addLogin } = await seeded();
    const bobs = await addLogin('bob', pair());
    const aliceOther = await addLogin('alice', pair({ accountUuid: 'acct-2', email: 'alice@work.example' }));
    const aliceKey = await credentials.addAccount({
      orgId: 'org-1',
      provider: 'anthropic',
      label: 'alice@example.com',
      kind: 'subscription',
      ownerUserId: 'alice',
      secret: 'sk-ant-oat01-0123456789abcdef',
      createdBy: 'alice',
    });
    const signIn = createClaudeSignInService({ credentials, capture: async () => pair({ accessToken: 'fake-access-new' }) });

    const flow = await finish(signIn);
    expect(flow.status).toBe('done');
    expect([bobs.id, aliceOther.id, aliceKey.id]).not.toContain(flow.accountId);
    // A finished sign-in is not shown again: a new click starts a new one.
    expect(signIn.start({ orgId: 'org-1', userId: 'alice' }).id).not.toBe(flow.id);
    expect(await credentials.getAccountOAuth('org-1', bobs.id)).toMatchObject({ accessToken: 'fake-access' });
    expect(await credentials.getAccountOAuth('org-1', aliceOther.id)).toMatchObject({ accessToken: 'fake-access' });

    // Signing in to it again finds it by its Claude account id.
    const again = await finish(createClaudeSignInService({ credentials, capture: async () => pair({ accessToken: 'fake-access-3' }) }));
    expect(again.accountId).toBe(flow.accountId);
    expect(await credentials.getAccountOAuth('org-1', flow.accountId!)).toMatchObject({ accessToken: 'fake-access-3' });
  });

  it('matches a sign-in without a Claude account id by its label', async () => {
    const { credentials, addLogin } = await seeded();
    const unnamed = pair({ accountUuid: undefined, email: undefined });
    // Listed first, so a looser match would pick them.
    const subscription = await credentials.addAccount({
      orgId: 'org-1',
      provider: 'anthropic',
      label: 'Claude',
      kind: 'subscription',
      ownerUserId: 'alice',
      secret: 'sk-ant-oat01-0123456789abcdef',
      createdBy: 'alice',
    });
    const other = await addLogin('alice', pair({ accountUuid: undefined, email: 'alice@work.example' }));
    const existing = await addLogin('alice', unnamed);
    const signIn = createClaudeSignInService({ credentials, capture: async () => ({ ...unnamed, accessToken: 'fake-access-new' }) });

    const flow = await finish(signIn);
    expect(flow.accountId).toBe(existing.id);
    expect(flow.accountId).not.toBe(subscription.id);
    expect((await credentials.getAccount('org-1', existing.id))?.label).toBe('Claude');
    expect(await credentials.getAccountOAuth('org-1', other.id)).toMatchObject({ accessToken: 'fake-access' });
  });

  it('adds a new account when the one it matched vanished before it was updated', async () => {
    const { credentials, addLogin } = await seeded();
    const existing = await addLogin('alice', pair());
    const racing = new Proxy(credentials, {
      get: (target, key) => {
        if (key === 'updateAccount') return async () => null;
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const flow = await finish(createClaudeSignInService({ credentials: racing, capture: async () => pair() }));
    expect(flow.status).toBe('done');
    expect(flow.accountId).not.toBe(existing.id);
    expect(await credentials.listAccounts('org-1')).toHaveLength(2);
  });

  it('keeps a cancelled sign-in cancelled when the CLI finishes or fails afterwards', async () => {
    const { credentials } = await seeded();
    const settles: Array<{ resolve: (oauth: ClaudeLoginOAuth) => void; reject: (error: Error) => void }> = [];
    const signIn = createClaudeSignInService({
      credentials,
      capture: () => new Promise((resolve, reject) => settles.push({ resolve, reject })),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const done = signIn.start({ orgId: 'org-1', userId: 'alice' });
    signIn.cancel(done.id);
    settles[0]!.resolve(pair());
    const failed = signIn.start({ orgId: 'org-1', userId: 'bob' });
    signIn.cancel(failed.id);
    settles[1]!.reject(new Error('late failure'));
    await new Promise(resolve => setTimeout(resolve, 20));

    for (const id of [done.id, failed.id]) {
      expect(signIn.get(id)).toMatchObject({ status: 'error', error: 'Claude sign-in was cancelled.' });
    }
    expect(signIn.get(done.id)).not.toHaveProperty('accountId');
    // A failure after the cancel is not reported either.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs an unexpected failure once, and not a sign-in error it explains itself', async () => {
    const { credentials } = await seeded();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = [new ClaudeSignInError('Claude sign-in did not finish.'), new Error('boom')];
    const signIn = createClaudeSignInService({
      credentials,
      capture: async () => {
        throw errors.shift();
      },
    });
    await finish(signIn);
    expect(warn).not.toHaveBeenCalled();
    await finish(signIn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[factory] Claude sign-in failed', { orgId: 'org-1', error: expect.any(Error) });
    warn.mockRestore();
  });

  it('keeps outcomes on the real clock by default', async () => {
    const { credentials } = await seeded();
    let clock = 1_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const signIn = createClaudeSignInService({ credentials, capture: async () => pair() });
      const done = await finish(signIn);
      clock += 10 * 60_000 + 1;
      expect(signIn.get(done.id)).toBeUndefined();
    } finally {
      dateNow.mockRestore();
    }
  });

  it('forgets a finished sign-in ten minutes after it finished, and keeps a pending one', async () => {
    const { credentials } = await seeded();
    let clock = 1_000;
    let release!: (oauth: ClaudeLoginOAuth) => void;
    const signIn = createClaudeSignInService({
      credentials,
      now: () => clock,
      capture: async () => pair(),
    });
    const waiting = createClaudeSignInService({
      credentials,
      now: () => clock,
      capture: () => new Promise(resolve => (release = resolve)),
    });

    const done = await finish(signIn);
    const pending = waiting.start({ orgId: 'org-1', userId: 'alice' });
    clock += 10 * 60_000;
    expect(signIn.get(done.id)?.status).toBe('done');
    expect(waiting.get(pending.id)?.status).toBe('pending');
    clock += 1;
    expect(signIn.get(done.id)).toBeUndefined();
    expect(waiting.get(pending.id)?.status).toBe('pending');

    // Starting a new sign-in prunes too.
    const second = await finish(signIn);
    clock += 10 * 60_000 + 1;
    signIn.start({ orgId: 'org-1', userId: 'carol' });
    expect(signIn.get(second.id)).toBeUndefined();
    release(pair());
    await vi.waitFor(() => expect(waiting.get(pending.id)?.status).toBe('done'));
  });
});

describe('runClaudeSignInCommand', () => {
  const node = process.execPath;
  const env = { PATH: process.env.PATH ?? '' };

  it('runs a command to its end and returns its exit code and output', async () => {
    const result = await runClaudeSignInCommand(
      node,
      ['-e', 'process.stdout.write("o1");setTimeout(()=>{process.stdout.write("o2");process.stderr.write("e1");process.exit(3)},20)'],
      { env: { ...env, SIGN_IN_TEST: 'x' }, timeoutMs: 10_000 },
    );
    expect(result).toEqual({ code: 3, stdout: 'o1o2', stderr: 'e1' });

    const echoed = await runClaudeSignInCommand(node, ['-e', 'process.stdout.write(process.env.SIGN_IN_TEST ?? "")'], {
      env: { ...env, SIGN_IN_TEST: 'from-env' },
      timeoutMs: 10_000,
    });
    expect(echoed.stdout).toBe('from-env');
  });

  it('stops a command that runs past its timeout', async () => {
    const started = Date.now();
    await expect(
      runClaudeSignInCommand(node, ['-e', 'setTimeout(()=>{},30000)'], { env, timeoutMs: 100 }),
    ).rejects.toThrow(new ClaudeSignInError(`${node} -e timed out.`));
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(runClaudeSignInCommand(node, [], { env, timeoutMs: 100 })).rejects.toThrow(`${node}  timed out.`);
  });

  it('kills a command it gives up on, so it cannot finish the sign-in afterwards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-sign-in-run-'));
    try {
      const late = (name: string) => `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(join(dir, name))},"x"),400)`;
      await expect(runClaudeSignInCommand(node, ['-e', late('timed-out')], { env, timeoutMs: 50 })).rejects.toThrow('timed out');
      const controller = new AbortController();
      const cancelled = runClaudeSignInCommand(node, ['-e', late('cancelled')], { env, timeoutMs: 30_000, signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      await expect(cancelled).rejects.toThrow('cancelled');
      await new Promise(resolve => setTimeout(resolve, 800));
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops a command when the sign-in is cancelled, and ignores a cancel after it ended', async () => {
    const controller = new AbortController();
    const running = runClaudeSignInCommand(node, ['-e', 'setTimeout(()=>{},30000)'], {
      env,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toThrow('Claude sign-in was cancelled.');

    const later = new AbortController();
    await expect(
      runClaudeSignInCommand(node, ['-e', ''], { env, timeoutMs: 10_000, signal: later.signal }),
    ).resolves.toMatchObject({ code: 0 });
    later.abort();
  });

  it('fails when the command cannot start', async () => {
    await expect(
      runClaudeSignInCommand('/nonexistent/claude-sign-in-test', ['auth'], { env, timeoutMs: 10_000 }),
    ).rejects.toThrow(/^\/nonexistent\/claude-sign-in-test could not start: /);
  });
});
