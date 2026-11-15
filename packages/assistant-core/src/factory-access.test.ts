/**
 * The assistant as an OAuth client of Factory's real authorization server (better-auth
 * `oauthProvider`, Google's token check replaced): register, the person's consent, the code
 * exchange, a renewal, the token reaching an authenticated route, and revocation.
 */
import { createTestGoogleAuth, TEST_ORIGIN } from '@factory/auth-better-auth/testing';
import type { TestGoogleAuth } from '@factory/auth-better-auth/testing';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FactoryAccess } from './factory-access.ts';
import { AssistantStorage } from './storage.ts';
import { testCipher } from './testing.ts';
import type { AssistantOwner } from './types.ts';

const ADA_OWNER: AssistantOwner = { orgId: 'org-a', userId: 'ada' };

let google: TestGoogleAuth;
let storage: AssistantStorage;
let access: FactoryAccess;
let cookie: string;
let clock: number;

const authServer = (request: Request) => google.provider.handleAuthRequest(request);

/** The browser's part: open the authorize URL signed in, accept on the consent page, follow the redirect back. */
async function consent(url: string): Promise<{ code: string; state: string }> {
  const authorized = await authServer(new Request(url, { headers: { cookie }, redirect: 'manual' }));
  const consentPage = new URL(authorized.headers.get('location') ?? '', TEST_ORIGIN);
  expect(consentPage.pathname).toBe('/oauth/consent');
  const consented = await authServer(
    new Request(`${TEST_ORIGIN}/auth/api/oauth2/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, cookie },
      body: JSON.stringify({ accept: true, oauth_query: consentPage.search.slice(1) }),
    }),
  );
  const { url: back } = (await consented.json()) as { url: string };
  const callback = new URL(back);
  expect(`${callback.origin}${callback.pathname}`).toBe(`${TEST_ORIGIN}/web/assistant/factory-access/callback`);
  return { code: callback.searchParams.get('code')!, state: callback.searchParams.get('state')! };
}

beforeEach(async () => {
  google = await createTestGoogleAuth();
  cookie = await google.signIn({ sub: 'google-ada', email: 'ada@example.com', name: 'Ada' });
  const backend = new LibSQLFactoryStorage({ id: 'assistant-oauth', url: ':memory:' });
  storage = backend.registerDomain(new AssistantStorage());
  await backend.init();
  clock = Date.now();
  access = new FactoryAccess({ storage, cipher: testCipher, publicOrigin: TEST_ORIGIN, authServer, now: () => clock });
});

describe('the assistant’s access to Factory', () => {
  it('is allowed by the person on the consent page and yields their access token, kept encrypted', async () => {
    expect(await access.status(ADA_OWNER)).toEqual({ connected: false, pending: false });
    const { url } = await access.start(ADA_OWNER, '/factories/f-1/settings/account');
    expect(await access.status(ADA_OWNER)).toEqual({ connected: false, pending: true });

    const { code, state } = await consent(url);
    expect(await access.complete(ADA_OWNER, { code, state })).toEqual({ returnTo: '/factories/f-1/settings/account' });
    expect(await access.status(ADA_OWNER)).toEqual({ connected: true, pending: false });

    const token = await access.accessToken(ADA_OWNER);
    expect(token.split('.')).toHaveLength(3);
    const row = await storage.getGrant(ADA_OWNER);
    expect(row?.status).toBe('granted');
    expect(row?.secret).not.toContain(token);

    // The token authenticates as Ada.
    const me = await google.provider.authenticateToken(token, new Request(TEST_ORIGIN) as never);
    expect(me?.user.email).toBe('ada@example.com');
  });

  it('refuses a callback it did not start, and a replayed one', async () => {
    const { url } = await access.start(ADA_OWNER);
    const { code, state } = await consent(url);
    await expect(access.complete(ADA_OWNER, { code, state: 'forged' })).rejects.toMatchObject({ code: 'factory_access_state' });
    await expect(access.complete({ orgId: 'org-a', userId: 'bob' }, { code, state })).rejects.toMatchObject({
      code: 'factory_access_state',
    });
    await access.complete(ADA_OWNER, { code, state });
    await expect(access.complete(ADA_OWNER, { code, state })).rejects.toMatchObject({ code: 'factory_access_state' });
  });

  it('renews the access token with the refresh token before it expires', async () => {
    const { url } = await access.start(ADA_OWNER);
    await access.complete(ADA_OWNER, await consent(url));
    const first = await access.accessToken(ADA_OWNER);
    clock += 59 * 60 * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2_000);
      const renewed = await access.accessToken(ADA_OWNER);
      expect(renewed).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is revoked and forgotten when the person disconnects', async () => {
    const { url } = await access.start(ADA_OWNER);
    await access.complete(ADA_OWNER, await consent(url));
    const grant = await storage.getGrant(ADA_OWNER);
    const { value } = await testCipher.decrypt<{ refreshToken: string }>(grant!.secret);

    await access.disconnect(ADA_OWNER);

    expect(await storage.getGrant(ADA_OWNER)).toBeNull();
    await expect(access.accessToken(ADA_OWNER)).rejects.toMatchObject({ code: 'factory_not_connected' });
    // The refresh token no longer renews anything.
    const refused = await authServer(
      new Request(`${TEST_ORIGIN}/auth/api/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: value.refreshToken, client_id: grant!.client_id }),
      }),
    );
    expect(refused.status).not.toBe(200);
  });
});
