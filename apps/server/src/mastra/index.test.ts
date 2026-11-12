import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as factoryModule from '@factory/server';

const factoryConfigs = vi.hoisted(() => [] as Array<ConstructorParameters<typeof factoryModule.MastraFactory>[0]>);
vi.mock('@factory/server', async importOriginal => {
  const actual = await importOriginal<typeof factoryModule>();
  class TrackedMastraFactory extends actual.MastraFactory {
    constructor(config: ConstructorParameters<typeof actual.MastraFactory>[0]) {
      super(config);
      factoryConfigs.push(config);
    }
  }
  return { ...actual, MastraFactory: TrackedMastraFactory };
});

/**
 * Smoke test for the platform-deployable entry (`src/mastra/index.ts`).
 *
 * Importing the module boots the real controller via top-level await and
 * constructs the server-owned Mastra. We assert the deployer-facing surface:
 * the module exports a `mastra` instance and that instance carries the web
 * `apiRoutes` (auth + `/web/*`) the deployer's generated Hono server mounts.
 *
 * Tests boot with MASTRACODE_AUTH_DISABLED=1 unless they state otherwise:
 * the factory has no default auth provider and refuses to boot without one.
 * The custom `/web/*` routes are always present.
 */
/** Boot the entry with Google sign-in (FACTORY_AUTH=google) the way `dev:local` runs it. */
function useGoogleAuth() {
  vi.stubEnv('MASTRACODE_AUTH_DISABLED', '');
  vi.stubEnv('FACTORY_AUTH', 'google');
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
  vi.stubEnv('FACTORY_AUTH_SECRET', 'a-session-secret-of-at-least-32-characters');
  vi.stubEnv('MASTRACODE_PUBLIC_URL', 'http://localhost:5874');
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('HOST', '127.0.0.1');
  // Set so the entry never writes the machine key under ~/.mastracode.
  vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
}

describe('platform entry (src/mastra/index.ts)', () => {
  // Every test in this file imports the real entry, and the entry reads its
  // auth and integration selection directly from the environment. Blank them
  // at file scope so a runner with real credentials exported can't flip the
  // entry into a different branch; each test states its own env on top of this.
  beforeEach(() => {
    for (const name of [
      'FACTORY_LOCAL_DEV_AUTH',
      'MASTRA_PLATFORM_SECRET_KEY',
      'MASTRA_PLATFORM_ACCESS_TOKEN',
      'MASTRA_CLOUD_ACCESS_TOKEN',
      'DATABASE_URL',
      'APP_DATABASE_URL',
      'REDIS_URL',
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'GITHUB_APP_SLUG',
      'GITHUB_APP_WEBHOOK_SECRET',
      'GITHUB_ACCESS_TOKEN',
      'GITHUB_ACCESS_TOKEN_ORG_ID',
      'GITLAB_ACCESS_TOKEN',
      'GITLAB_ACCESS_TOKEN_TYPE',
      'GITLAB_BASE_URL',
      'GITLAB_WEBHOOK_SECRET',
      'MASTRA_GITLAB_CONNECTION_ID',
      'SLACK_APP_SIGNING_SECRET',
      'MASTRACODE_DISPATCH_MAX_IN_FLIGHT',
      'FACTORY_BROWSER',
      'CLICKUP_API_TOKEN',
    ]) {
      vi.stubEnv(name, '');
    }
    vi.stubEnv('MASTRACODE_AUTH_DISABLED', '1');
    vi.stubEnv('MASTRA_PROJECT_ID', 'test-project');
    factoryConfigs.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('exports a booted Mastra with the web apiRoutes folded onto server config', { timeout: 60_000 }, async () => {
    const mod = await import('./index.js');

    expect(mod.mastra).toBeDefined();
    // The deployer imports this named export and generates its Hono server from it.
    expect(typeof mod.mastra.getServer).toBe('function');

    const server = mod.mastra.getServer();
    expect(server).toBeDefined();

    // The custom web surface must ride along on `server.apiRoutes` so the
    // deployer-generated server exposes it. At minimum the fs `/web/*` routes
    // are always assembled (github is fail-soft, auth routes are gated).
    const apiRoutes = server?.apiRoutes ?? [];
    const paths = apiRoutes.map(r => r.path);
    expect(paths.some(p => p.startsWith('/web/'))).toBe(true);
  });

  it(
    'always installs ClickUp, with no token in env, and starts its pollers with the intake routes they need',
    { timeout: 60_000 },
    async () => {
      // Each organization connects its own ClickUp token (ADR-0032): nothing in env decides whether
      // ClickUp is installed. A missing dependency (as once the intake routes for ClickUp's workers)
      // used to fail the whole boot.
      const mod = await import('./index.js');
      const installed = factoryConfigs[0]?.integrations?.map(integration => integration.id) ?? [];
      expect(installed).toContain('clickup');
      expect(factoryConfigs[0]?.retiredIntegrationEnv).toEqual({});
      expect(mod.mastra.getWorker('clickup-issue-reconcile')).toBeDefined();
      expect(mod.mastra.getWorker('clickup-conversations-issue-reconcile')).toBeDefined();
    },
  );

  it('hands a CLICKUP_API_TOKEN still in env only to the one-time move into the organization', { timeout: 60_000 }, async () => {
    vi.stubEnv('CLICKUP_API_TOKEN', ' pk_test_boot ');
    // The move checks the token's account; ClickUp is never called from a test.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith('https://api.clickup.com/') ? new Response('{}', { status: 401 }) : realFetch(input, init),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await import('./index.js');
      expect(factoryConfigs[0]?.retiredIntegrationEnv).toEqual({ CLICKUP_API_TOKEN: 'pk_test_boot' });
      expect(factoryConfigs[0]?.integrations?.map(integration => integration.id)).toContain('clickup');
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('uses the preferred installed boards without deployment-owned lifecycle handlers', async () => {
    const { factoryConfigVersion } = await import('./index.js');
    expect(factoryConfigVersion).toBe('mastracode-web-v1');
    expect(factoryConfigs[0]?.configVersion).toBe(factoryConfigVersion);
    expect(factoryConfigs[0]).not.toHaveProperty('rules');
    // Only the built-in Work and Review boards are installed.
    expect(factoryConfigs[0]?.boards).toBeUndefined();
    expect(factoryConfigs[0]?.includeDefaultBoards).toBeUndefined();
  });

  it('forwards the dispatcher concurrency environment setting to the factory', { timeout: 60_000 }, async () => {
    vi.stubEnv('MASTRACODE_DISPATCH_MAX_IN_FLIGHT', '7');
    await import('./index.js');

    expect(factoryConfigs).toHaveLength(1);
    expect(factoryConfigs[0]?.dispatcher).toEqual({ maxInFlight: 7 });
  });

  it('gives agent sessions a browser only when FACTORY_BROWSER is agent-browser', { timeout: 60_000 }, async () => {
    await import('./index.js');
    expect(factoryConfigs[0]?.browser).toBeUndefined();

    factoryConfigs.length = 0;
    vi.resetModules();
    vi.stubEnv('FACTORY_BROWSER', 'agent-browser');
    await import('./index.js');
    // `vi.resetModules()` reloads the entry's graph, so assert on the provider, not the class.
    expect(factoryConfigs[0]?.browser).toMatchObject({ provider: 'vercel-labs/agent-browser' });

    factoryConfigs.length = 0;
    vi.resetModules();
    vi.stubEnv('FACTORY_BROWSER', 'stagehand');
    await expect(import('./index.js')).rejects.toThrow('FACTORY_BROWSER must be unset or agent-browser');
  });

  it('installs GitHub rules that no longer re-triage a linked issue on its edits or comments', async () => {
    vi.stubEnv('GITHUB_APP_ID', '123');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'test-private-key');
    vi.stubEnv('GITHUB_APP_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_APP_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('GITHUB_APP_SLUG', 'factory-app');
    vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET', 'test-webhook-secret');
    await import('./index.js');
    const { GithubIntegration } = await import('@factory/integration-github');
    const github = factoryConfigs[0]?.integrations?.find(
      (integration): integration is InstanceType<typeof GithubIntegration> => integration instanceof GithubIntegration,
    );
    expect(github).toBeDefined();
    if (!github) throw new Error('Expected the configured GitHub integration');
    // Triage runs once, when a person moves the card into Triage (port of 3a769810f4): edits and
    // comments on the issue run no rule of their own; they only point the card's session at them.
    expect(github.rules.issueEdited).toBeNull();
    expect(github.rules.issueCommentCreated).toBeNull();
  });

  it('installs no GitHub rule overrides on whichever integration is installed', { timeout: 60_000 }, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The factory's integration signer needs a replica-stable secret; the
    // webhook secret is the first the entry falls back to.
    vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET', 'test-webhook-secret');

    // Platform credentials and no GITHUB_APP_* group: the factory installs the
    // Platform-backed integration itself, with its built-in rules.
    vi.stubEnv('MASTRA_PLATFORM_ACCESS_TOKEN', 'platform-token');
    await import('./index.js');
    expect(factoryConfigs[0]?.integrations?.some(integration => integration.id === 'github')).toBe(false);
    expect(factoryConfigs[0]?.platform?.github).toBeUndefined();

    vi.resetModules();
    factoryConfigs.length = 0;

    // A direct GITHUB_APP_* group supplies the integration itself, so
    // `platform.github` stays unset: set, it would warn on every boot that an
    // explicit integration takes precedence.
    vi.stubEnv('GITHUB_APP_ID', '123');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'test-private-key');
    vi.stubEnv('GITHUB_APP_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_APP_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('GITHUB_APP_SLUG', 'factory-app');
    await import('./index.js');
    expect(factoryConfigs[0]?.integrations?.some(integration => integration.id === 'github')).toBe(true);
    expect(factoryConfigs[0]?.platform?.github).toBeUndefined();
    expect(warn.mock.calls.flat().join('\n')).not.toContain("'github' config was provided");

    warn.mockRestore();
  });

  // Integration env groups are all-or-nothing: a partial set means the
  // integration stays un-wired, but boot must survive so the diagnostics
  // surface can report exactly which vars are missing.
  describe('integration env groups', () => {
    beforeEach(() => {
      for (const name of [
        'GITHUB_APP_ID',
        'GITHUB_APP_PRIVATE_KEY',
        'GITHUB_APP_CLIENT_ID',
        'GITHUB_APP_CLIENT_SECRET',
        'GITHUB_APP_SLUG',
        'GITHUB_APP_WEBHOOK_SECRET',
        'GITHUB_ACCESS_TOKEN',
        'GITHUB_ACCESS_TOKEN_ORG_ID',
        'GITLAB_ACCESS_TOKEN',
        'GITLAB_ACCESS_TOKEN_TYPE',
        'GITLAB_BASE_URL',
        'GITLAB_WEBHOOK_SECRET',
        'MASTRA_GITLAB_CONNECTION_ID',
        'SLACK_APP_SIGNING_SECRET',
      ]) {
        vi.stubEnv(name, '');
      }
      // The connect routes need an auth provider.
      useGoogleAuth();
      vi.resetModules();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it(
      'boots when the GitHub group is partially configured so diagnostics can report the missing setup',
      { timeout: 60_000 },
      async () => {
        vi.resetModules();
        // The test env may carry a full GitHub config — blank everything but the
        // app id to force the partial state.
        vi.stubEnv('GITHUB_APP_ID', '12345');
        vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
        vi.stubEnv('GITHUB_APP_CLIENT_ID', '');
        vi.stubEnv('GITHUB_APP_CLIENT_SECRET', '');
        vi.stubEnv('GITHUB_APP_SLUG', '');
        const mod = await import('./index.js');
        expect(mod.mastra).toBeDefined();
      },
    );

    it(
      'registers the direct GitHub App integration when the full group is configured',
      { timeout: 60_000 },
      async () => {
        vi.resetModules();
        // No platform identity in this env, so the only source of a GitHub
        // connection is the direct GITHUB_APP_* group wired in the entry.
        vi.stubEnv('MASTRA_PLATFORM_SECRET_KEY', '');
        vi.stubEnv('GITHUB_APP_ID', '12345');
        vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'test-private-key');
        vi.stubEnv('GITHUB_APP_CLIENT_ID', 'Iv1.client');
        vi.stubEnv('GITHUB_APP_CLIENT_SECRET', 'client-secret');
        vi.stubEnv('GITHUB_APP_SLUG', 'test-app');
        vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET', 'webhook-secret');
        const mod = await import('./index.js');
        const paths = mod.mastra.getServer()?.apiRoutes?.map(route => route.path) ?? [];
        // The connect route is registered only by the GithubIntegration, so its
        // presence proves the direct fallback wired the integration onto the factory.
        expect(paths).toContain('/auth/github/connect');
      },
    );

    // Boot verifies the token with `GET /user`; answer it locally so no test reaches GitHub.
    function stubGithubUser(): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ id: 4242, login: 'yura', type: 'User' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('registers GitHub without an App when only GITHUB_ACCESS_TOKEN is set', { timeout: 60_000 }, async () => {
      vi.resetModules();
      vi.stubEnv('MASTRA_PLATFORM_SECRET_KEY', '');
      vi.stubEnv('MASTRA_PLATFORM_ACCESS_TOKEN', '');
      vi.stubEnv('GITHUB_ACCESS_TOKEN', 'ghp_entry-secret');
      stubGithubUser();
      try {
        const mod = await import('./index.js');
        const integration = factoryConfigs[0]?.integrations?.find(candidate => candidate.id === 'github');
        expect(integration?.diagnostics()).toMatchObject({ appConfigured: false, fallbackTokenConfigured: true });
        expect(JSON.stringify(integration?.diagnostics())).not.toContain('ghp_entry-secret');
        expect(mod.mastra.getServer()?.apiRoutes?.map(route => route.path)).toContain('/auth/github/connect');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('runs the GitHub App group and the GITHUB_ACCESS_TOKEN fallback together', { timeout: 60_000 }, async () => {
      vi.resetModules();
      vi.stubEnv('MASTRA_PLATFORM_SECRET_KEY', '');
      vi.stubEnv('MASTRA_PLATFORM_ACCESS_TOKEN', '');
      vi.stubEnv('GITHUB_ACCESS_TOKEN', 'ghp_entry-secret');
      vi.stubEnv('GITHUB_APP_ID', '12345');
      vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'test-private-key');
      vi.stubEnv('GITHUB_APP_CLIENT_ID', 'Iv1.client');
      vi.stubEnv('GITHUB_APP_CLIENT_SECRET', 'client-secret');
      vi.stubEnv('GITHUB_APP_SLUG', 'test-app');
      vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET', 'webhook-secret');
      const fetchMock = stubGithubUser();
      try {
        await import('./index.js');
        const integration = factoryConfigs[0]?.integrations?.find(candidate => candidate.id === 'github');
        expect(integration?.diagnostics()).toMatchObject({
          appConfigured: true,
          slug: 'test-app',
          webhookSecretConfigured: true,
          fallbackTokenConfigured: true,
        });
        expect(JSON.stringify(integration?.diagnostics())).not.toContain('ghp_entry-secret');
        void fetchMock;
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it.each(['personal', 'group'] as const)(
      'registers direct GitLab with a %s access token',
      { timeout: 60_000 },
      async accessTokenType => {
        vi.resetModules();
        vi.stubEnv('MASTRA_PLATFORM_SECRET_KEY', '');
        vi.stubEnv('MASTRA_PLATFORM_ACCESS_TOKEN', '');
        vi.stubEnv('GITLAB_ACCESS_TOKEN', `glpat-${accessTokenType}-secret`);
        vi.stubEnv('GITLAB_ACCESS_TOKEN_TYPE', accessTokenType);
        vi.stubEnv('GITLAB_BASE_URL', 'https://gitlab.acme.test');
        await import('./index.js');

        const integration = factoryConfigs[0]?.integrations?.find(candidate => candidate.id === 'gitlab');
        expect(integration?.diagnostics()).toMatchObject({
          mode: 'direct',
          accessTokenType,
          endpointHost: 'gitlab.acme.test',
        });
        expect(JSON.stringify(integration?.diagnostics())).not.toContain(`glpat-${accessTokenType}-secret`);
      },
    );

  });

  describe('auth selection', () => {
    it('refuses to boot when no auth is configured', { timeout: 60_000 }, async () => {
      vi.stubEnv('MASTRACODE_AUTH_DISABLED', '');

      await expect(import('./index.js')).rejects.toThrow(
        /no auth provider configured.*FACTORY_AUTH=google.*MASTRACODE_AUTH_DISABLED=1/,
      );
    });

    it('passes null auth when MASTRACODE_AUTH_DISABLED=1', { timeout: 60_000 }, async () => {
      const mod = await import('./index.js');

      expect(factoryConfigs[0]?.auth).toBeNull();
      const paths = mod.mastra.getServer()?.apiRoutes?.map(route => route.path) ?? [];
      expect(paths).not.toContain('/auth/login');
    });

    it('uses Google sign-in on better-auth when FACTORY_AUTH=google', { timeout: 60_000 }, async () => {
      useGoogleAuth();
      await import('./index.js');

      expect(factoryConfigs[0]?.auth).toMatchObject({ name: 'better-auth' });
      // MCP clients sign in with OAuth on this server itself.
      expect(factoryConfigs[0]?.mcp).toEqual({
        authorizationServers: ['http://localhost:5874/auth/api'],
        resource: 'http://localhost:5874/web/factory',
      });
    });

    it('refuses the removed local dev auth by name', { timeout: 60_000 }, async () => {
      useGoogleAuth();
      vi.stubEnv('FACTORY_LOCAL_DEV_AUTH', '1');

      await expect(import('./index.js')).rejects.toThrow(/FACTORY_LOCAL_DEV_AUTH was removed/);
      expect(factoryConfigs).toHaveLength(0);
    });
  });
});
