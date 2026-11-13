/**
 * JSON 404 for server paths no route answers.
 *
 * The Mastra deployer ends every app with `app.get('*')`, which answers any GET it reaches with
 * its «Mastra Server» welcome page: 200, `text/html`. Under the server's own prefixes that turned a
 * removed or mistyped API path into a successful HTML response, and a client reading it failed on
 * `JSON.parse` ("Unexpected token '<', "<!doctype "… is not valid JSON") instead of seeing a 404.
 * A page loaded before a deploy still calls the routes it was built against, so this is what a
 * person sees after a route moves.
 *
 * These routes go last in the server's `apiRoutes`: custom routes register before the deployer's
 * catch-all and Hono tries handlers in registration order, so every real route still answers first.
 * They are public (`requiresAuth: false`): Mastra decides whether a custom path is public by
 * matching the patterns it was given, and a protected `/web/*` would make every public route with a
 * parameter under `/web` protected too. Answering 404 says nothing a signed-out caller may not
 * know; the Factory auth gate still runs first for these prefixes.
 */

import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute } from '@mastra/core/server';

/** Prefixes whose every path is the server's (API or auth), never the UI's. */
export const SERVER_ONLY_PREFIXES = ['/web', '/auth'] as const;

export interface UnknownServerRouteBody {
  error: 'not_found';
  message: string;
}

/** The last routes of the server: any method, any path under {@link SERVER_ONLY_PREFIXES} nothing else answered. */
export function buildUnknownServerRoutes(): ApiRoute[] {
  return SERVER_ONLY_PREFIXES.map(prefix =>
    registerApiRoute(`${prefix}/*`, {
      method: 'ALL',
      requiresAuth: false,
      handler: c =>
        c.json(
          {
            error: 'not_found',
            message: `No ${c.req.method} ${c.req.path} on this server. If this page was open during an update, reload it.`,
          } satisfies UnknownServerRouteBody,
          404,
        ),
    }),
  );
}
