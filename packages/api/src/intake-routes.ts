/**
 * Mastra `apiRoutes` for managing a project's intake routes: the ordered rules that place new
 * cards on a board and phase when they arrive, and the routes «За розкладом» that make cards
 * themselves on a trigger of their own (ADR-0021) — one list, one set of endpoints. A route with a
 * trigger is checked by the trigger engine before it is written and armed (or stopped) after; the
 * kinds on offer, a trigger's preview and a route's fire history have endpoints of their own.
 *
 * Reads need a signed-in user of the project's organization; writes need an organization admin in
 * tenant mode. A route's target must be an installed board and a phase new cards can reach when it
 * is written; a target that
 * stops existing later is reported in `problems` and skipped when cards arrive.
 */

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import type { z } from 'zod';

import { DEFAULT_ROUTE_EVENTS, INTAKE_TEMPLATE_PLACEHOLDERS, IntakeError, intakeTargetProblem } from '@factory/core';
import type { BoardRegistry, IntakeErrorCode, IntakeLocale, StatusEvent } from '@factory/core';
import { FACTORY_ROUTE_CONTRACTS } from '@factory/contracts';
import type { IntakeRouteFire as IntakeRouteFireView, IntakeRouteTriggeredBody } from '@factory/contracts';
import type { AuditEmitter } from '@factory/feed';
import { Route } from '@factory/http';
import type { RouteDependencies } from '@factory/http';
import { intakeRouteCardSource } from '@factory/runtime';
import type { IntakeTriggerEngine, ProjectBoardCache } from '@factory/runtime';
import { StoredBoardError, storedTriggerRoute } from '@factory/store';
import type {
  FactoryProjectsStorage,
  IntakeRouteFire,
  IntakeRouteFiresStorage,
  IntakeRouteTrigger,
  StoredBoardScope,
  StoredBoardsStorage,
  StoredIntakeRouteRecord,
  WorkItemsStorage,
} from '@factory/store';

export interface IntakeRouteRoutesDeps extends RouteDependencies {
  audit: AuditEmitter;
  projects: FactoryProjectsStorage;
  storage: StoredBoardsStorage;
  /** The project's installed boards, to check route targets against. */
  boards: Pick<ProjectBoardCache, 'describe'>;
  /**
   * Routes «За розкладом»: the engine that checks and arms their triggers, their fire log, and the
   * cards a fire filed (found by their source). Without it such routes are refused with 503.
   */
  triggers?: {
    engine: IntakeTriggerEngine;
    fires: Pick<IntakeRouteFiresStorage, 'listFires' | 'deleteFires'>;
    cards: Pick<WorkItemsStorage, 'getByProjectSource'>;
  };
}

const INTAKE_ERROR_STATUS: Record<IntakeErrorCode, 422 | 503> = {
  invalid_config: 422,
  unknown_kind: 422,
  target_unavailable: 422,
  trigger_unavailable: 503,
};

function triggeredFor(body: IntakeRouteTriggeredBody): IntakeRouteTrigger {
  return { trigger: body.trigger, action: body.action, policyKind: body.policy.kind };
}

type Resolved = StoredBoardScope & { userId: string };

/** A response the handler returns as is: a refusal or an error. */
class Refusal {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503;
  readonly body: Record<string, unknown>;

  constructor(status: 400 | 401 | 403 | 404 | 409 | 422 | 503, body: Record<string, unknown>) {
    this.status = status;
    this.body = body;
  }
}

function loose(context: unknown): Context {
  return context as Context;
}

function issueMessage(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map(issue => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

function presentFire(fire: IntakeRouteFire, workItemId: string | null): IntakeRouteFireView {
  return {
    id: fire.id,
    firedAt: fire.firedAt.toISOString(),
    triggerKind: fire.triggerKind,
    outcome: fire.outcome,
    workItemId,
    reason: fire.reason,
  };
}

export class IntakeRouteRoutes extends Route<IntakeRouteRoutesDeps> {
  async #resolve(c: Context): Promise<Resolved> {
    const { auth, projects } = this.deps;
    await auth.ensureUser(c);
    const tenant = auth.tenant(c);
    if (!tenant) throw new Refusal(401, { error: 'unauthorized' });
    if (!tenant.orgId) {
      throw new Refusal(403, { error: 'organization_required', message: 'Intake routes belong to an organization.' });
    }
    const parsed = FACTORY_ROUTE_CONTRACTS.intakeRouteList.pathSchema.safeParse({ id: c.req.param('id') });
    if (!parsed.success) throw new Refusal(404, { error: 'Project not found' });
    await projects.ensureReady();
    if (!(await projects.get({ orgId: tenant.orgId, id: parsed.data.id }))) {
      throw new Refusal(404, { error: 'Project not found' });
    }
    return { orgId: tenant.orgId, userId: tenant.userId, factoryProjectId: parsed.data.id };
  }

  async #requireAdmin(c: Context, scope: Resolved): Promise<void> {
    const { auth } = this.deps;
    if (auth.enabled() && !(await auth.isOrganizationAdmin(c, scope.orgId))) {
      throw new Refusal(403, {
        error: 'organization_admin_required',
        message: 'Organization administrator access is required to change intake routes.',
      });
    }
  }

  async #body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new Refusal(400, { error: 'invalid_request', message: 'Invalid JSON body.' });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new Refusal(422, { error: 'invalid_intake_route', message: issueMessage(parsed.error.issues) });
    }
    return parsed.data;
  }

  #routeId(c: Context): string {
    const parsed = FACTORY_ROUTE_CONTRACTS.intakeRouteGet.pathSchema.safeParse({
      id: c.req.param('id'),
      routeId: c.req.param('routeId'),
    });
    if (!parsed.success) throw new Refusal(404, { error: 'intake_route_not_found' });
    return parsed.data.routeId;
  }

  async #registry(scope: Resolved): Promise<BoardRegistry> {
    return (await this.deps.boards.describe(scope)).registry;
  }

  /** Refuses a target that isn't an installed board and phase, or, for a route placing new cards, one they can't land in. */
  async #checkTarget(
    scope: Resolved,
    route: {
      target: { boardKey: string; phaseKey?: string | null; joinClosedIssue?: boolean };
      on: readonly StatusEvent[];
    },
  ) {
    const problem = intakeTargetProblem(await this.#registry(scope), route);
    if (problem) throw new Refusal(422, { error: problem.code, message: problem.message });
  }

  #locale(c: Context): IntakeLocale {
    const parsed = FACTORY_ROUTE_CONTRACTS.intakeTriggerKinds.querySchema.safeParse({ locale: c.req.query('locale') });
    return parsed.success ? (parsed.data.locale ?? 'en') : 'en';
  }

  /** The card a fire filed, once the dispatcher has put it on the board. */
  async #fireCard(fire: IntakeRouteFire): Promise<string | null> {
    if (fire.workItemId) return fire.workItemId;
    if (fire.outcome !== 'done' || !fire.fireKey || !this.deps.triggers) return null;
    const card = await this.deps.triggers.cards.getByProjectSource({
      orgId: fire.orgId,
      factoryProjectId: fire.factoryProjectId,
      source: intakeRouteCardSource(fire.routeId, fire.fireKey),
    });
    return card?.id ?? null;
  }

  async #present(route: StoredIntakeRouteRecord, registry: BoardRegistry, locale: IntakeLocale) {
    const { orgId: _orgId, factoryProjectId: _project, trigger: _trigger, action: _action, policyKind: _policy, ...fields } =
      route;
    const triggerRoute = storedTriggerRoute(route);
    const problem = intakeTargetProblem(registry, triggerRoute ? { target: route.target, on: ['work_item.created'] } : route);
    const problems = problem ? [problem.message] : [];
    let triggered = null;
    if (triggerRoute) {
      if (this.deps.triggers) {
        const view = await this.deps.triggers.engine.inspect(triggerRoute, locale);
        problems.push(...view.problems.filter(message => message !== problem?.message));
        triggered = {
          trigger: { ...triggerRoute.trigger, summary: view.triggerSummary },
          action: { ...triggerRoute.action, summary: view.actionSummary },
          policy: { kind: triggerRoute.policyKind, summary: view.policySummary },
          nextFires: view.nextFires.map(at => at.toISOString()),
          lastFire: view.lastFire ? presentFire(view.lastFire, await this.#fireCard(view.lastFire)) : null,
        };
      } else {
        problems.push('Routes with a trigger of their own are not available on this server.');
        triggered = {
          trigger: { ...triggerRoute.trigger, summary: triggerRoute.trigger.kind },
          action: { ...triggerRoute.action, summary: triggerRoute.action.kind },
          policy: { kind: triggerRoute.policyKind, summary: triggerRoute.policyKind },
          nextFires: [],
          lastFire: null,
        };
      }
    }
    return { ...fields, problems, triggered };
  }

  async #list(c: Context, scope: Resolved, routes?: StoredIntakeRouteRecord[]) {
    const registry = await this.#registry(scope);
    routes ??= await this.deps.storage.listIntakeRoutes(scope);
    const { auth } = this.deps;
    const canEdit = !auth.enabled() || (await auth.isOrganizationAdmin(c, scope.orgId));
    const locale = this.#locale(c);
    const intakeRoutes = [];
    for (const route of routes) intakeRoutes.push(await this.#present(route, registry, locale));
    return c.json({ intakeRoutes, canEdit });
  }

  async #respond(c: Context, scope: Resolved, route: StoredIntakeRouteRecord, status: 200 | 201 = 200) {
    return c.json({ intakeRoute: await this.#present(route, await this.#registry(scope), this.#locale(c)) }, status);
  }

  #triggers() {
    if (!this.deps.triggers) {
      throw new Refusal(503, {
        error: 'intake_trigger_unavailable',
        message: 'Routes with a trigger of their own are not available on this server.',
      });
    }
    return this.deps.triggers;
  }

  /** Arms or stops a saved route's trigger; one that can't be is the server's problem, said loudly (503). */
  async #sync(route: StoredIntakeRouteRecord, previousTriggerKind?: string) {
    const triggerRoute = storedTriggerRoute(route);
    try {
      if (triggerRoute) await this.#triggers().engine.sync(triggerRoute, previousTriggerKind);
      else if (previousTriggerKind) await this.deps.triggers?.engine.remove(route.id, previousTriggerKind);
    } catch (error) {
      if (!(error instanceof IntakeError)) throw error;
      throw new Refusal(503, {
        error: 'intake_trigger_unavailable',
        message: `The route was saved, but ${error.message.charAt(0).toLowerCase()}${error.message.slice(1)}`,
      });
    }
  }

  async #audit(
    c: Context,
    scope: Resolved,
    action: 'created' | 'updated' | 'deleted' | 'reordered',
    targets: { id: string; name: string }[],
  ) {
    await this.deps.audit.emit({
      context: c,
      input: {
        action: `factory.intake_route.${action}`,
        factoryProjectId: scope.factoryProjectId,
        targets: targets.map(route => ({ type: 'intake_route', id: route.id, name: route.name })),
      },
    });
  }

  #route(
    contract: { path: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE' },
    handle: (c: Context) => Promise<Response>,
  ): ApiRoute {
    return registerApiRoute(contract.path, {
      method: contract.method,
      requiresAuth: false,
      handler: async c => {
        const context = loose(c);
        try {
          return await handle(context);
        } catch (error) {
          if (error instanceof Refusal) return context.json(error.body, error.status);
          if (error instanceof IntakeError) {
            const status = INTAKE_ERROR_STATUS[error.code];
            const code = status === 503 ? 'intake_trigger_unavailable' : 'invalid_intake_route';
            return context.json({ error: code, reason: error.code, message: error.message }, status);
          }
          if (error instanceof StoredBoardError) {
            return context.json(
              { error: error.code, message: error.message },
              error.code === 'intake_route_not_found' ? 404 : error.code === 'invalid_intake_route' ? 422 : 409,
            );
          }
          throw error;
        }
      },
    });
  }

  routes(): ApiRoute[] {
    const { storage } = this.deps;
    const contracts = FACTORY_ROUTE_CONTRACTS;
    return [
      // Before `/:routeId`: `kinds` and `preview` are not route ids.
      this.#route(contracts.intakeTriggerKinds, async c => {
        await this.#resolve(c);
        return c.json({
          ...this.#triggers().engine.listKinds(this.#locale(c)),
          placeholders: [...INTAKE_TEMPLATE_PLACEHOLDERS],
        });
      }),

      this.#route(contracts.intakeTriggerPreview, async c => {
        await this.#resolve(c);
        const body = await this.#body(c, contracts.intakeTriggerPreview.bodySchema);
        const preview = this.#triggers().engine.preview(body.trigger.kind, body.trigger.config, body.locale ?? 'en');
        return c.json({ ...preview, nextFires: preview.nextFires.map(at => at.toISOString()) });
      }),

      this.#route(contracts.intakeRouteFires, async c => {
        const scope = await this.#resolve(c);
        const parsed = contracts.intakeRouteFires.pathSchema.safeParse({ id: c.req.param('id'), routeId: c.req.param('routeId') });
        if (!parsed.success) throw new Refusal(404, { error: 'intake_route_not_found' });
        if (!(await storage.getIntakeRoute(scope, parsed.data.routeId))) throw new Refusal(404, { error: 'intake_route_not_found' });
        const fires = await this.#triggers().fires.listFires(scope, parsed.data.routeId, { limit: 50 });
        const presented = [];
        for (const fire of fires) presented.push(presentFire(fire, await this.#fireCard(fire)));
        return c.json({ fires: presented });
      }),

      this.#route(contracts.intakeRouteList, async c => this.#list(c, await this.#resolve(c))),

      this.#route(contracts.intakeRouteReorder, async c => {
        const scope = await this.#resolve(c);
        await this.#requireAdmin(c, scope);
        const { ids } = await this.#body(c, contracts.intakeRouteReorder.bodySchema);
        const routes = await storage.reorderIntakeRoutes(scope, ids, scope.userId);
        await this.#audit(c, scope, 'reordered', routes);
        return this.#list(c, scope, routes);
      }),

      this.#route(contracts.intakeRouteGet, async c => {
        const scope = await this.#resolve(c);
        const route = await storage.getIntakeRoute(scope, this.#routeId(c));
        if (!route) throw new Refusal(404, { error: 'intake_route_not_found' });
        return this.#respond(c, scope, route);
      }),

      this.#route(contracts.intakeRouteCreate, async c => {
        const scope = await this.#resolve(c);
        await this.#requireAdmin(c, scope);
        const { triggered: triggeredBody, ...input } = await this.#body(c, contracts.intakeRouteCreate.bodySchema);
        const triggered = triggeredBody ? triggeredFor(triggeredBody) : undefined;
        if (triggered) {
          await this.#triggers().engine.validate(
            { ...triggered, target: { boardKey: input.target.boardKey, phaseKey: input.target.phaseKey ?? null } },
            scope,
          );
        } else {
          await this.#checkTarget(scope, { target: input.target, on: input.on ?? DEFAULT_ROUTE_EVENTS });
        }
        const route = await storage.createIntakeRoute(scope, { ...input, ...(triggered ? { triggered } : {}) }, scope.userId);
        await this.#audit(c, scope, 'created', [route]);
        if (triggered) await this.#sync(route);
        return this.#respond(c, scope, route, 201);
      }),

      this.#route(contracts.intakeRouteUpdate, async c => {
        const scope = await this.#resolve(c);
        await this.#requireAdmin(c, scope);
        const id = this.#routeId(c);
        const { expectedRevision, triggered: triggeredBody, ...patch } = await this.#body(
          c,
          contracts.intakeRouteUpdate.bodySchema,
        );
        const current = await storage.getIntakeRoute(scope, id);
        if (!current) throw new Refusal(404, { error: 'intake_route_not_found' });
        const triggered = triggeredBody ? triggeredFor(triggeredBody) : undefined;
        const before = storedTriggerRoute(current);
        if (triggered && !before) {
          throw new Refusal(422, {
            error: 'invalid_intake_route',
            message: 'Only a route «За розкладом» has a trigger; add a new route to make one.',
          });
        }
        if (before) {
          const target = patch.target ?? current.target;
          await this.#triggers().engine.validate(
            {
              trigger: triggered?.trigger ?? before.trigger,
              action: triggered?.action ?? before.action,
              policyKind: triggered?.policyKind ?? before.policyKind,
              target: { boardKey: target.boardKey, phaseKey: target.phaseKey ?? null },
            },
            scope,
          );
        } else if (patch.target || patch.on) {
          // Narrowing or widening `on` changes which targets are allowed, so check the route as it will be.
          await this.#checkTarget(scope, { target: patch.target ?? current.target, on: patch.on ?? current.on });
        }
        const route = await storage.updateIntakeRoute(
          scope,
          id,
          { ...patch, ...(triggered ? { triggered } : {}) },
          { expectedRevision, actor: scope.userId },
        );
        await this.#audit(c, scope, 'updated', [route]);
        if (before) await this.#sync(route, before.trigger.kind);
        return this.#respond(c, scope, route);
      }),

      this.#route(contracts.intakeRouteDelete, async c => {
        const scope = await this.#resolve(c);
        await this.#requireAdmin(c, scope);
        const id = this.#routeId(c);
        const parsed = contracts.intakeRouteDelete.querySchema.safeParse({
          expectedRevision: c.req.query('expectedRevision'),
        });
        if (!parsed.success) {
          throw new Refusal(422, { error: 'invalid_request', message: issueMessage(parsed.error.issues) });
        }
        const route = await storage.getIntakeRoute(scope, id);
        if (!route) throw new Refusal(404, { error: 'intake_route_not_found' });
        await storage.deleteIntakeRoute(scope, id, { expectedRevision: parsed.data.expectedRevision });
        await this.#audit(c, scope, 'deleted', [route]);
        if (route.trigger) {
          // The route is gone; a trigger that can't be stopped now stops itself at its next fire.
          await this.deps.triggers?.engine.remove(route.id, route.trigger.kind).catch(() => undefined);
          await this.deps.triggers?.fires.deleteFires(route.id);
        }
        return c.body(null, 204);
      }),
    ];
  }
}
