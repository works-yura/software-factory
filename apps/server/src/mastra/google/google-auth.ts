import type { InvitationNotifier } from '@factory/access';
import { factoryAuthorizationServer, factoryMcpResource, MastraAuthBetterAuth } from '@factory/auth-better-auth';

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
 * `<MASTRACODE_PUBLIC_URL>/auth/api/callback/google`. `invitations`, when given, tells invited
 * people (`createInvitationEmails`).
 */
export function createGoogleAuth(invitations?: (publicUrl: string) => InvitationNotifier | undefined): MastraAuthBetterAuth {
  const clientId = required('GOOGLE_CLIENT_ID', 'the OAuth client id (Google Cloud › APIs & Services › Credentials).');
  const clientSecret = required('GOOGLE_CLIENT_SECRET', 'the OAuth client secret of that client.');
  const secret = required('FACTORY_AUTH_SECRET', 'a random session secret, e.g. `openssl rand -base64 32`.');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`FACTORY_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const publicUrl = required(
    'MASTRACODE_PUBLIC_URL',
    'the browser-facing origin; Google redirects back to <MASTRACODE_PUBLIC_URL>/auth/api/callback/google.',
  );
  const notifier = invitations?.(publicUrl);
  return new MastraAuthBetterAuth({ secret, google: { clientId, clientSecret }, ...(notifier ? { invitations: notifier } : {}) });
}

/**
 * The Factory MCP endpoint's OAuth: this server is the authorization server (better-auth's OAuth
 * provider under `/auth/api`), and one resource covers every Factory's endpoint. MCP clients such
 * as Claude Code discover both from the endpoint's 401, register themselves, and send the person
 * through Google sign-in and the consent page. Read after `createGoogleAuth`, which requires
 * MASTRACODE_PUBLIC_URL.
 */
export function googleMcpConfig(): { authorizationServers: string[]; resource: string } {
  const publicUrl = required('MASTRACODE_PUBLIC_URL', 'the browser-facing origin MCP clients reach this server at.');
  return { authorizationServers: [factoryAuthorizationServer(publicUrl)], resource: factoryMcpResource(publicUrl) };
}
