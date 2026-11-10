import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalDevAuth } from './local-dev-auth';

const at = (url: string) => new Request(url);

describe('createLocalDevAuth', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HOST', '127.0.0.1');
    vi.stubEnv('FACTORY_LOCAL_DEV_TRUSTED_HOSTS', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('signs in loopback requests and rejects any other host', async () => {
    const auth = createLocalDevAuth();
    expect(await auth.authenticateToken('', at('http://localhost:5874/api'))).toMatchObject({ id: 'factory-local-developer' });
    expect(await auth.authenticateToken('', at('http://127.0.0.1:5874/api'))).not.toBeNull();
    expect(await auth.authenticateToken('', at('https://mac.tailnet.ts.net/api'))).toBeNull();
  });

  it('signs in hosts listed in FACTORY_LOCAL_DEV_TRUSTED_HOSTS', async () => {
    vi.stubEnv('FACTORY_LOCAL_DEV_TRUSTED_HOSTS', 'Mac.Tailnet.ts.net, other.example');
    const auth = createLocalDevAuth();
    expect(await auth.authenticateToken('', at('https://mac.tailnet.ts.net/api'))).not.toBeNull();
    expect(await auth.authenticateToken('', at('https://evil.ts.net/api'))).toBeNull();
  });

  it('fails loudly on a wildcard or malformed host', () => {
    vi.stubEnv('FACTORY_LOCAL_DEV_TRUSTED_HOSTS', '*.ts.net');
    expect(() => createLocalDevAuth()).toThrow(/invalid hostname/);
  });
});
