import { createClient } from '@libsql/client';
import { LibsqlDialect } from '@libsql/kysely-libsql';
import { betterAuth } from 'better-auth';
import type { Auth, BetterAuthOptions } from 'better-auth';
import { makeSignature } from 'better-auth/crypto';
import { getMigrations } from 'better-auth/db/migration';

import { factoryBetterAuthOptions, MastraAuthBetterAuth } from './index';

/**
 * Tests only: the options Factory actually runs on (`factoryBetterAuthOptions`)
 * against a real in-memory libSQL database with better-auth's own migrations.
 * Google is the boundary: its ID-token check and profile lookup are replaced,
 * everything after (user/account rows, linking, sessions, organizations) is
 * better-auth.
 */

export const TEST_ORIGIN = 'http://localhost:4111';
const SECRET = 'test-secret-that-is-at-least-32-characters';

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export interface MemberRecord {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
}

export interface TestGoogleAuth {
  provider: MastraAuthBetterAuth;
  auth: Auth;
  /** Signs in through `POST /auth/api/sign-in/social` with a Google ID token; returns the session cookie. */
  signIn(profile: GoogleProfile): Promise<string>;
  /** A better-auth endpoint under `/auth/api` as the holder of `cookie`. */
  api(path: string, cookie: string, init?: { method?: string; body?: unknown }): Promise<Response>;
  members(): Promise<MemberRecord[]>;
}

export async function createTestGoogleAuth(): Promise<TestGoogleAuth> {
  const profiles = new Map<string, GoogleProfile>();
  const client = createClient({ url: ':memory:' });
  const base = factoryBetterAuthOptions({
    database: {
      dialect: new LibsqlDialect({ client } as ConstructorParameters<typeof LibsqlDialect>[0]),
      type: 'sqlite',
    },
    secret: SECRET,
    google: { clientId: 'google-client', clientSecret: 'google-secret' },
    publicUrl: TEST_ORIGIN,
  });
  // factoryBetterAuthOptions sets the Google provider as a plain object.
  const google = base.socialProviders?.google as { clientId: string; clientSecret: string; prompt: 'select_account' } | undefined;
  if (!google) throw new Error('factoryBetterAuthOptions has no Google provider');
  const options: BetterAuthOptions = {
    ...base,
    // better-auth turns its origin and callback-URL checks off under NODE_ENV=test; keep them on
    // as in production.
    advanced: { ...base.advanced, disableOriginCheck: false },
    socialProviders: {
      google: {
        ...google,
        verifyIdToken: async token => profiles.has(token),
        getUserInfo: async tokens => {
          const profile = profiles.get(tokens.idToken ?? '');
          if (!profile) return null;
          // Only the fields better-auth reads from Google's profile; the full type is Google's.
          return {
            user: { name: profile.name, email: profile.email, image: profile.picture, emailVerified: true },
            data: { ...profile, email_verified: true },
          } as never;
        },
      },
    },
  };
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const auth = betterAuth(options) as unknown as Auth;
  const provider = new MastraAuthBetterAuth({ auth });

  const api: TestGoogleAuth['api'] = (path, cookie, init = {}) =>
    provider.handleAuthRequest(
      new Request(`${TEST_ORIGIN}/auth/api${path}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: { cookie, origin: TEST_ORIGIN, ...(init.body ? { 'content-type': 'application/json' } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      }),
    );

  return {
    provider,
    auth,
    api,
    async signIn(profile) {
      const idToken = `id-token-${profile.sub}`;
      profiles.set(idToken, profile);
      const response = await provider.handleAuthRequest(
        new Request(`${TEST_ORIGIN}/auth/api/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: TEST_ORIGIN },
          body: JSON.stringify({ provider: 'google', idToken: { token: idToken } }),
        }),
      );
      if (response.status !== 200) {
        throw new Error(`Google sign-in for ${profile.email} answered ${response.status}: ${await response.text()}`);
      }
      const cookie = response.headers.getSetCookie().find(value => value.startsWith('better-auth.session_token='));
      if (!cookie) throw new Error(`Google sign-in for ${profile.email} set no session cookie`);
      return cookie.split(';')[0] ?? cookie;
    },
    async members() {
      const ctx = await auth.$context;
      return ctx.adapter.findMany<MemberRecord>({ model: 'member' });
    },
  };
}

/**
 * Tests only (e2e): signs a person in on a running Factory server's own auth database without
 * Google. Builds better-auth with the server's options on the same libSQL file, creates the user (or
 * reuses the row with that email) and a session, and returns the `Cookie` header value the server
 * accepts (`better-auth.session_token=<token>.<signature>`, signed with the server's
 * FACTORY_AUTH_SECRET). The server must have created its auth tables already (any request to
 * `/auth/me` does).
 */
export async function createTestSession(options: {
  /** The server's libSQL database (`file:<MASTRA_DB_PATH>`). */
  databaseUrl: string;
  /** The server's FACTORY_AUTH_SECRET. */
  secret: string;
  publicUrl: string;
  email: string;
  name: string;
}): Promise<string> {
  const client = createClient({ url: options.databaseUrl });
  try {
    const auth = betterAuth(
      factoryBetterAuthOptions({
        database: {
          dialect: new LibsqlDialect({ client } as ConstructorParameters<typeof LibsqlDialect>[0]),
          type: 'sqlite',
        },
        secret: options.secret,
        google: { clientId: 'e2e', clientSecret: 'e2e' },
        publicUrl: options.publicUrl,
      }),
    ) as unknown as Auth;
    const ctx = await auth.$context;
    const existing = await ctx.internalAdapter.findUserByEmail(options.email);
    const user =
      existing?.user ??
      (await ctx.internalAdapter.createUser(
        { email: options.email, name: options.name, emailVerified: true },
        { method: 'admin' },
      ));
    const session = await ctx.internalAdapter.createSession(user.id);
    const signed = `${session.token}.${await makeSignature(session.token, options.secret)}`;
    return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`;
  } finally {
    client.close();
  }
}
