import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens: how an agent session the Factory itself runs (a Claude Code
 * turn, say) reaches the MCP endpoint as its own bound session rather than as
 * a person. The server mints one per turn for exactly one session; the
 * endpoint verifies it and scopes the tools to that session's binding. A bare
 * session id is never enough: the token is an HMAC over the coordinates with a
 * server-held key, and it expires.
 */

/** The header a session token travels in; separate from `Authorization` so auth providers never see it. */
export { FACTORY_SESSION_TOKEN_HEADER } from '@factory/auth';

const TOKEN_PREFIX = 'fst1';
/** Long enough for one agent turn; a turn gets a fresh token. */
export const DEFAULT_SESSION_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

/** The session a token speaks for. */
export interface FactorySessionTokenClaims {
  orgId: string;
  factoryProjectId: string;
  /** The source-control session id the agent session runs as. */
  sessionId: string;
  threadId: string;
  resourceId: string;
  /**
   * `supervisor`: the token speaks for the Factory's own chat (the supervisor
   * session, `factory-supervisor:<factory>`), which has no session row; it
   * gets the supervisor's tools, acting as {@link userId}.
   */
  scope?: 'supervisor';
  /** Who a `supervisor` token acts as: the person whose message or answer started the turn. */
  userId?: string;
  /**
   * A signed-in person's message or answer started the turn, as `FACTORY_INTERACTIVE_KEY` marks a
   * Mastra turn started over HTTP: the person's own actions (approvals, proposals, role starts) are open to it.
   */
  interactive?: boolean;
}

export interface FactorySessionTokenSigner {
  sign(claims: FactorySessionTokenClaims, options?: { ttlMs?: number }): string;
  /** The claims of a valid, unexpired token; `null` for anything else. */
  verify(token: string | undefined | null): FactorySessionTokenClaims | null;
}

interface TokenPayload extends FactorySessionTokenClaims {
  /** Expiry, ms since the epoch. */
  exp: number;
}

const CLAIM_KEYS = ['orgId', 'factoryProjectId', 'sessionId', 'threadId', 'resourceId'] as const;

/**
 * A signer keyed off `secret`. The key is derived for this purpose only, so a
 * secret shared with OAuth `state` signing never makes a state value a valid
 * session token. Without a secret it uses a per-process random key: tokens
 * then only verify on the replica that minted them, which is all a local
 * single-process Factory needs.
 */
export function createFactorySessionTokenSigner(
  secret?: string,
  { now = () => Date.now() }: { now?: () => number } = {},
): FactorySessionTokenSigner {
  const root = secret && secret.length > 0 ? secret : randomBytes(32).toString('hex');
  const key = createHmac('sha256', root).update('factory-mcp-session-token/v1').digest();
  const mac = (body: string) => createHmac('sha256', key).update(`${TOKEN_PREFIX}.${body}`).digest('base64url');

  return {
    sign(claims, options = {}) {
      const payload: TokenPayload = {
        ...pickClaims(claims),
        exp: now() + (options.ttlMs ?? DEFAULT_SESSION_TOKEN_TTL_MS),
      };
      const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      return `${TOKEN_PREFIX}.${body}.${mac(body)}`;
    },
    verify(token) {
      if (!token) return null;
      const [prefix, body, signature, ...rest] = token.split('.');
      if (prefix !== TOKEN_PREFIX || !body || !signature || rest.length > 0) return null;
      const expected = Buffer.from(mac(body));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      let payload: Partial<TokenPayload>;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<TokenPayload>;
      } catch {
        return null;
      }
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now()) return null;
      for (const claim of CLAIM_KEYS) {
        const value = payload[claim];
        if (typeof value !== 'string' || value.length === 0) return null;
      }
      if (payload.scope !== undefined && payload.scope !== 'supervisor') return null;
      if (payload.scope === 'supervisor' && (typeof payload.userId !== 'string' || payload.userId.length === 0)) return null;
      if (payload.interactive !== undefined && typeof payload.interactive !== 'boolean') return null;
      return pickClaims(payload as FactorySessionTokenClaims);
    },
  };
}

function pickClaims(claims: FactorySessionTokenClaims): FactorySessionTokenClaims {
  return {
    orgId: claims.orgId,
    factoryProjectId: claims.factoryProjectId,
    sessionId: claims.sessionId,
    threadId: claims.threadId,
    resourceId: claims.resourceId,
    ...(claims.scope ? { scope: claims.scope } : {}),
    ...(typeof claims.userId === 'string' ? { userId: claims.userId } : {}),
    ...(claims.interactive === true ? { interactive: true } : {}),
  };
}
