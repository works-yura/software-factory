/**
 * Base class for factory route modules.
 *
 * Route modules build Mastra `apiRoutes` from injected dependencies instead of
 * reaching into host globals. The host server (e.g. `mastracode/web`) supplies
 * the auth seam and storage domain handles at construction time, so the routes
 * stay portable and testable with fakes.
 */

import type { Permission } from '@factory/access';
import type { ApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

/**
 * The auth surface factory routes need, implemented by the host server.
 *
 * Local (no-auth) deployments implement this with a stub where `enabled()`
 * returns `false` and `tenant()` returns `undefined` — routes then take their
 * single-user local paths.
 */
export interface RouteAuth {
  /** Whether an auth provider is active (tenant mode). */
  enabled(): boolean;
  /**
   * Resolve (and cache) the signed-in user for the request, if any. Must be
   * called before `tenant()` so the request context is populated.
   */
  ensureUser(c: Context): Promise<unknown>;
  /**
   * Tenant identity for the request, when signed in, with the person's role in `orgId`.
   */
  tenant(c: Context): { orgId?: string; userId: string; role?: string } | undefined;
  /**
   * Whether the caller's role in their organization holds the permission (`can()` of
   * `@factory/access`). With `organizationId`, also that it is the caller's organization.
   * Fail-closed: no user, another organization or an unknown role is `false`; a provider that
   * cannot answer throws (503).
   */
  can(c: Context, permission: Permission, organizationId?: string): Promise<boolean>;
}

/** Dependencies shared by every factory route module. */
export interface RouteDependencies {
  auth: RouteAuth;
}

/**
 * A route module: constructed once at boot with its dependencies, then asked
 * for the `ApiRoute[]` it serves.
 */
export abstract class Route<TDeps extends RouteDependencies = RouteDependencies> {
  protected readonly deps: TDeps;

  constructor(deps: TDeps) {
    this.deps = deps;
  }

  /** Build the Mastra `apiRoutes` served by this module. */
  abstract routes(): ApiRoute[];
}
