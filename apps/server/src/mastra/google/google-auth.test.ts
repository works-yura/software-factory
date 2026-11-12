import { MastraAuthBetterAuth } from '@factory/auth-better-auth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGoogleAuth } from './google-auth';

const SECRET = 'a-session-secret-of-at-least-32-characters';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createGoogleAuth', () => {
  function stubComplete() {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('FACTORY_AUTH_SECRET', SECRET);
    vi.stubEnv('MASTRACODE_PUBLIC_URL', 'https://factory.example.com');
  }

  it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'FACTORY_AUTH_SECRET', 'MASTRACODE_PUBLIC_URL'])(
    'stops the boot naming %s when it is missing',
    name => {
      stubComplete();
      vi.stubEnv(name, '');
      expect(() => createGoogleAuth()).toThrow(new RegExp(`FACTORY_AUTH=google needs ${name}`));
    },
  );

  it('refuses a session secret shorter than 32 characters', () => {
    stubComplete();
    vi.stubEnv('FACTORY_AUTH_SECRET', 'short');
    expect(() => createGoogleAuth()).toThrow(/FACTORY_AUTH_SECRET must be at least 32 characters/);
  });

  it('builds the better-auth provider', () => {
    stubComplete();
    expect(createGoogleAuth()).toBeInstanceOf(MastraAuthBetterAuth);
  });
});
