/**
 * The assistant as an OAuth client of Factory's own authorization server (ADR-0051): the person
 * allows it once in Account (authorization code + PKCE, the same consent page every MCP client
 * gets), and the assistant then reaches Factory's MCP with the person's own access token —
 * the person's role, nothing more. Tokens are kept encrypted; erasing the assistant revokes them.
 *
 * The access token lives about an hour and is bound to the browser session the person allowed it
 * from (better-auth `oauthProvider`); it renews with the refresh token (`offline_access`) while
 * that session lives. Background work after the person signed out needs ADR-0051's (г).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { FactoryGrant, SecretCipher } from './ports.ts';
import { AssistantError } from './errors.ts';
import type { AssistantStorage } from './storage.ts';
import type { AssistantOwner } from './types.ts';
import { assertOwner } from './types.ts';

/** Where the browser comes back after the consent page. */
export const ASSISTANT_OAUTH_CALLBACK_PATH = '/web/assistant/factory-access/callback';
export const ASSISTANT_OAUTH_CLIENT_NAME = 'Factory Помічник';
const SCOPE = 'openid profile email offline_access';
/** Renew this long before the token expires. */
const RENEW_MARGIN_MS = 60_000;
const PENDING_TTL_MS = 15 * 60_000;

interface PendingSecret {
  kind: 'pending';
  state: string;
  verifier: string;
  returnTo: string;
  startedAt: number;
  /** Tokens of an earlier grant, still revoked when the assistant is erased. */
  previous?: TokenSecret;
}

interface TokenSecret {
  kind: 'tokens';
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

type GrantSecret = PendingSecret | TokenSecret;

export interface FactoryAccessOptions {
  storage: AssistantStorage;
  cipher: SecretCipher;
  /** The server's public origin, e.g. `https://factory.example.com`. */
  publicOrigin: string;
  /** Factory's authorization server (better-auth under `/auth/api`), called in-process by the server. */
  authServer: (request: Request) => Promise<Response>;
  now?: () => number;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A same-origin path to come back to: `/…`, never `//host` or a scheme. */
export function safeReturnPath(raw: string | undefined | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

export class FactoryAccess implements FactoryGrant {
  readonly #options: FactoryAccessOptions;
  readonly #now: () => number;
  readonly #origin: string;

  constructor(options: FactoryAccessOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#origin = options.publicOrigin.replace(/\/+$/, '');
  }

  get redirectUri(): string {
    return `${this.#origin}${ASSISTANT_OAUTH_CALLBACK_PATH}`;
  }

  get resource(): string {
    return `${this.#origin}/web/factory`;
  }

  #auth(path: string, init: RequestInit): Promise<Response> {
    return this.#options.authServer(new Request(`${this.#origin}/auth/api${path}`, { redirect: 'manual', ...init }));
  }

  async #secret(owner: AssistantOwner): Promise<{ clientId: string; secret: GrantSecret } | null> {
    await this.#options.storage.ensureReady();
    const row = await this.#options.storage.getGrant(owner);
    if (!row) return null;
    const { value } = await this.#options.cipher.decrypt<GrantSecret>(row.secret);
    return { clientId: row.client_id, secret: value };
  }

  async #save(owner: AssistantOwner, clientId: string, secret: GrantSecret): Promise<void> {
    await this.#options.storage.putGrant(owner, {
      clientId,
      status: secret.kind === 'tokens' ? 'granted' : 'pending',
      secret: await this.#options.cipher.encrypt(secret),
    });
  }

  async status(owner: AssistantOwner): Promise<{ connected: boolean; pending: boolean }> {
    const grant = await this.#secret(owner);
    return {
      connected: grant?.secret.kind === 'tokens' || (grant?.secret.kind === 'pending' && Boolean(grant.secret.previous)),
      pending: grant?.secret.kind === 'pending',
    };
  }

  async #register(): Promise<string> {
    const response = await this.#auth('/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.#origin },
      body: JSON.stringify({
        client_name: ASSISTANT_OAUTH_CLIENT_NAME,
        redirect_uris: [this.redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    if (response.status !== 201 && response.status !== 200) {
      throw new AssistantError(
        'factory_access_unavailable',
        `Factory's sign-in refused to register the assistant (${response.status}).`,
        502,
      );
    }
    const { client_id: clientId } = (await response.json()) as { client_id?: string };
    if (!clientId) throw new AssistantError('factory_access_unavailable', "Factory's sign-in returned no client id.", 502);
    return clientId;
  }

  /** Begins the consent: the URL the browser opens (Factory's authorize → consent page → back here). */
  async start(owner: AssistantOwner, returnTo?: string): Promise<{ url: string }> {
    assertOwner(owner);
    const existing = await this.#secret(owner);
    const clientId = existing?.clientId ?? (await this.#register());
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(24));
    const previous = existing?.secret.kind === 'tokens' ? existing.secret : existing?.secret.previous;
    await this.#save(owner, clientId, {
      kind: 'pending',
      state,
      verifier,
      returnTo: safeReturnPath(returnTo),
      startedAt: this.#now(),
      ...(previous ? { previous } : {}),
    });
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: this.redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: SCOPE,
      state,
      resource: this.resource,
    });
    return { url: `${this.#origin}/auth/api/oauth2/authorize?${query}` };
  }

  /** The browser came back with a code: exchange it for the person's tokens. */
  async complete(owner: AssistantOwner, input: { code: string; state: string }): Promise<{ returnTo: string }> {
    const grant = await this.#secret(owner);
    if (!grant || grant.secret.kind !== 'pending' || !input.state || !sameText(grant.secret.state, input.state)) {
      throw new AssistantError('factory_access_state', 'This sign-in to Factory was not started here, or already finished.', 400);
    }
    const pending = grant.secret;
    if (this.#now() - pending.startedAt > PENDING_TTL_MS) {
      throw new AssistantError('factory_access_state', 'The sign-in to Factory took too long; start it again.', 400);
    }
    const response = await this.#auth('/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: this.redirectUri,
        client_id: grant.clientId,
        code_verifier: pending.verifier,
        resource: this.resource,
      }),
    });
    if (response.status !== 200) {
      throw new AssistantError('factory_access_refused', `Factory refused the sign-in (${response.status}).`, 502);
    }
    const tokens = await this.#tokens(response);
    await this.#save(owner, grant.clientId, tokens);
    if (pending.previous) await this.#revokeTokens(grant.clientId, pending.previous);
    return { returnTo: pending.returnTo };
  }

  async #tokens(response: Response): Promise<TokenSecret> {
    const body = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!body.access_token) throw new AssistantError('factory_access_refused', 'Factory returned no access token.', 502);
    return {
      kind: 'tokens',
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: this.#now() + (body.expires_in ?? 3600) * 1000,
    };
  }

  /** The person's current access token, renewed when it is about to expire. */
  async accessToken(owner: AssistantOwner): Promise<string> {
    const grant = await this.#secret(owner);
    const tokens = grant?.secret.kind === 'tokens' ? grant.secret : grant?.secret.kind === 'pending' ? grant.secret.previous : undefined;
    if (!grant || !tokens) {
      throw new AssistantError('factory_not_connected', 'Allow the assistant to reach Factory first (Account › Помічник).', 409);
    }
    if (tokens.expiresAt - RENEW_MARGIN_MS > this.#now()) return tokens.accessToken;
    const expired = () =>
      new AssistantError('factory_access_expired', 'The assistant’s access to Factory expired. Allow it again in Account › Помічник.', 409);
    if (!tokens.refreshToken) throw expired();
    const response = await this.#auth('/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: grant.clientId,
        resource: this.resource,
      }),
    });
    if (response.status !== 200) throw expired();
    const renewed = await this.#tokens(response);
    if (!renewed.refreshToken) renewed.refreshToken = tokens.refreshToken;
    await this.#save(owner, grant.clientId, grant.secret.kind === 'pending' ? { ...grant.secret, previous: renewed } : renewed);
    return renewed.accessToken;
  }

  async #revokeTokens(clientId: string, tokens: TokenSecret): Promise<void> {
    const revoke = async (token: string, hint: string) => {
      const response = await this.#auth('/oauth2/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }),
      });
      if (response.status !== 200) throw new Error(`revocation answered ${response.status}`);
    };
    if (tokens.refreshToken) await revoke(tokens.refreshToken, 'refresh_token');
    await revoke(tokens.accessToken, 'access_token');
  }

  /**
   * Revokes the person's tokens at Factory's authorization server. The grant row itself goes with
   * the owner's other rows; a revocation Factory refuses is logged loudly and does not stop the
   * erasing (the tokens die with their browser session, the access token within the hour).
   */
  async revoke(owner: AssistantOwner): Promise<void> {
    const grant = await this.#secret(owner);
    if (!grant) return;
    const tokens = grant.secret.kind === 'tokens' ? grant.secret : grant.secret.previous;
    if (!tokens) return;
    try {
      await this.#revokeTokens(grant.clientId, tokens);
    } catch (error) {
      console.error(
        `[assistant] Could not revoke the Factory access of ${owner.userId} in ${owner.orgId}; erasing it anyway:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** The person withdraws the assistant's access to Factory. */
  async disconnect(owner: AssistantOwner): Promise<void> {
    await this.revoke(owner);
    await this.#options.storage.deleteGrant(owner);
  }
}
