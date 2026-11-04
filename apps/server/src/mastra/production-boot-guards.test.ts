import type * as factoryModule from '@factory/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const factoryConfigs = vi.hoisted(() => [] as Array<ConstructorParameters<typeof factoryModule.MastraFactory>[0]>);
vi.mock('@factory/server', async importOriginal => {
  const actual = await importOriginal<typeof factoryModule>();
  // Records the config the entry builds. Boot itself is skipped: production
  // mode needs DATABASE_URL, and these tests check what the entry decides to
  // configure before the database is ever touched.
  class RecordedMastraFactory extends actual.MastraFactory {
    constructor(config: ConstructorParameters<typeof actual.MastraFactory>[0]) {
      super(config);
      factoryConfigs.push(config);
    }
    override async prepare() {
      return {} as Awaited<ReturnType<factoryModule.MastraFactory['prepare']>>;
    }
    override async finalize() {}
  }
  return { ...actual, MastraFactory: RecordedMastraFactory };
});

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/**
 * Outside development and tests the entry refuses to boot when a security
 * requirement is missing, the same way it already does for DATABASE_URL:
 * credential encryption needs its key or an explicit opt-out, and running
 * agent commands on the host needs an explicit opt-in.
 */
describe('production boot guards (src/mastra/index.ts)', () => {
  beforeEach(() => {
    for (const name of [
      'MASTRACODE_AUTH_DISABLED',
      'FACTORY_LOCAL_DEV_AUTH',
      'MASTRA_PLATFORM_SECRET_KEY',
      'MASTRA_PLATFORM_ACCESS_TOKEN',
      'MASTRA_CLOUD_ACCESS_TOKEN',
      'APP_DATABASE_URL',
      'REDIS_URL',
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'GITHUB_APP_SLUG',
      'GITHUB_APP_WEBHOOK_SECRET',
      'GITLAB_ACCESS_TOKEN',
      'SLACK_APP_SIGNING_SECRET',
      'FACTORY_SANDBOX_PROVIDER',
      'FACTORY_CREDENTIAL_ENCRYPTION',
      'FACTORY_CREDENTIAL_ENCRYPTION_KEY',
      'FACTORY_CREDENTIAL_ENCRYPTION_KEY_ID',
      'FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS',
    ]) {
      vi.stubEnv(name, '');
    }
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgres://factory:factory@127.0.0.1:1/factory');
    vi.stubEnv('MASTRA_PROJECT_ID', 'test-project');
    factoryConfigs.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function bootedConfig() {
    await import('./index.js');
    expect(factoryConfigs).toHaveLength(1);
    return factoryConfigs[0]!;
  }

  it('refuses to boot without a credential encryption key', { timeout: 60_000 }, async () => {
    vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'local');

    await expect(import('./index.js')).rejects.toThrow(/FACTORY_CREDENTIAL_ENCRYPTION_KEY is required/);
    expect(factoryConfigs).toHaveLength(0);
  });

  it('refuses to boot until host sandboxes are opted into', { timeout: 60_000 }, async () => {
    vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION_KEY', ENCRYPTION_KEY);

    await expect(import('./index.js')).rejects.toThrow(/FACTORY_SANDBOX_PROVIDER=local/);
    expect(factoryConfigs).toHaveLength(0);
  });

  it('boots with encryption and host sandboxes opted into', { timeout: 60_000 }, async () => {
    vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION_KEY', ENCRYPTION_KEY);
    vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'local');

    const config = await bootedConfig();

    expect(config.secretEncryption).toBeDefined();
    expect(config.sandbox).toMatchObject({ provider: 'local' });
  });

  it('refuses a cloud sandbox provider', { timeout: 60_000 }, async () => {
    vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION_KEY', ENCRYPTION_KEY);
    vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'e2b');

    await expect(import('./index.js')).rejects.toThrow(/FACTORY_SANDBOX_PROVIDER must be unset or local/);
    expect(factoryConfigs).toHaveLength(0);
  });

  it('boots with plaintext credentials and host sandboxes when both are opted into', { timeout: 60_000 }, async () => {
    vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION', 'plaintext');
    vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'local');

    const config = await bootedConfig();

    expect(config.secretEncryption).toBeUndefined();
    expect(config.sandbox).toMatchObject({ provider: 'local' });
  });

  it('keeps the development fallbacks', { timeout: 60_000 }, async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', '');

    const config = await bootedConfig();

    expect(config.secretEncryption).toBeUndefined();
    expect(config.sandbox).toMatchObject({ provider: 'local' });
  });
});
