import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// The machine credential key lives in ~/.mastracode; the tests never touch the real file.
const machineKeyReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('./local/local-dev-key', () => ({
  ownMachineCredentialKey: () => {
    machineKeyReads.count += 1;
    return Buffer.alloc(32, 9).toString('base64');
  },
}));

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
      'FACTORY_AUTH',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'FACTORY_AUTH_SECRET',
      'FACTORY_OWN_MACHINE',
    ]) {
      vi.stubEnv(name, '');
    }
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgres://factory:factory@127.0.0.1:1/factory');
    vi.stubEnv('MASTRA_PROJECT_ID', 'test-project');
    factoryConfigs.length = 0;
    machineKeyReads.count = 0;
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

  describe('FACTORY_AUTH=google', () => {
    beforeEach(() => {
      vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION_KEY', ENCRYPTION_KEY);
      vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'local');
      vi.stubEnv('FACTORY_AUTH', 'google');
      vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
      vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
      vi.stubEnv('FACTORY_AUTH_SECRET', 'a-session-secret-of-at-least-32-characters');
      vi.stubEnv('MASTRACODE_PUBLIC_URL', 'https://factory.example.com');
    });

    it('signs in with Google through better-auth', { timeout: 60_000 }, async () => {
      const config = await bootedConfig();

      expect(config.auth).toMatchObject({ name: 'better-auth' });
    });

    it('refuses to boot without the Google client', { timeout: 60_000 }, async () => {
      vi.stubEnv('GOOGLE_CLIENT_SECRET', '');

      await expect(import('./index.js')).rejects.toThrow(/FACTORY_AUTH=google needs GOOGLE_CLIENT_SECRET/);
      expect(factoryConfigs).toHaveLength(0);
    });

    it('refuses the removed Firebase sign-in by name', { timeout: 60_000 }, async () => {
      vi.stubEnv('FACTORY_AUTH', 'firebase');

      await expect(import('./index.js')).rejects.toThrow(/FACTORY_AUTH must be unset or google, got "firebase"/);
    });
  });
  describe('FACTORY_OWN_MACHINE=1 (a production server on the person\'s own machine)', () => {
    beforeEach(() => {
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('MASTRA_DB_PATH', join(mkdtempSync(join(tmpdir(), 'factory-own-machine-')), 'mastra.db'));
      vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'local');
      vi.stubEnv('FACTORY_AUTH', 'google');
      vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
      vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
      vi.stubEnv('FACTORY_AUTH_SECRET', 'a-session-secret-of-at-least-32-characters');
      vi.stubEnv('MASTRACODE_PUBLIC_URL', 'https://factory.example.com');
    });

    it('still needs DATABASE_URL without the opt-in', { timeout: 60_000 }, async () => {
      vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION_KEY', ENCRYPTION_KEY);

      await expect(import('./index.js')).rejects.toThrow(/DATABASE_URL is required/);
    });

    it('keeps what a development server has: local database, machine key, own-machine features', { timeout: 60_000 }, async () => {
      vi.stubEnv('FACTORY_OWN_MACHINE', '1');

      const config = await bootedConfig();

      expect(machineKeyReads.count).toBe(1);
      expect(config.secretEncryption).toBeDefined();
      expect(config.storage?.constructor.name).toBe('LibSQLFactoryStorage');
      expect(config.device).toBeDefined();
    });

    it('is refused without Google sign-in', { timeout: 60_000 }, async () => {
      vi.stubEnv('FACTORY_OWN_MACHINE', '1');
      vi.stubEnv('FACTORY_AUTH', '');
      vi.stubEnv('MASTRACODE_AUTH_DISABLED', '1');

      await expect(import('./index.js')).rejects.toThrow(/FACTORY_OWN_MACHINE=1 needs FACTORY_AUTH=google/);
    });
  });
});
