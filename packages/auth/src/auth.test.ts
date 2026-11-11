import { MASTRA_MESSAGE_AUTHOR_KEY, RequestContext } from '@mastra/core/request-context';
import type { IMastraAuthProvider } from '@mastra/core/server';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FACTORY_INTERACTIVE_KEY,
  createFactoryInteractiveMarker,
  ensureFactoryAuthUser,
  factoryUserOrgId,
  getFactoryAuthOrgId,
  getFactoryAuthUser,
  getFactoryAuthUserId,
  mountFactoryAuth,
  factoryAuthTenant,
} from './auth.ts';

// A fake SSO provider so the tests exercise the gating/routing logic in this
// module without a real identity provider. `authenticateToken`'s behavior is
// swapped per-test via `mockAuthenticate`.
const mockAuthenticate = vi.fn();
const mockGetLoginUrl = vi.fn((_redirectUri: string, _state: string) => 'https://idp.example/login');
const mockHandleCallback = vi.fn(async () => ({ user: { email: 'a@b.com' }, cookies: ['idp_session=sealed; Path=/'] }));
const mockGetLogoutUrl = vi.fn(async () => 'https://idp.example/logout');
const mockGetClearSessionHeaders = vi.fn(() => ({ 'Set-Cookie': 'idp_session=; Path=/; HttpOnly; Max-Age=0' }));
// Personal-org bootstrap (IOrganizationsProvider): the fake models "no org → org_new".
const mockEnsureOrganization = vi.fn(async (_userId: string) => 'org_new');
const mockIsOrganizationAdmin = vi.fn(async () => false);
const mockConsumePendingResponseHeaders = vi.fn((_req: Request): Record<string, string> | undefined => undefined);

class FakeSsoProvider {
  name = 'sso-fake';
  getLoginUrl = mockGetLoginUrl;
  handleCallback = mockHandleCallback;
  authenticateToken = mockAuthenticate;
  authorizeUser = async () => true;
  getLogoutUrl = mockGetLogoutUrl;
  getClearSessionHeaders = mockGetClearSessionHeaders;
  ensureOrganization = mockEnsureOrganization;
  isOrganizationAdmin = mockIsOrganizationAdmin;
  consumePendingResponseHeaders = mockConsumePendingResponseHeaders;
}

let providerEnabled = false;

function enableProvider() {
  providerEnabled = true;
}

/** The provider `mountFactoryAuth` mounts in a test: the fake when enabled, none otherwise. */
function activeProvider(): IMastraAuthProvider | undefined {
  return providerEnabled ? (new FakeSsoProvider() as unknown as IMastraAuthProvider) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  providerEnabled = false;
  // Restore default mock behavior after clearAllMocks wipes it.
  mockGetLoginUrl.mockReturnValue('https://idp.example/login');
  mockHandleCallback.mockResolvedValue({ user: { email: 'a@b.com' }, cookies: ['idp_session=sealed; Path=/'] });
  mockGetLogoutUrl.mockResolvedValue('https://idp.example/logout');
  mockGetClearSessionHeaders.mockReturnValue({ 'Set-Cookie': 'idp_session=; Path=/; HttpOnly; Max-Age=0' });
  mockEnsureOrganization.mockResolvedValue('org_new');
});

/** Build a gated app where the protected catch-all returns 200 "ok". */
function buildApp() {
  const app = new Hono();
  const enabled = mountFactoryAuth(app, { provider: activeProvider() });
  app.get('*', c => c.text('ok'));
  app.post('*', c => c.text('ok'));
  return { app, enabled };
}

describe('mountFactoryAuth provider selection', () => {
  it('leaves auth disabled when no provider is passed', () => {
    expect(mountFactoryAuth(new Hono())).toBe(false);
  });

  it('enables auth when a provider is passed', () => {
    expect(mountFactoryAuth(new Hono(), { provider: new FakeSsoProvider() as unknown as IMastraAuthProvider })).toBe(
      true,
    );
  });
});

describe('ensureFactoryAuthUser on ungated (requiresAuth: false) routes', () => {
  async function buildUngatedApp() {
    const provider = new FakeSsoProvider() as unknown as IMastraAuthProvider;
    const app = new Hono();
    app.get('/web/thing', async c => {
      const user = await ensureFactoryAuthUser(provider, c);
      return user ? c.json({ ok: true }) : c.json({ error: 'unauthorized' }, 401);
    });
    return app;
  }

  it('forwards a renewed session cookie on the handler response', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user_1', email: 'a@b.com', organizationId: 'org_1' });
    mockConsumePendingResponseHeaders.mockReturnValue({ 'Set-Cookie': 'idp-session=v2; Path=/; Max-Age=1209600' });
    const app = await buildUngatedApp();

    const res = await app.request('/web/thing', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBe('idp-session=v2; Path=/; Max-Age=1209600');
  });

  it('still authenticates when forwarding headers throws', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user_1', email: 'a@b.com', organizationId: 'org_1' });
    mockConsumePendingResponseHeaders.mockImplementation(() => {
      throw new Error('boom');
    });
    const app = await buildUngatedApp();

    const res = await app.request('/web/thing', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
  });
});

describe('mountFactoryAuth (disabled)', () => {
  it('is a no-op and leaves routes ungated', async () => {
    const { app, enabled } = buildApp();
    expect(enabled).toBe(false);

    const res = await app.request('/api/anything', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('mountFactoryAuth gate (enabled)', () => {
  beforeEach(enableProvider);

  it('forwards a renewed session cookie from the provider on authenticated requests', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user_1', email: 'a@b.com', organizationId: 'org_1' });
    mockConsumePendingResponseHeaders.mockReturnValue({ 'Set-Cookie': 'idp-session=v2; Path=/; Max-Age=1209600' });
    const { app } = buildApp();

    const res = await app.request('/api/agents', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBe('idp-session=v2; Path=/; Max-Age=1209600');
    expect(mockConsumePendingResponseHeaders).toHaveBeenCalledWith(expect.any(Request));
  });

  it('still serves authenticated requests when forwarding headers throws', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user_1', email: 'a@b.com', organizationId: 'org_1' });
    mockConsumePendingResponseHeaders.mockImplementation(() => {
      throw new Error('boom');
    });
    const { app } = buildApp();

    const res = await app.request('/api/agents', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
  });

  it('redirects unauthenticated HTML navigation to /signin with returnTo', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const res = await app.request('/some/page', { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('/signin?returnTo=')).toBe(true);
    expect(decodeURIComponent(location.split('returnTo=')[1]!)).toBe('/some/page');
  });

  it('lets unauthenticated HTML navigation reach /signin so the SPA can render the sign-in page', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const res = await app.request('/signin?returnTo=%2Fchat', { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('forwards the platform deploy-auth /login landing to /signin with its query intact', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const res = await app.request('/login?error=access_denied&error_description=You%20do%20not%20have%20access', {
      headers: { Accept: 'text/html' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      '/signin?error=access_denied&error_description=You%20do%20not%20have%20access',
    );
  });

  it('lets unauthenticated requests fetch static assets and metadata needed by the sign-in page', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    for (const path of [
      '/assets/app.js',
      '/manifest.webmanifest',
      '/mastra.svg',
      '/pwa-192.png',
      '/pwa-512.png',
      '/apple-touch-icon.png',
      '/favicon-session-initializing.svg',
      '/favicon-session-working.svg',
      '/favicon-session-awaiting.svg',
      '/favicon-session-error.svg',
    ]) {
      const res = await app.request(path, { headers: { Accept: '*/*' } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    }
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('keeps auth on other /favicon-session- paths and on non-GET favicon requests', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const unknownAsset = await app.request('/favicon-session-admin/config.json', { headers: { Accept: '*/*' } });
    expect(unknownAsset.status).toBe(401);

    const written = await app.request('/favicon-session-working.svg', {
      method: 'POST',
      headers: { Accept: '*/*' },
    });
    expect(written.status).toBe(401);
  });

  it('returns 401 JSON for unauthenticated /api requests', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const res = await app.request('/web/projects', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('lets unauthenticated GitHub webhook deliveries reach the route handler', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const res = await app.request('/web/github/webhook', { method: 'POST', headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('lets unauthenticated GitLab webhook deliveries reach the token-verifying route handler', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const res = await app.request('/web/gitlab/webhook', { method: 'POST', headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it.each(['/web/github/webhook', '/web/gitlab/webhook'])(
    'does not bypass auth for non-POST webhook request %s',
    async path => {
      mockAuthenticate.mockResolvedValue(null);
      const { app } = buildApp();

      const res = await app.request(path, { method: 'GET', headers: { Accept: 'application/json' } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    },
  );

  it('lets unauthenticated channel webhook deliveries reach the route handler', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const res = await app.request('/api/agent-controllers/mastra-code/channels/slack/webhook', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('passes channel webhooks through for any controller id', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const res = await app.request('/api/agent-controllers/some-other-controller/channels/slack/webhook', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('does not extend the webhook pass to platforms that are not allowlisted', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    // The pass exists because the Slack adapter verifies request signatures. A
    // platform that has not been vetted for that must not inherit it.
    const res = await app.request('/api/agent-controllers/mastra-code/channels/discord/webhook', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('does not bypass auth for non-POST channel webhook requests', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const res = await app.request('/api/agent-controllers/mastra-code/channels/slack/webhook', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('does not bypass auth for other agent-controller API paths', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const res = await app.request('/api/agent-controllers/mastra-code/sessions', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 for unauthenticated non-HTML navigation (XHR)', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();

    const res = await app.request('/some/page', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(401);
  });

  it('passes through when the provider authenticates', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user_ok', email: 'user@example.com', name: 'User' });
    const { app } = buildApp();

    const res = await app.request('/web/projects', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('treats a provider result without a stable user id as unauthenticated', async () => {
    // Downstream tenancy scopes rows by user id; a session that cannot yield
    // one must not pass the gate.
    mockAuthenticate.mockResolvedValue({ email: 'user@example.com', name: 'User' });
    const { app } = buildApp();

    const res = await app.request('/web/projects', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(401);
  });

  it('treats a thrown provider error as unauthenticated', async () => {
    mockAuthenticate.mockRejectedValue(new Error('boom'));
    const { app } = buildApp();

    const res = await app.request('/web/projects', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(401);
  });

  it('stashes flat-provider avatar URLs on the context for downstream routes', async () => {
    mockAuthenticate.mockResolvedValue({
      id: 'user_123',
      email: 'user@example.com',
      name: 'User',
      avatarUrl: 'https://avatars.example/user.png',
    });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => {
      const user = getFactoryAuthUser(c);
      return c.json({ userId: getFactoryAuthUserId(user), avatarUrl: user?.avatarUrl });
    });

    const res = await app.request('/web/whoami', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'user_123', avatarUrl: 'https://avatars.example/user.png' });
  });

  it('stashes session-provider avatar URLs on the context for downstream routes', async () => {
    mockAuthenticate.mockResolvedValue({
      session: { activeOrganizationId: 'org_123' },
      user: {
        id: 'user_123',
        email: 'user@example.com',
        name: 'User',
        avatarUrl: 'https://avatars.example/user.png',
      },
    });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => {
      const user = getFactoryAuthUser(c);
      return c.json({
        userId: getFactoryAuthUserId(user),
        organizationId: getFactoryAuthOrgId(user),
        avatarUrl: user?.avatarUrl,
      });
    });

    const res = await app.request('/web/whoami', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: 'user_123',
      organizationId: 'org_123',
      avatarUrl: 'https://avatars.example/user.png',
    });
  });

  it("reads a better-auth user's picture from its image field", async () => {
    mockAuthenticate.mockResolvedValue({
      session: { activeOrganizationId: 'org_123' },
      user: { id: 'user_123', email: 'user@example.com', name: 'User', image: 'https://lh3.example/photo.png' },
    });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => c.json({ avatarUrl: getFactoryAuthUser(c)?.avatarUrl }));

    const res = await app.request('/web/whoami', { headers: { Accept: 'application/json' } });
    expect(await res.json()).toEqual({ avatarUrl: 'https://lh3.example/photo.png' });
  });

  it('names the signed-in user as the author of messages sent on this request', async () => {
    mockAuthenticate.mockResolvedValue({
      id: 'user_123',
      email: 'user@example.com',
      avatarUrl: 'https://avatars.example/user.png',
    });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestContext' as never, new RequestContext() as never);
      await next();
    });
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c =>
      c.json((c.get('requestContext' as never) as RequestContext).get(MASTRA_MESSAGE_AUTHOR_KEY)),
    );

    const res = await app.request('/web/whoami', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'user_123',
      name: 'user@example.com',
      avatarUrl: 'https://avatars.example/user.png',
    });
  });

  it('marks requests a signed-in person makes as interactive, and signature-verified webhooks as not', async () => {
    mockAuthenticate.mockImplementation(async (token: string | undefined) =>
      token ? { id: 'user_123', organizationId: 'org_123' } : null,
    );
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestContext' as never, new RequestContext() as never);
      await next();
    });
    mountFactoryAuth(app, { provider: activeProvider() });
    const interactive = (c: { get(key: never): unknown }) =>
      (c.get('requestContext' as never) as RequestContext).get(FACTORY_INTERACTIVE_KEY) === true;
    app.get('/web/whoami', c => c.json({ interactive: interactive(c) }));
    app.post('/web/github/webhook', c => c.json({ interactive: interactive(c) }));

    const signedIn = await app.request('/web/whoami', {
      headers: { Accept: 'application/json', Authorization: 'Bearer cli-token' },
    });
    expect(await signedIn.json()).toEqual({ interactive: true });

    const webhook = await app.request('/web/github/webhook', { method: 'POST' });
    expect(await webhook.json()).toEqual({ interactive: false });
  });

  it('marks every request interactive when auth is disabled', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestContext' as never, new RequestContext() as never);
      await next();
    });
    app.use('*', createFactoryInteractiveMarker());
    app.get('/web/whoami', c =>
      c.json({
        interactive: (c.get('requestContext' as never) as RequestContext).get(FACTORY_INTERACTIVE_KEY) === true,
      }),
    );
    const res = await app.request('/web/whoami');
    expect(await res.json()).toEqual({ interactive: true });
  });

  it('selects a requested bearer organization proven by provider memberships', async () => {
    mockAuthenticate.mockResolvedValue({
      id: 'user_123',
      memberships: [
        { id: 'membership_1', organizationId: 'org_1' },
        { id: 'membership_2', organizationId: 'org_2' },
      ],
    });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => c.json(factoryAuthTenant(c)));

    const res = await app.request('/web/whoami', {
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer cli-token',
        'X-Mastra-Organization-Id': 'org_2',
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: 'org_2', userId: 'user_123' });
    expect(mockEnsureOrganization).not.toHaveBeenCalled();
  });

  it('selects a requested bearer organization proven by Studio membership ids', async () => {
    mockAuthenticate.mockResolvedValue({
      id: 'user_123',
      organizationId: 'org_1',
      memberOrgIds: ['org_1', 'org_2'],
    });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => c.json(factoryAuthTenant(c)));

    const res = await app.request('/web/whoami', {
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer cli-token',
        'X-Mastra-Organization-Id': 'org_2',
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: 'org_2', userId: 'user_123' });
    expect(mockEnsureOrganization).not.toHaveBeenCalled();
  });

  const jwtWithOrg = (orgId: string) =>
    `h.${Buffer.from(JSON.stringify({ sub: 'user_123', org_id: orgId })).toString('base64url')}.s`;

  it('selects the bearer token org_id claim when the user is a member', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user_123', organizationId: 'org_1', memberOrgIds: ['org_1', 'org_2'] });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => c.json(factoryAuthTenant(c)));

    const res = await app.request('/web/whoami', {
      headers: { Accept: 'application/json', Authorization: `Bearer ${jwtWithOrg('org_2')}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: 'org_2', userId: 'user_123' });
  });

  it('rejects a bearer token org_id claim the user is not a member of instead of using the default org', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user_123', organizationId: 'org_1', memberOrgIds: ['org_1'] });
    const { app } = buildApp();

    const res = await app.request('/web/projects', {
      headers: { Accept: 'application/json', Authorization: `Bearer ${jwtWithOrg('org_other')}` },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'organization_forbidden' });
    expect(mockEnsureOrganization).not.toHaveBeenCalled();
  });

  it('lets an explicit organization header win over the token org_id claim', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user_123', organizationId: 'org_1', memberOrgIds: ['org_1', 'org_2'] });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => c.json(factoryAuthTenant(c)));

    const res = await app.request('/web/whoami', {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${jwtWithOrg('org_2')}`,
        'X-Mastra-Organization-Id': 'org_1',
      },
    });

    expect(await res.json()).toEqual({ orgId: 'org_1', userId: 'user_123' });
  });

  it('rejects a requested bearer organization not present in provider memberships', async () => {
    mockAuthenticate.mockResolvedValue({
      id: 'user_123',
      memberships: [{ id: 'membership_1', organizationId: 'org_1' }],
    });
    const { app } = buildApp();

    const res = await app.request('/web/projects', {
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer cli-token',
        'X-Mastra-Organization-Id': 'org_other',
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'organization_forbidden' });
    expect(mockEnsureOrganization).not.toHaveBeenCalled();
  });

  it('does not let an organization header change cookie-authenticated tenancy', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user_123', organizationId: 'org_cookie' });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => c.json(factoryAuthTenant(c)));

    const res = await app.request('/web/whoami', {
      headers: { Accept: 'application/json', 'X-Mastra-Organization-Id': 'org_other' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: 'org_cookie', userId: 'user_123' });
  });
});

describe('mountFactoryAuth /auth routes (enabled)', () => {
  beforeEach(enableProvider);

  it('redirects /auth/login to the provider login URL', async () => {
    const { app } = buildApp();
    const res = await app.request('/auth/login?returnTo=/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://idp.example/login');
    expect(mockGetLoginUrl).toHaveBeenCalledOnce();
  });

  it('encodes returnTo into pipe-format state', async () => {
    const { app } = buildApp();
    await app.request('/auth/login?returnTo=/dashboard');
    const state = mockGetLoginUrl.mock.calls[0]![1] as string;
    const pipeIndex = state.indexOf('|');
    expect(pipeIndex).toBeGreaterThan(0);
    expect(decodeURIComponent(state.slice(pipeIndex + 1))).toBe('/dashboard');
  });

  it('stashes returnTo in a short-lived cookie across the login round-trip', async () => {
    const { app } = buildApp();
    const res = await app.request('/auth/login?returnTo=/dashboard');
    expect(res.headers.get('set-cookie')).toContain('mastra_factory_return_to=%2Fdashboard');
  });

  it('rejects external returnTo in login (open-redirect protection)', async () => {
    const { app } = buildApp();
    await app.request('/auth/login?returnTo=https://evil.com');
    // The encoded state must carry the sanitized "/" path, not the external URL.
    const state = mockGetLoginUrl.mock.calls[0]![1] as string;
    expect(decodeURIComponent(state.split('|')[1]!)).toBe('/');
  });

  it('rejects protocol-relative returnTo', async () => {
    const { app } = buildApp();
    await app.request('/auth/login?returnTo=//evil.com');
    const state = mockGetLoginUrl.mock.calls[0]![1] as string;
    expect(decodeURIComponent(state.split('|')[1]!)).toBe('/');
  });

  it('handles the callback, applies cookies, and redirects to decoded returnTo', async () => {
    const { app } = buildApp();
    const state = `uuid-1|${encodeURIComponent('/dashboard')}`;
    const res = await app.request(`/auth/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
    expect(res.headers.get('set-cookie')).toContain('idp_session=sealed');
    // Hono percent-decodes query values, so the provider sees the raw pipe form.
    expect(mockHandleCallback).toHaveBeenCalledWith('abc', 'uuid-1|/dashboard');
  });

  it('falls back to the returnTo cookie when the callback has no state', async () => {
    const { app } = buildApp();
    const res = await app.request('/auth/callback?code=abc', {
      headers: { Cookie: 'mastra_factory_return_to=%2Fconnect%2Fslack%3Fstate%3Dsigned' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/connect/slack?state=signed');
    // The stash cookie must be cleared once consumed.
    expect(res.headers.get('set-cookie')).toContain('mastra_factory_return_to=;');
  });

  it('rejects an external URL smuggled into the returnTo cookie', async () => {
    const { app } = buildApp();
    const res = await app.request('/auth/callback?code=abc', {
      headers: { Cookie: `mastra_factory_return_to=${encodeURIComponent('https://evil.com')}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('redirects callback back to login when code is missing', async () => {
    const { app } = buildApp();
    const res = await app.request('/auth/callback');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/login');
    expect(mockHandleCallback).not.toHaveBeenCalled();
  });

  it('surfaces an IdP denial on /signin, keeping the intended destination for a retry', async () => {
    const { app } = buildApp();
    const state = `uuid-1|${encodeURIComponent('/dashboard')}`;
    const res = await app.request(
      `/auth/callback?error=access_denied&error_description=You%20do%20not%20have%20access&state=${state}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      '/signin?error=access_denied&error_description=You+do+not+have+access&returnTo=%2Fdashboard',
    );
    expect(mockHandleCallback).not.toHaveBeenCalled();
  });

  it('caps the denial values so a hostile IdP response cannot inflate the /signin URL', async () => {
    const { app } = buildApp();
    const res = await app.request(`/auth/callback?error=${'e'.repeat(200)}&error_description=${'d'.repeat(1000)}`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '', 'https://app.example');
    expect(location.searchParams.get('error')).toBe('e'.repeat(64));
    expect(location.searchParams.get('error_description')).toBe('d'.repeat(256));
  });

  it('redirects callback back to login when the code exchange fails', async () => {
    mockHandleCallback.mockRejectedValue(new Error('expired code'));
    const { app } = buildApp();
    const state = `uuid-1|${encodeURIComponent('/dashboard')}`;
    const res = await app.request(`/auth/callback?code=bad&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/login');
  });

  it('logout clears the session cookie and redirects to the provider logout URL', async () => {
    const { app } = buildApp();
    const res = await app.request('/auth/logout');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://idp.example/logout');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('logout still clears the session cookie when the provider has no logout URL', async () => {
    mockGetLogoutUrl.mockRejectedValue(new Error('no session'));
    const { app } = buildApp();
    const res = await app.request('/auth/logout');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('/auth/me reports authenticated:false when no session', async () => {
    mockAuthenticate.mockResolvedValue(null);
    const { app } = buildApp();
    const res = await app.request('/auth/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false, user: null, provider: 'sso-fake' });
  });

  it('/auth/me reports the user when authenticated', async () => {
    mockAuthenticate.mockResolvedValue({
      id: 'user_me',
      email: 'user@example.com',
      name: 'User',
      avatarUrl: 'https://avatars.example/user.png',
    });
    const { app } = buildApp();
    const res = await app.request('/auth/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: true,
      telemetryEnabled: false,
      // No-org accounts are bootstrapped into a personal org during /auth/me.
      user: {
        userId: 'user_me',
        email: 'user@example.com',
        name: 'User',
        avatarUrl: 'https://avatars.example/user.png',
        organizationId: 'org_new',
      },
      provider: 'sso-fake',
    });
    expect(mockEnsureOrganization).toHaveBeenCalledWith('user_me');
  });

  it('/auth/me surfaces the organization id and stable user id to the SPA', async () => {
    mockAuthenticate.mockResolvedValue({
      id: 'user_1',
      email: 'user@example.com',
      name: 'User',
      organizationId: 'org_a',
    });
    const { app } = buildApp();
    const res = await app.request('/auth/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: true,
      telemetryEnabled: false,
      user: { email: 'user@example.com', name: 'User', organizationId: 'org_a', userId: 'user_1' },
      provider: 'sso-fake',
    });
    expect(mockEnsureOrganization).not.toHaveBeenCalled();
  });
});

describe('org-tenant identity', () => {
  beforeEach(enableProvider);

  it('getFactoryAuthOrgId reads the organization id from the user shape', () => {
    expect(getFactoryAuthOrgId({ id: 'user_1', organizationId: 'org_a' })).toBe('org_a');
    expect(getFactoryAuthOrgId({ id: 'user_1' })).toBeUndefined();
    expect(getFactoryAuthOrgId(undefined)).toBeUndefined();
  });

  it('factoryUserOrgId keys personal users on their own rung, never the shared local scope', () => {
    expect(factoryUserOrgId({ id: 'user_1', organizationId: 'org_a' })).toBe('org_a');
    expect(factoryUserOrgId({ id: 'user_2' })).toBe('user:user_2');
    // No user at all means no per-user rung; callers fall back to `local`.
    expect(factoryUserOrgId(undefined)).toBeUndefined();
    expect(factoryUserOrgId({ email: 'no-id@example.com' })).toBeUndefined();
  });

  it('gate stashes organizationId and factoryAuthTenant returns { orgId, userId }', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user_1', organizationId: 'org_a', email: 'u@e.com' });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => c.json(factoryAuthTenant(c) ?? { tenant: null }));

    const res = await app.request('/web/whoami', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: 'org_a', userId: 'user_1' });
    // The user already has an org — no bootstrap round-trip.
    expect(mockEnsureOrganization).not.toHaveBeenCalled();
  });

  it('gate bootstraps a no-org user so factoryAuthTenant yields the new org', async () => {
    mockAuthenticate.mockResolvedValue({ id: 'user_boot', email: 'boot@example.com' });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => c.json(factoryAuthTenant(c) ?? { tenant: null }));

    const res = await app.request('/web/whoami', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: 'org_new', userId: 'user_boot' });
    expect(mockEnsureOrganization).toHaveBeenCalledWith('user_boot');
  });

  it('factoryAuthTenant omits orgId for personal (no-org) users but keeps userId', async () => {
    // Bootstrap is best-effort: when org creation fails, the user genuinely
    // stays no-org, so the tenant must still expose a userId without an orgId.
    mockEnsureOrganization.mockResolvedValue(undefined as unknown as string);
    mockAuthenticate.mockResolvedValue({ id: 'user_solo', email: 'solo@e.com' });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => {
      const tenant = factoryAuthTenant(c);
      return c.json({ orgId: tenant?.orgId ?? null, userId: tenant?.userId ?? null });
    });

    const res = await app.request('/web/whoami', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: null, userId: 'user_solo' });
  });

  it('a thrown bootstrap error leaves the user no-org instead of failing the request', async () => {
    mockEnsureOrganization.mockRejectedValue(new Error('idp unavailable'));
    mockAuthenticate.mockResolvedValue({ id: 'user_err', email: 'err@e.com' });
    const app = new Hono();
    mountFactoryAuth(app, { provider: activeProvider() });
    app.get('/web/whoami', c => {
      const tenant = factoryAuthTenant(c);
      return c.json({ orgId: tenant?.orgId ?? null, userId: tenant?.userId ?? null });
    });

    const res = await app.request('/web/whoami', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: null, userId: 'user_err' });
  });
});
