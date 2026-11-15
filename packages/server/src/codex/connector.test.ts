// Codex's accounts connector (ADR-0036) driven end to end with the real sign-in service and a fake
// `codex login`: the connect is an authorize without a URL, `getAuthStatus` follows the CLI to the end,
// and the account it filed is a connection — with the CLI's tokens nowhere in what the routes answer.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createAgentAccountsConnections } from '@factory/api';
import { CODEX_HARNESS } from '@factory/contracts';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import { buildConnectionRoutes } from '@factory/integrations';
import { createFactoryStorageForTests } from '@factory/testing';

import { createCodexSignInService } from './sign-in.ts';
import type { CodexSignInRunner } from './sign-in.ts';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const AUTH = { chatgpt_plan_type: 'plus', chatgpt_account_id: 'ws-1', chatgpt_user_id: 'user-1' };
const ACCESS = jwt({ exp: 2_000_000_000, 'https://api.openai.com/auth': AUTH });
const REFRESH = 'refresh-contract-secret';

describe('Codex accounts connector with a fake codex CLI', () => {
  it('signs a member in through the CLI, follows the flow by its authId, and lists the filed account without its tokens', async () => {
    const seed = await createFactoryStorageForTests();
    let release!: () => void;
    const browserDone = new Promise<void>(resolve => (release = resolve));
    // A fake `codex login`: waits for the person to finish in the browser, then files auth.json in its CODEX_HOME.
    const run: CodexSignInRunner = async (_command, _args, options) => {
      await browserDone;
      await writeFile(
        join(options.env.CODEX_HOME!, 'auth.json'),
        JSON.stringify({ tokens: { id_token: jwt({ email: 'alice@example.com', 'https://api.openai.com/auth': AUTH }), access_token: ACCESS, refresh_token: REFRESH, account_id: 'ws-1' } }),
      );
      return { code: 0, stdout: '', stderr: '' };
    };
    const tempRoot = await mkdtemp(join(tmpdir(), 'codex-connector-'));
    const signIn = createCodexSignInService({ credentials: seed.credentials, run, env: { PATH: process.env.PATH, TMPDIR: tempRoot } });
    const connections = createAgentAccountsConnections({ harness: CODEX_HARNESS, kind: 'codex_login', signInName: 'ChatGPT', credentials: seed.credentials, signIn });
    const routes = buildConnectionRoutes({ auth: fakeRouteAuth({ isAdmin: async () => false }), connectors: [{ id: 'codex', connections }] });
    const hono = new Hono();
    hono.use('*', async (c, next) => {
      c.set('factoryAuthUser' as never, { id: 'alice', organizationId: 'org1' } as never);
      await next();
    });
    mountApiRoutes(hono as never, routes);
    const answers: string[] = [];
    const send = async (method: string, path: string, body?: unknown) => {
      const response = await hono.request(path, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
      const text = await response.text();
      answers.push(text);
      return JSON.parse(text);
    };

    const started = await send('POST', '/web/connections', { connector: 'codex', method: 'sign-in', input: {} });
    expect(started).toMatchObject({ type: 'authorize', authId: expect.any(String), waiting: { title: expect.stringContaining('ChatGPT') } });
    const status = () => send('GET', `/web/connections/authorizations/${started.authId}?connector=codex`);
    expect(await status()).toEqual({ status: 'pending' });

    release();
    await vi.waitFor(async () => expect(await status()).toEqual({ status: 'completed' }));
    const { connections: listed } = await send('GET', '/web/connections');
    expect(listed).toEqual([
      expect.objectContaining({ connector: expect.objectContaining({ id: 'codex' }), accountLabel: 'alice@example.com', accountDetail: 'Yours · plus', state: expect.objectContaining({ tone: 'ok' }) }),
    ]);
    expect(answers.join('\n')).not.toContain(REFRESH);
    expect(answers.join('\n')).not.toContain(ACCESS);
  });
});
