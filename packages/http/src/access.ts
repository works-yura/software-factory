/**
 * Every route says what it needs (ADR-0045): a permission of `@factory/access`, or `public` for the
 * few that take no signed-in person (webhooks, sign-in). {@link enforceRouteAccess} checks it in
 * front of the handler for every route the server serves; a write that declares nothing is refused,
 * so a new route cannot slip through without a decision.
 */
import { isPermission } from '@factory/access';
import type { Permission } from '@factory/access';
import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import type { RouteAuth } from './route.ts';

/** What a route needs: a permission, or nothing at all (`public`: the route authenticates itself or needs no one). */
export type RouteAccess = Permission | 'public';

const ACCESS = Symbol.for('factory.routeAccess');

type Stamped = { [ACCESS]?: RouteAccess };

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'ALL']);

/** Whether the method changes something (and so must declare what it needs). */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/** Declares what a route needs; returns the same route. */
export function withAccess<T extends ApiRoute>(access: RouteAccess, route: T): T {
  if (access !== 'public' && !isPermission(access)) throw new Error(`Unknown permission ${String(access)} for ${route.path}`);
  (route as T & Stamped)[ACCESS] = access;
  return route;
}

/** What the route declared, if anything. */
export function routeAccess(route: ApiRoute): RouteAccess | undefined {
  return (route as ApiRoute & Stamped)[ACCESS];
}

type RegisterOptions = Parameters<typeof registerApiRoute>[1];

/** `registerApiRoute` with the access it needs: `route('/web/x', { method: 'POST', access: 'card.write', handler })`. */
export function route<P extends string>(path: P, options: RegisterOptions & { access: RouteAccess }): ApiRoute {
  const { access, ...rest } = options;
  return withAccess(access, registerApiRoute(path, rest as RegisterOptions));
}

/** Routes that change something without declaring what they need. Empty on a well-built server. */
export function undeclaredWrites(routes: readonly ApiRoute[]): string[] {
  return routes
    .filter(candidate => isMutatingMethod(candidate.method) && routeAccess(candidate) === undefined)
    .map(candidate => `${candidate.method} ${candidate.path}`);
}

type Handler = (c: Context, next: () => Promise<void>) => unknown;

export const PERMISSION_UNDECLARED_BODY = {
  error: 'permission_undeclared',
  message: 'This action declares no permission, so Factory refuses it. This is a bug in Factory.',
} as const;

/** The 403 a caller without the permission gets. */
export function forbiddenBody(permission: Permission) {
  return {
    error: 'forbidden',
    permission,
    message: `Your role in this organization does not allow this (${permission}). Ask an admin of your organization.`,
  };
}

/**
 * Puts the access check in front of every route: a write without a declaration answers 403
 * `permission_undeclared` (and is logged), a declared permission the caller's role lacks answers
 * 403 `forbidden`. Reads that declare nothing pass (the gate already requires a member). With auth
 * off there is one local operator and nothing to check.
 */
export function enforceRouteAccess(routes: readonly ApiRoute[], auth: RouteAuth): ApiRoute[] {
  return routes.map(candidate => {
    const access = routeAccess(candidate);
    const mutating = isMutatingMethod(candidate.method);
    if (access === 'public' || (!mutating && access === undefined)) return candidate;
    const guard = async (c: Context): Promise<Response | undefined> => {
      if (access === undefined) {
        console.error(`[access] ${candidate.method} ${candidate.path} declares no permission; refusing ${c.req.method} ${c.req.path}.`);
        return c.json(PERMISSION_UNDECLARED_BODY, 403);
      }
      if (!auth.enabled()) return undefined;
      await auth.ensureUser(c);
      if (!auth.tenant(c)) return c.json({ error: 'unauthorized' }, 401);
      if (!(await auth.can(c, access))) return c.json(forbiddenBody(access), 403);
      return undefined;
    };
    const wrap =
      (handler: Handler): Handler =>
      async (c, next) =>
        (await guard(c)) ?? handler(c, next);
    const wrapped = { ...candidate } as ApiRoute & Stamped & { handler?: Handler; createHandler?: (...args: never[]) => Promise<Handler> };
    if (typeof wrapped.handler === 'function') wrapped.handler = wrap(wrapped.handler);
    if (typeof wrapped.createHandler === 'function') {
      const create = wrapped.createHandler;
      wrapped.createHandler = (async (...args: never[]) => wrap(await create(...args))) as never;
    }
    if (access !== undefined) wrapped[ACCESS] = access;
    return wrapped;
  });
}

/**
 * A route module's declaration of what its routes need, keyed `"METHOD /path"` exactly as the
 * routes register. Stamps each named route. A module may leave some routes out on some servers
 * (local-only or optional ones), so a key without a route is fine; a route without a key stays
 * undeclared (reads pass; writes are refused, and the coverage test fails).
 */
export function declareAccess<T extends ApiRoute>(routes: readonly T[], table: Readonly<Record<string, RouteAccess>>): T[] {
  return routes.map(candidate => {
    const access = table[`${candidate.method} ${candidate.path}`];
    return access === undefined ? candidate : withAccess(access, candidate);
  });
}
