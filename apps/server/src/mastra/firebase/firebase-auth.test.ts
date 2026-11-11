import type { DecodedIdToken } from 'firebase-admin/auth';
import { describe, expect, it } from 'vitest';

import { LOCAL_USER } from '../local/local-dev-auth';
import { createFirebaseAuthProvider, FIREBASE_SESSION_COOKIE } from './firebase-auth';
import type { FirebaseTokenVerifier } from './firebase-auth';

const ORIGIN = 'http://localhost:5874';

function claims(email: string, overrides: Partial<DecodedIdToken> = {}): DecodedIdToken {
  return {
    uid: `uid-${email}`,
    email,
    email_verified: true,
    name: 'Ada Lovelace',
    picture: 'https://example.com/ada.png',
    auth_time: Math.floor(Date.now() / 1000),
    ...overrides,
  } as DecodedIdToken;
}

/** Tokens are the email they belong to; session cookies are `session:<email>`. */
function fakeVerifier(overrides: Partial<Record<string, Partial<DecodedIdToken>>> = {}): FirebaseTokenVerifier {
  return {
    async verifyIdToken(idToken) {
      if (idToken === 'forged') throw new Error('invalid signature');
      return claims(idToken, overrides[idToken]);
    },
    async verifySessionCookie(sessionCookie) {
      if (!sessionCookie.startsWith('session:')) throw new Error('invalid session cookie');
      const email = sessionCookie.slice('session:'.length);
      return claims(email, overrides[email]);
    },
    async createSessionCookie(idToken) {
      return `session:${idToken}`;
    },
  };
}

function provider(verifier = fakeVerifier(), ownerEmail?: string) {
  return createFirebaseAuthProvider({
    allowedEmails: ['ada@example.com', 'Owner@Example.com'],
    ownerEmail,
    webConfig: { apiKey: 'web-key', authDomain: 'demo.firebaseapp.com', projectId: 'demo' },
    verifier,
  }) as ReturnType<typeof createFirebaseAuthProvider> & {
    handleAuthRequest(request: Request): Promise<Response>;
    getClearSessionHeaders(): Record<string, string>;
  };
}

function signIn(body: unknown, headers: Record<string, string> = { Origin: ORIGIN }) {
  return new Request(`${ORIGIN}/auth/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: 'localhost:5874', ...headers },
    body: JSON.stringify(body),
  });
}

const withCookie = (value: string) =>
  new Request(`${ORIGIN}/api/factories`, { headers: { cookie: `other=1; ${FIREBASE_SESSION_COOKIE}=${value}` } });

describe('createFirebaseAuthProvider', () => {
  it('hands an allowed Google account an HttpOnly session cookie that later requests sign in with', async () => {
    const auth = provider();
    const response = await auth.handleAuthRequest(signIn({ idToken: 'ada@example.com' }));

    expect(response.status).toBe(200);
    const setCookie = response.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain(`${FIREBASE_SESSION_COOKIE}=session%3Aada%40example.com`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');

    expect(await auth.authenticateToken('', withCookie('session%3Aada%40example.com'))).toEqual({
      id: 'uid-ada@example.com',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      avatarUrl: 'https://example.com/ada.png',
      organizationId: LOCAL_USER.organizationId,
      organizationMembershipIds: [LOCAL_USER.organizationId],
    });
  });

  it('refuses a Google account that is not on the allow-list, or whose email is unverified', async () => {
    const auth = provider(fakeVerifier({ 'ada@example.com': { email_verified: false } }));

    const stranger = await auth.handleAuthRequest(signIn({ idToken: 'eve@example.com' }));
    expect(stranger.status).toBe(403);
    expect(stranger.headers.get('Set-Cookie')).toBeNull();
    expect(await stranger.json()).toEqual({ message: 'eve@example.com is not allowed to use this Factory.' });

    expect((await auth.handleAuthRequest(signIn({ idToken: 'ada@example.com' }))).status).toBe(403);
    expect(await auth.authenticateToken('', withCookie('session:eve@example.com'))).toBeNull();
    expect(await auth.authenticateToken('', withCookie('session:ada@example.com'))).toBeNull();
  });

  it('refuses forged tokens, stale sign-ins, cross-site posts and malformed bodies', async () => {
    const auth = provider(fakeVerifier({ 'ada@example.com': { auth_time: Math.floor(Date.now() / 1000) - 600 } }));

    expect((await auth.handleAuthRequest(signIn({ idToken: 'forged' }))).status).toBe(401);
    expect((await auth.handleAuthRequest(signIn({ idToken: 'ada@example.com' }))).status).toBe(401);
    expect((await auth.handleAuthRequest(signIn({ idToken: 'owner@example.com' }, { Origin: 'https://evil.example' }))).status).toBe(
      403,
    );
    expect((await auth.handleAuthRequest(signIn({}))).status).toBe(400);
    expect(await auth.authenticateToken('', withCookie('forged'))).toBeNull();
    expect(await auth.authenticateToken('', new Request(`${ORIGIN}/api/factories`))).toBeNull();
  });

  it('signs the owner in as the local developer, so their earlier work stays theirs', async () => {
    const auth = provider(fakeVerifier(), 'owner@example.com');
    expect(await auth.authenticateToken('', withCookie('session:owner@example.com'))).toMatchObject({
      id: LOCAL_USER.id,
      email: 'owner@example.com',
    });
    expect(() =>
      createFirebaseAuthProvider({
        allowedEmails: ['ada@example.com'],
        ownerEmail: 'owner@example.com',
        webConfig: { apiKey: 'k', authDomain: 'd', projectId: 'p' },
        verifier: fakeVerifier(),
      }),
    ).toThrow(/not in the allowed emails/);
  });

  it('accepts a Firebase ID token as a bearer token', async () => {
    const auth = provider();
    expect(await auth.authenticateToken('ada@example.com', new Request(`${ORIGIN}/api/factories`))).toMatchObject({
      email: 'ada@example.com',
    });
    expect(await auth.authenticateToken('forged', new Request(`${ORIGIN}/api/factories`))).toBeNull();
  });

  it('serves the public web config, clears the cookie on sign-out, and puts everyone in one organization', async () => {
    const auth = provider();
    const config = await auth.handleAuthRequest(new Request(`${ORIGIN}/auth/api/config`));
    expect(await config.json()).toEqual({ apiKey: 'web-key', authDomain: 'demo.firebaseapp.com', projectId: 'demo' });

    const signOut = await auth.handleAuthRequest(new Request(`${ORIGIN}/auth/api/sign-out`, { method: 'POST' }));
    expect(signOut.headers.get('Set-Cookie')).toContain(`${FIREBASE_SESSION_COOKIE}=; Path=/; Max-Age=0`);
    expect(auth.getClearSessionHeaders()['Set-Cookie']).toContain('Max-Age=0');

    expect((await auth.handleAuthRequest(new Request(`${ORIGIN}/auth/api/unknown`))).status).toBe(404);
    expect(await auth.ensureOrganization('anyone')).toBe(LOCAL_USER.organizationId);
    expect(await auth.isOrganizationAdmin(LOCAL_USER.organizationId, 'anyone')).toBe(true);
    expect(await auth.isOrganizationAdmin('other-org', 'anyone')).toBe(false);
  });

  it('marks the cookie Secure behind HTTPS', async () => {
    const auth = provider();
    const response = await auth.handleAuthRequest(
      new Request('https://mac.tailnet.ts.net/auth/api/session', {
        method: 'POST',
        headers: { Origin: 'https://mac.tailnet.ts.net', 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: 'ada@example.com' }),
      }),
    );
    expect(response.headers.get('Set-Cookie')).toContain('; Secure');
  });

  it('needs at least one allowed email', () => {
    expect(() =>
      createFirebaseAuthProvider({
        allowedEmails: [],
        webConfig: { apiKey: 'k', authDomain: 'd', projectId: 'p' },
        verifier: fakeVerifier(),
      }),
    ).toThrow(/at least one allowed email/);
  });
});
