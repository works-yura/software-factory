/**
 * Server-wide error handler for the MastraCode web surface.
 *
 * Installed as `server.onError`, which the deployer applies to the top-level
 * Hono app AND the custom-route sub-app (`/web/*`, `/auth/*`) — without it,
 * unexpected route errors surface as an opaque `Internal Server Error` with no
 * server-side trace.
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * A Hono `HTTPException`, recognized by shape: the deployer bundles its own hono (its
 * request timeout and body limit throw that copy's class), so `instanceof` against ours misses it.
 */
function httpException(err: unknown): { status: ContentfulStatusCode; message: string } | undefined {
  if (!(err instanceof Error)) return undefined;
  const { status, getResponse } = err as Error & { status?: unknown; getResponse?: unknown };
  if (typeof getResponse !== 'function' || typeof status !== 'number' || status < 400 || status > 599) {
    return undefined;
  }
  return { status: status as ContentfulStatusCode, message: err.message };
}

/**
 * Requests the deployer's timeout already answered. Their handler keeps running and, when it ends,
 * the CORS middleware the timeout wraps writes headers onto the response already sent, which throws
 * (`Response body object should not be disturbed or locked`); nobody receives that error.
 */
const timedOut = new WeakSet<Context>();

/** Handle a route error: log full detail server-side, return structured JSON. */
export function handleServerError(err: Error, c: Context): Response {
  // Deliberate HTTP errors (auth middleware, body limits, handlers) keep their
  // status + message; they are expected flows, not server faults.
  const http = httpException(err);
  if (http?.status === 504) {
    // The deployer's request timeout (`server.timeout`): the handler may still finish its work.
    timedOut.add(c);
    console.warn(`[Factory] ${c.req.method} ${c.req.path} timed out before its handler answered`);
    return c.json(
      {
        error: 'gateway_timeout',
        message: 'The server stopped waiting for this request after its time limit; what it started may still finish.',
      },
      504,
    );
  }
  if (http) return c.json({ error: http.message }, http.status);

  const message = err instanceof Error ? err.message : String(err);
  if (timedOut.has(c)) {
    console.warn(`[Factory] ${c.req.method} ${c.req.path} ended after its timeout answered: ${message}`);
    return c.json({ error: 'gateway_timeout', message }, 504);
  }

  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[Factory] ${c.req.method} ${c.req.path} failed: ${detail}`);

  return c.json({ error: 'internal_error', message }, 500);
}
