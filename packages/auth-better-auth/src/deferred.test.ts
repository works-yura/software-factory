import { betterAuth } from 'better-auth';
import type { Auth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MastraAuthBetterAuth } from './index';

/**
 * Deferred instance mode: the provider builds its own `betterAuth()` in
 * `init()` on the host database and owns schema migrations (once-per-process
 * latch, retry on failure). Migrations are mocked here — real migration
 * behavior is exercised against a real database in the host's smoke tests.
 */

const { runMigrations } = vi.hoisted(() => ({ runMigrations: vi.fn(async () => {}) }));

vi.mock('better-auth/db/migration', () => ({
  getMigrations: vi.fn(async () => ({ runMigrations })),
}));

const SECRET = 'test-secret-that-is-at-least-32-chars';
const GOOGLE = { clientId: 'google-client', clientSecret: 'google-secret' };

/** Passthrough database handle: the provider forwards `database` to betterAuth as-is. */
const memoryDb = () => ({
  database: memoryAdapter({
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
    // The MCP authorization server (oauthProvider + jwt).
    jwks: [],
    oauthClient: [],
    oauthRefreshToken: [],
    oauthAccessToken: [],
    oauthConsent: [],
    oauthResource: [],
    oauthClientResource: [],
  }),
});

type ProviderInternals = {
  auth: {
    options: {
      trustedOrigins?: string[];
      basePath?: string;
      emailAndPassword?: { enabled?: boolean };
      socialProviders?: { google?: { clientId?: string; prompt?: string } };
    };
  };
};

beforeEach(() => {
  runMigrations.mockReset();
  runMigrations.mockResolvedValue(undefined);
});

describe('deferred instance mode', () => {
  it('requires auth or secret at construction', () => {
    expect(() => new MastraAuthBetterAuth({} as never)).toThrow(/Better Auth instance is required/);
  });

  it('requires the Google client when it builds its own instance', () => {
    expect(() => new MastraAuthBetterAuth({ secret: SECRET })).toThrow(/Google client/);
  });

  it('accessing the instance before init() throws', () => {
    const provider = new MastraAuthBetterAuth({ secret: SECRET, google: GOOGLE });
    expect(() => (provider as unknown as ProviderInternals).auth).toThrow(/not initialized/);
  });

  it('init() fails fast without a database', async () => {
    const provider = new MastraAuthBetterAuth({ secret: SECRET, google: GOOGLE });
    await expect(provider.init({ publicUrl: 'https://factory.acme.com' })).rejects.toThrow(/database/);
  });

  it('init() builds a provider-owned instance under /auth/api and trusts host origins', async () => {
    // SameSite=None only lets the browser send the cookie — better-auth still
    // rejects requests from origins outside trustedOrigins, so cross-origin
    // SPA deploys must have their origins forwarded.
    const provider = new MastraAuthBetterAuth({ secret: SECRET, google: GOOGLE });
    await provider.init({
      database: memoryDb(),
      publicUrl: 'https://api.acme.com',
      allowedOrigins: ['https://app.acme.com'],
    });

    const auth = (provider as unknown as ProviderInternals).auth;
    expect(auth).toBeDefined();
    expect(auth.options.basePath).toBe('/auth/api');
    expect(auth.options.trustedOrigins).toEqual(['https://app.acme.com']);
    // Google is the only way in.
    expect(auth.options.emailAndPassword?.enabled).toBe(false);
    expect(auth.options.socialProviders?.google).toMatchObject({ clientId: 'google-client', prompt: 'select_account' });
  });

  it('handleAuthRequest 503s while migrations fail, then retries and recovers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runMigrations.mockRejectedValueOnce(new Error('database locked'));
    const provider = new MastraAuthBetterAuth({ secret: SECRET, google: GOOGLE });
    await provider.init({ database: memoryDb(), publicUrl: 'http://localhost:3000' });

    const first = await provider.handleAuthRequest(new Request('http://localhost:3000/auth/api/get-session'));
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: 'auth_unavailable' });

    const second = await provider.handleAuthRequest(new Request('http://localhost:3000/auth/api/get-session'));
    expect(second.status).not.toBe(503);
    expect(runMigrations).toHaveBeenCalledTimes(2);

    // The once-per-process latch holds after success: no more migration runs.
    await provider.handleAuthRequest(new Request('http://localhost:3000/auth/api/get-session'));
    expect(runMigrations).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('organization lookups run the migrations first', async () => {
    const provider = new MastraAuthBetterAuth({ secret: SECRET, google: GOOGLE });
    await provider.init({ database: memoryDb(), publicUrl: 'http://localhost:3000' });

    await expect(provider.isOrganizationAdmin('org_1', 'user_1')).resolves.toBe(false);

    expect(runMigrations).toHaveBeenCalledOnce();
  });

  it('organization lookups fail loudly when the migrations fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runMigrations.mockRejectedValueOnce(new Error('database locked'));
    const provider = new MastraAuthBetterAuth({ secret: SECRET, google: GOOGLE });
    await provider.init({ database: memoryDb(), publicUrl: 'http://localhost:3000' });

    await expect(provider.isOrganizationAdmin('org_1', 'user_1')).rejects.toThrow('database locked');
    warn.mockRestore();
  });

  it('bring-your-own instances never trigger provider-owned migrations', async () => {
    const auth = betterAuth({
      baseURL: 'http://localhost:3000',
      secret: SECRET,
      basePath: '/auth/api',
      database: memoryDb().database,
    }) as unknown as Auth;
    const provider = new MastraAuthBetterAuth({ auth });
    await provider.init({});

    await provider.handleAuthRequest(new Request('http://localhost:3000/auth/api/get-session'));
    expect(runMigrations).not.toHaveBeenCalled();
  });
});
