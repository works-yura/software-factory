/**
 * Test-only helpers for factory route modules. Excluded from the build.
 */

import type { ApiRoute } from '@mastra/core/server';
import type { Context, Hono } from 'hono';

import { can } from '@factory/access';
import type { Role } from '@factory/access';

import type { RouteAuth } from './route.ts';

/**
 * Register a list of Mastra `ApiRoute` entries onto a plain Hono app. In
 * production these routes are handed to Mastra as `server.apiRoutes` and
 * mounted by the Hono adapter's `registerCustomApiRoutes()`. Tests that drive
 * the route handlers directly use this to mount them on a bare Hono app so
 * they can assert HTTP behavior at the same `/web/...` paths the adapter
 * serves.
 */
export function mountApiRoutes(app: Hono<any>, routes: ApiRoute[]): void {
  for (const route of routes) {
    const handler = 'handler' in route ? route.handler : undefined;
    if (!handler) continue;
    app.on(route.method, route.path, handler as never);
  }
}

/** The user shape tests stash on the request context, mirroring the web host. */
export interface TestAuthUser {
  id: string;
  organizationId?: string;
}

/**
 * A `RouteAuth` fake backed by a `factoryAuthUser` context variable, mirroring how
 * the web host resolves its signed-in user. Tests put a {@link TestAuthUser}
 * on the context (via middleware) and the fake derives the tenant from it.
 * The caller's role is `role(orgId, userId)` when given, else admin or member by
 * `isAdmin` (default: admin); `can()` reads the real role matrix.
 */
export function fakeRouteAuth(
  options: {
    /** Whether an auth provider is active. Defaults to true (tenant mode). */
    enabled?: boolean;
    /** Whether the caller is an admin, called as `(organizationId, userId)`. Defaults to yes. */
    isAdmin?: (organizationId: string, userId: string) => Promise<boolean>;
    /** The caller's role, called as `(organizationId, userId)`; wins over `isAdmin`. */
    role?: (organizationId: string, userId: string) => Promise<Role>;
  } = {},
): RouteAuth {
  const enabled = options.enabled ?? true;
  const isAdmin = options.isAdmin ?? (async () => true);
  const roleOf = options.role ?? (async (organizationId: string, userId: string) => ((await isAdmin(organizationId, userId)) ? 'admin' : 'member'));
  const user = (c: Context): TestAuthUser | undefined => c.get('factoryAuthUser' as never) as TestAuthUser | undefined;
  return {
    enabled: () => enabled,
    ensureUser: async c => user(c),
    tenant: c => {
      const u = user(c);
      return u ? { orgId: u.organizationId, userId: u.id } : undefined;
    },
    can: async (c, permission, organizationId) => {
      const u = user(c);
      if (!u) return false;
      const orgId = organizationId ?? u.organizationId;
      if (!orgId) return false;
      try {
        return can(await roleOf(orgId, u.id), permission);
      } catch {
        return false;
      }
    },
  };
}
