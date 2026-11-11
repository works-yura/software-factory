import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeCodexSpawn } from '@factory/harness-codex/testkit';
import { createFactoryStorageForTests } from '@factory/testing';

import { captureCodexSignIn, CodexSignInError, createCodexSignInService } from './sign-in.ts';

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

/** A fake app-server whose device sign-in files `auth.json` in its CODEX_HOME once the person "entered the code". */
function deviceSignIn(outcome: { success: boolean; error?: string } = { success: true }) {
  const spawn = fakeCodexSpawn(server => {
    server.handle('account/login/start', params => {
      expect(params).toEqual({ type: 'chatgptDeviceCode' });
      const home = spawn.calls.at(-1)!.env!.CODEX_HOME!;
      setTimeout(() => {
        if (outcome.success) writeFileSync(join(home, 'auth.json'), authJson, { mode: 0o600 });
        server.notify('account/login/completed', { loginId: 'login-1', success: outcome.success, error: outcome.error ?? null });
      }, 5);
      return { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHI' };
    });
  });
  return spawn;
}

describe('captureCodexSignIn', () => {
  it('runs a device sign-in in a throwaway 0700 home, shows the code, and captures the pair and who signed in', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'codex-sign-in-test-'));
    const spawn = deviceSignIn();
    const prompts: unknown[] = [];
    const homes: string[] = [];
    const oauth = await captureCodexSignIn({
      signal: new AbortController().signal,
      onPrompt: prompt => {
        prompts.push(prompt);
        const home = spawn.calls[0]!.env!.CODEX_HOME!;
        homes.push(home);
        expect(statSync(home).mode & 0o777).toBe(0o700);
      },
      spawn,
      tempRoot,
      env: { PATH: '/bin', HOME: '/home/me', OPENAI_API_KEY: 'server-key' },
    });
    expect(prompts).toEqual([{ url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGHI' }]);
    expect(oauth).toMatchObject({ refreshToken: 'refresh-1', email: 'alice@example.com', workspaceId: 'ws-1', subscriptionType: 'plus', accountUuid: 'user-1:ws-1' });
    // Never the person's own home, nothing of the server's keys, the sign-in kept as a file.
    expect(spawn.calls[0]!.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(spawn.calls[0]!.env!.CODEX_HOME).not.toBe('/home/me/.codex');
    expect(spawn.calls[0]!.args).toEqual(['app-server', '-c', 'cli_auth_credentials_store="file"']);
    expect(existsSync(homes[0]!)).toBe(false);
    expect(readdirSync(tempRoot)).toEqual([]);
    expect(spawn.servers[0]!.closed).toBe(true);
  });

  it('says why a sign-in failed, and cancels one still waiting', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'codex-sign-in-test-'));
    await expect(
      captureCodexSignIn({ signal: new AbortController().signal, onPrompt: () => {}, spawn: deviceSignIn({ success: false, error: 'device code login is disabled' }), tempRoot, env: {} }),
    ).rejects.toThrow('ChatGPT sign-in failed: device code login is disabled');

    const controller = new AbortController();
    const waiting = fakeCodexSpawn(server =>
      server.handle('account/login/start', () => ({ type: 'chatgptDeviceCode', loginId: 'login-2', verificationUrl: 'https://x', userCode: 'C' })),
    );
    const capture = captureCodexSignIn({ signal: controller.signal, onPrompt: () => controller.abort(), spawn: waiting, tempRoot, env: {} });
    await expect(capture).rejects.toBeInstanceOf(CodexSignInError);
    await expect(capture).rejects.toThrow('cancelled');
    expect(waiting.servers[0]!.requests('account/login/cancel')[0]?.params).toEqual({ loginId: 'login-2' });
    expect(readdirSync(tempRoot)).toEqual([]);
  });
});

describe('createCodexSignInService', () => {
  it("files the sign-in as the person's codex_login account, and a second sign-in to it replaces its pair", async () => {
    const storage = await createFactoryStorageForTests();
    const service = createCodexSignInService({ credentials: storage.credentials, spawn: deviceSignIn(), env: {} });
    const flow = service.start({ orgId: 'org-1', userId: 'alice' });
    expect(flow.status).toBe('pending');
    for (let i = 0; i < 100 && service.get(flow.id)?.status === 'pending'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const done = service.get(flow.id)!;
    expect(done).toMatchObject({ status: 'done' });
    const [account] = await storage.credentials.listAccounts('org-1', 'openai-codex');
    expect(account).toMatchObject({ id: done.accountId, kind: 'codex_login', label: 'alice@example.com', ownerUserId: 'alice', hint: '' });

    const again = createCodexSignInService({ credentials: storage.credentials, spawn: deviceSignIn(), env: {} });
    const second = again.start({ orgId: 'org-1', userId: 'alice' });
    for (let i = 0; i < 100 && again.get(second.id)?.status === 'pending'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(again.get(second.id)).toMatchObject({ status: 'done', accountId: account!.id });
    expect(await storage.credentials.listAccounts('org-1', 'openai-codex')).toHaveLength(1);
  });
});
