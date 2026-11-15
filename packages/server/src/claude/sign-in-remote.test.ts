/**
 * Signing in to Claude from a browser on another machine than the server: the CLI opens no browser,
 * the authorize URL it prints reaches the person through the flow, and the code they paste back goes
 * to the CLI's stdin. A fake `claude` prints what 2.1.325 prints (an OSC 8 hyperlink under a pty, the
 * URL repeated) in pieces and waits on stdin.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentAccountsConnections } from '@factory/api';
import { CLAUDE_CODE_HARNESS } from '@factory/contracts';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import { buildConnectionRoutes } from '@factory/integrations';
import { createFactoryStorageForTests } from '@factory/testing';

import { NO_BROWSER } from '../accounts/sign-in-command.ts';
import type { SignInCommandOptions } from '../accounts/sign-in-command.ts';
import { captureClaudeSignIn, ClaudeSignInError, createClaudeSignInService } from './sign-in.ts';
import type { ClaudeSignInCommandResult, ClaudeSignInRunner } from './sign-in.ts';

const AUTHORIZE =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=client-1&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=challenge-1&code_challenge_method=S256&state=state-1';
const CODE = 'pasted-code-1#state-1';

/** What `claude auth login --claudeai` prints, split where a pipe may split it. */
const OUTPUT = [
  'Opening browser to sign in…\n',
  "If the browser didn't open, visit: \x1b]8;;",
  `${AUTHORIZE}\x07${AUTHORIZE.slice(0, 40)}`,
  `${AUTHORIZE.slice(40)}${AUTHORIZE}\x1b]8;;\x07\n`,
  'Paste code here if prompted > ',
];

const stored = JSON.stringify({
  claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: 1_900_000_000_000, scopes: ['user:inference'] },
});

/**
 * A fake `claude auth login`: prints {@link OUTPUT}, reads one line from stdin, and signs in when it
 * is {@link CODE} (writing what the real CLI writes on Linux), else fails as the real one does.
 */
function fakeClaude() {
  const seen: { env?: Record<string, string>; writes: string[]; args?: string[] } = { writes: [] };
  const run: ClaudeSignInRunner = (command, args, options: SignInCommandOptions) => {
    seen.env = options.env;
    seen.args = args;
    return new Promise<ClaudeSignInCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ClaudeSignInError(`${command} ${args[0]} timed out.`)), options.timeoutMs);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new ClaudeSignInError('Claude sign-in was cancelled.'));
      });
      options.onStarted?.({
        write: text => {
          seen.writes.push(text);
          clearTimeout(timer);
          const dir = options.env.CLAUDE_CONFIG_DIR!;
          if (text !== `${CODE}\n`) {
            resolve({ code: 1, stdout: OUTPUT.join(''), stderr: "Login failed: That code wasn't accepted. Sign in again to get a new code.\n" });
            return;
          }
          void Promise.all([
            writeFile(join(dir, '.credentials.json'), stored),
            writeFile(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com', accountUuid: 'acct-1' } })),
          ]).then(() => resolve({ code: 0, stdout: `${OUTPUT.join('')}Login successful.\n`, stderr: '' }));
        },
      });
      // Printed piece by piece, as a pipe hands it over.
      void (async () => {
        for (const piece of OUTPUT) {
          await new Promise(next => setTimeout(next, 1));
          options.onOutput?.(piece);
        }
      })();
    });
  };
  return { run, seen };
}

describe('Claude sign-in from another machine', () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'claude-remote-sign-in-'));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function service(run: ClaudeSignInRunner, timeoutMs = 60_000) {
    const seeded = await createFactoryStorageForTests();
    const signIn = createClaudeSignInService({
      credentials: seeded.credentials,
      capture: options => captureClaudeSignIn({ ...options, run, platform: 'linux', tempRoot, env: { PATH: '/usr/bin' }, timeoutMs }),
    });
    return { signIn, credentials: seeded.credentials };
  }

  it('opens no browser on the server, shows the authorize URL, and signs in with the pasted code', async () => {
    const cli = fakeClaude();
    const { signIn, credentials } = await service(cli.run);
    const alice = { orgId: 'org-1', userId: 'alice' };

    const flow = signIn.start(alice);
    expect(flow.prompt).toBeUndefined();
    await vi.waitFor(() => expect(signIn.get(flow.id)?.prompt).toEqual({ url: AUTHORIZE, acceptsCode: true }));
    expect(cli.seen.args).toEqual(['auth', 'login', '--claudeai']);
    expect(cli.seen.env?.BROWSER).toBe(NO_BROWSER);

    expect(signIn.submitCode(flow.id, alice, `  ${CODE}\n`)).toBe('accepted');
    expect(cli.seen.writes).toEqual([`${CODE}\n`]);
    await vi.waitFor(() => expect(signIn.get(flow.id)?.status).toBe('done'));
    const done = signIn.get(flow.id)!;
    expect(done.prompt).toBeUndefined();
    expect(await credentials.getAccount('org-1', done.accountId!)).toMatchObject({ kind: 'claude_login', ownerUserId: 'alice', label: 'alice@example.com' });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('takes a code only from the person who started it, once, and only a one-line code', async () => {
    const cli = fakeClaude();
    const { signIn } = await service(cli.run);
    const alice = { orgId: 'org-1', userId: 'alice' };
    const flow = signIn.start(alice);
    expect(signIn.submitCode(flow.id, alice, CODE)).toBe('not_waiting');
    await vi.waitFor(() => expect(signIn.get(flow.id)?.prompt?.acceptsCode).toBe(true));

    expect(signIn.submitCode(flow.id, { orgId: 'org-1', userId: 'bob' }, CODE)).toBe('not_found');
    expect(signIn.submitCode(flow.id, { orgId: 'org-2', userId: 'alice' }, CODE)).toBe('not_found');
    expect(signIn.submitCode('missing', alice, CODE)).toBe('not_found');
    expect(signIn.submitCode(flow.id, alice, 'two\nlines')).toBe('invalid');
    expect(signIn.submitCode(flow.id, alice, 'has space')).toBe('invalid');
    expect(signIn.submitCode(flow.id, alice, '   ')).toBe('invalid');
    expect(signIn.submitCode(flow.id, alice, 'x'.repeat(2049))).toBe('invalid');
    expect(cli.seen.writes).toEqual([]);

    expect(signIn.submitCode(flow.id, alice, CODE)).toBe('accepted');
    expect(signIn.submitCode(flow.id, alice, CODE)).toBe('not_waiting');
    expect(cli.seen.writes).toEqual([`${CODE}\n`]);
    await vi.waitFor(() => expect(signIn.get(flow.id)?.status).toBe('done'));
    expect(signIn.submitCode(flow.id, alice, CODE)).toBe('not_waiting');
  });

  it('says why a wrong code failed, in the CLI’s words', async () => {
    const cli = fakeClaude();
    const { signIn } = await service(cli.run);
    const alice = { orgId: 'org-1', userId: 'alice' };
    const flow = signIn.start(alice);
    await vi.waitFor(() => expect(signIn.get(flow.id)?.prompt).toBeDefined());
    expect(signIn.submitCode(flow.id, alice, 'wrong-code')).toBe('accepted');
    await vi.waitFor(() =>
      expect(signIn.get(flow.id)).toMatchObject({ status: 'error', error: "Claude sign-in failed: That code wasn't accepted. Sign in again to get a new code." }),
    );
    expect(signIn.get(flow.id)?.prompt).toBeUndefined();
  });

  it('stops the CLI on a cancel and when nobody pastes a code in time, and cleans up', async () => {
    const cancelled = fakeClaude();
    const first = await service(cancelled.run);
    const alice = { orgId: 'org-1', userId: 'alice' };
    const flow = first.signIn.start(alice);
    await vi.waitFor(() => expect(first.signIn.get(flow.id)?.prompt).toBeDefined());
    expect(first.signIn.cancel(flow.id)).toBe(true);
    expect(first.signIn.get(flow.id)).toMatchObject({ status: 'error', error: 'Claude sign-in was cancelled.' });
    expect(first.signIn.get(flow.id)?.prompt).toBeUndefined();
    expect(first.signIn.submitCode(flow.id, alice, CODE)).toBe('not_waiting');
    expect(cancelled.seen.writes).toEqual([]);
    await vi.waitFor(async () => expect(await readdir(tempRoot)).toEqual([]));

    const late = fakeClaude();
    const second = await service(late.run, 50);
    const timedOut = second.signIn.start(alice);
    await vi.waitFor(() => expect(second.signIn.get(timedOut.id)).toMatchObject({ status: 'error', error: 'claude auth timed out.' }));
    await vi.waitFor(async () => expect(await readdir(tempRoot)).toEqual([]));
  });

  it('shows no URL the CLI printed for another host', async () => {
    const prompts: unknown[] = [];
    const run: ClaudeSignInRunner = async (_command, _args, options) => {
      options.onOutput?.("If the browser didn't open, visit: https://evil.example/cai/oauth/authorize?state=x\n");
      return { code: 1, stdout: '', stderr: '' };
    };
    await expect(captureClaudeSignIn({ run, platform: 'linux', tempRoot, env: {}, onPrompt: prompt => prompts.push(prompt) })).rejects.toThrow(
      'Claude sign-in did not finish (claude exited with 1).',
    );
    expect(prompts).toEqual([]);
  });
});

describe('Claude accounts connector with a fake claude CLI', () => {
  it('serves the authorize URL through the flow, takes the pasted code from its owner, and files the account', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'claude-connector-'));
    try {
      const seed = await createFactoryStorageForTests();
      const cli = fakeClaude();
      const signIn = createClaudeSignInService({
        credentials: seed.credentials,
        capture: options => captureClaudeSignIn({ ...options, run: cli.run, platform: 'linux', tempRoot, env: {} }),
      });
      const connections = createAgentAccountsConnections({ harness: CLAUDE_CODE_HARNESS, kind: 'claude_login', signInName: 'Claude', credentials: seed.credentials, signIn });
      const connector = CLAUDE_CODE_HARNESS.setup.accounts!.connector;
      const routes = buildConnectionRoutes({ auth: fakeRouteAuth({ isAdmin: async () => false }), connectors: [{ id: connector, connections }] });
      const send = async (userId: string, method: string, path: string, body?: unknown) => {
        const hono = new Hono();
        hono.use('*', async (c, next) => {
          c.set('factoryAuthUser' as never, { id: userId, organizationId: 'org1' } as never);
          await next();
        });
        mountApiRoutes(hono as never, routes);
        const response = await hono.request(path, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
        return { status: response.status, body: (await response.json()) as any };
      };

      const started = await send('alice', 'POST', '/web/connections', { connector, method: 'sign-in', input: {} });
      expect(started.body).toMatchObject({ type: 'authorize', authId: expect.any(String) });
      const status = () => send('alice', 'GET', `/web/connections/authorizations/${started.body.authId}?connector=${connector}`);
      await vi.waitFor(async () => expect((await status()).body).toEqual({ status: 'pending', prompt: { url: AUTHORIZE, acceptsCode: true } }));

      const code = (userId: string) => send(userId, 'POST', `/web/connections/authorizations/${started.body.authId}/code?connector=${connector}`, { code: CODE });
      expect((await code('bob')).status).toBe(404);
      expect(cli.seen.writes).toEqual([]);
      expect(await code('alice')).toEqual({ status: 200, body: { status: 'pending' } });
      await vi.waitFor(async () => expect((await status()).body).toEqual({ status: 'completed' }));
      expect(cli.seen.writes).toEqual([`${CODE}\n`]);
      expect((await seed.credentials.listAccounts('org1', 'anthropic')).map(account => account.ownerUserId)).toEqual(['alice']);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

/**
 * The real CLI, only when asked (`FACTORY_CLAUDE_SIGN_IN_SMOKE=$(which claude)`): starts a sign-in,
 * checks the authorize URL arrives with no browser opened, and cancels it — never signs in. Run as
 * `platform: 'linux'` so not even the default Keychain item is read; the CLI files nothing before a code.
 */
describe.skipIf(!process.env.FACTORY_CLAUDE_SIGN_IN_SMOKE)('the real claude CLI', () => {
  it('prints the authorize URL to a pipe and stops on a cancel', { timeout: 60_000 }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'claude-sign-in-smoke-'));
    try {
      const controller = new AbortController();
      const urls: string[] = [];
      const capture = captureClaudeSignIn({
        command: process.env.FACTORY_CLAUDE_SIGN_IN_SMOKE!,
        platform: 'linux',
        tempRoot,
        timeoutMs: 30_000,
        signal: controller.signal,
        onPrompt: prompt => {
          urls.push(prompt.url);
          expect(prompt.submitCode).toBeTypeOf('function');
          controller.abort();
        },
      });
      await expect(capture).rejects.toThrow('Claude sign-in was cancelled.');
      expect(urls).toHaveLength(1);
      const url = new URL(urls[0]!);
      expect(url.origin).toBe('https://claude.com');
      expect(url.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
      expect(url.searchParams.getAll('state')).toHaveLength(1);
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
