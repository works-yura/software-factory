import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isFactorySandbox } from '@mastra/core/workspace';
import type { FactorySandboxContext } from '@mastra/core/workspace';
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
 * Sandbox selection lives inline in the entry, which hands the factory one
 * host `FactorySandbox` chosen at boot, because `src/mastra/index.ts` is
 * copied verbatim into the create-factory template (scripts/sync-template.mjs)
 * — the entry must stay a single self-contained file. These tests boot the
 * real entry and create session sandboxes from that host object directly.
 *
 * The only provider is the local one; platform credentials are integration
 * credentials and never select a sandbox.
 */
describe('entry host sandbox (src/mastra/index.ts)', () => {
  beforeEach(() => {
    for (const name of [
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
      'SLACK_APP_SIGNING_SECRET',
      'MASTRACODE_DISPATCH_MAX_IN_FLIGHT',
      'FACTORY_SANDBOX_PROVIDER',
      'FACTORY_LOCAL_DEV_AUTH',
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

  /**
   * Boots the entry and returns a session-sandbox constructor backed by the
   * host `FactorySandbox` it configured, called the way factory calls it:
   * with the session context and the provider's default (empty) settings.
   */
  async function importSandboxCallback() {
    await import('./index.js');
    expect(factoryConfigs).toHaveLength(1);
    const host = factoryConfigs[0]?.sandbox;
    if (!isFactorySandbox(host)) throw new Error('entry factory config has no FactorySandbox');
    return (ctx: Partial<FactorySandboxContext> & { sessionId: string }) =>
      host.create({ getRepositoryAccess: undefined, ...ctx }, {});
  }

  it('creates a per-session LocalSandbox', { timeout: 60_000 }, async () => {
    const callback = await importSandboxCallback();

    const sandbox = callback({ sessionId: 'session-3' });

    // `vi.resetModules()` reloads the entry's module graph, so provider classes
    // have a fresh identity — assert on the stable `provider` discriminator.
    expect(sandbox).toMatchObject({ provider: 'local' });
  });

  it('stays local when platform credentials are configured', { timeout: 60_000 }, async () => {
    vi.stubEnv('MASTRA_PLATFORM_ACCESS_TOKEN', 'jwt_platform');
    vi.stubEnv('MASTRA_PLATFORM_SECRET_KEY', 'sk_secret');
    const callback = await importSandboxCallback();

    expect(callback({ sessionId: 'session-local' })).toMatchObject({ provider: 'local' });
  });

  it('rejects any FACTORY_SANDBOX_PROVIDER other than local', { timeout: 60_000 }, async () => {
    vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'e2b');

    await expect(import('./index.js')).rejects.toThrow(/FACTORY_SANDBOX_PROVIDER must be unset or local/);
    expect(factoryConfigs).toHaveLength(0);
  });
});
