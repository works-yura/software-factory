import { MastraAuthBetterAuth } from '@factory/auth-better-auth';

/** better-auth refuses shorter secrets; checking here names the setting instead. */
const MIN_SECRET_LENGTH = 32;

function required(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`FACTORY_AUTH=google needs ${name}: ${hint}`);
  return value;
}

/**
 * Google sign-in on better-auth (see `@factory/auth-better-auth`). Every missing setting stops the
 * boot by name. The redirect URI to register in Google Cloud is
 * `<MASTRACODE_PUBLIC_URL>/auth/api/callback/google`.
 */
export function createGoogleAuth(): MastraAuthBetterAuth {
  const clientId = required('GOOGLE_CLIENT_ID', 'the OAuth client id (Google Cloud › APIs & Services › Credentials).');
  const clientSecret = required('GOOGLE_CLIENT_SECRET', 'the OAuth client secret of that client.');
  const secret = required('FACTORY_AUTH_SECRET', 'a random session secret, e.g. `openssl rand -base64 32`.');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`FACTORY_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  required(
    'MASTRACODE_PUBLIC_URL',
    'the browser-facing origin; Google redirects back to <MASTRACODE_PUBLIC_URL>/auth/api/callback/google.',
  );
  return new MastraAuthBetterAuth({ secret, google: { clientId, clientSecret } });
}
